/**
 * The agent tool loop, following Trie IDE's toolLoop.ts contract:
 * `[system, user]` then alternating assistant tool-call envelopes and user
 * tool-result turns; the loop ends on a control tool (step_complete /
 * step_failed), on exhausting the call budget, or on repeated malformed
 * output. One repair attempt per failure; the hybrid frontier model is
 * consulted for a stuck hint after consecutive failures and for a final
 * review after a mutating turn completes.
 *
 * Hybrid upgrades (research-backed):
 * - Evidence-grounded final review (diff + typecheck/test output first)
 * - AutoMix-style local self-grade before finish
 * - Token-uncertainty mid-turn escalation (daemon confidence + heuristics)
 * - MinionS-style frontier decomposition for large tasks
 */
import type { ChatTurn, GenerationParams, InferenceClient } from '../inference/types'
import { isWebSearchConfigured, readConfig } from '../config'
import type { ChangedFileStat } from './checkpoints'
import { buildWorkspaceContext } from './context'
import {
  formatDecomposeInjection,
  frontierDecompose,
  shouldDecompose,
} from './hybridDecompose'
import { formatEvidenceForFrontier, gatherReviewEvidence } from './hybridEvidence'
import { localSelfGrade } from './hybridSelfGrade'
import { heuristicUncertainty, HybridUncertaintyTracker } from './hybridUncertainty'
import { FrontierAssist, type GuideNote } from './frontierAssist'
import {
  agentSystemPrompt,
  agentUserPrompt,
  isReadOnlyMode,
  repairTurn,
  toolResultTurn,
  type AgentMode,
} from './prompts'
import {
  buildWebSearchQuery,
  taskNeedsWebSearch,
  webSearchTaskNote,
} from './webSearchIntent'
import {
  isTrivialConversation,
  taskExpectsCodeChanges,
  summaryClaimsFileChanges,
} from './taskIntent'
import {
  parseToolCall,
  summarizeArgs,
  TOOL_SPECS,
  toolGroupKey,
  toolLineDelta,
  WorkspaceTools,
  type ToolCall,
} from './tools'

export interface LoopEvents {
  onGenerating(active: boolean): void
  onToolCall(id: number, call: ToolCall, argsSummary: string): void
  onToolResult(
    id: number,
    ok: boolean,
    summary: string,
    viaTrie?: boolean,
    trieMs?: number,
    scanMs?: number,
  ): void
  onTodos(todo: string[], done: string[]): void
  /** Frontier model is consulting (stuck hint or final review). */
  onHybridChecking(active: boolean, checkpoint?: GuideNote['checkpoint'] | 'decompose'): void
  onGuideNote(note: GuideNote): void
  /** Frontier decomposition plan — show subtasks in the UI. */
  onHybridPlan?(subtasks: string[], rationale: string): void
  /** Context usage after each generation — real token counts from the backend. */
  onContext?(usedTokens: number, limitTokens: number): void
  /** Memory compaction started/finished; `savedTokens` on finish. */
  onCompaction?(active: boolean, savedTokens?: number): void
}

/** Events subset needed by compaction (manual trigger passes just these). */
export type CompactionEvents = Pick<LoopEvents, 'onContext' | 'onCompaction'>

export interface LoopResult {
  ok: boolean
  summary: string
  /** Files successfully edited this turn — fallback when shadow-git diff is empty. */
  mutatedFiles?: ChangedFileStat[]
  /** Hybrid telemetry for this turn (README / diagnostics). */
  hybridStats?: HybridTurnStats
}

export interface HybridTurnStats {
  frontierCalls: number
  decomposed: boolean
  uncertaintyEscalations: number
  selfGradeConfidence: number | null
  evidenceChecks: number
}

export interface HybridTurnContext {
  /** Checkpoint sha from ChatViewProvider — used to diff for final review. */
  changedFileStats?: () => Promise<ChangedFileStat[]>
}

const MAX_HISTORY_TURNS = 40
const SELF_GRADE_THRESHOLD = 0.55
/** Compact memory when the estimated context passes this share of the window. */
const COMPACT_THRESHOLD = 0.75
/** Recent turns kept verbatim through a compaction. */
const KEEP_RECENT_TURNS = 8

/** Context window we budget against: daemon knows its length; API backends assume 32k. */
function contextLimit(): number {
  const cfg = readConfig()
  return cfg.backend === 'daemon' ? Math.max(2048, cfg.daemon.contextLength) : 32768
}

/** Cheap token estimate (~4 chars/token) plus per-turn overhead. */
function estimateTokens(turns: readonly ChatTurn[]): number {
  let total = 0
  for (const turn of turns) total += Math.ceil(turn.content.length / 4) + 8
  return total
}

export class AgentSession {
  private turns: ChatTurn[] = []
  private cachedTokenEstimate = 0
  private todo: string[] = []
  private done: string[] = []
  private started = false
  private callId = 0
  private mode: AgentMode = 'code'
  /** Whether any mutating tool succeeded this turn — fed to the hybrid final review. */
  private mutatedThisTurn = false
  /** Trivial conversational turns never spend frontier tokens, even if the local model stumbles. */
  private hybridEligibleThisTurn = true

  constructor(
    private readonly root: string,
    private readonly workspaceName: string,
    private readonly frontier: FrontierAssist,
  ) {}

  reset(): void {
    this.turns = []
    this.cachedTokenEstimate = 0
    this.todo = []
    this.done = []
    this.started = false
  }

  /** Raw LLM turns, for chat-history persistence. */
  exportTurns(): ChatTurn[] {
    return [...this.turns]
  }

  /** Rehydrate a persisted chat so the conversation can continue in context. */
  restoreTurns(turns: ChatTurn[]): void {
    this.turns = [...turns]
    this.cachedTokenEstimate = estimateTokens(this.turns)
    this.started = turns.length > 0
    this.todo = []
    this.done = []
  }

  async runTurn(
    task: string,
    mode: AgentMode,
    client: InferenceClient,
    params: GenerationParams,
    maxCalls: number,
    events: LoopEvents,
    signal: AbortSignal,
    hybridCtx?: HybridTurnContext,
  ): Promise<LoopResult> {
    this.frontier.resetTurn()
    const tools = new WorkspaceTools(this.root)
    this.mode = mode
    this.hybridEligibleThisTurn = !isTrivialConversation(task)
    const uncertainty = new HybridUncertaintyTracker()
    const hybridStats: HybridTurnStats = {
      frontierCalls: 0,
      decomposed: false,
      uncertaintyEscalations: 0,
      selfGradeConfidence: null,
      evidenceChecks: 0,
    }
    let uncertaintyEscalated = false
    const searchNote = webSearchTaskNote(task)

    if (!this.started) {
      const workspaceContext = buildWorkspaceContext(this.root, this.workspaceName)
      this.turns.push({ role: 'system', content: agentSystemPrompt(mode) })
      this.turns.push({ role: 'user', content: agentUserPrompt(task, workspaceContext, searchNote) })
      this.started = true
      await this.maybeDecompose(task, workspaceContext, mode, events, hybridStats)
} else {
      this.turns[0] = { role: 'system', content: agentSystemPrompt(mode) }
      const userTurn: ChatTurn = {
        role: 'user',
        content: searchNote ? `Task: ${task}\n\n${searchNote}` : `Task: ${task}`,
      };
      this.turns.push(userTurn);
      this.cachedTokenEstimate += Math.ceil(userTurn.content.length / 4) + 8;
    }

    let webSearchUsedThisTurn = await this.maybePrefetchWebSearch(task, tools, events)

    let consecutiveFailures = 0
    this.mutatedThisTurn = false
    const mutatedFiles: ChangedFileStat[] = []

    for (let i = 0; i < maxCalls; i++) {
      if (signal.aborted) return { ok: false, summary: 'Stopped.', hybridStats }

      await this.compactIfNeeded(client, params, events, signal)

      events.onGenerating(true)
      let raw: string
      let genResult: Awaited<ReturnType<InferenceClient['generate']>>
      try {
        genResult = await client.generate(this.windowedTurns(), params, () => {}, signal)
        raw = genResult.text
      } finally {
        events.onGenerating(false)
      }
      if (genResult.tokensIn > 0) {
        events.onContext?.(genResult.tokensIn + genResult.tokensOut, contextLimit())
      }

      const parsed = parseToolCall(raw)
      const parsedOk = !('error' in parsed)
      uncertainty.noteGeneration(
        {
          ...genResult,
          uncertainty: genResult.uncertainty ?? heuristicUncertainty(raw, parsedOk),
        },
        raw,
        parsedOk,
      )
      if (!parsedOk) uncertainty.noteMalformed()

      if (
        !uncertaintyEscalated &&
        this.hybridEligibleThisTurn &&
        uncertainty.shouldEscalate() &&
        this.frontier.enabled()
      ) {
        uncertaintyEscalated = true
        hybridStats.uncertaintyEscalations++
        await this.consultFrontier('uncertainty', events, hybridStats, {
          uncertainty: uncertainty.snapshot(),
        })
      }

      if ('error' in parsed) {
        consecutiveFailures++
        if (consecutiveFailures >= 3) {
          return {
            ok: false,
            summary: `The model kept producing malformed output: ${parsed.error}`,
            hybridStats,
          }
        }
        await this.maybeStuckHint(consecutiveFailures, events, hybridStats)
        const assistantTurn: ChatTurn = { role: 'assistant', content: raw.slice(0, 2000) };
        this.turns.push(assistantTurn);
        this.cachedTokenEstimate += Math.ceil(assistantTurn.content.length / 4) + 8;
                    const userTurn: ChatTurn = { role: 'user', content: repairTurn(parsed.error) };
        this.turns.push(userTurn);
        this.cachedTokenEstimate += Math.ceil(userTurn.content.length / 4) + 8;
        continue
      }

      const call = parsed
      uncertainty.noteToolCall(call)
      this.turns.push({ role: 'assistant', content: JSON.stringify(call) })
      const id = ++this.callId

      if (call.tool === 'step_complete' || call.tool === 'step_failed') {
        if (
          call.tool === 'step_complete' &&
          taskNeedsWebSearch(task) &&
          isWebSearchConfigured(readConfig()) &&
          !webSearchUsedThisTurn
        ) {
          const userTurn: ChatTurn = {
            role: 'user',
            content: toolResultTurn(
              'step_complete',
              false,
              'Refused: this task needs web_search first. Call web_search with a focused query, then step_complete with titles and full URLs from the results.',
            ),
          };
this.turns.push(userTurn);
this.cachedTokenEstimate += Math.ceil(userTurn.content.length / 4) + 8;
          consecutiveFailures++
          continue
        }
        if (
          call.tool === 'step_complete' &&
          mode === 'code' &&
          taskExpectsCodeChanges(task) &&
          !this.mutatedThisTurn
        ) {
          const userTurn: ChatTurn = {
            role: 'user',
            content: toolResultTurn(
              'step_complete',
              false,
              'Refused: this task requires file edits but edit_file/write_file has not succeeded yet. Make the changes, then call step_complete — do not claim changes in summary without a successful edit.',
            ),
          };
this.turns.push(userTurn);
this.cachedTokenEstimate += Math.ceil(userTurn.content.length / 4) + 8;
          consecutiveFailures++
          continue
        }
        const ok = call.tool === 'step_complete'
        const summary =
          (typeof call.args['summary'] === 'string' && (call.args['summary'] as string)) ||
          (typeof call.args['reason'] === 'string' && (call.args['reason'] as string)) ||
          (ok ? 'Done.' : 'Failed.')
        if (
          call.tool === 'step_complete' &&
          mode === 'code' &&
          !this.mutatedThisTurn &&
          summaryClaimsFileChanges(summary)
        ) {
          const userTurn: ChatTurn = {
            role: 'user',
            content: toolResultTurn(
              'step_complete',
              false,
              'Refused: your summary claims files were changed but edit_file/write_file did not succeed this turn. Actually edit the files first, then summarize what changed.',
            ),
          };
          this.turns.push(userTurn);
          this.cachedTokenEstimate += Math.ceil(userTurn.content.length / 4) + 8;
          consecutiveFailures++
          continue
        }
        if (ok) {
          await this.finishWithHybridReview(
            client,
            params,
            signal,
            events,
            hybridStats,
            hybridCtx,
          )
        }
        return { ok, summary, mutatedFiles: mutatedFiles.length > 0 ? mutatedFiles : undefined, hybridStats }
      }

      if (call.tool === 'update_todos') {
        this.todo = Array.isArray(call.args['todo'])
          ? (call.args['todo'] as unknown[]).filter((t): t is string => typeof t === 'string')
          : []
        this.done = Array.isArray(call.args['done'])
          ? (call.args['done'] as unknown[]).filter((t): t is string => typeof t === 'string')
          : []
        events.onTodos(this.todo, this.done)
        this.turns.push({ role: 'user', content: toolResultTurn('update_todos', true, 'Todo list updated.') })
        consecutiveFailures = 0
        continue
      }

      const spec0 = TOOL_SPECS.find((t) => t.name === call.tool)
      if (spec0?.mutating && isReadOnlyMode(this.mode)) {
        const modeName = this.mode === 'plan' ? 'PLAN' : 'ASK'
        this.turns.push({
          role: 'user',
          content: toolResultTurn(
            call.tool,
            false,
            `Refused: ${call.tool} modifies the workspace, but you are in ${modeName} mode (read-only). Finish with step_complete instead.`,
          ),
        })
        consecutiveFailures++
        if (consecutiveFailures >= 4) {
          return {
            ok: false,
            summary: `Stopped: the model kept trying to modify files in ${modeName.toLowerCase()} mode. Switch to Code mode to make changes.`,
            hybridStats,
          }
        }
        continue
      }

      events.onToolCall(id, call, summarizeArgs(call))
      const outcome = await tools.execute(call)
      events.onToolResult(id, outcome.ok, outcome.uiSummary, outcome.viaTrie, outcome.trieMs, outcome.scanMs)
      this.turns.push({ role: 'user', content: toolResultTurn(call.tool, outcome.ok, outcome.result) })

      if (call.tool === 'web_search') webSearchUsedThisTurn = true

      const spec = TOOL_SPECS.find((t) => t.name === call.tool)
      if (outcome.ok && spec?.mutating) {
        this.mutatedThisTurn = true
        const relPath = toolGroupKey(call)
        if (relPath) {
          const delta = toolLineDelta(call)
          const existing = mutatedFiles.find((f) => f.path === relPath)
          if (existing) {
            existing.added += delta.added
            existing.deleted += delta.deleted
          } else {
            mutatedFiles.push({ path: relPath, ...delta })
          }
        }
      }

      if (outcome.ok) {
        consecutiveFailures = 0
      } else {
        consecutiveFailures++
        if (consecutiveFailures >= 2) await this.maybeStuckHint(consecutiveFailures, events, hybridStats)
        if (consecutiveFailures >= 4) {
          return {
            ok: false,
            summary: `Stopped after repeated tool failures (last: ${outcome.uiSummary})`,
            hybridStats,
          }
        }
      }
    }

    return {
      ok: false,
      summary: `Stopped: the agent used all ${maxCalls} tool calls without finishing. You can raise trie-ide.agent.maxToolCalls or continue with a follow-up message.`,
      mutatedFiles: mutatedFiles.length > 0 ? mutatedFiles : undefined,
      hybridStats,
    }
  }

  /** Estimated tokens currently in the conversation (chars/4 heuristic). */
  estimatedContextTokens(): number {
    return estimateTokens(this.turns)
  }

  private async compactIfNeeded(
    client: InferenceClient,
    params: GenerationParams,
    events: CompactionEvents,
    signal: AbortSignal,
  ): Promise<void> {
    if (estimateTokens(this.turns) < contextLimit() * COMPACT_THRESHOLD) return
    await this.compactNow(client, params, events, signal)
  }

  /**
   * Memory compaction: summarize everything between the system prompt and the
   * last few turns with the local model, then splice the summary in their
   * place. Falls back to hard truncation if summarization fails.
   */
  async compactNow(
    client: InferenceClient,
    params: GenerationParams,
    events: CompactionEvents,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.turns.length < KEEP_RECENT_TURNS + 4) return
    const before = estimateTokens(this.turns)
    events.onCompaction?.(true)
    const head = this.turns[0]
    const middle = this.turns.slice(1, -KEEP_RECENT_TURNS)
    const tail = this.turns.slice(-KEEP_RECENT_TURNS)
    let summaryTurn: ChatTurn
    try {
      const transcript = middle
        .map((t) => `[${t.role}] ${t.content}`)
        .join('\n')
        .slice(0, 24_000)
      const res = await client.generate(
        [
          {
            role: 'system',
            content:
              'Summarize this coding-agent transcript in under 300 words. Keep: the original task, files read/edited (exact paths), key findings, decisions made, and current todo state. Drop: raw file contents, tool call syntax, repeated attempts. Write plain prose.',
          },
          { role: 'user', content: transcript },
        ],
        { ...params, temperature: 0.1, maxTokens: 512 },
        () => {},
        signal,
      )
      const summary = res.text.trim()
      if (!summary) throw new Error('empty summary')
      summaryTurn = {
        role: 'user',
        content: `[Memory compacted] Summary of the earlier conversation:\n${summary}`,
      }
    } catch {
      summaryTurn = {
        role: 'user',
        content:
          '[Memory compacted] Older turns were dropped to fit the context window. Re-read files if earlier details are needed.',
      }
    }
    this.turns = [head, summaryTurn, ...tail]
    const after = estimateTokens(this.turns)
    events.onCompaction?.(false, Math.max(0, before - after))
    events.onContext?.(after, contextLimit())
  }

  /** Auto-run web_search when the task clearly needs external info — local models often skip it. */
  private async maybePrefetchWebSearch(
    task: string,
    tools: WorkspaceTools,
    events: LoopEvents,
  ): Promise<boolean> {
    if (!isWebSearchConfigured(readConfig()) || !taskNeedsWebSearch(task)) return false

    const call: ToolCall = {
      thought: 'Searching the web for sources relevant to this question.',
      tool: 'web_search',
      args: { query: buildWebSearchQuery(task) },
    }
    const id = ++this.callId
    events.onToolCall(id, call, summarizeArgs(call))
    const outcome = await tools.execute(call)
    events.onToolResult(id, outcome.ok, outcome.uiSummary, outcome.viaTrie, outcome.trieMs, outcome.scanMs)
    this.turns.push({ role: 'assistant', content: JSON.stringify(call) })
    this.turns.push({ role: 'user', content: toolResultTurn('web_search', outcome.ok, outcome.result) })
    return true
  }

  private async maybeDecompose(
    task: string,
    workspaceContext: string,
    mode: AgentMode,
    events: LoopEvents,
    stats: HybridTurnStats,
  ): Promise<void> {
    if (
      mode !== 'code' ||
      !this.hybridEligibleThisTurn ||
      !this.frontier.enabled() ||
      !shouldDecompose(task, 0)
    ) return
    events.onHybridChecking(true, 'decompose')
    try {
      const plan = await frontierDecompose(task, workspaceContext, () => readConfig().frontierAssist)
      if (!plan) return
      stats.decomposed = true
      stats.frontierCalls++
      events.onHybridPlan?.(plan.subtasks, plan.rationale)
      this.turns.push({ role: 'user', content: formatDecomposeInjection(plan) })
    } finally {
      events.onHybridChecking(false, 'decompose')
    }
  }

  private async finishWithHybridReview(
    client: InferenceClient,
    params: GenerationParams,
    signal: AbortSignal,
    events: LoopEvents,
    stats: HybridTurnStats,
    hybridCtx?: HybridTurnContext,
  ): Promise<void> {
    if (!this.hybridEligibleThisTurn || !this.frontier.enabled()) return

    const grade = await localSelfGrade(client, this.windowedTurns(), params, signal)
    if (grade) {
      stats.selfGradeConfidence = grade.confidence
      if (grade.confidence < SELF_GRADE_THRESHOLD) {
        if (this.mutatedThisTurn) {
          await this.maybeFinalReview(events, stats, hybridCtx)
        } else {
          await this.consultFrontier('self_grade', events, stats, { selfGrade: grade })
        }
      }
      return
    }

    // If the local model could not produce a grade, only escalate completed
    // workspace changes. Plain answers do not justify a speculative cloud call.
    if (this.mutatedThisTurn) await this.maybeFinalReview(events, stats, hybridCtx)
  }

  private windowedTurns(): ChatTurn[] {
    if (this.turns.length <= MAX_HISTORY_TURNS + 2) return this.turns
    return [...this.turns.slice(0, 2), ...this.turns.slice(-(MAX_HISTORY_TURNS))]
  }

  private transcriptTail(): string {
    return this.turns
      .slice(-16)
      .map((t) => `[${t.role}] ${t.content.slice(0, 700)}`)
      .join('\n')
  }

  private async consultFrontier(
    checkpoint: GuideNote['checkpoint'],
    events: LoopEvents,
    stats: HybridTurnStats,
    extra: {
      evidence?: string
      selfGrade?: { confidence: number; concerns: string }
      uncertainty?: number
    } = {},
  ): Promise<void> {
    events.onHybridChecking(true, checkpoint)
    let note: GuideNote | null = null
    try {
      note = await this.frontier.consult(checkpoint, {
        transcript: this.transcriptTail(),
        ...extra,
      })
      if (note) stats.frontierCalls++
    } finally {
      events.onHybridChecking(false, checkpoint)
    }
    if (!note) return
    events.onGuideNote(note)
    // An empty note (e.g. "looks_good" with nothing to add) is shown in the
    // UI but injecting a blank advisory into the conversation helps nobody.
    if (note.text.trim()) {
      this.turns.push({
        role: 'user',
        content: `Guide note from a senior reviewer (advisory): ${note.text}`,
      })
    }
  }

  private async maybeStuckHint(
    consecutiveFailures: number,
    events: LoopEvents,
    stats: HybridTurnStats,
  ): Promise<void> {
    if (
      consecutiveFailures < 2 ||
      !this.hybridEligibleThisTurn ||
      !this.frontier.enabled()
    ) return
    await this.consultFrontier('stuck_hint', events, stats)
  }

  private async maybeFinalReview(
    events: LoopEvents,
    stats: HybridTurnStats,
    hybridCtx?: HybridTurnContext,
  ): Promise<void> {
    if (!this.frontier.enabled()) return

    let evidenceBlock: string | undefined
    if (this.mutatedThisTurn && hybridCtx?.changedFileStats) {
      try {
        const files = await hybridCtx.changedFileStats()
        stats.evidenceChecks = files.length
        const evidence = await gatherReviewEvidence(this.root, files)
        evidenceBlock = formatEvidenceForFrontier(evidence)
      } catch {
        /* evidence is best-effort */
      }
    }

    await this.consultFrontier('final_review', events, stats, { evidence: evidenceBlock })
  }
}

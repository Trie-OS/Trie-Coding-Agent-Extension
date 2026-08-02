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
import type { ChatTurn, ChatTurnImage, GenerationParams, InferenceClient } from '../inference/types'
import { isWebSearchConfigured, readConfig } from '../config'
import type { ChangedFileStat } from './checkpoints'
import {
  collectPreviousUserTasks,
  COMPACTION_SUMMARY_PROMPT,
  dropOldestRound,
  estimateTokens,
  extractSummary,
  KEEP_RECENT_TURNS,
  renderCompactionEnvelope,
} from './compaction'
import { buildWorkspaceContext } from './context'
import { PersistentPermissionStore } from './permissions'
import { clearScratchpad, ensureScratchpad } from './scratchpad'
import {
  formatDecomposeInjection,
  frontierDecompose,
  shouldDecompose,
} from './hybridDecompose'
import { formatEvidenceForFrontier, gatherReviewEvidence } from './hybridEvidence'
import { localSelfGrade } from './hybridSelfGrade'
import { heuristicUncertainty, HybridUncertaintyTracker } from './hybridUncertainty'
import { FrontierAssist, type GuideNote } from './frontierAssist'
import { HookManager } from './hooks'
import { PlanSession } from './planSession'
import { PermissionBroker } from './permissionBroker'
import { QuestionBroker } from './questionBroker'
import {
  agentSystemPrompt,
  agentUserPrompt,
  buildTaskNotes,
  isPlanAllowedMutatingTool,
  isReadOnlyMode,
  repairTurn,
  toolResultTurn,
  type AgentMode,
} from './prompts'
import {
  buildWebSearchQuery,
  taskNeedsWebSearch,
} from './webSearchIntent'
import {
  isLazyStepCompleteSummary,
  isTrivialConversation,
  NewFeatureDiscoveryGuard,
  StuckRecoveryGate,
  taskAsksForRecommendations,
  taskExpectsCodeChanges,
  taskNeedsCodebaseExploration,
  summaryClaimsFileChanges,
} from './taskIntent'
import {
  finishRecommendationAnswer,
  isObviouslyFailedRecommendationDraft,
} from './recommendationAnswer'
import { VerificationTracker, verificationPolicy } from './verificationPolicy'
import type { MultitaskBus } from './multitaskBus'
import {
  parseToolCall,
  summarizeArgs,
  TOOL_SPECS,
  toolGroupKey,
  toolLineDelta,
  WorkspaceTools,
  type ToolCall,
  type ToolOutcome,
} from './tools'

export interface MultitaskSessionOptions {
  agentId: string
  agentName: string
  bus: MultitaskBus
  /** Skip MinionS frontier decompose — Multitask roles are already scoped. */
  skipDecompose?: boolean
  onBusActivity?: (summary: string) => void
}

export interface LoopEvents {
  onGenerating(active: boolean): void
  onReasoningChunk?(text: string): void
  onReasoningDone?(): void
  onToolCall(id: number, call: ToolCall, argsSummary: string): void
  onToolResult(
    id: number,
    ok: boolean,
    summary: string,
    viaTrie?: boolean,
    trieMs?: number,
    scanMs?: number,
    detail?: string,
    userSkipped?: boolean,
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
  onCompaction?(active: boolean, savedTokens?: number, keptTurns?: number): void
  /** Plan mode handoff — user approves switching to Code. */
  onPlanHandoff?(payload: { path: string; content: string }): Promise<'execute' | 'stay'>
}

export interface PlanExecutePayload {
  path: string
  content: string
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
  /** User approved plan — host should enqueue a Code turn. */
  planExecute?: PlanExecutePayload
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
const GENERATION_TIMEOUT_MS = 3 * 60 * 1000
/** Compact memory when the estimated context passes this share of the window. */
const COMPACT_THRESHOLD = 0.75
const STALL_GUARD_CALLS = 6
const STALL_GUARD_MAX_NUDGES = 2

/** Context window we budget against: daemon knows its length; API backends assume 32k. */
function contextLimit(): number {
  const cfg = readConfig()
  return cfg.backend === 'daemon' ? Math.max(2048, cfg.daemon.contextLength) : 32768
}

const UI_TOOL_DETAIL_MAX = 4000

function toolUiDetail(result: string): string | undefined {
  const trimmed = result.trim()
  if (!trimmed) return undefined
  return trimmed.length <= UI_TOOL_DETAIL_MAX
    ? trimmed
    : trimmed.slice(0, UI_TOOL_DETAIL_MAX) + '\n…'
}

export async function generateWithTimeout(
  client: InferenceClient,
  turns: ChatTurn[],
  params: GenerationParams,
  onToken: (text: string) => void,
  signal: AbortSignal,
  timeoutMs = GENERATION_TIMEOUT_MS,
): Promise<Awaited<ReturnType<InferenceClient['generate']>>> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), timeoutMs)
  const combined = AbortSignal.any([signal, timeout.signal])
  try {
    return await client.generate(turns, params, onToken, combined)
  } catch (error) {
    if (timeout.signal.aborted && !signal.aborted) {
      const cancellable = client as InferenceClient & { cancel?: () => Promise<void> }
      await cancellable.cancel?.().catch(() => {})
      throw new Error(
        `Generation timed out after ${Math.round(timeoutMs / 1000)} seconds. The turn was stopped instead of leaving the agent active indefinitely.`,
      )
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
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
  /** One sparse Hybrid recovery per stuck episode/turn. */
  private readonly stuckRecovery = new StuckRecoveryGate()
  private multitask: MultitaskSessionOptions | null = null
  private readonly multitaskCursor = { value: 0 }
  /** Session-scoped shell approvals (Allow once / for session). */
  readonly permissions: PersistentPermissionStore
  readonly questionBroker = new QuestionBroker()
  readonly permissionBroker = new PermissionBroker()
  readonly planSession: PlanSession
  readonly hooks: HookManager
  /** Stable id for scratchpad paths; set by the chat host. */
  private sessionId = 'default'
  /** Last backend-reported token count (preferred for compaction threshold). */
  private lastReportedTokens = 0

  constructor(
    private readonly root: string,
    private readonly workspaceName: string,
    private readonly frontier: FrontierAssist,
  ) {
    this.planSession = new PlanSession(root)
    this.permissions = new PersistentPermissionStore(root)
    this.hooks = new HookManager(root)
  }

  get workspaceRoot(): string {
    return this.root
  }

  setSessionId(id: string): void {
    this.sessionId = id
  }

  getSessionId(): string {
    return this.sessionId
  }

  configureMultitask(options: MultitaskSessionOptions | null): void {
    this.multitask = options
    this.multitaskCursor.value = 0
  }

  reset(): void {
    clearScratchpad(this.root, this.sessionId)
    this.turns = []
    this.cachedTokenEstimate = 0
    this.todo = []
    this.done = []
    this.started = false
    this.permissions.clear()
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

  /**
   * Rewind model history to a prior boundary (used with checkpoint file restore).
   * Keeps the system prompt when present; clears todos.
   */
  rewindTurns(toLength: number): void {
    const keep = Math.max(0, Math.min(toLength, this.turns.length))
    this.turns = this.turns.slice(0, keep)
    this.cachedTokenEstimate = estimateTokens(this.turns)
    this.started = this.turns.length > 0
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
    turnImages?: ChatTurnImage[],
  ): Promise<LoopResult> {
    this.frontier.resetTurn()
    ensureScratchpad(this.root, this.sessionId)
    const tools = new WorkspaceTools(
      this.root,
      this.multitask
        ? {
            agentId: this.multitask.agentId,
            agentName: this.multitask.agentName,
            bus: this.multitask.bus,
            cursor: this.multitaskCursor,
            onActivity: this.multitask.onBusActivity,
          }
        : undefined,
      {
        permissions: this.permissions,
        sessionId: this.sessionId,
        questionBroker: this.questionBroker,
        permissionBroker: this.permissionBroker,
        planSession: mode === 'plan' ? this.planSession : undefined,
        profile: readConfig().agent.profile,
      },
    )
    this.mode = mode
    this.hybridEligibleThisTurn = !isTrivialConversation(task)
    this.stuckRecovery.reset()
    const uncertainty = new HybridUncertaintyTracker()
    const hybridStats: HybridTurnStats = {
      frontierCalls: 0,
      decomposed: false,
      uncertaintyEscalations: 0,
      selfGradeConfidence: null,
      evidenceChecks: 0,
    }
    let uncertaintyEscalated = false
    // Route the prompt up front (web search, recommendations, …) so the model
    // handles the ask correctly on the first pass — not via post-hoc correction.
    const taskNotes = buildTaskNotes(task, mode)
    const promptOptions = { multitask: !!this.multitask }

    if (!this.started) {
      const workspaceContext = buildWorkspaceContext(this.root, this.workspaceName)
      this.turns.push({ role: 'system', content: agentSystemPrompt(mode, promptOptions) })
      this.turns.push({
        role: 'user',
        content: agentUserPrompt(task, workspaceContext, taskNotes),
        ...(turnImages?.length ? { images: turnImages } : {}),
      })
      this.started = true
      await this.maybeDecompose(task, workspaceContext, mode, events, hybridStats, signal)
    } else {
      this.turns[0] = { role: 'system', content: agentSystemPrompt(mode, promptOptions) }
      const userTurn: ChatTurn = {
        role: 'user',
        content: taskNotes ? `Task: ${task}\n\n${taskNotes}` : `Task: ${task}`,
        ...(turnImages?.length ? { images: turnImages } : {}),
      }
      this.turns.push(userTurn)
      this.cachedTokenEstimate += Math.ceil(userTurn.content.length / 4) + 8
    }

    let webSearchUsedThisTurn = await this.maybePrefetchWebSearch(task, tools, events)
    let exploredThisTurn = webSearchUsedThisTurn
    const webSearchAllowedThisTurn = taskNeedsWebSearch(task)
    const featureDiscovery = new NewFeatureDiscoveryGuard(task)
    const explorationTools = new Set([
      'read_file',
      'list_dir',
      'glob',
      'grep',
      'search_symbols',
      'web_search',
    ])

    let consecutiveFailures = 0
    let callsSinceProgress = 0
    let stallNudges = 0
    this.mutatedThisTurn = false
    const mutatedFiles: ChangedFileStat[] = []
    const verification = new VerificationTracker()

    for (let i = 0; i < maxCalls; i++) {
      if (signal.aborted) return { ok: false, summary: 'Stopped.', hybridStats }

      await this.compactIfNeeded(client, params, events, signal)

      events.onGenerating(true)
      let raw = ''
      let genResult: Awaited<ReturnType<InferenceClient['generate']>> | undefined
      let generationError: unknown
      try {
        genResult = await generateWithTimeout(
          client,
          this.windowedTurns(),
          params,
          (token) => {
            if (!token) return
            events.onReasoningChunk?.(token)
          },
          signal,
        )
        raw = genResult.text
      } catch (error) {
        generationError = error
      } finally {
        events.onGenerating(false)
        events.onReasoningDone?.()
      }
      if (generationError !== undefined) {
        const message =
          generationError instanceof Error ? generationError.message : String(generationError)
        if (
          message.startsWith('Generation timed out') &&
          await this.maybeStuckRecovery('generation_timeout', events, hybridStats)
        ) {
          continue
        }
        throw generationError
      }
      if (!genResult) throw new Error('Generation ended without a result.')
      if (genResult.tokensIn > 0) {
        this.lastReportedTokens = genResult.tokensIn + genResult.tokensOut
        events.onContext?.(this.lastReportedTokens, contextLimit())
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

      let call = parsed
      uncertainty.noteToolCall(call)
      this.turns.push({ role: 'assistant', content: JSON.stringify(call) })
      const id = ++this.callId

      if (call.tool === 'exit_plan_mode') {
        if (mode !== 'plan') {
          this.turns.push({
            role: 'user',
            content: toolResultTurn('exit_plan_mode', false, 'Refused: exit_plan_mode is only valid in Plan mode.'),
          })
          consecutiveFailures++
          continue
        }
        const planPath = tools.planSession?.relativePath
        const planContent = tools.planSession?.read()?.trim() ?? ''
        if (!planPath || planContent.length < 40) {
          this.turns.push({
            role: 'user',
            content: toolResultTurn(
              'exit_plan_mode',
              false,
              'Refused: write a substantive plan with update_plan before calling exit_plan_mode.',
            ),
          })
          consecutiveFailures++
          continue
        }
        events.onToolCall(id, call, summarizeArgs(call))
        events.onToolResult(id, true, planPath)
        const decision = events.onPlanHandoff
          ? await events.onPlanHandoff({ path: planPath, content: planContent })
          : 'stay'
        if (decision === 'execute') {
          return {
            ok: true,
            summary: 'Plan approved — implementing in Code mode.',
            hybridStats,
            planExecute: { path: planPath, content: planContent },
          }
        }
        this.turns.push({
          role: 'user',
          content: toolResultTurn(
            'exit_plan_mode',
            false,
            'User chose to stay in Plan mode. Revise the plan with update_plan if needed, then call exit_plan_mode again.',
          ),
        })
        consecutiveFailures = 0
        continue
      }

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
        let summary =
          (typeof call.args['summary'] === 'string' && (call.args['summary'] as string)) ||
          (typeof call.args['reason'] === 'string' && (call.args['reason'] as string)) ||
          (ok ? 'Done.' : 'Failed.')
        const postAgent = this.hooks.postAgent(call.tool, summary)
        if (postAgent.denied) {
          const userTurn: ChatTurn = {
            role: 'user',
            content: toolResultTurn(call.tool, false, `Refused by hook: ${postAgent.denied}`),
          }
          this.turns.push(userTurn)
          this.cachedTokenEstimate += Math.ceil(userTurn.content.length / 4) + 8
          consecutiveFailures++
          continue
        }
        summary = postAgent.summary

        // Recommendation asks: LLM-as-judge on the draft; rewrite once if needed.
        // No fixed "4–7 bullets" template — the judge scores substance.
        if (taskAsksForRecommendations(task)) {
          if (!exploredThisTurn && call.tool === 'step_complete' && summary.trim().length < 200) {
            const userTurn: ChatTurn = {
              role: 'user',
              content: toolResultTurn(
                'step_complete',
                false,
                'Refused: ground recommendations in the codebase first (read_file/grep/search_symbols), then step_complete with your advice.',
              ),
            }
            this.turns.push(userTurn)
            this.cachedTokenEstimate += Math.ceil(userTurn.content.length / 4) + 8
            consecutiveFailures++
            continue
          }
          const notes = this.transcriptTail()
          events.onGenerating(true)
          try {
            summary = await finishRecommendationAnswer(
              client,
              task,
              summary,
              notes,
              params,
              signal,
              {
                forceRewrite:
                  call.tool === 'step_failed' || isObviouslyFailedRecommendationDraft(summary),
              },
            )
          } finally {
            events.onGenerating(false)
          }
          await this.finishWithHybridReview(
            client,
            params,
            signal,
            events,
            hybridStats,
            hybridCtx,
          )
          return {
            ok: true,
            summary,
            mutatedFiles: mutatedFiles.length > 0 ? mutatedFiles : undefined,
            hybridStats,
          }
        }

        if (call.tool === 'step_complete' && isLazyStepCompleteSummary(summary)) {
          const userTurn: ChatTurn = {
            role: 'user',
            content: toolResultTurn(
              'step_complete',
              false,
              'Refused: summary is a placeholder (ellipsis/teaser). Explore the codebase or finish the answer, then call step_complete with a substantive summary.',
            ),
          }
          this.turns.push(userTurn)
          this.cachedTokenEstimate += Math.ceil(userTurn.content.length / 4) + 8
          consecutiveFailures++
          continue
        }
        if (
          call.tool === 'step_complete' &&
          taskNeedsCodebaseExploration(task) &&
          !exploredThisTurn &&
          summary.trim().length < 200
        ) {
          const userTurn: ChatTurn = {
            role: 'user',
            content: toolResultTurn(
              'step_complete',
              false,
              'Refused: this task needs codebase exploration first. Use read_file, grep, or search_symbols to inspect the project, then call step_complete with detailed recommendations.',
            ),
          }
          this.turns.push(userTurn)
          this.cachedTokenEstimate += Math.ceil(userTurn.content.length / 4) + 8
          consecutiveFailures++
          continue
        }
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
        if (call.tool === 'step_complete' && mode === 'code' && this.mutatedThisTurn) {
          const policy = verificationPolicy(
            task,
            mutatedFiles.map((file) => file.path),
          )
          const reminder = verification.takeCompletionNudge(policy)
          if (reminder) {
            const userTurn: ChatTurn = {
              role: 'user',
              content: toolResultTurn('step_complete', false, `Refused once: ${reminder}`),
            }
            this.turns.push(userTurn)
            this.cachedTokenEstimate += Math.ceil(userTurn.content.length / 4) + 8
            continue
          }
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
      if (spec0?.mutating && readConfig().agent.profile === 'explore') {
        this.turns.push({
          role: 'user',
          content: toolResultTurn(
            call.tool,
            false,
            `Refused: profile "explore" is read-first and blocks mutating tools. Switch trie-ide.agent.profile to default/accept-edits/auto-approve for edits.`,
          ),
        })
        consecutiveFailures++
        continue
      }
      if (spec0?.mutating && isReadOnlyMode(this.mode) && !isPlanAllowedMutatingTool(call.tool)) {
        const modeName = this.mode === 'plan' ? 'PLAN' : 'ASK'
        this.turns.push({
          role: 'user',
          content: toolResultTurn(
            call.tool,
            false,
            `Refused: ${call.tool} modifies the workspace, but you are in ${modeName} mode. Use update_plan in Plan mode, or switch to Code mode.`,
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

      const preHook = this.hooks.preTool(call)
      call = preHook.rewritten
      if (explorationTools.has(call.tool)) exploredThisTurn = true

      events.onToolCall(id, call, summarizeArgs(call))
      const localSearchQuery =
        call.tool === 'search_symbols' && typeof call.args['query'] === 'string'
          ? call.args['query']
          : call.tool === 'grep' && typeof call.args['pattern'] === 'string'
            ? call.args['pattern']
            : null
      const repeatedFeatureSearch =
        localSearchQuery === null ? null : featureDiscovery.beforeSearch(localSearchQuery)
      let outcome: ToolOutcome =
        preHook.denied
          ? {
              ok: false,
              result: `Error: ${preHook.denied}`,
              uiSummary: 'denied by hook',
            }
        : repeatedFeatureSearch !== null
          ? {
              ok: true,
              result: repeatedFeatureSearch,
              uiSummary: 'pivot to integration points',
            }
          : call.tool === 'web_search' && !webSearchAllowedThisTurn
          ? {
              ok: false,
              result:
                'Web search denied for this turn: the active user request does not require external/current factual information and did not explicitly ask to search, research, or browse the web. Continue from repository files, local package types, and local documentation. A local search returning no matches does not authorize internet access.',
              uiSummary: 'denied by task intent',
            }
          : await tools.execute(call)
      outcome = this.hooks.postTool(call, outcome)
      if (localSearchQuery !== null && repeatedFeatureSearch === null) {
        outcome = {
          ...outcome,
          result: featureDiscovery.afterSearch(localSearchQuery, outcome.result),
        }
      }
      events.onToolResult(
        id,
        outcome.ok,
        outcome.uiSummary,
        outcome.viaTrie,
        outcome.trieMs,
        outcome.scanMs,
        outcome.uiDetail ?? toolUiDetail(outcome.result),
        outcome.userSkipped,
      )
      this.turns.push({ role: 'user', content: toolResultTurn(call.tool, outcome.ok, outcome.result) })

      const progressTool =
        call.tool === 'edit_file' ||
        call.tool === 'write_file' ||
        call.tool === 'run_command' ||
        call.tool === 'run_verification' ||
        call.tool === 'update_todos' ||
        call.tool === 'ask_user_question'
      if (outcome.ok && progressTool) {
        callsSinceProgress = 0
      } else {
        callsSinceProgress += 1
      }
      if (
        mode === 'code' &&
        stallNudges < STALL_GUARD_MAX_NUDGES &&
        callsSinceProgress >= STALL_GUARD_CALLS
      ) {
        const guard: ChatTurn = {
          role: 'user',
          content: toolResultTurn(
            call.tool,
            false,
            'Stall guard: progress is unclear after several tool calls. Narrow scope now: update_todos with 2-5 concrete steps OR ask_user_question to resolve ambiguity, then execute one step end-to-end.',
          ),
        }
        this.turns.push(guard)
        this.cachedTokenEstimate += Math.ceil(guard.content.length / 4) + 8
        callsSinceProgress = 0
        stallNudges += 1
      }

      if (call.tool === 'web_search' && outcome.ok) webSearchUsedThisTurn = true
      if (
        repeatedFeatureSearch !== null ||
        /Feature-existence discovery is complete/i.test(outcome.result)
      ) {
        await this.maybeStuckRecovery('feature_discovery', events, hybridStats)
      } else if (call.tool === 'web_search' && !webSearchAllowedThisTurn) {
        await this.maybeStuckRecovery('web_search_denied', events, hybridStats)
      }

      if (
        outcome.ok &&
        (call.tool === 'edit_file' || call.tool === 'write_file' || call.tool === 'run_command')
      ) {
        this.mutatedThisTurn = true
        verification.noteMutation()
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
      if (outcome.ok && call.tool === 'run_verification') {
        const skipReason = call.args['skipReason']
        verification.noteVerification(typeof skipReason === 'string' && Boolean(skipReason.trim()))
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

  /** Estimated tokens currently in the conversation. */
  estimatedContextTokens(): number {
    return this.lastReportedTokens > 0 ? this.lastReportedTokens : estimateTokens(this.turns)
  }

  private async compactIfNeeded(
    client: InferenceClient,
    params: GenerationParams,
    events: CompactionEvents,
    signal: AbortSignal,
  ): Promise<void> {
    const used = this.estimatedContextTokens()
    if (used < contextLimit() * COMPACT_THRESHOLD) return
    await this.compactNow(client, params, events, signal)
  }

  /**
   * Transactional memory compaction (Vibe-style): summarize a *copy* of history,
   * preserve recent user tasks verbatim, and only replace live turns on success.
   * On summarizer failure, drop whole oldest rounds until under budget — never
   * leave a half-mutated transcript.
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
    let committed = false
    try {
      const head = this.turns[0]
      const middle = this.turns.slice(1, -KEEP_RECENT_TURNS)
      const tail = this.turns.slice(-KEEP_RECENT_TURNS)
      const previousTasks = collectPreviousUserTasks(middle)
      let summary: string | null = null
      try {
        const transcript = middle
          .map((t) => `[${t.role}] ${t.content}`)
          .join('\n')
          .slice(0, 24_000)
        const res = await client.generate(
          [
            { role: 'system', content: COMPACTION_SUMMARY_PROMPT },
            { role: 'user', content: transcript },
          ],
          { ...params, temperature: 0.1, maxTokens: 512 },
          () => {},
          signal,
        )
        summary = extractSummary(res.text)
      } catch {
        summary = null
      }

      let next: ChatTurn[]
      if (summary) {
        next = [
          head,
          { role: 'user', content: renderCompactionEnvelope(summary, previousTasks) },
          ...tail,
        ]
      } else {
        // Fallback: drop oldest rounds on a copy until under threshold or stuck.
        let candidate = [...this.turns]
        const limit = contextLimit() * COMPACT_THRESHOLD
        while (estimateTokens(candidate) > limit) {
          const dropped = dropOldestRound(candidate)
          if (!dropped) break
          candidate = dropped
        }
        if (candidate.length >= this.turns.length) {
          // Nothing to reclaim — leave live history untouched.
          return
        }
        next = candidate
      }

      // Commit only after a successful candidate is built.
      this.turns = next
      this.lastReportedTokens = 0
      this.cachedTokenEstimate = estimateTokens(this.turns)
      const after = this.cachedTokenEstimate
      committed = true
      events.onCompaction?.(false, Math.max(0, before - after), KEEP_RECENT_TURNS)
      events.onContext?.(after, contextLimit())
    } finally {
      if (!committed) events.onCompaction?.(false)
    }
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
    events.onToolResult(
      id,
      outcome.ok,
      outcome.uiSummary,
      outcome.viaTrie,
      outcome.trieMs,
      outcome.scanMs,
      outcome.uiDetail ?? toolUiDetail(outcome.result),
      outcome.userSkipped,
    )
    this.turns.push({ role: 'assistant', content: JSON.stringify(call) })
    this.turns.push({ role: 'user', content: toolResultTurn('web_search', outcome.ok, outcome.result) })
    return outcome.ok
  }

  private async maybeDecompose(
    task: string,
    workspaceContext: string,
    mode: AgentMode,
    events: LoopEvents,
    stats: HybridTurnStats,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      mode !== 'code' ||
      this.multitask?.skipDecompose ||
      !this.hybridEligibleThisTurn ||
      !this.frontier.enabled() ||
      !shouldDecompose(task, 0)
    ) return
    events.onHybridChecking(true, 'decompose')
    try {
      const plan = await frontierDecompose(
        task,
        workspaceContext,
        () => readConfig().frontierAssist,
        signal,
      )
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
  ): Promise<boolean> {
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
    if (!note) return false
    events.onGuideNote(note)
    // An empty note (e.g. "looks_good" with nothing to add) is shown in the
    // UI but injecting a blank advisory into the conversation helps nobody.
    if (note.text.trim()) {
      this.turns.push({
        role: 'user',
        content: `Guide note from a senior reviewer (advisory): ${note.text}`,
      })
    }
    return true
  }

  private async maybeStuckRecovery(
    reason: 'feature_discovery' | 'web_search_denied' | 'generation_timeout',
    events: LoopEvents,
    stats: HybridTurnStats,
  ): Promise<boolean> {
    if (
      !this.hybridEligibleThisTurn ||
      !this.stuckRecovery.claim(this.frontier.enabled())
    ) return false
    return this.consultFrontier('stuck_hint', events, stats, {
      evidence: `Recovery trigger: ${reason.replaceAll('_', ' ')}. Give a concrete repository-local next step that moves this task toward implementation.`,
    })
  }

  private async maybeStuckHint(
    consecutiveFailures: number,
    events: LoopEvents,
    stats: HybridTurnStats,
  ): Promise<void> {
    if (consecutiveFailures < 2) return
    if (
      !this.hybridEligibleThisTurn ||
      !this.stuckRecovery.claim(this.frontier.enabled())
    ) {
      return
    }
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

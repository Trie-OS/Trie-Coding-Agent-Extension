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
 * - Token-uncertainty mid-turn escalation (daemon confidence + heuristics)
 * - MinionS-style frontier decomposition for large tasks
 */
import type { ChatTurn, ChatTurnImage, GenerationParams, InferenceClient } from '../inference/types'
import { isWebSearchConfigured, readConfig } from '../config'
import type { ChangedFileStat } from './checkpoints'
import {
  collectPreviousUserTasks,
  COMPACTION_SUMMARY_PROMPT,
  compactOldToolResults,
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
import { formatEvidenceForFrontier, gatherReviewEvidence, type VerifyResult } from './hybridEvidence'
import { heuristicUncertainty, HybridUncertaintyTracker } from './hybridUncertainty'
import { FrontierAssist, type GuideNote } from './frontierAssist'
import { HookManager } from './hooks'
import { PlanSession } from './planSession'
import { PermissionBroker } from './permissionBroker'
import { QuestionBroker } from './questionBroker'
import {
  agentSystemPrompt,
  agentUserPrompt,
  availableToolSpecs,
  buildTaskNotes,
  isPlanAllowedMutatingTool,
  isReadOnlyMode,
  repairTurn,
  toolResultTurn,
  type AgentMode,
} from './prompts'
import { compileOpenAiTools, compileToolGrammar } from './toolGrammar'
import {
  buildWebSearchQuery,
  taskNeedsWebSearch,
} from './webSearchIntent'
import {
  isLazyStepCompleteSummary,
  isPrematureStepFailedReason,
  isTrivialConversation,
  NewFeatureDiscoveryGuard,
  StuckRecoveryGate,
  taskAsksForRecommendations,
  taskExpectsCodeChanges,
  taskNeedsCodebaseExploration,
  summaryClaimsFileChanges,
  summaryDeflectsToDocs,
  summaryMissesRecommendationAsk,
  isScopeNarrowingQuestion,
} from './taskIntent'
import {
  finishRecommendationAnswer,
  isObviouslyFailedRecommendationDraft,
} from './recommendationAnswer'
import {
  recommendationBudgetReached,
  recommendationGenerationTimeout,
} from './recommendationBudget'
import { TurnBudget } from './turnBudget'
import {
  ThoughtStreamParser,
  sanitizeReplyText,
  sanitizeThoughtDisplay,
} from './thoughtStream'
import { VerificationTracker, verificationPolicy } from './verificationPolicy'
import {
  capReasoningChunk,
  explorationNudgeLimit,
  isReasoningModel,
  stallNudgeLimit,
} from './modelBehavior'
import { AutomaticRepairGate, detectAutomaticVerifications } from './automaticVerification'
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
  onReasoningDone?(text?: string): void
  onReasoningOutcome?(accepted: boolean): void
  onReplyStart?(): void
  onReplyChunk?(text: string): void
  onReplyDiscard?(): void
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
  onTelemetry?(telemetry: TurnTelemetry): void
  /** Memory compaction started/finished; `savedTokens` on finish. */
  onCompaction?(active: boolean, savedTokens?: number, keptTurns?: number): void
  /** Plan mode handoff — user approves switching to Code. */
  onPlanHandoff?(payload: { path: string; content: string }): Promise<'execute' | 'stay'>
  /** Lazy checkpoint before the first mutating tool in a code turn. */
  ensureCheckpoint?: () => Promise<string | undefined>
}

export interface AgentSessionOptions {
  userPermissionsDir?: string
}

export interface TurnTelemetry {
  phase: string
  localGenerations: number
  localGenerationMs: number
  explorationCalls: number
  judgeMs: number
  synthesisMs: number
  tokensIn: number
  tokensOut: number
  truncationRetries: number
  deadlineRemainingMs: number
  frontierCalls: number
  frontierSkippedReason?: string
  compactionGenerations: number
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
const GENERATION_TIMEOUT_MS = 3 * 60 * 1000
/** Compact memory when the estimated context passes this share of the window. */
const COMPACT_THRESHOLD = 0.75
const STALL_GUARD_MAX_NUDGES = 2
const STUCK_HINT_WAIT_MS = 250
const RECOMMENDATION_EVIDENCE_MAX_CHARS = 12_000

interface RecommendationEvidence {
  source: string
  text: string
  quality: 'discovery' | 'exact-read'
  discoveredBeforeRead?: boolean
}

function recommendationEvidenceSource(call: ToolCall): string {
  const args = call.args
  switch (call.tool) {
    case 'read_file':
      return `read_file ${String(args['path'] ?? '')}${
        args['startLine'] || args['endLine']
          ? ` L${String(args['startLine'] ?? 1)}-${String(args['endLine'] ?? 'end')}`
          : ''
      }`
    case 'read_files':
      return `read_files ${Array.isArray(args['paths']) ? args['paths'].join(', ') : ''}`
    case 'grep':
      return `grep /${String(args['pattern'] ?? '')}/ ${String(args['glob'] ?? '')}`.trim()
    case 'search_symbols':
      return `search_symbols ${String(args['query'] ?? '')}`
    case 'glob':
      return `glob ${String(args['pattern'] ?? '')}`
    case 'list_dir':
      return `list_dir ${String(args['path'] ?? '.')}`
    case 'web_search':
      return `web_search ${String(args['query'] ?? '')}`
    default:
      return call.tool
  }
}

function formatRecommendationEvidence(items: RecommendationEvidence[]): string {
  let remaining = RECOMMENDATION_EVIDENCE_MAX_CHARS
  const sections: string[] = []
  for (const [index, item] of items.entries()) {
    if (remaining <= 0) break
    const quality =
      item.quality === 'exact-read'
        ? `exact-read discovered-before-read=${item.discoveredBeforeRead === true ? 'yes' : 'no'}`
        : 'discovery'
    const header = `[E${index + 1}] ${item.source} (${quality})`
    const text = item.text.trim().slice(0, Math.min(4000, remaining))
    sections.push(`${header}\n${text}`)
    remaining -= header.length + text.length + 2
  }
  return sections.join('\n\n')
}

function extractDiscoveredPaths(text: string): string[] {
  const matches = text.match(
    /(?:^|\n)([A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|md|json|css|html))(?::\d+)?/g,
  )
  return (
    matches?.map((match) => match.trim().replace(/:\d+$/, '').replaceAll('\\', '/')) ?? []
  )
}

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
    options?: AgentSessionOptions,
  ) {
    this.planSession = new PlanSession(root)
    this.permissions = new PersistentPermissionStore(root, options?.userPermissionsDir)
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
    const recommendationTurn = taskAsksForRecommendations(task)
    const budget = new TurnBudget(mode, recommendationTurn)
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
        deadlineAt: budget.deadlineAt,
        abortSignal: budget.signal(signal),
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
    const reasoningModel = isReasoningModel(client.describe())
    const promptOptions = { multitask: !!this.multitask, reasoningModel }
    const codeExplorationNudgeCalls = explorationNudgeLimit(reasoningModel)
    const stallGuardCalls = stallNudgeLimit(reasoningModel)
    // Tool-loop envelopes are short. A lower cap prevents malformed local
    // recommendation turns from spending the full 2k-token answer budget.
    const availableTools = availableToolSpecs(mode, promptOptions)
    const toolGrammar = compileToolGrammar(availableTools)
    const nativeTools = compileOpenAiTools(availableTools)
    const loopParams = taskAsksForRecommendations(task)
      ? {
          ...params,
          maxTokens: Math.min(params.maxTokens, 768),
          grammar: toolGrammar,
          nativeTools,
        }
      : { ...params, grammar: toolGrammar, nativeTools }

    if (!this.started) {
      const workspaceContext = buildWorkspaceContext(this.root, this.workspaceName)
      this.turns.push({ role: 'system', content: agentSystemPrompt(mode, promptOptions) })
      this.turns.push({
        role: 'user',
        content: agentUserPrompt(task, workspaceContext, taskNotes),
        ...(turnImages?.length ? { images: turnImages } : {}),
      })
      this.started = true
      await this.maybeDecompose(
        task,
        workspaceContext,
        mode,
        events,
        hybridStats,
        budget.signal(signal, 30_000),
      )
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
      'read_files',
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
    let recommendationExplorationCalls = 0
    let codeExplorationCalls = 0
    let codeExplorationNudged = false
    let retriedPrematureStepFailure = false
    const automaticRepair = new AutomaticRepairGate()
    let pendingStuckHint: string | null = null
    let truncatedGenerations = 0
    let compactionGenerations = 0
    const recommendationEvidence: RecommendationEvidence[] = []
    const verifyResults: VerifyResult[] = []
    const discoveredPaths = new Set<string>()
    const telemetry: TurnTelemetry = {
      phase: 'starting',
      localGenerations: 0,
      localGenerationMs: 0,
      explorationCalls: 0,
      judgeMs: 0,
      synthesisMs: 0,
      tokensIn: 0,
      tokensOut: 0,
      truncationRetries: 0,
      deadlineRemainingMs: budget.remainingMs(),
      frontierCalls: 0,
      compactionGenerations: 0,
    }
    const emitTelemetry = (phase: string): void => {
      telemetry.phase = phase
      telemetry.localGenerations = budget.localGenerations
      telemetry.deadlineRemainingMs = budget.remainingMs()
      telemetry.frontierCalls = this.frontier.callsThisTurn
      telemetry.frontierSkippedReason = this.frontier.getSkipReason()
      telemetry.compactionGenerations = compactionGenerations
      hybridStats.frontierCalls = this.frontier.callsThisTurn
      events.onTelemetry?.({ ...telemetry })
    }
    emitTelemetry('starting')
    const deferStuckHint = (text: string): void => {
      pendingStuckHint = text
    }

    const finishRecommendation = async (
      draft: string,
      forceRewrite: boolean,
    ): Promise<LoopResult> => {
      events.onGenerating(true)
      try {
        const summary = await finishRecommendationAnswer(
          client,
          task,
          draft,
          this.transcriptTail(),
          params,
          signal,
          {
            forceRewrite,
            frontier: this.frontier.enabled() ? this.frontier : undefined,
            evidence: formatRecommendationEvidence(recommendationEvidence),
            budget,
            onPhase: (phase, durationMs, truncationRetries, tokensIn, tokensOut) => {
              if (phase === 'judge') telemetry.judgeMs += durationMs
              else telemetry.synthesisMs += durationMs
              telemetry.truncationRetries += truncationRetries
              telemetry.tokensIn += tokensIn
              telemetry.tokensOut += tokensOut
              emitTelemetry(phase)
            },
            onReplyStart: events.onReplyStart,
            onReplyChunk: events.onReplyChunk,
            onReplyDiscard: events.onReplyDiscard,
          },
        )
        return {
          ok: true,
          summary,
          mutatedFiles: mutatedFiles.length > 0 ? mutatedFiles : undefined,
          hybridStats,
        }
      } finally {
        events.onGenerating(false)
      }
    }

    const toolCallLimit = maxCalls === 0 ? Number.POSITIVE_INFINITY : Math.max(1, maxCalls)
    for (let i = 0; i < toolCallLimit; i++) {
      if (signal.aborted) return { ok: false, summary: 'Stopped.', hybridStats }
      if (budget.expired()) {
        return {
          ok: false,
          summary: 'Stopped: the end-to-end turn deadline was reached.',
          hybridStats,
        }
      }
      if (pendingStuckHint) {
        const guideContent = `Guide note from a senior reviewer (advisory): ${pendingStuckHint}`
        this.turns.push({
          role: 'user',
          content: guideContent,
        })
        this.cachedTokenEstimate += Math.ceil(guideContent.length / 4) + 8
        pendingStuckHint = null
      }

      const recommendationElapsed = budget.elapsedMs()
      if (
        recommendationTurn &&
        recommendationBudgetReached(
          recommendationExplorationCalls,
          recommendationElapsed,
        )
      ) {
        return await finishRecommendation('', true)
      }

      await this.compactIfNeeded(
        client,
        params,
        events,
        budget.signal(signal),
        budget,
        () => {
          compactionGenerations += 1
        },
      )

      if (!budget.claimLocalGeneration()) {
        if (recommendationTurn) return await finishRecommendation('', true)
        if (budget.expired() || mode === 'code') {
          return {
            ok: false,
            summary:
              `Stopped: the ${mode} mode turn deadline was reached (${Math.round(budget.elapsedMs() / 1000)}s). ` +
              `Raise trie-ide.agent.budgets.modeDeadline${mode === 'code' ? 'Code' : mode === 'plan' ? 'Plan' : 'Ask'}Ms in Settings, or send a narrower follow-up.`,
            hybridStats,
          }
        }
        return {
          ok: false,
          summary:
            `Stopped: the ${mode} mode local-generation budget (${budget.maxLocalGenerations}) was reached. ` +
            'Each model reply in the tool loop counts as one generation. Send a narrower follow-up or switch to Code mode.',
          hybridStats,
        }
      }

      events.onGenerating(true)
      emitTelemetry('local generation')
      const localGenerationStartedAt = Date.now()
      let raw = ''
      let genResult: Awaited<ReturnType<InferenceClient['generate']>> | undefined
      let generationError: unknown
      const thoughtStream = new ThoughtStreamParser()
      let visibleReasoningChars = 0
      try {
        genResult = await generateWithTimeout(
          client,
          this.turns,
          loopParams,
          (token) => {
            if (!token) return
            const delta = thoughtStream.push(token)
            if (delta) {
              events.onReasoningChunk?.(delta)
              return
            }
            // Reasoning traces (e.g. reasoning_content) are plain text — never stream
            // JSON envelope syntax (`"tool":`, commas, braces) into the thought panel.
            if (!thoughtStream.inToolEnvelope()) {
              const trimmed = token.trimStart()
              if (trimmed && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
                const visible = capReasoningChunk(token, visibleReasoningChars, reasoningModel)
                if (visible) {
                  visibleReasoningChars += visible.length
                  events.onReasoningChunk?.(visible)
                }
              }
            }
          },
          budget.signal(signal),
          recommendationTurn
            ? Math.max(
                1000,
                Math.min(
                  GENERATION_TIMEOUT_MS,
                  recommendationGenerationTimeout(recommendationElapsed),
                ),
              )
            : GENERATION_TIMEOUT_MS,
        )
        raw = genResult.text
      } catch (error) {
        generationError = error
      } finally {
        telemetry.localGenerationMs += Date.now() - localGenerationStartedAt
        events.onGenerating(false)
        const finalThought = sanitizeThoughtDisplay(thoughtStream.finalThought()).trim()
        events.onReasoningDone?.(finalThought || undefined)
        thoughtStream.reset()
      }
      if (generationError !== undefined) {
        events.onReasoningOutcome?.(false)
        const message =
          generationError instanceof Error ? generationError.message : String(generationError)
        if (recommendationTurn && message.startsWith('Generation timed out')) {
          return await finishRecommendation('', true)
        }
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
      telemetry.tokensIn += genResult.tokensIn
      telemetry.tokensOut += genResult.tokensOut
      emitTelemetry('local generation')
      if (budget.expired()) {
        events.onReasoningOutcome?.(false)
        return {
          ok: false,
          summary: 'Stopped: the end-to-end turn deadline was reached.',
          hybridStats,
        }
      }
      if (genResult.truncated) {
        events.onReasoningOutcome?.(false)
        if (recommendationTurn) {
          // The capped loop output is only a draft/tool envelope. Never expose
          // it as a final answer; synthesize afresh with the larger budget.
          return await finishRecommendation('', true)
        }
        truncatedGenerations += 1
        telemetry.truncationRetries += 1
        emitTelemetry('truncation retry')
        if (truncatedGenerations >= 2) {
          return {
            ok: false,
            summary:
              'Stopped after two output-limit truncations. No partial answer was returned; increase the max-token setting or narrow the request.',
            hybridStats,
          }
        }
        const assistantTurn: ChatTurn = { role: 'assistant', content: raw.slice(0, 2000) }
        const retryTurn: ChatTurn = {
          role: 'user',
          content:
            'Your previous JSON envelope hit the output limit and was discarded. Retry concisely with one complete tool call. Do not continue the partial text.',
        }
        this.turns.push(assistantTurn, retryTurn)
        this.cachedTokenEstimate +=
          Math.ceil((assistantTurn.content.length + retryTurn.content.length) / 4) + 16
        continue
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
        events.onReasoningOutcome?.(false)
        consecutiveFailures++
        if (consecutiveFailures >= 3) {
          return {
            ok: false,
            summary: `The model kept producing malformed output: ${parsed.error}`,
            hybridStats,
          }
        }
        await this.maybeStuckHint(
          consecutiveFailures,
          events,
          hybridStats,
          deferStuckHint,
        )
        const assistantTurn: ChatTurn = { role: 'assistant', content: raw.slice(0, 2000) };
        this.turns.push(assistantTurn);
        this.cachedTokenEstimate += Math.ceil(assistantTurn.content.length / 4) + 8;
                    const userTurn: ChatTurn = { role: 'user', content: repairTurn(parsed.error) };
        this.turns.push(userTurn);
        this.cachedTokenEstimate += Math.ceil(userTurn.content.length / 4) + 8;
        continue
      }

      events.onReasoningOutcome?.(true)
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
          }
          this.turns.push(userTurn)
          this.cachedTokenEstimate += Math.ceil(userTurn.content.length / 4) + 8
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
          }
          this.turns.push(userTurn)
          this.cachedTokenEstimate += Math.ceil(userTurn.content.length / 4) + 8
          consecutiveFailures++
          continue
        }
        const ok = call.tool === 'step_complete'
        const resultKey = ok ? 'summary' : 'reason'
        const resultValue = call.args[resultKey]
        if (typeof resultValue !== 'string' || !resultValue.trim()) {
          const userTurn: ChatTurn = {
            role: 'user',
            content: toolResultTurn(
              call.tool,
              false,
              `Refused: ${call.tool}.${resultKey} is required and must contain the user-facing ${ok ? 'answer' : 'error reason'}.`,
            ),
          }
          this.turns.push(userTurn)
          this.cachedTokenEstimate += Math.ceil(userTurn.content.length / 4) + 8
          consecutiveFailures++
          continue
        }
        const rawSummary = resultValue
        if (
          call.tool === 'step_failed' &&
          mode === 'code' &&
          !retriedPrematureStepFailure &&
          isPrematureStepFailedReason(rawSummary)
        ) {
          retriedPrematureStepFailure = true
          const retry =
            'Do not call step_failed. The request is implementable: use reasonable defaults that match existing codebase patterns and implement now. Call step_complete when done.'
          this.turns.push({
            role: 'user',
            content: toolResultTurn('step_failed', false, retry),
          })
          this.cachedTokenEstimate += Math.ceil(retry.length / 4) + 8
          consecutiveFailures = 0
          continue
        }
        // Some compatible providers nest a complete step_complete envelope
        // inside the summary string. Recover its answer before policy checks.
        const sanitizedSummary = sanitizeReplyText(rawSummary)
        if (call.tool === 'step_complete' && rawSummary.trim() && !sanitizedSummary) {
          const userTurn: ChatTurn = {
            role: 'user',
            content: toolResultTurn(
              'step_complete',
              false,
              'Refused: step_complete.summary contains an internal tool-call envelope instead of a user-facing answer. Put the final answer directly in summary.',
            ),
          }
          this.turns.push(userTurn)
          this.cachedTokenEstimate += Math.ceil(userTurn.content.length / 4) + 8
          consecutiveFailures++
          continue
        }
        let summary = sanitizedSummary || rawSummary
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
        const sanitizedPostHookSummary = sanitizeReplyText(summary)
        if (!sanitizedPostHookSummary) {
          const userTurn: ChatTurn = {
            role: 'user',
            content: toolResultTurn(
              call.tool,
              false,
              `Refused: the post-agent hook produced an empty or internal result. Return a user-facing ${ok ? 'answer' : 'error reason'}.`,
            ),
          }
          this.turns.push(userTurn)
          this.cachedTokenEstimate += Math.ceil(userTurn.content.length / 4) + 8
          consecutiveFailures++
          continue
        }
        summary = sanitizedPostHookSummary

        if (
          call.tool === 'step_complete' &&
          taskAsksForRecommendations(task) &&
          summaryMissesRecommendationAsk(task, summary)
        ) {
          const userTurn: ChatTurn = {
            role: 'user',
            content: toolResultTurn(
              'step_complete',
              false,
              'Refused: empty answer or doc handoff — put substantive improvement advice in summary (the harness will judge depth at finish).',
            ),
          }
          this.turns.push(userTurn)
          this.cachedTokenEstimate += Math.ceil(userTurn.content.length / 4) + 8
          consecutiveFailures++
          continue
        }
        if (call.tool === 'step_complete' && taskNeedsCodebaseExploration(task) && summaryDeflectsToDocs(summary)) {
          const userTurn: ChatTurn = {
            role: 'user',
            content: toolResultTurn(
              'step_complete',
              false,
              'Refused: do not punt to documentation links. Synthesize actionable advice from the files you explored directly in summary.',
            ),
          }
          this.turns.push(userTurn)
          this.cachedTokenEstimate += Math.ceil(userTurn.content.length / 4) + 8
          consecutiveFailures++
          continue
        }

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
          // The recommendation judge already performs the semantic completion
          // check. Running localSelfGrade here would add a redundant 70B pass.
          return await finishRecommendation(
            summary,
            call.tool === 'step_failed' || isObviouslyFailedRecommendationDraft(summary),
          )
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
          }
          this.turns.push(userTurn)
          this.cachedTokenEstimate += Math.ceil(userTurn.content.length / 4) + 8
          consecutiveFailures++
          continue
        }
        if (call.tool === 'step_complete' && mode === 'code' && this.mutatedThisTurn) {
          const policy = verificationPolicy(
            task,
            mutatedFiles.map((file) => file.path),
          )
          if (policy.needed && !verification.hasCurrentEvidence()) {
            const automaticChecks = detectAutomaticVerifications(
              this.root,
              mutatedFiles.map((file) => file.path),
              policy.useVisualHarness,
            )
            let automaticFailure: ToolOutcome | null = null
            let automaticFailureLabel = ''
            let verificationSkipped = false
            for (const check of automaticChecks) {
              const verifyCall: ToolCall = {
                thought: 'Automatically verify the completed edit batch.',
                tool: 'run_verification',
                args: { packagePath: check.packagePath, script: check.script },
              }
              const verifyId = ++this.callId
              events.onToolCall(verifyId, verifyCall, summarizeArgs(verifyCall))
              const verifyOutcome = await tools.execute(verifyCall)
              events.onToolResult(
                verifyId,
                verifyOutcome.ok,
                verifyOutcome.uiSummary,
                verifyOutcome.viaTrie,
                verifyOutcome.trieMs,
                verifyOutcome.scanMs,
                verifyOutcome.uiDetail ?? toolUiDetail(verifyOutcome.result),
                verifyOutcome.userSkipped,
              )
              const denied = verifyOutcome.userSkipped || /verification denied/i.test(verifyOutcome.result)
              verifyResults.push({
                command: `${check.packagePath}: ${check.script}`,
                ok: verifyOutcome.ok,
                output: verifyOutcome.result.slice(0, 2000),
              })
              if (denied) {
                verificationSkipped = true
                break
              }
              if (!verifyOutcome.ok) {
                automaticFailure = verifyOutcome
                automaticFailureLabel = `${check.packagePath}: ${check.script}`
                break
              }
            }

            if (verificationSkipped) {
              verification.noteVerification(true)
            } else if (automaticChecks.length > 0 && !automaticFailure) {
              verification.noteVerification()
            } else if (automaticFailure) {
              if (automaticRepair.onFailure() === 'stop') {
                const failureSummary =
                  `Automatic verification still fails after one repair attempt (${automaticFailureLabel}).\n\n` +
                  automaticFailure.result
                return {
                  ok: false,
                  summary: failureSummary,
                  mutatedFiles: mutatedFiles.length > 0 ? mutatedFiles : undefined,
                  hybridStats,
                }
              }
              const repairTurn: ChatTurn = {
                role: 'user',
                content: toolResultTurn(
                  'run_verification',
                  false,
                  `${automaticFailure.result}\n\nYou have exactly one repair attempt. Fix the reported failure with the smallest edit, then call step_complete; verification will run again automatically.`,
                ),
              }
              this.turns.push(repairTurn)
              this.cachedTokenEstimate += Math.ceil(repairTurn.content.length / 4) + 8
              consecutiveFailures = 0
              continue
            }

            if (automaticChecks.length === 0) {
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
          }
        }
        if (ok) {
          if (!taskAsksForRecommendations(task) && summary.trim()) {
            events.onReplyStart?.()
            events.onReplyChunk?.(summary)
          }
          await this.finishWithHybridReview(
            events,
            hybridStats,
            hybridCtx,
            signal,
            budget,
            verifyResults,
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

      if (
        call.tool === 'ask_user_question' &&
        taskAsksForRecommendations(task) &&
        isScopeNarrowingQuestion(call.args)
      ) {
        this.turns.push({
          role: 'user',
          content: toolResultTurn(
            'ask_user_question',
            false,
            'Refused: user asked for broad harness improvement advice. Explore the codebase and step_complete with numbered file-grounded recommendations — do not ask them to narrow scope.',
          ),
        })
        consecutiveFailures++
        continue
      }

      const preHook = this.hooks.preTool(call)
      call = preHook.rewritten
      if (explorationTools.has(call.tool)) exploredThisTurn = true

      if (spec0?.mutating && call.tool !== 'update_plan' && !spec0.control) {
        await events.ensureCheckpoint?.()
      }

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
      if (recommendationTurn && outcome.ok && explorationTools.has(call.tool)) {
        recommendationExplorationCalls += 1
        const isRead = call.tool === 'read_file' || call.tool === 'read_files'
        const readPaths =
          call.tool === 'read_files' && Array.isArray(call.args['paths'])
            ? call.args['paths']
                .filter((item): item is string => typeof item === 'string')
                .map((item) => item.replaceAll('\\', '/'))
            : [String(call.args['path'] ?? '').replaceAll('\\', '/')]
        if (!isRead) {
          for (const path of extractDiscoveredPaths(outcome.result)) discoveredPaths.add(path)
        }
        telemetry.explorationCalls = recommendationExplorationCalls
        recommendationEvidence.push({
          source: recommendationEvidenceSource(call),
          text: outcome.result,
          quality: isRead ? 'exact-read' : 'discovery',
          discoveredBeforeRead: isRead
            ? readPaths.every(
                (readPath) =>
                  discoveredPaths.has(readPath) ||
                  [...discoveredPaths].some(
                    (path) => path.endsWith(`/${readPath}`) || readPath.endsWith(`/${path}`),
                  ),
              )
            : undefined,
        })
        emitTelemetry('exploration')
      }

      if (
        mode === 'code' &&
        taskExpectsCodeChanges(task) &&
        !this.mutatedThisTurn &&
        outcome.ok &&
        explorationTools.has(call.tool)
      ) {
        codeExplorationCalls += 1
        if (codeExplorationCalls >= codeExplorationNudgeCalls && !codeExplorationNudged) {
          codeExplorationNudged = true
          const guard: ChatTurn = {
            role: 'user',
            content: toolResultTurn(
              call.tool,
              false,
              'Exploration cap: stop reading/searching and apply the smallest edit_file or write_file change now based on what you already know, then step_complete with what changed.',
            ),
          }
          this.turns.push(guard)
          this.cachedTokenEstimate += Math.ceil(guard.content.length / 4) + 8
        }
      }

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
        callsSinceProgress >= stallGuardCalls
      ) {
        const guard: ChatTurn = {
          role: 'user',
          content: toolResultTurn(
            call.tool,
            false,
            taskExpectsCodeChanges(task)
              ? 'Stall guard: you have explored enough without editing. Make one concrete edit_file or write_file change for the highest-priority item, then step_complete.'
              : 'Stall guard: progress is unclear after several tool calls. Narrow scope now: update_todos with 2-5 concrete steps OR ask_user_question to resolve ambiguity, then execute one step end-to-end.',
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
        await this.maybeStuckRecovery(
          'feature_discovery',
          events,
          hybridStats,
          deferStuckHint,
        )
      } else if (call.tool === 'web_search' && !webSearchAllowedThisTurn) {
        await this.maybeStuckRecovery(
          'web_search_denied',
          events,
          hybridStats,
          deferStuckHint,
        )
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
      if (call.tool === 'run_verification') {
        const skipReason = call.args['skipReason']
        const skipped = typeof skipReason === 'string' && Boolean(skipReason.trim())
        if (outcome.ok) {
          verification.noteVerification(skipped)
        }
        const script = typeof call.args['script'] === 'string' ? call.args['script'] : 'verification'
        const packagePath =
          typeof call.args['packagePath'] === 'string' && call.args['packagePath'].trim()
            ? call.args['packagePath'].trim()
            : '.'
        verifyResults.push({
          command: skipped ? `(skipped) ${skipReason}` : `${packagePath}: ${script}`,
          ok: outcome.ok && !skipped,
          output: outcome.result.slice(0, 2000),
        })
      }

      if (outcome.ok) {
        consecutiveFailures = 0
      } else {
        consecutiveFailures++
        if (consecutiveFailures >= 2) {
          await this.maybeStuckHint(
            consecutiveFailures,
            events,
            hybridStats,
            deferStuckHint,
          )
        }
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
      summary: `Stopped: the agent used all ${toolCallLimit} tool calls without finishing. You can raise trie-ide.agent.maxToolCalls or set it to 0 for unlimited calls.`,
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
    budget?: TurnBudget,
    onCompacted?: () => void,
  ): Promise<void> {
    const used = this.estimatedContextTokens()
    const overTurnLimit = this.turns.length > MAX_HISTORY_TURNS + KEEP_RECENT_TURNS
    if (used < contextLimit() * COMPACT_THRESHOLD && !overTurnLimit) return
    const lazy = compactOldToolResults(
      this.turns,
      Math.floor(contextLimit() * COMPACT_THRESHOLD),
    )
    if (lazy.compactedResults > 0) {
      this.turns = lazy.turns
      this.lastReportedTokens = 0
      this.cachedTokenEstimate = estimateTokens(this.turns)
      events.onCompaction?.(
        false,
        lazy.savedTokens,
        Math.min(KEEP_RECENT_TURNS, this.turns.length),
      )
      events.onContext?.(this.cachedTokenEstimate, contextLimit())
      onCompacted?.()
      if (
        this.cachedTokenEstimate < contextLimit() * COMPACT_THRESHOLD &&
        !overTurnLimit
      ) {
        return
      }
    }
    if (budget && !budget.claimCompactionGeneration()) return
    const compacted = await this.compactNow(client, params, events, signal)
    if (compacted) onCompacted?.()
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
  ): Promise<boolean> {
    if (this.turns.length < KEEP_RECENT_TURNS + 4) return false
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
          return false
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
      return true
    } finally {
      if (!committed) events.onCompaction?.(false)
    }
    return false
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
      const plan = await frontierDecompose(task, workspaceContext, this.frontier, signal)
      if (!plan) return
      stats.decomposed = true
      stats.frontierCalls = this.frontier.callsThisTurn
      events.onHybridPlan?.(plan.subtasks, plan.rationale)
      this.turns.push({ role: 'user', content: formatDecomposeInjection(plan) })
    } finally {
      events.onHybridChecking(false, 'decompose')
    }
  }

  private async finishWithHybridReview(
    events: LoopEvents,
    stats: HybridTurnStats,
    hybridCtx: HybridTurnContext | undefined,
    signal: AbortSignal,
    budget: TurnBudget | undefined,
    verifyResults: VerifyResult[],
  ): Promise<void> {
    if (!this.mutatedThisTurn) return
    await this.maybeFinalReview(events, stats, hybridCtx, signal, budget, verifyResults)
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
    signal?: AbortSignal,
    budget?: TurnBudget,
  ): Promise<boolean> {
    const note = await this.fetchFrontierNote(
      checkpoint,
      events,
      stats,
      extra,
      signal,
      budget,
    )
    if (!note) return false
    if (note.text.trim()) {
      this.turns.push({
        role: 'user',
        content: `Guide note from a senior reviewer (advisory): ${note.text}`,
      })
    }
    return true
  }

  private async fetchFrontierNote(
    checkpoint: GuideNote['checkpoint'],
    events: LoopEvents,
    stats: HybridTurnStats,
    extra: {
      evidence?: string
      selfGrade?: { confidence: number; concerns: string }
      uncertainty?: number
    } = {},
    signal?: AbortSignal,
    budget?: TurnBudget,
  ): Promise<GuideNote | null> {
    events.onHybridChecking(true, checkpoint)
    let note: GuideNote | null = null
    try {
      note = await this.frontier.consult(checkpoint, {
        transcript: this.transcriptTail(),
        ...extra,
      }, signal, budget?.remainingMs())
      if (note) stats.frontierCalls = this.frontier.callsThisTurn
    } finally {
      events.onHybridChecking(false, checkpoint)
    }
    if (!note) return null
    events.onGuideNote(note)
    return note
  }

  private async maybeStuckRecovery(
    reason: 'feature_discovery' | 'web_search_denied' | 'generation_timeout',
    events: LoopEvents,
    stats: HybridTurnStats,
    onLateHint?: (text: string) => void,
  ): Promise<boolean> {
    if (
      !this.hybridEligibleThisTurn ||
      !this.stuckRecovery.claim(this.frontier.enabled())
    ) return false
    const extra = {
      evidence: `Recovery trigger: ${reason.replaceAll('_', ' ')}. Give a concrete repository-local next step that moves this task toward implementation.`,
    }
    if (reason === 'generation_timeout') {
      return this.consultFrontier('stuck_hint', events, stats, extra)
    }
    return this.waitBrieflyForHint(
      this.fetchFrontierNote('stuck_hint', events, stats, extra),
      onLateHint,
    )
  }

  private async maybeStuckHint(
    consecutiveFailures: number,
    events: LoopEvents,
    stats: HybridTurnStats,
    onLateHint?: (text: string) => void,
  ): Promise<void> {
    if (consecutiveFailures < 2) return
    if (
      !this.hybridEligibleThisTurn ||
      !this.stuckRecovery.claim(this.frontier.enabled())
    ) {
      return
    }
    await this.waitBrieflyForHint(
      this.fetchFrontierNote('stuck_hint', events, stats),
      onLateHint,
    )
  }

  /**
   * Let cached/fast hints land immediately, but overlap slow frontier requests
   * with the next local generation. Late notes are queued by the caller and
   * inserted at the next safe loop boundary, never mid-generation.
   */
  private async waitBrieflyForHint(
    request: Promise<GuideNote | null>,
    onLateHint?: (text: string) => void,
  ): Promise<boolean> {
    const safeRequest = request.catch(() => null)
    const late = Symbol('late')
    const result = await new Promise<GuideNote | null | typeof late>((resolve) => {
      const timer = setTimeout(() => resolve(late), STUCK_HINT_WAIT_MS)
      void safeRequest.then((note) => {
        clearTimeout(timer)
        resolve(note)
      })
    })
    if (result === late) {
      void safeRequest.then((note) => {
        if (note?.text.trim()) onLateHint?.(note.text.trim())
      })
      return false
    }
    if (!result) return false
    if (result.text.trim()) {
      this.turns.push({
        role: 'user',
        content: `Guide note from a senior reviewer (advisory): ${result.text}`,
      })
    }
    return true
  }

  private async maybeFinalReview(
    events: LoopEvents,
    stats: HybridTurnStats,
    hybridCtx: HybridTurnContext | undefined,
    signal: AbortSignal | undefined,
    budget: TurnBudget | undefined,
    verifyResults: VerifyResult[],
  ): Promise<void> {
    if (!this.hybridEligibleThisTurn || !this.frontier.enabled()) return

    let evidenceBlock: string | undefined
    if (this.mutatedThisTurn && hybridCtx?.changedFileStats) {
      try {
        const files = await hybridCtx.changedFileStats()
        stats.evidenceChecks = files.length
        const evidence = await gatherReviewEvidence(this.root, files, verifyResults)
        evidenceBlock = formatEvidenceForFrontier(evidence)
      } catch {
        /* evidence is best-effort */
      }
    } else if (verifyResults.length > 0) {
      const evidence = await gatherReviewEvidence(this.root, [], verifyResults)
      evidenceBlock = formatEvidenceForFrontier(evidence)
    }

    await this.consultFrontier(
      'final_review',
      events,
      stats,
      { evidence: evidenceBlock },
      signal,
      budget,
    )
  }
}

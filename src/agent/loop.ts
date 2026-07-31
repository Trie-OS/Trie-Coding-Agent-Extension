/**
 * The agent tool loop, following Trie IDE's toolLoop.ts contract:
 * `[system, user]` then alternating assistant tool-call envelopes and user
 * tool-result turns; the loop ends on a control tool (step_complete /
 * step_failed), on exhausting the call budget, or on repeated malformed
 * output. One repair attempt per failure; the hybrid frontier model is
 * consulted for a stuck hint after consecutive failures and for a final
 * review after a mutating turn completes.
 */
import type { ChatTurn, GenerationParams, InferenceClient } from '../inference/types'
import { buildWorkspaceContext } from './context'
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
  parseToolCall,
  summarizeArgs,
  TOOL_SPECS,
  WorkspaceTools,
  type ToolCall,
} from './tools'

export interface LoopEvents {
  onGenerating(active: boolean): void
  onToolCall(id: number, call: ToolCall, argsSummary: string): void
  onToolResult(id: number, ok: boolean, summary: string, viaTrie?: boolean): void
  onTodos(todo: string[], done: string[]): void
  /** Frontier model is consulting (stuck hint or final review). */
  onHybridChecking(active: boolean, checkpoint?: 'stuck_hint' | 'final_review'): void
  onGuideNote(note: GuideNote): void
}

export interface LoopResult {
  ok: boolean
  summary: string
}

const MAX_HISTORY_TURNS = 40

export class AgentSession {
  private turns: ChatTurn[] = []
  private todo: string[] = []
  private done: string[] = []
  private started = false
  private callId = 0
  private mode: AgentMode = 'code'
  /** Whether any mutating tool succeeded this turn — fed to the hybrid final review. */
  private mutatedThisTurn = false

  constructor(
    private readonly root: string,
    private readonly workspaceName: string,
    private readonly frontier: FrontierAssist,
  ) {}

  reset(): void {
    this.turns = []
    this.todo = []
    this.done = []
    this.started = false
  }

  async runTurn(
    task: string,
    mode: AgentMode,
    client: InferenceClient,
    params: GenerationParams,
    maxCalls: number,
    events: LoopEvents,
    signal: AbortSignal,
  ): Promise<LoopResult> {
    this.frontier.resetTurn()
    const tools = new WorkspaceTools(this.root)
    this.mode = mode

    if (!this.started) {
      const workspaceContext = buildWorkspaceContext(this.root, this.workspaceName)
      this.turns.push({ role: 'system', content: agentSystemPrompt(mode) })
      this.turns.push({ role: 'user', content: agentUserPrompt(task, workspaceContext) })
      this.started = true
    } else {
      // The mode can change between turns; the system prompt is always turn 0.
      this.turns[0] = { role: 'system', content: agentSystemPrompt(mode) }
      this.turns.push({ role: 'user', content: `Task: ${task}` })
    }

    let consecutiveFailures = 0
    this.mutatedThisTurn = false

    for (let i = 0; i < maxCalls; i++) {
      if (signal.aborted) return { ok: false, summary: 'Stopped.' }

      events.onGenerating(true)
      let raw: string
      try {
        const result = await client.generate(this.windowedTurns(), params, () => {}, signal)
        raw = result.text
      } finally {
        events.onGenerating(false)
      }

      const parsed = parseToolCall(raw)
      if ('error' in parsed) {
        consecutiveFailures++
        if (consecutiveFailures >= 3) {
          return { ok: false, summary: `The model kept producing malformed output: ${parsed.error}` }
        }
        await this.maybeStuckHint(consecutiveFailures, events)
        this.turns.push({ role: 'assistant', content: raw.slice(0, 2000) })
        this.turns.push({ role: 'user', content: repairTurn(parsed.error) })
        continue
      }

      const call = parsed
      this.turns.push({ role: 'assistant', content: JSON.stringify(call) })
      const id = ++this.callId

      // Control tools terminate the turn.
      if (call.tool === 'step_complete' || call.tool === 'step_failed') {
        const ok = call.tool === 'step_complete'
        const summary =
          (typeof call.args['summary'] === 'string' && (call.args['summary'] as string)) ||
          (typeof call.args['reason'] === 'string' && (call.args['reason'] as string)) ||
          (ok ? 'Done.' : 'Failed.')
        if (ok) await this.maybeFinalReview(events)
        return { ok, summary }
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
          }
        }
        continue
      }

      events.onToolCall(id, call, summarizeArgs(call))
      const outcome = await tools.execute(call)
      events.onToolResult(id, outcome.ok, outcome.uiSummary, outcome.viaTrie)
      this.turns.push({ role: 'user', content: toolResultTurn(call.tool, outcome.ok, outcome.result) })

      const spec = TOOL_SPECS.find((t) => t.name === call.tool)
      if (outcome.ok && spec?.mutating) this.mutatedThisTurn = true

      if (outcome.ok) {
        consecutiveFailures = 0
      } else {
        consecutiveFailures++
        if (consecutiveFailures >= 2) await this.maybeStuckHint(consecutiveFailures, events)
        if (consecutiveFailures >= 4) {
          return { ok: false, summary: `Stopped after repeated tool failures (last: ${outcome.uiSummary})` }
        }
      }
    }

    return {
      ok: false,
      summary: `Stopped: the agent used all ${maxCalls} tool calls without finishing. You can raise trie-ide.agent.maxToolCalls or continue with a follow-up message.`,
    }
  }

  /** Sliding window: system + first user turn always kept, then the most recent turns. */
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

  private async maybeStuckHint(consecutiveFailures: number, events: LoopEvents): Promise<void> {
    if (consecutiveFailures < 2 || !this.frontier.enabled()) return
    events.onHybridChecking(true, 'stuck_hint')
    let note: GuideNote | null = null
    try {
      note = await this.frontier.consult('stuck_hint', this.transcriptTail())
    } finally {
      events.onHybridChecking(false)
    }
    if (!note) return
    events.onGuideNote(note)
    this.turns.push({
      role: 'user',
      content: `Guide note from a senior reviewer (advisory): ${note.text}`,
    })
  }

  private async maybeFinalReview(events: LoopEvents): Promise<void> {
    if (!this.frontier.enabled()) return
    events.onHybridChecking(true, 'final_review')
    let note: GuideNote | null = null
    try {
      note = await this.frontier.consult('final_review', this.buildFinalReviewContext())
    } finally {
      events.onHybridChecking(false)
    }
    if (note) events.onGuideNote(note)
  }

  /** Transcript plus a one-line work summary for the frontier reviewer. */
  private buildFinalReviewContext(): string {
    const toolsUsed: string[] = []
    for (const turn of this.turns) {
      if (turn.role !== 'assistant') continue
      try {
        const call = JSON.parse(turn.content) as { tool?: string }
        if (call.tool && call.tool !== 'step_complete' && call.tool !== 'step_failed') {
          toolsUsed.push(call.tool)
        }
      } catch {
        /* prose turn */
      }
    }
    const work = this.mutatedThisTurn
      ? 'Workspace was modified this turn.'
      : 'Read-only turn (no file edits).'
    const summary =
      toolsUsed.length > 0
        ? `${work} Tools used (${toolsUsed.length}): ${toolsUsed.join(', ')}`
        : `${work} No tools were called.`
    return `${summary}\n\n${this.transcriptTail()}`
  }
}

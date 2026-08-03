/**
 * Hybrid frontier assist, mirroring Trie IDE's design
 * (app/src/main/services/frontierAssist/, docs/HYBRID-ASSIST.md):
 *
 * The local model does all the work; an optional frontier (cloud) model is
 * consulted only at high-leverage checkpoints and returns a short advisory
 * guide note. It never drives the tool loop and never edits files. The local
 * model does every tool call and self-grades before a finish-line escalation.
 * Trivial or confidently completed turns stay local.
 * disabled/no-key → silent null, split consult/completion budgets per turn,
 * 3-minute cooldown after a 429.
 */
import { getActiveFrontierConfig, type FrontierAssistConfig } from '../config'
import { readAgentBudgets } from './agentBudgets'

export type Checkpoint = 'stuck_hint' | 'final_review' | 'uncertainty' | 'self_grade'

export interface GuideNote {
  checkpoint: Checkpoint
  verdict: 'looks_good' | 'concern'
  text: string
}

export interface ConsultContext {
  transcript: string
  evidence?: string
  selfGrade?: { confidence: number; concerns: string }
  uncertainty?: number
}

export interface FrontierCompletionOptions {
  maxTokens: number
  temperature: number
  signal?: AbortSignal
  timeoutMs?: number
}

export interface FrontierCompletionResult {
  text: string
  truncated: boolean
  tokensIn?: number
  tokensOut?: number
}

const RATE_LIMIT_COOLDOWN_MS = 3 * 60 * 1000
const MAX_CONTEXT_CHARS = 8000
const REQUEST_TIMEOUT_MS = 30_000

const SYSTEM = [
  'You are a senior engineer reviewing the work of a smaller local coding model.',
  'Given the transcript, reply with exactly one JSON object:',
  '{"verdict": "looks_good" | "concern", "text": "<one short paragraph of specific, actionable guidance>"}',
  'Be concrete: name files, tools, or commands. Never propose that you do the work yourself.',
].join('\n')

function checkpointQuestion(checkpoint: Checkpoint): string {
  switch (checkpoint) {
    case 'stuck_hint':
      return 'The local model appears stuck (failed calls, repeated no-result exploration, denied unnecessary web search, or a generation stall). Give one concrete repository-local next step toward implementation.'
    case 'uncertainty':
      return 'The local model looks uncertain (low token confidence or repeated flailing). Give one concrete next step.'
    case 'self_grade':
      return 'The local model rated its own work as low-confidence before finishing. What should it verify or fix?'
    case 'final_review':
      return 'The local model believes the task is complete. Review the evidence below (diff + verification output): is anything wrong or missing?'
  }
}

export class FrontierAssist {
  private consultCallsThisTurn = 0
  private completionCallsThisTurn = 0
  private cooldownUntil = 0
  private lastSkipReason: string | undefined

  constructor(private readonly getConfig: () => FrontierAssistConfig) {}

  resetTurn(): void {
    this.consultCallsThisTurn = 0
    this.completionCallsThisTurn = 0
    this.lastSkipReason = undefined
  }

  get callsThisTurn(): number {
    return this.consultCallsThisTurn + this.completionCallsThisTurn
  }

  getSkipReason(): string | undefined {
    return this.lastSkipReason
  }

  enabled(): boolean {
    const cfg = this.getConfig()
    if (!cfg.enabled) return false
    return getActiveFrontierConfig(cfg) !== null
  }

  /** Returns null (silently) when disabled, rate-limited, or over budget — hybrid must never block local work. */
  async consult(
    checkpoint: Checkpoint,
    ctx: ConsultContext,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<GuideNote | null> {
    const clipped =
      ctx.transcript.length > MAX_CONTEXT_CHARS
        ? `…${ctx.transcript.slice(-MAX_CONTEXT_CHARS)}`
        : ctx.transcript
    const parts = [checkpointQuestion(checkpoint)]
    if (ctx.uncertainty !== undefined) {
      parts.push(`Local uncertainty score: ${ctx.uncertainty.toFixed(2)} (0=confident, 1=flailing)`)
    }
    if (ctx.selfGrade) {
      parts.push(
        `Local self-grade: confidence=${ctx.selfGrade.confidence.toFixed(2)}, concerns="${ctx.selfGrade.concerns}"`,
      )
    }
    if (ctx.evidence) parts.push('', ctx.evidence)
    parts.push('', 'Transcript:', clipped)
    const userContent = parts.join('\n')

    const raw = await this.request('consult', SYSTEM, userContent, {
      maxTokens: 400,
      temperature: 0.2,
      signal,
      timeoutMs,
    })
    return raw === null ? null : this.parseGuideNote(checkpoint, raw.text)
  }

  /**
   * Short frontier completion for high-leverage read-only work (judge/rewrite).
   * Shares cooldown and timeout with advisory consults but uses the completion budget.
   */
  async complete(
    system: string,
    userContent: string,
    options: FrontierCompletionOptions,
  ): Promise<string | null> {
    return (await this.completeResult(system, userContent, options))?.text ?? null
  }

  async completeResult(
    system: string,
    userContent: string,
    options: FrontierCompletionOptions,
  ): Promise<FrontierCompletionResult | null> {
    return this.request('completion', system, userContent, options)
  }

  private async request(
    kind: 'consult' | 'completion',
    system: string,
    userContent: string,
    options: FrontierCompletionOptions,
  ): Promise<FrontierCompletionResult | null> {
    const fa = this.getConfig()
    if (!this.enabled()) {
      this.lastSkipReason = 'hybrid_disabled'
      return null
    }
    const cfg = getActiveFrontierConfig(fa)
    if (!cfg) {
      this.lastSkipReason = 'hybrid_not_configured'
      return null
    }
    if (Date.now() < this.cooldownUntil) {
      this.lastSkipReason = 'rate_limited'
      return null
    }

    const budgets = readAgentBudgets()
    if (kind === 'consult') {
      if (this.consultCallsThisTurn >= budgets.frontierConsultLimit) {
        this.lastSkipReason = 'consult_budget_exhausted'
        return null
      }
      this.consultCallsThisTurn++
    } else if (this.completionCallsThisTurn >= budgets.frontierCompletionLimit) {
      this.lastSkipReason = 'completion_budget_exhausted'
      return null
    } else {
      this.completionCallsThisTurn++
    }

    try {
      return cfg.provider === 'anthropic'
        ? await this.callAnthropic(cfg.apiKey, cfg.model, system, userContent, options)
        : await this.callOpenAiCompatible(
            cfg.provider === 'moonshot'
              ? 'https://api.moonshot.ai/v1/chat/completions'
              : 'https://api.openai.com/v1/chat/completions',
            cfg.apiKey,
            cfg.model,
            system,
            userContent,
            options,
          )
    } catch {
      this.lastSkipReason = 'frontier_request_failed'
      return null // advisory only — a failed cloud call must never break the loop
    }
  }

  private async callOpenAiCompatible(
    url: string,
    apiKey: string,
    model: string,
    system: string,
    content: string,
    options: FrontierCompletionOptions,
  ): Promise<FrontierCompletionResult | null> {
    const timeout = AbortSignal.timeout(
      Math.max(1, Math.min(REQUEST_TIMEOUT_MS, options.timeoutMs ?? REQUEST_TIMEOUT_MS)),
    )
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content },
        ],
        max_tokens: options.maxTokens,
        temperature: options.temperature,
      }),
      signal,
    })
    if (response.status === 429) {
      this.cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS
      this.lastSkipReason = 'rate_limited'
      return null
    }
    if (!response.ok) return null
    const data = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string }
        finish_reason?: string | null
      }>
      usage?: { prompt_tokens?: number; completion_tokens?: number; output_tokens?: number }
    }
    const choice = data.choices?.[0]
    const text = choice?.message?.content
    if (typeof text !== 'string') return null
    return {
      text,
      truncated: choice?.finish_reason === 'length' || choice?.finish_reason === 'max_tokens',
      tokensIn: data.usage?.prompt_tokens ?? 0,
      tokensOut: data.usage?.completion_tokens ?? data.usage?.output_tokens ?? 0,
    }
  }

  private async callAnthropic(
    apiKey: string,
    model: string,
    system: string,
    content: string,
    options: FrontierCompletionOptions,
  ): Promise<FrontierCompletionResult | null> {
    const timeout = AbortSignal.timeout(
      Math.max(1, Math.min(REQUEST_TIMEOUT_MS, options.timeoutMs ?? REQUEST_TIMEOUT_MS)),
    )
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        system,
        messages: [{ role: 'user', content }],
        max_tokens: options.maxTokens,
        temperature: options.temperature,
      }),
      signal,
    })
    if (response.status === 429) {
      this.cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS
      this.lastSkipReason = 'rate_limited'
      return null
    }
    if (!response.ok) return null
    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>
      stop_reason?: string | null
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    const text = data.content?.find((b) => b.type === 'text')?.text
    if (typeof text !== 'string') return null
    return {
      text,
      truncated: data.stop_reason === 'max_tokens',
      tokensIn: data.usage?.input_tokens ?? 0,
      tokensOut: data.usage?.output_tokens ?? 0,
    }
  }

  private parseGuideNote(checkpoint: Checkpoint, raw: string): GuideNote | null {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start === -1 || end <= start) {
      // Model answered in prose; still useful as a note.
      return { checkpoint, verdict: 'concern', text: raw.trim().slice(0, 600) }
    }
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as { verdict?: string; text?: string }
      if (typeof parsed.text !== 'string') return null
      return {
        checkpoint,
        verdict: parsed.verdict === 'looks_good' ? 'looks_good' : 'concern',
        text: parsed.text.slice(0, 600),
      }
    } catch {
      return { checkpoint, verdict: 'concern', text: raw.trim().slice(0, 600) }
    }
  }
}

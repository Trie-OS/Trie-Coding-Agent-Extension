/**
 * Uncertainty signals for mid-turn hybrid escalation.
 *
 * When the daemon exposes token-level confidence (mean logprob), we use it.
 * Otherwise we fall back to observable loop signals (parse failures, max-token
 * truncation, repeated tools) — same intent as semantic-entropy escalation,
 * without an extra sampling pass.
 */
import type { GenerateResult } from '../inference/types'
import type { ToolCall } from './tools'

const ENTROPY_ESCALATE = 0.62

export class HybridUncertaintyTracker {
  private malformedCount = 0
  private lastTool = ''
  private repeatToolCount = 0
  private lastUncertainty = 0

  noteMalformed(): void {
    this.malformedCount++
  }

  noteGeneration(result: GenerateResult, raw: string, parsedOk: boolean): void {
    let score = result.uncertainty ?? 0
    if (!parsedOk) score = Math.max(score, 0.85)
    if (result.truncated) score = Math.max(score, 0.75)
    if (this.malformedCount > 0) score = Math.max(score, 0.55 + this.malformedCount * 0.1)
    // Very short JSON envelopes often mean the model is guessing.
    if (parsedOk && raw.length < 80) score = Math.max(score, 0.5)
    this.lastUncertainty = Math.min(1, score)
  }

  noteToolCall(call: ToolCall): void {
    if (call.tool === this.lastTool) this.repeatToolCount++
    else {
      this.lastTool = call.tool
      this.repeatToolCount = 1
    }
    if (this.repeatToolCount >= 4) {
      this.lastUncertainty = Math.max(this.lastUncertainty, 0.7)
    }
  }

  shouldEscalate(): boolean {
    return this.lastUncertainty >= ENTROPY_ESCALATE
  }

  snapshot(): number {
    return this.lastUncertainty
  }

  reset(): void {
    this.malformedCount = 0
    this.lastTool = ''
    this.repeatToolCount = 0
    this.lastUncertainty = 0
  }
}

/** Extension-side heuristic when the backend does not report logprob confidence. */
export function heuristicUncertainty(raw: string, parsedOk: boolean): number {
  if (!parsedOk) return 0.9
  let score = 0.15
  if (raw.length < 100) score += 0.2
  if (!/"thought"\s*:/.test(raw)) score += 0.15
  return Math.min(1, score)
}

import type { AgentMode } from './prompts.ts'

const MODE_DEADLINES_MS: Record<AgentMode, number> = {
  code: 8 * 60_000,
  plan: 4 * 60_000,
  ask: 2 * 60_000,
}

const MODE_GENERATION_LIMITS: Record<AgentMode, number> = {
  code: 16,
  plan: 10,
  ask: 8,
}

export class TurnBudget {
  readonly startedAt: number
  readonly deadlineAt: number
  readonly maxLocalGenerations: number
  private localGenerationCount = 0
  private readonly now: () => number

  constructor(
    mode: AgentMode,
    recommendation: boolean,
    now: () => number = Date.now,
  ) {
    this.now = now
    this.startedAt = now()
    this.deadlineAt =
      this.startedAt + (recommendation ? 2 * 60_000 : MODE_DEADLINES_MS[mode])
    this.maxLocalGenerations = recommendation
      ? 6
      : MODE_GENERATION_LIMITS[mode]
  }

  claimLocalGeneration(): boolean {
    if (this.expired() || this.localGenerationCount >= this.maxLocalGenerations) return false
    this.localGenerationCount += 1
    return true
  }

  get localGenerations(): number {
    return this.localGenerationCount
  }

  elapsedMs(): number {
    return Math.max(0, this.now() - this.startedAt)
  }

  remainingMs(): number {
    return Math.max(0, this.deadlineAt - this.now())
  }

  expired(): boolean {
    return this.remainingMs() <= 0
  }

  signal(parent: AbortSignal, maxPhaseMs = Number.POSITIVE_INFINITY): AbortSignal {
    const timeoutMs = Math.max(1, Math.min(this.remainingMs(), maxPhaseMs))
    return AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)])
  }
}

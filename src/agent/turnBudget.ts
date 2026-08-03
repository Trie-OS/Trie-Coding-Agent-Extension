import type { AgentMode } from './prompts.ts'
import { readAgentBudgets } from './agentBudgets.ts'

export class TurnBudget {
  readonly startedAt: number
  readonly deadlineAt: number
  readonly maxLocalGenerations: number
  readonly maxToolLoopGenerations: number
  readonly reservedFinishMs: number
  private localGenerationCount = 0
  private readonly now: () => number

  constructor(
    mode: AgentMode,
    recommendation: boolean,
    now: () => number = Date.now,
  ) {
    const budgets = readAgentBudgets()
    this.now = now
    this.startedAt = now()
    this.deadlineAt =
      this.startedAt +
      (recommendation ? budgets.recommendationDeadlineMs : budgets.modeDeadlinesMs[mode])
    this.maxLocalGenerations = recommendation
      ? budgets.recommendationGenerationLimit
      : budgets.modeGenerationLimits[mode]
    this.maxToolLoopGenerations = this.maxLocalGenerations
    this.reservedFinishMs = budgets.reservedFinishMs
  }

  claimLocalGeneration(): boolean {
    if (this.expired() || this.localGenerationCount >= this.maxToolLoopGenerations) return false
    this.localGenerationCount += 1
    return true
  }

  claimCompactionGeneration(): boolean {
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

  finishReservedMs(): number {
    return Math.max(0, this.remainingMs() - this.reservedFinishMs)
  }

  expired(): boolean {
    return this.remainingMs() <= 0
  }

  signal(parent: AbortSignal, maxPhaseMs = Number.POSITIVE_INFINITY): AbortSignal {
    const timeoutMs = Math.max(1, Math.min(this.remainingMs(), maxPhaseMs))
    return AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)])
  }
}

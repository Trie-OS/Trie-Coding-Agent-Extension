export const RECOMMENDATION_EXPLORATION_MAX_CALLS = 3
export const RECOMMENDATION_LOCAL_BUDGET_MS = 90_000

export function recommendationBudgetReached(
  explorationCalls: number,
  elapsedMs: number,
): boolean {
  return (
    explorationCalls >= RECOMMENDATION_EXPLORATION_MAX_CALLS ||
    elapsedMs >= RECOMMENDATION_LOCAL_BUDGET_MS
  )
}

export function recommendationGenerationTimeout(elapsedMs: number): number {
  return Math.max(1000, RECOMMENDATION_LOCAL_BUDGET_MS - elapsedMs)
}

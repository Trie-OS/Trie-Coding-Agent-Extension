import { readAgentBudgets, type AgentBudgetConfig } from './agentBudgets.ts'

type ExplorationBudget = Pick<
  AgentBudgetConfig,
  'recommendationExplorationCalls' | 'recommendationExplorationMs'
>

const EXPLORATION_DEFAULTS: ExplorationBudget = {
  recommendationExplorationCalls: 3,
  recommendationExplorationMs: 90_000,
}

function resolveExplorationBudgets(budgets?: ExplorationBudget): ExplorationBudget {
  if (budgets) {
    return {
      recommendationExplorationCalls:
        budgets.recommendationExplorationCalls ?? EXPLORATION_DEFAULTS.recommendationExplorationCalls,
      recommendationExplorationMs:
        budgets.recommendationExplorationMs ?? EXPLORATION_DEFAULTS.recommendationExplorationMs,
    }
  }
  const cfg = readAgentBudgets()
  return {
    recommendationExplorationCalls: cfg.recommendationExplorationCalls,
    recommendationExplorationMs: cfg.recommendationExplorationMs,
  }
}

export function recommendationBudgetReached(
  explorationCalls: number,
  elapsedMs: number,
  budgets?: ExplorationBudget,
): boolean {
  const limits = resolveExplorationBudgets(budgets)
  return (
    explorationCalls >= limits.recommendationExplorationCalls ||
    elapsedMs >= limits.recommendationExplorationMs
  )
}

export function recommendationGenerationTimeout(
  elapsedMs: number,
  budgets?: ExplorationBudget,
): number {
  const limits = resolveExplorationBudgets(budgets)
  return Math.max(1000, limits.recommendationExplorationMs - elapsedMs)
}

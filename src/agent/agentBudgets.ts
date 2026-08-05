import type { AgentMode } from './prompts'
import { readConfig } from '../config.ts'

export interface AgentBudgetConfig {
  modeDeadlinesMs: Record<AgentMode, number>
  modeGenerationLimits: Record<AgentMode, number>
  maxCompactionGenerations: number
  recommendationDeadlineMs: number
  recommendationGenerationLimit: number
  recommendationExplorationCalls: number
  recommendationExplorationMs: number
  frontierConsultLimit: number
  frontierCompletionLimit: number
  reservedFinishMs: number
}

const DEFAULTS: AgentBudgetConfig = {
  modeDeadlinesMs: {
    code: 8 * 60_000,
    plan: 4 * 60_000,
    ask: 2 * 60_000,
  },
  modeGenerationLimits: {
    code: 0,
    plan: 10,
    ask: 8,
  },
  maxCompactionGenerations: 2,
  recommendationDeadlineMs: 2 * 60_000,
  recommendationGenerationLimit: 6,
  recommendationExplorationCalls: 3,
  recommendationExplorationMs: 90_000,
  frontierConsultLimit: 4,
  frontierCompletionLimit: 4,
  reservedFinishMs: 45_000,
}

export function readAgentBudgets(): AgentBudgetConfig {
  const cfg = readConfig().agent.budgets
  return {
    modeDeadlinesMs: {
      code: cfg.modeDeadlineCodeMs ?? DEFAULTS.modeDeadlinesMs.code,
      plan: cfg.modeDeadlinePlanMs ?? DEFAULTS.modeDeadlinesMs.plan,
      ask: cfg.modeDeadlineAskMs ?? DEFAULTS.modeDeadlinesMs.ask,
    },
    modeGenerationLimits: {
      // Code mode is never generation-capped; only the turn deadline applies.
      code: 0,
      plan: cfg.modeGenerationsPlan ?? DEFAULTS.modeGenerationLimits.plan,
      ask: cfg.modeGenerationsAsk ?? DEFAULTS.modeGenerationLimits.ask,
    },
    maxCompactionGenerations:
      cfg.maxCompactionGenerations ?? DEFAULTS.maxCompactionGenerations,
    recommendationDeadlineMs:
      cfg.recommendationDeadlineMs ?? DEFAULTS.recommendationDeadlineMs,
    recommendationGenerationLimit:
      cfg.recommendationGenerationLimit ?? DEFAULTS.recommendationGenerationLimit,
    recommendationExplorationCalls:
      cfg.recommendationExplorationCalls ?? DEFAULTS.recommendationExplorationCalls,
    recommendationExplorationMs:
      cfg.recommendationExplorationMs ?? DEFAULTS.recommendationExplorationMs,
    frontierConsultLimit: cfg.frontierConsultLimit ?? DEFAULTS.frontierConsultLimit,
    frontierCompletionLimit: cfg.frontierCompletionLimit ?? DEFAULTS.frontierCompletionLimit,
    reservedFinishMs: cfg.reservedFinishMs ?? DEFAULTS.reservedFinishMs,
  }
}

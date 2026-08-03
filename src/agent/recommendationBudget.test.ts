import assert from 'node:assert/strict'
import test from 'node:test'
import {
  recommendationBudgetReached,
  recommendationGenerationTimeout,
} from './recommendationBudget.ts'

const DEFAULT_EXPLORATION_BUDGET = {
  recommendationExplorationCalls: 3,
  recommendationExplorationMs: 90_000,
} as const

test('recommendation exploration stops at either tool or wall-clock budget', () => {
  assert.equal(
    recommendationBudgetReached(2, 89_999, DEFAULT_EXPLORATION_BUDGET),
    false,
  )
  assert.equal(recommendationBudgetReached(3, 1, DEFAULT_EXPLORATION_BUDGET), true)
  assert.equal(recommendationBudgetReached(0, 90_000, DEFAULT_EXPLORATION_BUDGET), true)
})

test('recommendation generation timeout consumes remaining wall budget', () => {
  assert.equal(recommendationGenerationTimeout(30_000, DEFAULT_EXPLORATION_BUDGET), 60_000)
  assert.equal(recommendationGenerationTimeout(89_500, DEFAULT_EXPLORATION_BUDGET), 1000)
})

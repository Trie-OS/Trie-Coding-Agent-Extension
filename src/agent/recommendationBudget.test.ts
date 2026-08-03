import assert from 'node:assert/strict'
import test from 'node:test'
import {
  recommendationBudgetReached,
  recommendationGenerationTimeout,
} from './recommendationBudget.ts'

test('recommendation exploration stops at either tool or wall-clock budget', () => {
  assert.equal(recommendationBudgetReached(2, 89_999), false)
  assert.equal(recommendationBudgetReached(3, 1), true)
  assert.equal(recommendationBudgetReached(0, 90_000), true)
})

test('recommendation generation timeout consumes remaining wall budget', () => {
  assert.equal(recommendationGenerationTimeout(30_000), 60_000)
  assert.equal(recommendationGenerationTimeout(89_500), 1000)
})

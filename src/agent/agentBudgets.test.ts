import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readAgentBudgets } from './agentBudgets.ts'
import { TurnBudget } from './turnBudget.ts'

describe('readAgentBudgets', () => {
  it('ignores persisted settings and never generation-caps Code mode', () => {
    assert.equal(readAgentBudgets().modeGenerationLimits.code, 0)
    const budget = new TurnBudget('code', false, () => 0)
    assert.equal(budget.maxLocalGenerations, Number.POSITIVE_INFINITY)
  })
})

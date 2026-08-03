import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readAgentBudgets } from './agentBudgets.ts'
import { TurnBudget } from './turnBudget.ts'

describe('TurnBudget', () => {
  it('uses configurable defaults from agent budgets', () => {
    const budget = new TurnBudget('code', false, () => 0)
    const cfg = readAgentBudgets()
    assert.equal(budget.maxLocalGenerations, cfg.modeGenerationLimits.code)
    assert.equal(budget.deadlineAt, cfg.modeDeadlinesMs.code)
    assert.equal(budget.reservedFinishMs, cfg.reservedFinishMs)
  })

  it('reserves finish time separately from remaining deadline', () => {
    const budget = new TurnBudget('ask', false, () => 0)
    assert.equal(budget.finishReservedMs(), budget.remainingMs() - budget.reservedFinishMs)
  })
})

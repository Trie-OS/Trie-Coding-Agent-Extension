import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readAgentBudgets } from './agentBudgets.ts'
import { TurnBudget } from './turnBudget.ts'

describe('TurnBudget', () => {
  it('uses configurable defaults from agent budgets', () => {
    const budget = new TurnBudget('code', false, () => 0)
    const cfg = readAgentBudgets()
    assert.equal(
      budget.maxLocalGenerations,
      cfg.modeGenerationLimits.code === 0
        ? Number.POSITIVE_INFINITY
        : cfg.modeGenerationLimits.code,
    )
    assert.equal(budget.deadlineAt, cfg.modeDeadlinesMs.code)
    assert.equal(budget.reservedFinishMs, cfg.reservedFinishMs)
  })

  it('reserves finish time separately from remaining deadline', () => {
    const budget = new TurnBudget('ask', false, () => 0)
    assert.equal(budget.finishReservedMs(), budget.remainingMs() - budget.reservedFinishMs)
  })

  it('does not consume tool-loop generations for compaction', () => {
    const budget = new TurnBudget('code', false, () => 0)
    assert.ok(budget.claimCompactionGeneration())
    assert.ok(budget.claimCompactionGeneration())
    assert.equal(budget.claimCompactionGeneration(), false)
    assert.equal(budget.localGenerations, 0)
    assert.ok(budget.claimLocalGeneration())
    assert.equal(budget.localGenerations, 1)
  })

  it('treats a zero Code generation limit as unlimited', () => {
    const budget = new TurnBudget('code', false, () => 0)
    assert.equal(budget.maxLocalGenerations, Number.POSITIVE_INFINITY)
    for (let index = 0; index < 100; index++) assert.ok(budget.claimLocalGeneration())
  })

  it('never generation-caps Code mode', () => {
    const budget = new TurnBudget('code', false, () => 0)
    assert.equal(budget.localGenerationBudgetExhausted(), false)
    for (let index = 0; index < 200; index++) budget.claimLocalGeneration()
    assert.equal(budget.localGenerationBudgetExhausted(), false)
  })
})

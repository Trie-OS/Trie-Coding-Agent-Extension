import assert from 'node:assert/strict'
import test from 'node:test'
import type { FrontierAssist, FrontierCompletionOptions } from './frontierAssist.ts'
import type { InferenceClient } from '../inference/types.ts'
import { recommendationBudgetReached } from './recommendationBudget.ts'
import { finishRecommendationAnswer } from './recommendationAnswer.ts'
import { TurnBudget } from './turnBudget.ts'

function localClient(onGenerate: () => void): InferenceClient {
  return {
    describe: () => 'fake local',
    async generate() {
      onGenerate()
      return { text: '', tokensIn: 0, tokensOut: 0, truncated: false }
    },
  }
}

test('recommendation exploration stops at three calls or 90 seconds', () => {
  let now = 0
  const budget = new TurnBudget('ask', true, () => now)
  let calls = 0
  while (!recommendationBudgetReached(calls, budget.elapsedMs())) {
    calls += 1
  }
  assert.equal(calls, 3)

  now = 0
  calls = 0
  while (!recommendationBudgetReached(calls, budget.elapsedMs())) {
    calls += 1
    now += 45_000
  }
  assert.equal(calls, 2)
  assert.equal(budget.elapsedMs(), 90_000)
})

test('frontier judge passes return grounded draft without rewrite', async () => {
  let localCalls = 0
  let frontierCalls = 0
  const frontier = {
    enabled: () => true,
    async completeResult() {
      frontierCalls += 1
      return {
        text: '{"adequate": true, "factuallyGrounded": true, "feedback": "", "rejectedClaims": []}',
        truncated: false,
      }
    },
  } as unknown as FrontierAssist
  const budget = new TurnBudget('ask', true)
  const draft = 'A grounded repository draft with concrete implementation recommendations.'
  const result = await finishRecommendationAnswer(
    localClient(() => {
      localCalls += 1
    }),
    'Recommend harness improvements',
    draft,
    'Evidence notes.',
    { temperature: 0.2, topP: 0.95, maxTokens: 256 },
    new AbortController().signal,
    { frontier, evidence: '[E1] src/agent/loop.ts', budget },
  )
  assert.equal(result, draft)
  assert.equal(localCalls, 0)
  assert.equal(frontierCalls, 1)
  assert.equal(budget.localGenerations, 0)
})

test('frontier failure is bounded by the shared deadline', async () => {
  let now = 119_500
  const budget = new TurnBudget('ask', true, () => now)
  now = 239_000
  const timeouts: number[] = []
  const frontier = {
    enabled: () => true,
    async completeResult(
      _system: string,
      _user: string,
      options: FrontierCompletionOptions,
    ) {
      timeouts.push(options.timeoutMs ?? Number.POSITIVE_INFINITY)
      return null
    },
  } as unknown as FrontierAssist
  const result = await finishRecommendationAnswer(
    localClient(() => assert.fail('Hybrid failure must not fall back locally')),
    'Recommend harness improvements',
    'Unverified draft.',
    'Evidence notes.',
    { temperature: 0.2, topP: 0.95, maxTokens: 256 },
    new AbortController().signal,
    { frontier, evidence: '[E1] src/agent/loop.ts', budget },
  )
  assert.ok(timeouts.every((timeout) => timeout <= 500))
  assert.match(result, /not returning the unverified draft/i)
})

test('stop signal cancels frontier judge without local fallback', async () => {
  let localCalls = 0
  const controller = new AbortController()
  const frontier = {
    enabled: () => true,
    async completeResult(
      _system: string,
      _user: string,
      options: FrontierCompletionOptions,
    ) {
      if (options.signal?.aborted) return null
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      return null
    },
  } as unknown as FrontierAssist
  const pending = finishRecommendationAnswer(
    localClient(() => {
      localCalls += 1
    }),
    'Recommend harness improvements',
    'A grounded repository draft with concrete implementation recommendations.',
    'Evidence notes.',
    { temperature: 0.2, topP: 0.95, maxTokens: 256 },
    controller.signal,
    { frontier, evidence: '[E1] src/agent/loop.ts', budget: new TurnBudget('ask', true) },
  )
  controller.abort()
  const result = await pending
  assert.equal(localCalls, 0)
  assert.match(result, /not returning the unverified draft/i)
})

test('repeatedly truncated synthesis never returns partial text', async () => {
  const responses = [
    {
      text: '{"adequate": false, "factuallyGrounded": false, "feedback": "Needs rewrite", "rejectedClaims": []}',
      truncated: false,
    },
    { text: 'PARTIAL SECRET', truncated: true },
    { text: ' still partial', truncated: true },
    { text: ' still partial', truncated: true },
  ]
  const frontier = {
    enabled: () => true,
    async completeResult() {
      return responses.shift() ?? null
    },
  } as unknown as FrontierAssist
  const result = await finishRecommendationAnswer(
    localClient(() => assert.fail('Hybrid truncation must not fall back locally')),
    'Recommend harness improvements',
    'A grounded repository draft with concrete implementation recommendations.',
    'Evidence notes.',
    { temperature: 0.2, topP: 0.95, maxTokens: 256 },
    new AbortController().signal,
    { frontier, evidence: '[E1] src/agent/loop.ts' },
  )
  assert.doesNotMatch(result, /PARTIAL SECRET/)
  assert.match(result, /rewrite failed/i)
})

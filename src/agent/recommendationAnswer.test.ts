import assert from 'node:assert/strict'
import test from 'node:test'
import type { FrontierAssist } from './frontierAssist.ts'
import type { InferenceClient } from '../inference/types.ts'
import {
  finishRecommendationAnswer,
  isObviouslyFailedRecommendationDraft,
  judgeRecommendationAnswer,
  rewriteRecommendationAnswer,
  stitchSynthesisContinuation,
} from './recommendationAnswer.ts'
import { recommendationTaskNote } from './taskIntent.ts'

test('isObviouslyFailedRecommendationDraft catches only obvious non-answers', () => {
  assert.equal(isObviouslyFailedRecommendationDraft(''), true)
  assert.equal(
    isObviouslyFailedRecommendationDraft(
      'The user asked for recommendations, but I failed to provide actionable changes. I will retry.',
    ),
    true,
  )
  assert.equal(
    isObviouslyFailedRecommendationDraft(
      'Read docs/ARCHITECTURE.md and docs/GETTING-STARTED.md for more information.',
    ),
    true,
  )
  const shallow =
    '1. **loop.ts:** Add more logging, 2. **tools.ts:** Consider exposing more tool options, 3. **prompts.ts:** Implement handlers.'
  assert.equal(isObviouslyFailedRecommendationDraft(shallow), false)
  assert.equal(
    isObviouslyFailedRecommendationDraft(
      '1. loop.ts — refuse vague step_complete; judge depth at finish via LLM rubric.',
    ),
    false,
  )
})

test('recommendationTaskNote does not prescribe a fixed count or template', () => {
  const note = recommendationTaskNote('Recommend ways to improve this agent harness', 'ask')
  assert.match(note, /improvement|Priority gaps/i)
  assert.match(note, /file-grounded|loop\.ts/i)
  assert.doesNotMatch(note, /4–7|4-7/)
  assert.match(note, /read-only|step_complete\.summary/i)
})

test('recommendation judge and rewrite use frontier without local generation', async () => {
  let localCalls = 0
  const local: InferenceClient = {
    describe: () => 'slow local',
    generate: async () => {
      localCalls++
      throw new Error('local generation should not run')
    },
  }
  const responses = [
    '{"adequate": true, "factuallyGrounded": false, "feedback": "The absence claim is unsupported by E1.", "rejectedClaims": [{"claim": "loop.ts is missing", "reason": "E1 proves it exists", "evidenceIds": ["E1"]}]}',
    '### Priority gaps\n1. **loop.ts** — Current: serial self-grade. Gap: redundant pass. Fix: skip it after judge.',
  ]
  const frontierInputs: string[] = []
  const frontier = {
    enabled: () => true,
    completeResult: async (_system: string, user: string) => {
      frontierInputs.push(user)
      const text = responses.shift()
      return text ? { text, truncated: false } : null
    },
  } as unknown as FrontierAssist
  const params = { temperature: 0.2, topP: 0.95, maxTokens: 2048 }
  const signal = new AbortController().signal
  const shallowDraft =
    'Add more logging to loop.ts and expose additional tool options for customization.'
  const evidence = '[E1] read_file src/agent/loop.ts\nexport class AgentSession {}'

  const judgment = await judgeRecommendationAnswer(
    local,
    'How can I improve this agent harness?',
    shallowDraft,
    params,
    signal,
    frontier,
    evidence,
  )
  assert.equal(judgment.adequate, false)
  assert.equal(judgment.factuallyGrounded, false)

  const rewritten = await rewriteRecommendationAnswer(
    local,
    'How can I improve this agent harness?',
    'Read loop.ts.',
    shallowDraft,
    judgment.feedback,
    params,
    signal,
    frontier,
    evidence,
  )
  assert.match(rewritten ?? '', /Priority gaps/)
  assert.equal(frontierInputs.every((input) => input.includes('[E1]')), true)
  assert.equal(localCalls, 0)
})

test('judge fails closed when factual-grounding verdict is missing', async () => {
  const local: InferenceClient = {
    describe: () => 'unused',
    generate: async () => {
      throw new Error('local generation should not run')
    },
  }
  const frontier = {
    enabled: () => true,
    completeResult: async () => ({
      text: '{"adequate": true, "feedback": ""}',
      truncated: false,
    }),
  } as unknown as FrontierAssist
  const judgment = await judgeRecommendationAnswer(
    local,
    'How can I improve this agent harness?',
    'A sufficiently long draft that makes a current-state repository claim.',
    { temperature: 0.2, topP: 0.95, maxTokens: 2048 },
    new AbortController().signal,
    frontier,
    '[E1] read_file src/agent/loop.ts\nexport class AgentSession {}',
  )
  assert.equal(judgment.adequate, false)
  assert.equal(judgment.factuallyGrounded, false)
})

test('passing draft returns directly without rewrite synthesis', async () => {
  const local: InferenceClient = {
    describe: () => 'unused',
    generate: async () => {
      throw new Error('local generation should not run')
    },
  }
  let frontierCalls = 0
  const frontier = {
    enabled: () => true,
    completeResult: async () => {
      frontierCalls++
      return {
        text: '{"adequate": true, "factuallyGrounded": true, "feedback": "", "rejectedClaims": []}',
        truncated: false,
      }
    },
  } as unknown as FrontierAssist
  const draft =
    '1. **loop.ts** — Current: serial self-grade before finish. Gap: redundant pass. Fix: skip hybrid finish when no mutations.'
  const answer = await finishRecommendationAnswer(
    local,
    'How can I improve this agent harness?',
    draft,
    'notes',
    { temperature: 0.2, topP: 0.95, maxTokens: 2048 },
    new AbortController().signal,
    {
      frontier,
      evidence: '[E1] read_file src/agent/loop.ts\nexport class AgentSession {}',
    },
  )
  assert.equal(answer, draft)
  assert.equal(frontierCalls, 1)
})

test('terminal envelope draft is unwrapped before judging and returning', async () => {
  const answer =
    '1. **src/agent/loop.ts** — Preserve terminal summaries before sanitizing provider output.'
  const local: InferenceClient = {
    describe: () => 'unused',
    generate: async () => {
      throw new Error('local generation should not run')
    },
  }
  const frontier = {
    enabled: () => true,
    completeResult: async () => ({
      text: '{"adequate": true, "factuallyGrounded": true, "feedback": "", "rejectedClaims": []}',
      truncated: false,
    }),
  } as unknown as FrontierAssist

  const result = await finishRecommendationAnswer(
    local,
    'How can I improve this agent harness?',
    JSON.stringify({ thought: 'Done', tool: 'step_complete', args: { summary: answer } }),
    'notes',
    { temperature: 0.2, topP: 0.95, maxTokens: 2048 },
    new AbortController().signal,
    {
      frontier,
      evidence: '[E1] read_file src/agent/loop.ts\nexport class AgentSession {}',
    },
  )

  assert.equal(result, answer)
})

test('falls back to evidence-grounded local synthesis when Hybrid fails', async () => {
  let localCalls = 0
  const local: InferenceClient = {
    describe: () => 'local fallback',
    generate: async () => {
      localCalls++
      return {
        text: '### Priority gaps\n1. **src/agent/loop.ts** — Use the explored evidence to make the completion path more resilient.',
        tokensIn: 20,
        tokensOut: 25,
        truncated: false,
      }
    },
  }
  const frontier = {
    enabled: () => true,
    completeResult: async () => null,
  } as unknown as FrontierAssist

  const answer = await finishRecommendationAnswer(
    local,
    'How can I improve this agent harness?',
    'This draft is too vague to be useful.',
    'Read src/agent/loop.ts.',
    { temperature: 0.2, topP: 0.95, maxTokens: 2048 },
    new AbortController().signal,
    {
      frontier,
      evidence: '[E1] read_file src/agent/loop.ts\nexport class AgentSession {}',
    },
  )

  assert.match(answer, /Priority gaps/)
  assert.equal(localCalls, 1)
})

test('internal Hybrid tool envelope is rejected and replaced by a local answer', async () => {
  let localCalls = 0
  const local: InferenceClient = {
    describe: () => 'local fallback',
    generate: async () => {
      localCalls++
      return {
        text: '### Priority gaps\n1. **src/agent/loop.ts** — Retry final synthesis when a provider emits an internal tool call.',
        tokensIn: 20,
        tokensOut: 25,
        truncated: false,
      }
    },
  }
  const responses = [
    {
      text: JSON.stringify({
        thought: 'Inspect another file',
        tool: 'read_file',
        args: { path: 'src/agent/loop.ts' },
      }),
      truncated: false,
    },
  ]
  const frontier = {
    enabled: () => true,
    completeResult: async () => responses.shift() ?? null,
  } as unknown as FrontierAssist

  const answer = await finishRecommendationAnswer(
    local,
    'How can I improve this agent harness?',
    '',
    'Read src/agent/loop.ts.',
    { temperature: 0.2, topP: 0.95, maxTokens: 2048 },
    new AbortController().signal,
    {
      forceRewrite: true,
      frontier,
      evidence: '[E1] read_file src/agent/loop.ts\nexport class AgentSession {}',
    },
  )

  assert.match(answer, /Priority gaps/)
  assert.doesNotMatch(answer, /"tool":"read_file"/)
  assert.equal(localCalls, 1)
})

test('truncated frontier synthesis continues from retained partial text', async () => {
  const local: InferenceClient = {
    describe: () => 'unused',
    generate: async () => {
      throw new Error('local generation should not run')
    },
  }
  const frontierInputs: string[] = []
  const responses = [
    { text: '### Partial answer', truncated: true },
    { text: '\n\nAll remaining sections are present.', truncated: false },
  ]
  const frontier = {
    enabled: () => true,
    completeResult: async (_system: string, user: string) => {
      frontierInputs.push(user)
      return responses.shift() ?? null
    },
  } as unknown as FrontierAssist
  const answer = await rewriteRecommendationAnswer(
    local,
    'How can I improve this agent harness?',
    'notes',
    'draft',
    'rewrite',
    { temperature: 0.2, topP: 0.95, maxTokens: 2048 },
    new AbortController().signal,
    frontier,
    '[E1] read_file src/agent/loop.ts\nexport class AgentSession {}',
  )
  assert.match(answer ?? '', /Partial answer[\s\S]*remaining sections/)
  assert.equal(frontierInputs.length, 2)
  assert.match(frontierInputs[1]!, /continue from the exact cutoff/i)
  assert.doesNotMatch(frontierInputs[1]!, /rewrite the complete answer from the beginning/i)
})

test('stitchSynthesisContinuation removes repeated overlap without losing prior text', () => {
  assert.equal(
    stitchSynthesisContinuation(
      'First section.\nShared sentence.',
      'Shared sentence.\nSecond section.',
    ),
    'First section.\nShared sentence.\nSecond section.',
  )
})

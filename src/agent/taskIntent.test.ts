import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isAbandonedRecommendationFailure,
  isLazyStepCompleteSummary,
  isScopeNarrowingQuestion,
  recommendationTaskNote,
  summaryDeflectsToDocs,
  summaryMissesRecommendationAsk,
  taskNeedsCodebaseExploration,
} from './taskIntent.ts'

test('taskNeedsCodebaseExploration detects recommendation requests', () => {
  assert.equal(taskNeedsCodebaseExploration('Make some recommendations for this project'), true)
  assert.equal(taskNeedsCodebaseExploration('Suggest improvements for the codebase'), true)
  assert.equal(
    taskNeedsCodebaseExploration('Tell me how this agent harness could be improved'),
    true,
  )
  assert.equal(taskNeedsCodebaseExploration('How can I improve the agent harness'), true)
  assert.equal(taskNeedsCodebaseExploration('Fix the login bug'), false)
  assert.equal(taskNeedsCodebaseExploration('hi'), false)
})

test('summaryDeflectsToDocs catches doc handoffs without actionable advice', () => {
  const bad =
    'Agent harness improvement areas: planning mode, inference process, and chat loop. Read docs/HYBRID-ASSIST.md and docs/GETTING-STARTED.md for more information'
  assert.equal(summaryDeflectsToDocs(bad), true)
  assert.equal(
    summaryDeflectsToDocs(
      [
        '1. Gate step_complete on recommendation asks so architecture dumps are refused.',
        '2. Stream thought tokens through ThoughtStreamParser instead of raw JSON.',
        'See docs/ARCHITECTURE.md for background.',
      ].join('\n'),
    ),
    false,
  )
})

test('summaryMissesRecommendationAsk only blocks obvious non-answers before finish', () => {
  const task = 'Tell me how this agent harness could be improved'
  const bad =
    'Agent harness improvement areas: planning mode. Read docs/HYBRID-ASSIST.md for more information'
  assert.equal(summaryMissesRecommendationAsk(task, bad), true)

  const shallow =
    '1. **loop.ts:** Add more logging, 2. **tools.ts:** Consider exposing more tool options, 3. **prompts.ts:** Implement handlers.'
  assert.equal(summaryMissesRecommendationAsk(task, shallow), false)

  const robust =
    '### Priority gaps\n1. **permissions.ts** — session-only allow; gap: no permanent rules. Fix: persist to `.trie-ide/permissions.json`.'
  assert.equal(summaryMissesRecommendationAsk(task, robust), false)
})

test('isScopeNarrowingQuestion detects inappropriate clarifiers', () => {
  assert.equal(
    isScopeNarrowingQuestion({
      questions: [{ question: 'What specific areas of the agent harness would you like to improve?', options: ['Everything', 'Loop'] }],
    }),
    true,
  )
  assert.equal(
    isScopeNarrowingQuestion({
      questions: [{ question: 'Which database should we use for auth?', options: ['Postgres', 'SQLite'] }],
    }),
    false,
  )
})

test('isLazyStepCompleteSummary detects placeholder summaries', () => {
  assert.equal(isLazyStepCompleteSummary('Here are   ...'), true)
  assert.equal(isLazyStepCompleteSummary('Here are my recommendations...'), true)
  assert.equal(isLazyStepCompleteSummary("I'll look into that…"), true)
  assert.equal(isLazyStepCompleteSummary('Done.'), false)
  assert.equal(
    isLazyStepCompleteSummary(
      '1. **Architecture** — split daemon and extension concerns.\n2. **Tests** — add coverage for tool parsing.',
    ),
    false,
  )
})

test('recommendationTaskNote lightly routes without a fixed format', () => {
  const note = recommendationTaskNote('Recommend ways to improve this agent harness', 'ask')
  assert.match(note, /improvement|Priority gaps/i)
  assert.doesNotMatch(note, /4–7|4-7/)
  assert.equal(recommendationTaskNote('Fix the login bug', 'code'), '')
})

test('isAbandonedRecommendationFailure catches meta-apology step_failed reasons', () => {
  const task = 'Recommend ways I can improve this agent harness'
  assert.equal(
    isAbandonedRecommendationFailure(
      task,
      'The user explicitly asked for concrete recommendations, but I failed to provide actionable changes. I misunderstood the task; I will retry with a proper action plan based on the file analysis.',
    ),
    true,
  )
  assert.equal(
    isAbandonedRecommendationFailure(task, 'Blocked: no workspace folder is open.'),
    false,
  )
})

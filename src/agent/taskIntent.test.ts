import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isAbandonedRecommendationFailure,
  isLazyStepCompleteSummary,
  recommendationTaskNote,
  summaryMissesRecommendationAsk,
  taskNeedsCodebaseExploration,
} from './taskIntent.ts'

test('taskNeedsCodebaseExploration detects recommendation requests', () => {
  assert.equal(taskNeedsCodebaseExploration('Make some recommendations for this project'), true)
  assert.equal(taskNeedsCodebaseExploration('Suggest improvements for the codebase'), true)
  assert.equal(taskNeedsCodebaseExploration('Fix the login bug'), false)
  assert.equal(taskNeedsCodebaseExploration('hi'), false)
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

test('summaryMissesRecommendationAsk catches architecture dumps without advice', () => {
  const task = 'Recommend improvements to the agent harness we have here.'
  const dump = [
    '### Analysis',
    'chat.ts Orchestrates single-agent runs and the agent lifecycle.',
    'subagents.ts Handles multi-agent workflows.',
    'plan.ts Manages planning-mode state.',
    'All the core logic and interdependencies are now fully documented and understood.',
    'No additional files are required for this analysis.',
  ].join(' ')
  assert.equal(summaryMissesRecommendationAsk(task, dump), true)
  assert.equal(
    summaryMissesRecommendationAsk(
      task,
      [
        '### Recommendations',
        '1. Make edit_file line-anchored by default — reduces search drift failures.',
        '2. Gate step_complete on recommendation asks so architecture dumps are refused.',
        '3. Consider verifying harness contracts with focused loop tests.',
      ].join('\n'),
    ),
    false,
  )
})

test('recommendationTaskNote lightly routes without a fixed format', () => {
  const note = recommendationTaskNote('Recommend ways to improve this agent harness', 'ask')
  assert.match(note, /recommendations/i)
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

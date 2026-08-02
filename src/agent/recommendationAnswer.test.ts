import assert from 'node:assert/strict'
import test from 'node:test'
import { isObviouslyFailedRecommendationDraft } from './recommendationAnswer.ts'
import { recommendationTaskNote } from './taskIntent.ts'

test('isObviouslyFailedRecommendationDraft catches apologies only', () => {
  assert.equal(isObviouslyFailedRecommendationDraft(''), true)
  assert.equal(
    isObviouslyFailedRecommendationDraft(
      'The user asked for recommendations, but I failed to provide actionable changes. I will retry.',
    ),
    true,
  )
  assert.equal(
    isObviouslyFailedRecommendationDraft(
      'Consider making edit_file line-anchored after reads so small models do not retype search blocks.',
    ),
    false,
  )
})

test('recommendationTaskNote does not prescribe a fixed count or template', () => {
  const note = recommendationTaskNote('Recommend ways to improve this agent harness', 'ask')
  assert.match(note, /recommendations/i)
  assert.doesNotMatch(note, /4–7|4-7|must list/i)
  assert.match(note, /read-only|step_complete\.summary/i)
})

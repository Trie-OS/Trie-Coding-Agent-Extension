import { describe, expect, it } from 'vitest'
import { isPrematureStepFailedReason } from './agent'

describe('isPrematureStepFailedReason', () => {
  it('flags ambiguity and clarification give-ups', () => {
    expect(isPrematureStepFailedReason('The user request is ambiguous about exact location')).toBe(
      true,
    )
    expect(isPrematureStepFailedReason('Need more information before implementing')).toBe(true)
    expect(isPrematureStepFailedReason('Unclear which component to edit')).toBe(true)
    expect(isPrematureStepFailedReason('Should ask the user for clarification')).toBe(true)
    expect(isPrematureStepFailedReason('Not sure which option to pick')).toBe(true)
    expect(isPrematureStepFailedReason('Requirements are underspecified')).toBe(true)
  })

  it('allows genuine blockers', () => {
    expect(isPrematureStepFailedReason('Permission denied writing to /etc/hosts')).toBe(false)
    expect(isPrematureStepFailedReason('Required API key is missing from environment')).toBe(false)
    expect(isPrematureStepFailedReason('File src/missing.ts does not exist')).toBe(false)
    expect(isPrematureStepFailedReason('Contradictory requirements: add and remove the same file')).toBe(
      false,
    )
  })
})

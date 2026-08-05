import { describe, expect, it } from 'vitest'
import { parseGuideNoteResponse, guideNoteLabel } from './guideNote'

describe('guideNote', () => {
  it('parses JSON responses', () => {
    expect(
      parseGuideNoteResponse(
        'plan_critique',
        '{"verdict":"concerns","text":"Step 2 lacks a verification."}',
      ),
    ).toMatchObject({ verdict: 'concerns' })
  })

  it('falls back to plain text', () => {
    const note = parseGuideNoteResponse('stuck_hint', 'Try grep for the symbol first.')
    expect(note?.text).toContain('grep')
    expect(note?.verdict).toBe('hint')
  })

  it('labels checkpoints', () => {
    expect(
      guideNoteLabel({ checkpoint: 'stuck_hint', verdict: 'hint', text: 'x' }),
    ).toBe('Hybrid · suggestion for local model')
  })
})

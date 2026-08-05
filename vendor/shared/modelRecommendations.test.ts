import { describe, expect, it } from 'vitest'
import { recommendationForRam } from '@shared/modelRecommendations'

const GB = 1024 * 1024 * 1024

describe('recommendationForRam', () => {
  it('picks 3B tier for 8 GB machines', () => {
    expect(recommendationForRam(8 * GB).displayName).toContain('3B')
  })

  it('picks 7B tier for 16 GB machines', () => {
    expect(recommendationForRam(16 * GB).displayName).toContain('7B')
  })

  it('picks 14B tier for 32 GB machines', () => {
    expect(recommendationForRam(32 * GB).displayName).toContain('14B')
  })
})

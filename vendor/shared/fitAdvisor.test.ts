import { describe, expect, it } from 'vitest'
import {
  describeFit,
  estimateFit,
  estimateKvCacheHeuristic,
  estimateModelRamNeed,
  kvCacheBytes,
  OVERHEAD_BYTES,
  ramBudgetGuidance,
} from './fitAdvisor'

const GB = 1024 * 1024 * 1024

describe('kvCacheBytes', () => {
  it('matches the MODELS.md formula', () => {
    const bytes = kvCacheBytes({ ctxLen: 4096, nLayers: 32, nKvHeads: 8, headDim: 128 })
    expect(bytes).toBe(2 * 32 * 4096 * 8 * 128 * 2)
  })
})

describe('estimateFit', () => {
  it('badges a small model on a big machine as fits', () => {
    const estimate = estimateFit({
      fileSizeBytes: 4.7 * GB,
      kvCacheBytes: 0.5 * GB,
      physicalRamBytes: 24 * GB,
    })
    expect(estimate.badge).toBe('fits')
    expect(estimate.neededBytes).toBeCloseTo(4.7 * GB + 0.5 * GB + OVERHEAD_BYTES, 0)
  })

  it("badges an oversized model as won't-fit", () => {
    const estimate = estimateFit({
      fileSizeBytes: 40 * GB,
      kvCacheBytes: 2 * GB,
      physicalRamBytes: 16 * GB,
    })
    expect(estimate.badge).toBe('wont-fit')
  })
})

describe('estimateModelRamNeed', () => {
  it('includes weights, heuristic KV, and overhead', () => {
    const model = { sizeBytes: 40 * GB, ctxLen: 131_072 }
    const kv = estimateKvCacheHeuristic(model)
    expect(estimateModelRamNeed(model)).toBeCloseTo(40 * GB + kv + OVERHEAD_BYTES, 0)
  })

  it('returns 0 for API-style zero-byte models', () => {
    expect(estimateModelRamNeed({ sizeBytes: 0, ctxLen: 128_000 })).toBe(0)
  })
})

describe('ramBudgetGuidance', () => {
  it('derives budget from physical RAM without naming a model', () => {
    const guidance = ramBudgetGuidance(64 * GB)
    expect(guidance.physicalRamGb).toBeCloseTo(64, 0)
    expect(guidance.budgetGb).toBeCloseTo(48, 0)
    expect(guidance.summary).toContain('64 GB RAM')
    expect(guidance.summary).not.toContain('Qwen')
  })
})

describe('describeFit', () => {
  it('renders the actual numbers', () => {
    const estimate = estimateFit({
      fileSizeBytes: 9 * GB,
      kvCacheBytes: 0.7 * GB,
      physicalRamBytes: 24 * GB,
    })
    expect(describeFit(estimate, 24 * GB)).toMatch(/needs ~1[01]\.\d GB of your 24\.0 GB/)
  })
})

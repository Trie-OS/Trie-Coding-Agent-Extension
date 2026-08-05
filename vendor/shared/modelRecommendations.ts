/**
 * Curated coder-model picks by RAM tier (onboarding + settings guidance).
 */
export interface ModelRecommendation {
  /** Minimum RAM (GB) for this tier — inclusive. */
  minRamGb: number
  /** Upper bound (GB), exclusive; null = no upper limit. */
  maxRamGb: number | null
  displayName: string
  /** Preferred quant label when scanning or choosing files. */
  quant: string
  approximateSizeGb: number
  notes: string
}

export const MODEL_RECOMMENDATIONS: readonly ModelRecommendation[] = [
  {
    minRamGb: 0,
    maxRamGb: 12,
    displayName: 'Qwen2.5-Coder-3B-Instruct Q4_K_M',
    quant: 'Q4_K_M',
    approximateSizeGb: 2,
    notes: 'Usable for chat; planning will be weak.',
  },
  {
    minRamGb: 12,
    maxRamGb: 24,
    displayName: 'Qwen2.5-Coder-7B-Instruct Q4_K_M',
    quant: 'Q4_K_M',
    approximateSizeGb: 4.7,
    notes: 'The onboarding default for most laptops.',
  },
  {
    minRamGb: 24,
    maxRamGb: 48,
    displayName: 'Qwen2.5-Coder-14B-Instruct Q4_K_M',
    quant: 'Q4_K_M',
    approximateSizeGb: 9,
    notes: 'Sweet spot for Plan mode.',
  },
  {
    minRamGb: 48,
    maxRamGb: 64,
    displayName: 'Qwen2.5-Coder-32B-Instruct Q4_K_M',
    quant: 'Q4_K_M',
    approximateSizeGb: 20,
    notes: 'Genuinely strong agentic coding.',
  },
  {
    minRamGb: 64,
    maxRamGb: null,
    displayName: 'Llama-3.3-70B Q4',
    quant: 'Q4_K_M',
    approximateSizeGb: 40,
    notes: 'Drive read speed dominates load time.',
  },
] as const

/** Pick the best recommendation for the machine's physical RAM. */
export function recommendationForRam(physicalRamBytes: number): ModelRecommendation {
  const ramGb = physicalRamBytes / (1024 * 1024 * 1024)
  const match =
    MODEL_RECOMMENDATIONS.find(
      (r) => ramGb >= r.minRamGb && (r.maxRamGb === null || ramGb < r.maxRamGb),
    ) ?? MODEL_RECOMMENDATIONS[MODEL_RECOMMENDATIONS.length - 1]!
  return match
}

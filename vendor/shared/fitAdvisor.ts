/**
 * Fit advisor (MODELS.md §"The fit advisor"): estimate whether a GGUF model
 * fits in physical RAM and badge it Fits / Tight / Won't fit with real
 * numbers — never a silent "just try it".
 *
 * Pure math — safe to import from main and renderer.
 */

/** Fraction of physical RAM the advisor budgets for a single loaded model. */
export const BUDGET_FRACTION = 0.75
/** Fixed compute-buffer + app overhead allowance, per MODELS.md. */
export const OVERHEAD_BYTES = 1.5 * 1024 * 1024 * 1024

export type FitBadge = 'fits' | 'tight' | 'wont-fit'

export interface KvCacheParams {
  ctxLen: number
  nLayers: number
  nKvHeads: number
  headDim: number
  /** Bytes per KV element; f16 = 2. */
  bytesPerElement?: number
}

/** `2 * nLayers * ctxLen * nKvHeads * headDim * bytesPerElement` (MODELS.md). */
export function kvCacheBytes(params: KvCacheParams): number {
  const { ctxLen, nLayers, nKvHeads, headDim, bytesPerElement = 2 } = params
  return 2 * nLayers * ctxLen * nKvHeads * headDim * bytesPerElement
}

export interface FitEstimateInput {
  /** GGUF file size on disk (weights, mmap'd). */
  fileSizeBytes: number
  /** KV cache footprint for the requested context length, or 0 if unknown. */
  kvCacheBytes: number
  physicalRamBytes: number
}

export interface FitEstimate {
  neededBytes: number
  budgetBytes: number
  ratio: number
  badge: FitBadge
}

/**
 * `neededBytes = fileSize + kvCache + overhead` vs `budget = 0.75 * RAM`.
 * Badges: Fits < 60% of budget, Tight 60-100%, Won't fit > 100%.
 */
export function estimateFit(input: FitEstimateInput): FitEstimate {
  const neededBytes = input.fileSizeBytes + input.kvCacheBytes + OVERHEAD_BYTES
  const budgetBytes = BUDGET_FRACTION * input.physicalRamBytes
  const ratio = budgetBytes > 0 ? neededBytes / budgetBytes : Infinity
  const badge: FitBadge = ratio > 1 ? 'wont-fit' : ratio >= 0.6 ? 'tight' : 'fits'
  return { neededBytes, budgetBytes, ratio, badge }
}

/** Rough KV cache when layer metadata isn't on the model row yet. */
export function estimateKvCacheHeuristic(model: {
  sizeBytes: number
  ctxLen: number | null
}): number {
  if (model.sizeBytes <= 0) return 0
  const ctx = model.ctxLen ?? 8192
  // Scales ~2% of weight size per 8k ctx step — order-of-magnitude per MODELS.md.
  return model.sizeBytes * 0.02 * (ctx / 8192)
}

/** Total estimated RAM to load a local GGUF (weights + KV + overhead). */
export function estimateModelRamNeed(model: { sizeBytes: number; ctxLen: number | null }): number {
  if (model.sizeBytes <= 0) return 0
  return model.sizeBytes + estimateKvCacheHeuristic(model) + OVERHEAD_BYTES
}

export interface RamBudgetGuidance {
  physicalRamGb: number
  budgetGb: number
  summary: string
}

/** Dynamic RAM guidance for onboarding — no hardcoded model names. */
export function ramBudgetGuidance(physicalRamBytes: number): RamBudgetGuidance {
  const physicalRamGb = physicalRamBytes / (1024 * 1024 * 1024)
  const budgetGb = (BUDGET_FRACTION * physicalRamBytes) / (1024 * 1024 * 1024)
  return {
    physicalRamGb,
    budgetGb,
    summary: `Your Mac has ${physicalRamGb.toFixed(0)} GB RAM. Models under ~${budgetGb.toFixed(0)} GB estimated RAM should load comfortably.`,
  }
}

function gib(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1)
}

/** Human string like "needs ~11.2 GB of your 24 GB" — always shown with the badge. */
export function describeFit(estimate: FitEstimate, physicalRamBytes: number): string {
  return `needs ~${gib(estimate.neededBytes)} GB of your ${gib(physicalRamBytes)} GB`
}

export function fitBadgeLabel(badge: FitBadge): string {
  if (badge === 'wont-fit') return "Won't fit"
  if (badge === 'tight') return 'Tight'
  return 'Fits'
}

/**
 * Collapse duplicate registry rows that point at the same logical model
 * (e.g. the same GGUF scanned into multiple LM Studio folder stores).
 */
import type { Model, ModelStore } from './ipc-contract'

export function modelIdentityKey(model: Model): string {
  return `${model.displayName}\0${model.sizeBytes}\0${model.quant ?? ''}`
}

function pickerScore(model: Model, store: ModelStore | undefined): number {
  let score = 0
  if (model.status === 'available') score += 100
  if (store?.mounted) score += 50
  if (store?.kind === 'internal_folder') score += 20
  else if (store?.kind === 'scanned_folder') score += 10
  if (model.lastUsedAt) score += 1
  return score
}

/** Keep one row per display name + size + quant; prefer available, mounted stores. */
export function dedupeModelsForPicker(models: Model[], stores: ModelStore[]): Model[] {
  const storeById = new Map(stores.map((s) => [s.id, s]))
  const best = new Map<string, Model>()

  for (const model of models) {
    const key = modelIdentityKey(model)
    const store = storeById.get(model.storeId)
    const prev = best.get(key)
    if (!prev || pickerScore(model, store) > pickerScore(prev, storeById.get(prev.storeId))) {
      best.set(key, model)
    }
  }

  return [...best.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
}

/**
 * If `modelId` was from an unmounted duplicate store, return a surviving
 * registry row with the same identity. Otherwise keep the id, or null if gone.
 */
export function coerceLiveModelId(modelId: string | null, models: Model[]): string | null {
  if (!modelId) return null
  if (models.some((m) => m.id === modelId)) return modelId
  return null
}

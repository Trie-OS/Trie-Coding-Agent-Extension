/**
 * Shared constants + helpers for the local MLX inference provider.
 *
 * MLX uses `mlx_lm.server` (a Python OpenAI-compatible server). The provider
 * spawns it as a subprocess and then reuses the same HTTP streaming logic as
 * the API provider.
 */
import type { Model, ModelStore } from './ipc-contract'

/** Synthetic registry id — not a DB row; injected into `models:list` when enabled. */
export const MLX_PROVIDER_MODEL_ID = 'mlx:local'
export const MLX_PROVIDER_STORE_ID = 'mlx:local-store'

export function isMlxProviderModelId(modelId: string): boolean {
  return modelId === MLX_PROVIDER_MODEL_ID
}

export function syntheticMlxStore(): ModelStore {
  return {
    id: MLX_PROVIDER_STORE_ID,
    label: 'MLX provider',
    kind: 'mlx',
    volumeHint: null,
    remoteHostId: null,
    remotePath: null,
    remoteHostName: null,
    readMbps: null,
    lastSeenAt: Date.now(),
    mounted: true,
  }
}

export function syntheticMlxModel(): Model {
  return {
    id: MLX_PROVIDER_MODEL_ID,
    storeId: MLX_PROVIDER_STORE_ID,
    displayName: 'MLX local server',
    hfRepoId: null,
    hfFile: null,
    quant: null,
    sizeBytes: 0,
    sha256: '',
    arch: 'mlx',
    paramsB: null,
    ctxLen: 32768,
    chatTemplate: null,
    supportsVision: false,
    status: 'available',
    addedAt: Date.now(),
    lastUsedAt: null,
  }
}

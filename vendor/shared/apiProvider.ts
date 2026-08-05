/**
 * Shared constants + helpers for the OpenAI-compatible API inference provider
 * (Kimi K3, opencodex, or any local `/v1/chat/completions` proxy).
 */
import type { GenerationParams } from './inference'
import type { Model, ModelStore } from './ipc-contract'
import { isMlxProviderModelId } from './mlxProvider'

/** Synthetic registry id — not a DB row; injected into `models:list` when enabled. */
export const API_PROVIDER_MODEL_ID = 'api:external'
export const API_PROVIDER_STORE_ID = 'api:external-store'

/** Many OpenAI-compatible endpoints (Kimi, etc.) only accept temperature 1. */
export const API_PROVIDER_DEFAULT_TEMPERATURE = 1

export function isApiProviderModelId(modelId: string): boolean {
  return modelId === API_PROVIDER_MODEL_ID
}

/** Apply API-provider sampling defaults on top of app generation settings. */
export function generationParamsForApiProvider(params: GenerationParams): GenerationParams {
  return { ...params, temperature: API_PROVIDER_DEFAULT_TEMPERATURE }
}

export function generationParamsForModel(
  modelId: string,
  params: GenerationParams,
): GenerationParams {
  return isApiProviderModelId(modelId) ? generationParamsForApiProvider(params) : params
}

export function coerceDbModelId(modelId: string | null | undefined): string | null {
  if (!modelId) return null
  return isApiProviderModelId(modelId) || isMlxProviderModelId(modelId) ? null : modelId
}

export function syntheticApiStore(): ModelStore {
  return {
    id: API_PROVIDER_STORE_ID,
    label: 'API provider',
    kind: 'api',
    volumeHint: null,
    remoteHostId: null,
    remotePath: null,
    remoteHostName: null,
    readMbps: null,
    lastSeenAt: Date.now(),
    mounted: true,
  }
}

export function syntheticApiModel(modelName: string): Model {
  const display = modelName.trim() || 'API model'
  return {
    id: API_PROVIDER_MODEL_ID,
    storeId: API_PROVIDER_STORE_ID,
    displayName: display,
    hfRepoId: null,
    hfFile: null,
    quant: null,
    sizeBytes: 0,
    sha256: '',
    arch: 'api',
    paramsB: null,
    ctxLen: 128_000,
    chatTemplate: null,
    supportsVision: true,
    status: 'available',
    addedAt: Date.now(),
    lastUsedAt: null,
  }
}

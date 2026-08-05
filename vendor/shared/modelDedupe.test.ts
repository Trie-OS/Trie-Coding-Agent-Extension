import { describe, expect, it } from 'vitest'
import { coerceLiveModelId, dedupeModelsForPicker } from './modelDedupe'
import type { Model, ModelStore } from './ipc-contract'

function model(overrides: Partial<Model> & Pick<Model, 'id' | 'storeId'>): Model {
  return {
    displayName: 'gemma-2-27b-it-Q4_K_M',
    hfRepoId: null,
    hfFile: null,
    quant: 'Q4_K_M',
    sizeBytes: 15_500_000_000,
    sha256: '',
    arch: 'gemma2',
    paramsB: 27,
    ctxLen: 8192,
    chatTemplate: null,
    supportsVision: false,
    status: 'available',
    addedAt: 1,
    lastUsedAt: null,
    ...overrides,
  }
}

function store(overrides: Partial<ModelStore> & Pick<ModelStore, 'id'>): ModelStore {
  return {
    label: 'lmstudio',
    kind: 'scanned_folder',
    volumeHint: '/tmp/models',
    remoteHostId: null,
    remotePath: null,
    remoteHostName: null,
    readMbps: null,
    lastSeenAt: null,
    mounted: true,
    ...overrides,
  }
}

describe('dedupeModelsForPicker', () => {
  it('keeps one model when the same GGUF is registered in multiple stores', () => {
    const stores = [
      store({ id: 's1', label: 'lmstudio', mounted: true }),
      store({ id: 's2', label: 'lmstudio-community', mounted: false }),
    ]
    const models = [
      model({ id: 'm1', storeId: 's1', status: 'available' }),
      model({ id: 'm2', storeId: 's2', status: 'offline' }),
    ]
    expect(dedupeModelsForPicker(models, stores)).toEqual([models[0]])
  })

  it('prefers an available mounted copy over offline duplicates', () => {
    const stores = [
      store({ id: 's1', mounted: false }),
      store({ id: 's2', mounted: true }),
    ]
    const models = [
      model({ id: 'm1', storeId: 's1', status: 'offline' }),
      model({ id: 'm2', storeId: 's2', status: 'available' }),
    ]
    expect(dedupeModelsForPicker(models, stores)).toEqual([models[1]])
  })
})

describe('coerceLiveModelId', () => {
  it('returns null when the selected id was removed from the registry', () => {
    const models = [model({ id: 'live', storeId: 's1' })]
    expect(coerceLiveModelId('dead-id', models)).toBeNull()
    expect(coerceLiveModelId('live', models)).toBe('live')
    expect(coerceLiveModelId(null, models)).toBeNull()
  })
})

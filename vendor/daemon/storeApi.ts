/**
 * Store scan/init helpers for the `trie-daemon` daemon (MODELS.md layout).
 */
import { readdirSync } from 'node:fs'
import { posix } from 'node:path'
import {
  hasStoreManifest,
  initializeDriveStore,
  MODELS_SUBDIR,
  modelsDirOf,
  readModelManifest,
  readStoreManifest,
  storeDirNameOf,
} from '../main/services/driveManifest'

export interface DaemonStoreModel {
  modelId: string
  displayName: string
  relPath: string
  quant: string
  sizeBytes: number
  sha256: string
  hfRepoId: string
  hfFile: string
  arch: string | null
  paramsB: number | null
  ctxLen: number | null
  chatTemplate: string | null
  partFiles: string[] | null
}

export interface DaemonStoreInfo {
  storeId: string
  label: string
  volumePath: string
  models: DaemonStoreModel[]
}

export function scanStoreVolume(volumePath: string): DaemonStoreInfo | null {
  if (!hasStoreManifest(volumePath)) return null
  const storeManifest = readStoreManifest(volumePath)
  let slugs: string[] = []
  try {
    slugs = readdirSync(modelsDirOf(volumePath), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const models: DaemonStoreModel[] = []
  for (const slug of slugs) {
    const manifest = readModelManifest(volumePath, slug)
    models.push({
      modelId: manifest.modelId,
      displayName: manifest.displayName,
      relPath: posix.join(storeDirNameOf(volumePath), MODELS_SUBDIR, slug),
      quant: manifest.quant,
      sizeBytes: manifest.sizeBytes,
      sha256: manifest.sha256,
      hfRepoId: manifest.hf.repoId,
      hfFile: manifest.hf.file,
      arch: manifest.arch ?? null,
      paramsB: manifest.paramsB ?? null,
      ctxLen: manifest.ctxLen ?? null,
      chatTemplate: manifest.chatTemplate ?? null,
      partFiles: manifest.partFiles ?? null,
    })
  }

  return {
    storeId: storeManifest.storeId,
    label: storeManifest.label,
    volumePath,
    models,
  }
}

export function initStoreVolume(volumePath: string, label: string): DaemonStoreInfo {
  if (!hasStoreManifest(volumePath)) {
    initializeDriveStore(volumePath, label)
  }
  return scanStoreVolume(volumePath)!
}

/**
 * Drive-store manifest format (MODELS.md §"On-disk layout").
 *
 * A drive becomes a model store when `TrieModels/store.json` exists.
 * Each model folder under `TrieModels/models/<slug>/` is
 * self-describing via its own `manifest.json` — the whole drive is portable
 * to another machine (a fresh install scans and adopts everything).
 *
 * Fail-loudly policy: a store.json or manifest.json that exists but doesn't
 * parse/validate is a typed error, never silently skipped — a half-written
 * or hand-edited file should be visible, not invisible.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
import { z } from 'zod'
import { ForgeError } from '@shared/errors'
import {
  TRIE_MODELS_DIR,
  STORE_MANIFEST_FILE,
  MODELS_SUBDIR,
  MODEL_MANIFEST_FILE,
  resolveStoreRoot,
  hasStoreManifest as diskHasStoreManifest,
  hasStoreManifestSafe as diskHasStoreManifestSafe,
  modelsDirOf as preferredModelsDirOf,
  storeManifestPathOf as preferredStoreManifestPathOf,
} from '@shared/diskLayout'

export {
  TRIE_MODELS_DIR,
  STORE_MANIFEST_FILE,
  MODELS_SUBDIR,
  MODEL_MANIFEST_FILE,
} from '@shared/diskLayout'

function fsFail(operation: string, path: string, error: unknown): never {
  throw new ForgeError(
    'FS_OPERATION_FAILED',
    `${operation} failed for ${path}: ${error instanceof Error ? error.message : String(error)}`,
    { path, errno: (error as NodeJS.ErrnoException).code },
  )
}

/**
 * External-drive stores must live at the volume mount root (`/Volumes/DriveName`),
 * not a nested folder — TrieModels/ is always created there.
 */
export function normalizeExternalVolumePath(path: string): string {
  const resolved = resolve(path).replace(/\/+$/, '') || '/'
  const match = /^(\/Volumes\/[^/]+)/.exec(resolved)
  if (match?.[1] && match[1] !== resolved) return match[1]
  return resolved
}

export function storeRootOf(volumePath: string): string | null {
  return resolveStoreRoot(volumePath)
}

/** Store folder name relative to the volume root (`TrieModels`, etc.). */
export function storeDirNameOf(volumePath: string): string {
  return basename(resolveStoreRoot(volumePath) ?? join(volumePath, TRIE_MODELS_DIR))
}

export function modelsDirOf(volumePath: string): string {
  const root = resolveStoreRoot(volumePath)
  return root ? join(root, MODELS_SUBDIR) : preferredModelsDirOf(volumePath)
}

export function storeManifestPathOf(volumePath: string): string {
  const root = resolveStoreRoot(volumePath)
  return root ? join(root, STORE_MANIFEST_FILE) : preferredStoreManifestPathOf(volumePath)
}

export function modelDirOf(volumePath: string, slug: string): string {
  return join(modelsDirOf(volumePath), slug)
}

/** True if `volumePath` already looks like a Trie IDE model store. */
export function hasStoreManifest(volumePath: string): boolean {
  try {
    return diskHasStoreManifest(volumePath)
  } catch (error) {
    fsFail('check store manifest', storeManifestPathOf(volumePath), error)
  }
}

/** Like `hasStoreManifest` but never throws — used when polling /Volumes. */
export function hasStoreManifestSafe(volumePath: string): boolean {
  return diskHasStoreManifestSafe(volumePath)
}

export const storeManifestSchema = z.object({
  schemaVersion: z.literal(1),
  storeId: z.string().min(1),
  createdAt: z.string().min(1),
  label: z.string().min(1),
})
export type StoreManifest = z.infer<typeof storeManifestSchema>

export const modelManifestSchema = z.object({
  schemaVersion: z.literal(1),
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  hf: z.object({
    repoId: z.string().min(1),
    file: z.string().min(1),
    revision: z.string().min(1),
  }),
  quant: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().min(1),
  arch: z.string().nullable().optional(),
  paramsB: z.number().nullable().optional(),
  ctxLen: z.number().int().positive().nullable().optional(),
  chatTemplate: z.string().nullable().optional(),
  downloadedAt: z.string().min(1),
  /**
   * The exact downloaded filename(s), in shard-part order — see migration
   * 005 / `models.part_files`. Optional so a manifest written before this
   * field existed still parses; `modelRegistry.ts`'s reconcile-on-mount
   * treats a missing value as `null` (directory-scan fallback), same as any
   * other pre-migration row.
   */
  partFiles: z.array(z.string().min(1)).min(1).optional(),
})
export type ModelManifest = z.infer<typeof modelManifestSchema>

/** Read + validate `store.json`. Throws DRIVE_MANIFEST_CORRUPT if malformed. */
export function readStoreManifest(volumePath: string): StoreManifest {
  const path = storeManifestPathOf(volumePath)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new ForgeError('DRIVE_MANIFEST_CORRUPT', `Can't read store manifest at ${path}`, {
      path,
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ForgeError('DRIVE_MANIFEST_CORRUPT', `store.json is not valid JSON: ${path}`, {
      path,
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  const result = storeManifestSchema.safeParse(parsed)
  if (!result.success) {
    throw new ForgeError(
      'DRIVE_MANIFEST_CORRUPT',
      `store.json failed validation: ${z.prettifyError(result.error)}`,
      { path },
    )
  }
  return result.data
}

/**
 * Create the `TrieModels/` layout + `store.json` on a fresh drive.
 * Throws DRIVE_ALREADY_A_STORE if a manifest already exists — initialization
 * is one-shot per drive, never a silent overwrite.
 */
export function initializeDriveStore(volumePath: string, label: string): StoreManifest {
  const root = normalizeExternalVolumePath(volumePath)
  if (hasStoreManifest(root)) {
    throw new ForgeError('DRIVE_ALREADY_A_STORE', `${root} is already a model store`, {
      volumePath: root,
    })
  }
  try {
    mkdirSync(preferredModelsDirOf(root), { recursive: true })
  } catch (error) {
    fsFail('create model store directory', preferredModelsDirOf(root), error)
  }
  const manifest: StoreManifest = {
    schemaVersion: 1,
    storeId: randomUUID(),
    createdAt: new Date().toISOString(),
    label,
  }
  try {
    writeFileSync(preferredStoreManifestPathOf(root), JSON.stringify(manifest, null, 2), 'utf8')
  } catch (error) {
    fsFail('write store manifest', preferredStoreManifestPathOf(root), error)
  }
  return manifest
}

/** Read + validate one model's `manifest.json`. Throws MODEL_MANIFEST_CORRUPT if malformed. */
export function readModelManifest(volumePath: string, slug: string): ModelManifest {
  const path = join(modelDirOf(volumePath, slug), MODEL_MANIFEST_FILE)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new ForgeError('MODEL_MANIFEST_CORRUPT', `Can't read model manifest at ${path}`, {
      path,
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ForgeError('MODEL_MANIFEST_CORRUPT', `manifest.json is not valid JSON: ${path}`, {
      path,
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  const result = modelManifestSchema.safeParse(parsed)
  if (!result.success) {
    throw new ForgeError(
      'MODEL_MANIFEST_CORRUPT',
      `manifest.json failed validation: ${z.prettifyError(result.error)}`,
      { path },
    )
  }
  return result.data
}

/** Write a model's `manifest.json` (download completion / adoption). */
export function writeModelManifest(
  volumePath: string,
  slug: string,
  manifest: ModelManifest,
): void {
  mkdirSync(modelDirOf(volumePath, slug), { recursive: true })
  writeFileSync(
    join(modelDirOf(volumePath, slug), MODEL_MANIFEST_FILE),
    JSON.stringify(manifest, null, 2),
    'utf8',
  )
}

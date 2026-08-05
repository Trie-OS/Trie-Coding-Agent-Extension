/**
 * Canonical on-disk layout for Trie IDE / Trie OS (MODELS.md).
 *
 * Store discovery is structural (`store.json` + `models/` sibling) so volumes
 * initialized under a previous product name are adopted without hard-coding
 * legacy folder names in source.
 */
import { existsSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export const TRIE_MODELS_DIR = 'TrieModels'
export const TRIE_DB_FILENAME = 'trie.db'
export const TRIE_DAEMON_ENTRY = 'trie-daemon.js'

export const STORE_MANIFEST_FILE = 'store.json'
export const MODELS_SUBDIR = 'models'
export const MODEL_MANIFEST_FILE = 'manifest.json'

/** Preferred models root for new stores. */
export function modelsDirOf(volumePath: string): string {
  return join(volumePath, TRIE_MODELS_DIR, MODELS_SUBDIR)
}

export function storeManifestPathOf(volumePath: string): string {
  return join(volumePath, TRIE_MODELS_DIR, STORE_MANIFEST_FILE)
}

export function modelDirOf(volumePath: string, slug: string): string {
  return join(modelsDirOf(volumePath), slug)
}

/**
 * Find an existing model-store root on a volume — `TrieModels/` first, then any
 * sibling directory that already has `store.json` + `models/`.
 */
export function resolveStoreRoot(volumePath: string): string | null {
  const preferred = join(volumePath, TRIE_MODELS_DIR)
  if (existsSync(join(preferred, STORE_MANIFEST_FILE))) return preferred

  let entries: string[]
  try {
    entries = readdirSync(volumePath)
  } catch {
    return null
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue
    const root = join(volumePath, name)
    if (
      existsSync(join(root, STORE_MANIFEST_FILE)) &&
      existsSync(join(root, MODELS_SUBDIR))
    ) {
      return root
    }
  }
  return null
}

export function hasStoreManifest(volumePath: string): boolean {
  return resolveStoreRoot(volumePath) !== null
}

export function hasStoreManifestSafe(volumePath: string): boolean {
  try {
    return hasStoreManifest(volumePath)
  } catch {
    return false
  }
}

/** Resolve the SQLite file in userData, renaming a lone legacy *.db if needed. */
export function resolveDatabasePath(userDataDir: string): string {
  const triePath = join(userDataDir, TRIE_DB_FILENAME)
  if (existsSync(triePath)) return triePath

  let entries: string[]
  try {
    entries = readdirSync(userDataDir)
  } catch {
    return triePath
  }

  const dbs = entries.filter((name) => name.endsWith('.db') && !name.endsWith('-shm'))
  if (dbs.length === 1 && dbs[0] !== TRIE_DB_FILENAME) {
    const legacyPath = join(userDataDir, dbs[0]!)
    renameSync(legacyPath, triePath)
    for (const suffix of ['-wal', '-shm']) {
      const from = join(userDataDir, `${dbs[0]}${suffix}`)
      const to = join(userDataDir, `${TRIE_DB_FILENAME}${suffix}`)
      if (existsSync(from)) renameSync(from, to)
    }
    return triePath
  }
  return triePath
}

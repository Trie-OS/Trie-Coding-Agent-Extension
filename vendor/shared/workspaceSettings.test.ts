import { describe, expect, it } from 'vitest'
import {
  ACTIVE_REPO_SETTINGS_KEY,
  readActiveRepoPath,
  writeActiveRepoPath,
} from './workspaceSettings'

describe('readActiveRepoPath', () => {
  it('returns null for missing, empty, or null values', () => {
    expect(readActiveRepoPath({})).toBeNull()
    expect(readActiveRepoPath({ [ACTIVE_REPO_SETTINGS_KEY]: null })).toBeNull()
    expect(readActiveRepoPath({ [ACTIVE_REPO_SETTINGS_KEY]: '' })).toBeNull()
  })

  it('returns the stored relative path', () => {
    expect(readActiveRepoPath({ [ACTIVE_REPO_SETTINGS_KEY]: 'trie-ide' })).toBe('trie-ide')
  })

  it('ignores non-string values', () => {
    expect(readActiveRepoPath({ [ACTIVE_REPO_SETTINGS_KEY]: 1 })).toBeNull()
  })
})

describe('writeActiveRepoPath', () => {
  it('round-trips through readActiveRepoPath', () => {
    const settings = writeActiveRepoPath({ layout: {} }, 'MyRepo')
    expect(readActiveRepoPath(settings)).toBe('MyRepo')
    expect(settings.layout).toEqual({})
  })

  it('clears with null', () => {
    const settings = writeActiveRepoPath({ [ACTIVE_REPO_SETTINGS_KEY]: 'x' }, null)
    expect(readActiveRepoPath(settings)).toBeNull()
  })
})

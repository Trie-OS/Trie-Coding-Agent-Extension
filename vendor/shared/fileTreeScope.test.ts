import { describe, expect, it } from 'vitest'
import {
  fsScopeForActiveRepo,
  isFileTreeScoped,
  needsProjectSelection,
  resolveFileTreeRootLabel,
  resolveProjectLabel,
  shouldShowProjectPicker,
} from './fileTreeScope'

describe('isFileTreeScoped', () => {
  it('is false when no repo is selected', () => {
    expect(isFileTreeScoped(null)).toBe(false)
  })

  it('is true when a child repo is selected', () => {
    expect(isFileTreeScoped('trie-ide')).toBe(true)
  })
})

describe('fsScopeForActiveRepo', () => {
  it('uses workspace scope for all folders', () => {
    expect(fsScopeForActiveRepo(null)).toBe('workspace')
  })

  it('uses agent scope when a repo is selected', () => {
    expect(fsScopeForActiveRepo('trie-ide')).toBe('agent')
  })
})

describe('resolveFileTreeRootLabel', () => {
  const repos = [
    { relPath: 'trie-ide', name: 'trie-ide' },
    { relPath: 'Ridgits', name: 'Ridgits' },
  ]

  it('shows the workspace name when unscoped', () => {
    expect(resolveFileTreeRootLabel(repos, null, 'GitHub')).toBe('GitHub')
  })

  it('shows the selected repo name when scoped', () => {
    expect(resolveFileTreeRootLabel(repos, 'trie-ide', 'GitHub')).toBe('trie-ide')
  })

  it('falls back to the relative path when the repo list is stale', () => {
    expect(resolveFileTreeRootLabel(repos, 'Missing', 'GitHub')).toBe('Missing')
  })
})

describe('shouldShowProjectPicker', () => {
  it('is false for zero or one repo', () => {
    expect(shouldShowProjectPicker([])).toBe(false)
    expect(shouldShowProjectPicker([{ relPath: '', name: 'trie-ide' }])).toBe(false)
  })

  it('is true for multi-repo workspaces', () => {
    expect(
      shouldShowProjectPicker([
        { relPath: 'trie-ide', name: 'trie-ide' },
        { relPath: 'Ridgits', name: 'Ridgits' },
      ]),
    ).toBe(true)
  })
})

describe('resolveProjectLabel', () => {
  const repos = [
    { relPath: 'trie-ide', name: 'trie-ide' },
    { relPath: 'Ridgits', name: 'Ridgits' },
  ]

  it('shows workspace — All repos when unscoped in a multi-repo workspace', () => {
    expect(resolveProjectLabel(repos, null, 'GitHub')).toBe('GitHub — All repos')
  })

  it('shows the selected repo name when scoped', () => {
    expect(resolveProjectLabel(repos, 'trie-ide', 'GitHub')).toBe('trie-ide')
  })

  it('shows the single repo name when the workspace has one child repo', () => {
    expect(resolveProjectLabel([{ relPath: 'trie-ide', name: 'trie-ide' }], null, 'GitHub')).toBe(
      'trie-ide',
    )
  })

  it('shows the workspace name when there are no repos', () => {
    expect(resolveProjectLabel([], null, 'GitHub')).toBe('GitHub')
  })
})

describe('needsProjectSelection', () => {
  const repos = [
    { relPath: 'trie-ide', name: 'trie-ide' },
    { relPath: 'Ridgits', name: 'Ridgits' },
  ]

  it('is true when multi-repo and nothing is selected', () => {
    expect(needsProjectSelection(repos, null)).toBe(true)
  })

  it('is false when a repo is selected', () => {
    expect(needsProjectSelection(repos, 'trie-ide')).toBe(false)
  })

  it('is false for single-repo workspaces', () => {
    expect(needsProjectSelection([{ relPath: 'trie-ide', name: 'trie-ide' }], null)).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { resolveEditorRelPath, toWorkspaceRelativePath } from './agentPaths'

describe('toWorkspaceRelativePath', () => {
  it('returns agent path unchanged when no repo is selected', () => {
    expect(toWorkspaceRelativePath('iOS.swift', null)).toBe('iOS.swift')
  })

  it('prefixes agent-relative paths with the active repo', () => {
    expect(toWorkspaceRelativePath('iOS.swift', 'AppleIntelligenceGlowEffect')).toBe(
      'AppleIntelligenceGlowEffect/iOS.swift',
    )
  })

  it('does not double-prefix workspace-relative paths', () => {
    expect(
      toWorkspaceRelativePath('AppleIntelligenceGlowEffect/iOS.swift', 'AppleIntelligenceGlowEffect'),
    ).toBe('AppleIntelligenceGlowEffect/iOS.swift')
  })
})

describe('resolveEditorRelPath', () => {
  it('normalizes agent-relative paths', () => {
    expect(resolveEditorRelPath('iOS.swift', 'repo')).toBe('repo/iOS.swift')
  })

  it('passes through workspace-relative paths', () => {
    expect(resolveEditorRelPath('repo/iOS.swift', 'repo')).toBe('repo/iOS.swift')
  })
})

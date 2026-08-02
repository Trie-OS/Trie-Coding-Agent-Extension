import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildAddPreview, buildUnifiedDiffPreview, capLines } from './diffPreview.ts'

describe('diffPreview', () => {
  it('caps lines with ellipsis', () => {
    assert.equal(capLines('a\nb\nc', 2), 'a\nb\n…')
  })

  it('builds unified diff with minus and plus prefixes', () => {
    const preview = buildUnifiedDiffPreview('old line', 'new line')
    assert.match(preview, /^\u2212old line/m)
    assert.match(preview, /^\+new line/m)
  })

  it('builds add-only preview for writes', () => {
    const preview = buildAddPreview('hello\nworld')
    assert.match(preview, /^\+hello/m)
    assert.match(preview, /^\+world/m)
  })
})

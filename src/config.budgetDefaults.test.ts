import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LEGACY_MAX_TOOL_CALLS, normalizeMaxToolCalls } from './config.ts'

describe('legacy budget defaults', () => {
  it('treats the old tool-call cap as unlimited', () => {
    assert.equal(normalizeMaxToolCalls(LEGACY_MAX_TOOL_CALLS), 0)
    assert.equal(normalizeMaxToolCalls(0), 0)
    assert.equal(normalizeMaxToolCalls(12), 12)
  })
})

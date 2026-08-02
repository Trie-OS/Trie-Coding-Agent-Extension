import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isScratchpadPath, scratchpadRelPrefix } from './scratchpad.ts'

describe('scratchpad paths', () => {
  it('recognizes session-scoped scratchpad relatives', () => {
    const id = 'abc-123'
    const prefix = scratchpadRelPrefix(id)
    assert.equal(isScratchpadPath(`${prefix}/tmp.sh`, id), true)
    assert.equal(isScratchpadPath(prefix, id), true)
    assert.equal(isScratchpadPath('src/main.ts', id), false)
    assert.equal(isScratchpadPath(`${prefix}/x`, 'other'), false)
  })
})

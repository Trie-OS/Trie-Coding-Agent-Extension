import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectPreviousUserTasks,
  dropOldestRound,
  extractSummary,
  isUserTaskTurn,
  renderCompactionEnvelope,
} from './compaction.ts'
import type { ChatTurn } from '../inference/types.ts'

describe('compaction helpers', () => {
  it('identifies user task turns vs tool results', () => {
    assert.equal(isUserTaskTurn({ role: 'user', content: 'Task: fix the bug' }), true)
    assert.equal(isUserTaskTurn({ role: 'user', content: 'Result of read_file:\nok' }), false)
    assert.equal(isUserTaskTurn({ role: 'assistant', content: 'Task: x' }), false)
  })

  it('collects recent user tasks newest-last', () => {
    const middle: ChatTurn[] = [
      { role: 'user', content: 'Task: one' },
      { role: 'assistant', content: '{}' },
      { role: 'user', content: 'Result of read_file:\nok' },
      { role: 'user', content: 'Task: two' },
    ]
    assert.deepEqual(collectPreviousUserTasks(middle), ['Task: one', 'Task: two'])
  })

  it('drops the oldest round after the system prompt', () => {
    const messages: ChatTurn[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Task: old' },
      { role: 'assistant', content: '{"tool":"read_file"}' },
      { role: 'user', content: 'Result of read_file:\nok' },
      { role: 'user', content: 'Task: new' },
      { role: 'assistant', content: '{"tool":"step_complete"}' },
    ]
    const dropped = dropOldestRound(messages)
    assert.ok(dropped)
    assert.equal(dropped![0].content, 'sys')
    assert.equal(dropped![1].content, 'Task: new')
    assert.equal(dropped!.length, 3)
  })

  it('returns null when only one round remains', () => {
    const messages: ChatTurn[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Task: only' },
      { role: 'assistant', content: '{}' },
    ]
    assert.equal(dropOldestRound(messages), null)
  })

  it('extracts summary tags and rejects tool-call shaped text', () => {
    assert.equal(extractSummary('<summary>Kept paths and todos.</summary>'), 'Kept paths and todos.')
    assert.equal(extractSummary('{"tool":"step_complete","args":{}}'), null)
    assert.equal(extractSummary('Plain prose summary of the work.'), 'Plain prose summary of the work.')
  })

  it('renders a compaction envelope with verbatim tasks', () => {
    const text = renderCompactionEnvelope('Did the thing.', ['Task: ship it'])
    assert.match(text, /Memory compacted/)
    assert.match(text, /Task: ship it/)
    assert.match(text, /Did the thing/)
  })
})

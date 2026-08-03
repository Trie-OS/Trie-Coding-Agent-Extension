import assert from 'node:assert/strict'
import test from 'node:test'
import { isOutputTruncatedFinishReason } from './truncation.ts'

test('OpenAI finish reasons identify output-limit truncation', () => {
  assert.equal(isOutputTruncatedFinishReason('length'), true)
  assert.equal(isOutputTruncatedFinishReason('max_tokens'), true)
  assert.equal(isOutputTruncatedFinishReason('stop'), false)
  assert.equal(isOutputTruncatedFinishReason('tool_calls'), false)
  assert.equal(isOutputTruncatedFinishReason(null), false)
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  capReasoningChunk,
  explorationNudgeLimit,
  isReasoningModel,
  REASONING_STREAM_CHAR_CAP,
  stallNudgeLimit,
} from './modelBehavior.ts'

describe('reasoning-model behavior', () => {
  it('recognizes common reasoning model labels', () => {
    assert.equal(isReasoningModel('Ministral-3-14B-Reasoning @ daemon'), true)
    assert.equal(isReasoningModel('deepseek-r1:14b @ ollama'), true)
    assert.equal(isReasoningModel('openai/o3-mini'), true)
  })

  it('does not classify coder models as reasoning models', () => {
    assert.equal(isReasoningModel('Qwen2.5-Coder-14B-Instruct @ daemon'), false)
    assert.equal(isReasoningModel('gpt-4o-mini @ api'), false)
  })

  it('nudges reasoning models toward edits earlier', () => {
    assert.equal(explorationNudgeLimit(true), 5)
    assert.equal(explorationNudgeLimit(false), 10)
    assert.equal(stallNudgeLimit(true), 4)
    assert.equal(stallNudgeLimit(false), 6)
  })

  it('caps only reasoning-model UI traces', () => {
    assert.equal(capReasoningChunk('abcdef', REASONING_STREAM_CHAR_CAP - 3, true), 'abc')
    assert.equal(capReasoningChunk('abcdef', REASONING_STREAM_CHAR_CAP, true), '')
    assert.equal(capReasoningChunk('abcdef', REASONING_STREAM_CHAR_CAP, false), 'abcdef')
  })
})


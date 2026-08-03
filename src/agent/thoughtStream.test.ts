import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ThoughtStreamParser, extractPartialThoughtField } from './thoughtStream.ts'

describe('extractPartialThoughtField', () => {
  it('extracts thought text from partial JSON', () => {
    const partial = '{"thought": "Planning next moves'
    assert.equal(extractPartialThoughtField(partial), 'Planning next moves')
  })

  it('extracts complete thought and ignores trailing keys', () => {
    const full = '{"thought": "Read file first", "tool": "read_file", "args": {}}'
    assert.equal(extractPartialThoughtField(full), 'Read file first')
  })

  it('unescapes common sequences', () => {
    const raw = '{"thought": "line1\\nline2\\tend"'
    assert.equal(extractPartialThoughtField(raw), 'line1\nline2\tend')
  })
})

describe('ThoughtStreamParser', () => {
  it('emits only new thought deltas', () => {
    const parser = new ThoughtStreamParser()
    assert.equal(parser.push('{"thought": "Hel'), 'Hel')
    assert.equal(parser.push('lo"'), 'lo')
    assert.equal(parser.push(', "tool": "grep"}'), '')
    assert.equal(parser.finalThought(), 'Hello')
  })
})

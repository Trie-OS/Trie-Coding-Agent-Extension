import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ThoughtStreamParser,
  extractPartialThoughtField,
  isToolCallEnvelope,
  sanitizeReplyText,
  sanitizeThoughtDisplay,
} from './thoughtStream.ts'

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

describe('sanitizeThoughtDisplay', () => {
  it('extracts thought from a complete tool envelope', () => {
    const raw = JSON.stringify({
      thought: 'Read loop.ts first.',
      tool: 'read_file',
      args: { path: 'src/agent/loop.ts' },
    })
    assert.equal(sanitizeThoughtDisplay(raw), 'Read loop.ts first.')
  })

  it('passes through plain prose unchanged', () => {
    assert.equal(sanitizeThoughtDisplay('Planning the next read.'), 'Planning the next read.')
  })

  it('returns empty for a bare tool envelope', () => {
    const raw = JSON.stringify({
      thought: 'Inspect daemon client.',
      tool: 'read_file',
      args: { path: 'src/inference/daemonClient.ts' },
    })
    assert.equal(sanitizeThoughtDisplay(raw), 'Inspect daemon client.')
    assert.equal(
      sanitizeThoughtDisplay(JSON.stringify({ tool: 'grep', args: { pattern: 'foo' } })),
      '',
    )
  })
})

describe('sanitizeReplyText', () => {
  it('rejects tool-call JSON and never promotes thought to the final reply', () => {
    const raw = JSON.stringify({
      thought: 'The exploration reveals verificationPolicy.ts is a policy layer.',
      tool: 'read_file',
      args: { path: 'src/inference/daemonClient.ts' },
    })
    assert.equal(sanitizeReplyText(raw), '')
  })

  it('passes through normal markdown answers', () => {
    assert.equal(
      sanitizeReplyText('### Priority gaps\n1. **loop.ts** — tighten step_complete gates.'),
      '### Priority gaps\n1. **loop.ts** — tighten step_complete gates.',
    )
  })

  it('unwraps direct and nested terminal tool envelopes', () => {
    const answer = 'The harness should preserve final answers at the provider boundary.'
    assert.equal(
      sanitizeReplyText(
        JSON.stringify({ thought: 'Done', tool: 'step_complete', args: { summary: answer } }),
      ),
      answer,
    )
    assert.equal(
      sanitizeReplyText(
        JSON.stringify({
          thought: 'Function call',
          tool: 'step_complete',
          args: {
            thought: 'Done',
            tool: 'step_complete',
            args: { summary: answer },
          },
        }),
      ),
      answer,
    )
  })

  it('rejects non-terminal tool envelopes', () => {
    assert.equal(
      sanitizeReplyText(
        JSON.stringify({ thought: 'Inspect first', tool: 'read_file', args: { path: 'loop.ts' } }),
      ),
      '',
    )
  })
})

describe('ThoughtStreamParser envelope guard', () => {
  it('does not treat JSON syntax tokens as plain reasoning', () => {
    const parser = new ThoughtStreamParser()
    assert.equal(parser.push('{'), '')
    assert.equal(parser.inToolEnvelope(), true)
    assert.equal(parser.push('\n  "thought": "Hello'), 'Hello')
    assert.equal(parser.push(' there"'), ' there')
    assert.equal(parser.push(',\n  "tool": "read_file"'), '')
  })
})

describe('isToolCallEnvelope', () => {
  it('detects tool-call JSON', () => {
    assert.equal(
      isToolCallEnvelope('{"thought":"x","tool":"read_file","args":{"path":"a.ts"}}'),
      true,
    )
    assert.equal(isToolCallEnvelope('plain answer'), false)
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

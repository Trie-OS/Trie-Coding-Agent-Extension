import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractJsonObject, parseToolCall } from './toolParse.ts'

const TOOL_NAMES = new Set(['read_file', 'grep', 'edit_file', 'write_file', 'step_complete'])

describe('parseToolCall', () => {
  it('parses a standard envelope', () => {
    const call = parseToolCall(
      '{"thought": "read", "tool": "read_file", "args": {"path": "src/a.ts"}}',
      TOOL_NAMES,
    )
    assert.ok(!('error' in call))
    if ('error' in call) return
    assert.equal(call.tool, 'read_file')
    assert.equal(call.args.path, 'src/a.ts')
  })

  it('prefers a full envelope over a bare args object earlier in the output', () => {
    const raw = [
      'Retrying with the corrected path.',
      '{"path": "src/ImageAttachmentChips.tsx", "startLine": 1, "endLine": 400}',
      '{"thought": "read component", "tool": "read_file", "args": {"path": "src/ImageAttachmentChips.tsx"}}',
    ].join('\n')
    const call = parseToolCall(raw, TOOL_NAMES)
    assert.ok(!('error' in call))
    if ('error' in call) return
    assert.equal(call.tool, 'read_file')
  })

  it('recovers args-only objects by inferring the tool', () => {
    const call = parseToolCall('{"path": "src/a.ts", "startLine": 1, "endLine": 200}', TOOL_NAMES)
    assert.ok(!('error' in call))
    if ('error' in call) return
    assert.equal(call.tool, 'read_file')
    assert.equal(call.args.startLine, 1)
  })

  it('infers edit_file from line-anchored replace args', () => {
    const call = parseToolCall(
      '{"path":"src/a.ts","startLine":10,"endLine":12,"replace":"const x = 2"}',
      TOOL_NAMES,
    )
    assert.ok(!('error' in call))
    if ('error' in call) return
    assert.equal(call.tool, 'edit_file')
  })

  it('accepts alternate tool field names', () => {
    const call = parseToolCall(
      '{"thought": "search", "action": "grep", "arguments": {"pattern": "ImageAttachment"}}',
      TOOL_NAMES,
    )
    assert.ok(!('error' in call))
    if ('error' in call) return
    assert.equal(call.tool, 'grep')
  })

  it('reports a clear error when no tool can be resolved', () => {
    const result = parseToolCall('{"thought": "hmm"}', TOOL_NAMES)
    assert.ok('error' in result)
    assert.match(result.error, /Missing `tool` field/)
  })

  it('refuses an edit_file payload recovered from truncated output', () => {
    // Output cut off mid-`search` (token limit): force-closing it would
    // produce a chopped search string that can never match — or worse, could
    // match the wrong thing. Must be rejected with actionable guidance.
    const truncated =
      '{"thought": "edit", "tool": "edit_file", "args": {"path": "src/a.ts", "search": "const x = 1\\nconst y = '
    const result = parseToolCall(truncated, TOOL_NAMES)
    assert.ok('error' in result)
    assert.match(result.error, /cut off/)
    assert.match(result.error, /shorter/)
  })

  it('still recovers truncated non-mutating calls', () => {
    const truncated = '{"thought": "read it", "tool": "read_file", "args": {"path": "src/a.ts"'
    const result = parseToolCall(truncated, TOOL_NAMES)
    assert.ok(!('error' in result))
    if ('error' in result) return
    assert.equal(result.tool, 'read_file')
  })
})

describe('extractJsonObject', () => {
  it('ignores example JSON in repair prose and keeps the real envelope', () => {
    const raw = [
      'Your last response was invalid.',
      '{"thought": "...", "tool": "<name>", "args": {...}}',
      '{"thought": "ok", "tool": "grep", "args": {"pattern": "thumbnail"}}',
    ].join('\n')
    const json = extractJsonObject(raw, TOOL_NAMES)
    assert.ok(json)
    const parsed = JSON.parse(json!) as { tool?: string }
    assert.equal(parsed.tool, 'grep')
  })
})

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { findEditRange, findLineRange } from './editMatcher.ts'

const FILE = [
  'export function parsePlanArtifact(raw: string): PlanArtifact {',
  '  let json: unknown',
  '  try {',
  '    json = JSON.parse(raw)',
  '  } catch (error) {',
  '    const incomplete = isIncompleteJsonError(error)',
  '    throw new ForgeError(',
  "      'PLAN_ARTIFACT_INVALID',",
  '      { raw: raw.slice(0, 4000), truncated: incomplete },',
  '    )',
  '  }',
  '  return planArtifactSchema.parse(json)',
  '}',
  '',
  'export function otherHelper(): void {',
  '  console.log("noop")',
  '}',
].join('\n')

describe('findLineRange', () => {
  it('resolves an inclusive 1-based window to original file bytes', () => {
    const match = findLineRange(FILE, 6, 10)
    assert.ok(!('error' in match))
    if ('error' in match) return
    assert.equal(match.kind, 'lines')
    assert.equal(match.matchedStartLine, 6)
    assert.equal(match.matchedEndLine, 10)
    const sliced = FILE.slice(match.start, match.end)
    assert.ok(sliced.startsWith('    const incomplete'))
    assert.ok(sliced.includes("PLAN_ARTIFACT_INVALID"))
  })

  it('rejects out-of-range windows', () => {
    assert.ok('error' in findLineRange(FILE, 0, 2))
    assert.ok('error' in findLineRange(FILE, 10, 5))
    assert.ok('error' in findLineRange(FILE, 1, 999))
  })
})

describe('findEditRange', () => {
  it('still prefers exact matches', () => {
    const match = findEditRange(FILE, '  return planArtifactSchema.parse(json)')
    assert.ok(!('error' in match))
    if ('error' in match) return
    assert.equal(match.kind, 'exact')
  })

  it('returns nearest candidates for drifted search instead of auto-applying', () => {
    const search = [
      '    const incomplete = isIncompleteJsonError(error)',
      '    throw new ForgeError(',
      "      'PLAN_ARTIFACT_INVALID',",
      '      { raw: raw.slice(0, 4000), truncated: incomplete, },',
      '    )',
    ].join('\n')
    const match = findEditRange(FILE, search)
    assert.ok('error' in match)
    if (!('error' in match)) return
    assert.equal(match.error, 'not_found')
    assert.ok((match.candidates[0]?.score ?? 0) >= 0.8)
    assert.equal(match.candidates[0]?.startLine, 6)
    assert.equal(match.candidates[0]?.endLine, 10)
  })
})

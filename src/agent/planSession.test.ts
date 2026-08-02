import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PlanSession } from './planSession.ts'

describe('PlanSession', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'trie-plan-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('creates and writes a plan file under .trie-ide/plans', () => {
    const session = new PlanSession(root)
    const rel = session.write('# Plan\n\n1. Do thing\n')
    assert.match(rel, /^\.trie-ide\/plans\/\d+-[a-z0-9]+\.md$/)
    assert.equal(session.read(), '# Plan\n\n1. Do thing\n')
    assert.ok(fs.existsSync(path.join(root, rel)))
  })

  it('reuses the same plan file within a session', () => {
    const session = new PlanSession(root)
    const first = session.ensurePlanFile()
    const second = session.write('updated')
    assert.equal(first, second)
  })
})

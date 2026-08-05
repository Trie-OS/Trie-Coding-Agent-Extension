import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it } from 'node:test'
import {
  AutomaticRepairGate,
  detectAutomaticVerifications,
} from './automaticVerification.ts'

function fixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trie-auto-verify-'))
}

function manifest(root: string, rel: string, scripts: Record<string, string>): void {
  const dir = path.join(root, rel)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts }), 'utf8')
}

describe('detectAutomaticVerifications', () => {
  it('prefers a focused typecheck over broad tests', () => {
    const root = fixture()
    try {
      manifest(root, '.', { build: 'tsc', test: 'node --test', typecheck: 'tsc --noEmit' })
      assert.deepEqual(detectAutomaticVerifications(root, ['src/agent/loop.ts'], false), [
        { packagePath: '.', script: 'typecheck' },
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('prefers tests when test files changed', () => {
    const root = fixture()
    try {
      manifest(root, '.', { test: 'node --test', typecheck: 'tsc --noEmit' })
      assert.deepEqual(detectAutomaticVerifications(root, ['src/agent/loop.test.ts'], false), [
        { packagePath: '.', script: 'test' },
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('selects one check per touched monorepo package', () => {
    const root = fixture()
    try {
      manifest(root, 'packages/a', { typecheck: 'tsc --noEmit' })
      manifest(root, 'packages/b', { test: 'vitest' })
      assert.deepEqual(
        detectAutomaticVerifications(
          root,
          ['packages/a/src/a.ts', 'packages/b/src/b.ts'],
          false,
        ),
        [
          { packagePath: 'packages/a', script: 'typecheck' },
          { packagePath: 'packages/b', script: 'test' },
        ],
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('prefers UI verification for consequential rendered behavior', () => {
    const root = fixture()
    try {
      manifest(root, '.', { typecheck: 'tsc --noEmit', 'ui:test': 'playwright test' })
      assert.deepEqual(detectAutomaticVerifications(root, ['media/src/main.ts'], true), [
        { packagePath: '.', script: 'ui:test' },
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('AutomaticRepairGate', () => {
  it('allows exactly one repair after verification failure', () => {
    const gate = new AutomaticRepairGate()
    assert.equal(gate.onFailure(), 'repair')
    assert.equal(gate.onFailure(), 'stop')
    assert.equal(gate.onFailure(), 'stop')
  })
})


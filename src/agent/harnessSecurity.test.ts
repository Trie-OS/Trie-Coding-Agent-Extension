import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { assertContainedInWorkspace } from './pathContainment.ts'
import { ShadowRepo } from './checkpoints.ts'
import { searchWorkspaceText } from './grepSearch.ts'

describe('pathContainment', () => {
  it('rejects symlink escapes outside the workspace', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trie-path-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'trie-out-'))
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret', 'utf8')
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'))
      await assert.rejects(
        () => assertContainedInWorkspace(root, 'link.txt'),
        /escapes the workspace/,
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('allows missing in-workspace targets when allowMissing is true', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trie-path-missing-'))
    try {
      const resolved = await assertContainedInWorkspace(root, 'docs/new-file.md', {
        allowMissing: true,
      })
      const realRoot = await fs.promises.realpath(root).catch(() => root)
      const rel = path.relative(realRoot, resolved).split(path.sep).join('/')
      assert.equal(rel, 'docs/new-file.md')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('checkpoints snapshot', () => {
  it('does not create a new commit when the workspace is unchanged', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trie-ckpt-'))
    try {
      fs.writeFileSync(path.join(root, 'README.md'), 'hello', 'utf8')
      const repo = new ShadowRepo(root)
      if (!(await repo.isGitAvailable())) return
      const first = await repo.snapshot('first')
      const second = await repo.snapshot('second')
      assert.equal(first, second)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('grepSearch cancellation', () => {
  it('returns cancelled when the abort signal fires', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trie-grep-'))
    try {
      fs.writeFileSync(path.join(root, 'a.txt'), 'needle here', 'utf8')
      const controller = new AbortController()
      controller.abort()
      const result = await searchWorkspaceText({
        root,
        pattern: 'needle',
        glob: '**/*',
        exclude: '**/{node_modules,.git}/**',
        maxHits: 10,
        maxFileBytes: 4096,
        signal: controller.signal,
      })
      assert.equal(result.cancelled, true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

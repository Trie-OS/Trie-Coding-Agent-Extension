import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { WorktreeManager } from './worktrees.ts'

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function initRepo(): string {
  // Keep fixtures inside the workspace so sandboxed CI can write them.
  const root = mkdtempSync(join(process.cwd(), '.tmp-mt-'))
  git(root, ['init', '-b', 'main'])
  git(root, ['config', 'user.email', 'test@trie.invalid'])
  git(root, ['config', 'user.name', 'Trie Test'])
  writeFileSync(join(root, 'README.md'), 'hello\n')
  writeFileSync(join(root, 'shared.txt'), 'base\n')
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'init'])
  return root
}

test('creates isolated child worktrees and cleans them up', async () => {
  const root = initRepo()
  try {
    const manager = new WorktreeManager(root, 'parent-aaaa-bbbb-cccc')
    await manager.prepare()
    const a = await manager.createChild('child-aaaa-1111', 'Architecture')
    const b = await manager.createChild('child-bbbb-2222', 'Implementation')
    assert.notEqual(a.path, b.path)
    assert.match(a.branch, /^trie\/mt\//)
    writeFileSync(join(a.path, 'arch.txt'), 'from-a\n')
    writeFileSync(join(b.path, 'impl.txt'), 'from-b\n')
    const shaA = await manager.commitChild(a.childId, 'arch change')
    const shaB = await manager.commitChild(b.childId, 'impl change')
    assert.ok(shaA)
    assert.ok(shaB)
    await manager.cleanup(true)
    assert.equal(manager.listChildren().length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('integrates non-overlapping child edits into the primary worktree', async () => {
  const root = initRepo()
  try {
    const manager = new WorktreeManager(root, 'parent-cccc-dddd-eeee')
    await manager.prepare()
    const a = await manager.createChild('child-aaaa-3333', 'Architecture')
    const b = await manager.createChild('child-bbbb-4444', 'Implementation')
    writeFileSync(join(a.path, 'arch-only.ts'), 'export const a = 1\n')
    writeFileSync(join(b.path, 'impl-only.ts'), 'export const b = 2\n')
    await manager.commitChild(a.childId, 'arch')
    await manager.commitChild(b.childId, 'impl')
    const result = await manager.integrate([a.childId, b.childId])
    assert.equal(result.ok, true, result.summary)
    assert.equal(readFileSync(join(root, 'arch-only.ts'), 'utf8'), 'export const a = 1\n')
    assert.equal(readFileSync(join(root, 'impl-only.ts'), 'utf8'), 'export const b = 2\n')
    await manager.cleanup(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reports conflict when siblings edit the same file', async () => {
  const root = initRepo()
  try {
    const manager = new WorktreeManager(root, 'parent-ffff-0000-1111')
    await manager.prepare()
    const a = await manager.createChild('child-aaaa-5555', 'Architecture')
    const b = await manager.createChild('child-bbbb-6666', 'Implementation')
    writeFileSync(join(a.path, 'shared.txt'), 'changed-by-a\n')
    writeFileSync(join(b.path, 'shared.txt'), 'changed-by-b\n')
    await manager.commitChild(a.childId, 'a edit')
    await manager.commitChild(b.childId, 'b edit')
    const result = await manager.integrate([a.childId, b.childId])
    assert.equal(result.ok, false)
    assert.ok(result.conflicts.length > 0)
    assert.match(result.summary, /Conflict/i)
    // Primary tree should remain at the original shared content after abort.
    assert.equal(readFileSync(join(root, 'shared.txt'), 'utf8'), 'base\n')
    await manager.cleanup(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('prepare refuses a dirty worktree', async () => {
  const root = initRepo()
  try {
    writeFileSync(join(root, 'dirty.txt'), 'nope\n')
    const manager = new WorktreeManager(root, 'parent-dirty-0000')
    await assert.rejects(() => manager.prepare(), /uncommitted changes/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

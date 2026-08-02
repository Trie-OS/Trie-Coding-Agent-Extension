/**
 * Git worktree isolation for parallel Multitask children.
 * Uses the user's real repository (not shadow checkpoints).
 */
import { execFile } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export interface ChildWorktree {
  childId: string
  label: string
  path: string
  branch: string
}

export interface IntegrateConflict {
  childId: string
  label: string
  branch: string
  files: string[]
}

export interface IntegrateResult {
  ok: boolean
  merged: string[]
  conflicts: IntegrateConflict[]
  summary: string
  integrateBranch?: string
}

interface GitResult {
  stdout: string
  stderr: string
  exitCode: number
}

function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8)
}

function slug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24) || 'agent'
}

export class WorktreeManager {
  readonly repoRoot: string
  readonly parentId: string
  readonly parentShort: string
  readonly baseDir: string
  private readonly gitBinary: string
  private baseSha = ''
  private baseBranch = ''
  private readonly children = new Map<string, ChildWorktree>()

  constructor(repoRoot: string, parentId: string, gitBinary = 'git') {
    this.repoRoot = repoRoot
    this.parentId = parentId
    this.gitBinary = gitBinary
    this.parentShort = shortId(parentId)
    this.baseDir = join(repoRoot, '.trie-ide', 'multitask', this.parentShort)
  }

  static async resolveRepoRoot(
    workspacePath: string,
    gitBinary = 'git',
  ): Promise<string | null> {
    const result = await runGit(gitBinary, ['rev-parse', '--show-toplevel'], workspacePath)
    if (result.exitCode !== 0) return null
    const root = result.stdout.trim()
    return root || null
  }

  async prepare(): Promise<void> {
    const top = await this.run(['rev-parse', '--show-toplevel'])
    if (top.exitCode !== 0) throw new Error('Workspace is not inside a git repository.')
    const status = await this.run(['status', '--porcelain'])
    if (status.exitCode !== 0) throw new Error(status.stderr || 'git status failed')
    if (status.stdout.trim()) {
      throw new Error(
        'Working tree has uncommitted changes. Commit or stash before parallel Multitask with edits.',
      )
    }
    const head = await this.run(['rev-parse', 'HEAD'])
    if (head.exitCode !== 0 || !head.stdout.trim()) {
      throw new Error('Repository has no HEAD commit to base worktrees on.')
    }
    this.baseSha = head.stdout.trim()
    const branch = await this.run(['rev-parse', '--abbrev-ref', 'HEAD'])
    this.baseBranch = branch.exitCode === 0 ? branch.stdout.trim() : 'HEAD'
    mkdirSync(this.baseDir, { recursive: true })
  }

  async createChild(childId: string, label: string): Promise<ChildWorktree> {
    if (!this.baseSha) await this.prepare()
    const branch = `trie/mt/${this.parentShort}/${shortId(childId)}-${slug(label)}`
    const path = join(this.baseDir, shortId(childId))
    // Drop leftover worktree/branch from a previous interrupted run.
    await this.run(['worktree', 'remove', '--force', path]).catch(() => undefined)
    await this.run(['branch', '-D', branch]).catch(() => undefined)
    rmSync(path, { recursive: true, force: true })
    const added = await this.run([
      'worktree',
      'add',
      '-b',
      branch,
      path,
      this.baseSha,
    ])
    if (added.exitCode !== 0) {
      throw new Error(added.stderr || added.stdout || `Failed to create worktree for ${label}`)
    }
    const child: ChildWorktree = { childId, label, path, branch }
    this.children.set(childId, child)
    return child
  }

  getChild(childId: string): ChildWorktree | undefined {
    return this.children.get(childId)
  }

  listChildren(): ChildWorktree[] {
    return [...this.children.values()]
  }

  /** Commit all local changes in a child worktree. Returns commit sha or null if clean. */
  async commitChild(childId: string, message: string): Promise<string | null> {
    const child = this.children.get(childId)
    if (!child) return null
    const status = await this.runIn(child.path, ['status', '--porcelain'])
    if (status.exitCode !== 0 || !status.stdout.trim()) return null
    const add = await this.runIn(child.path, ['add', '-A'])
    if (add.exitCode !== 0) throw new Error(add.stderr || 'git add failed in child worktree')
    const commit = await this.runIn(
      child.path,
      ['commit', '-m', message.slice(0, 120)],
      {
        GIT_AUTHOR_NAME: 'Trie Multitask',
        GIT_AUTHOR_EMAIL: 'multitask@trie-ide.invalid',
        GIT_COMMITTER_NAME: 'Trie Multitask',
        GIT_COMMITTER_EMAIL: 'multitask@trie-ide.invalid',
      },
    )
    if (commit.exitCode !== 0) {
      throw new Error(commit.stderr || commit.stdout || 'git commit failed in child worktree')
    }
    const sha = await this.runIn(child.path, ['rev-parse', 'HEAD'])
    return sha.exitCode === 0 ? sha.stdout.trim() : null
  }

  async collectDiff(childId: string): Promise<string> {
    const child = this.children.get(childId)
    if (!child || !this.baseSha) return ''
    const diff = await this.run(['diff', '--stat', `${this.baseSha}...${child.branch}`])
    if (diff.exitCode !== 0) return diff.stderr || ''
    return diff.stdout.trim()
  }

  /**
   * Merge child branches into the primary worktree in the given order.
   * Stops at the first conflict and leaves the tree conflicted for inspection
   * only when merge --abort itself fails; otherwise restores a clean base.
   */
  async integrate(childIds: string[]): Promise<IntegrateResult> {
    const merged: string[] = []
    const conflicts: IntegrateConflict[] = []
    const integrateBranch = `trie/mt/${this.parentShort}/integrate`
    await this.run(['branch', '-D', integrateBranch]).catch(() => undefined)
    const create = await this.run(['branch', integrateBranch, this.baseSha])
    if (create.exitCode !== 0) {
      return {
        ok: false,
        merged,
        conflicts,
        summary: create.stderr || 'Failed to create integrate branch',
      }
    }
    const checkout = await this.run(['checkout', integrateBranch])
    if (checkout.exitCode !== 0) {
      return {
        ok: false,
        merged,
        conflicts,
        summary: checkout.stderr || 'Failed to checkout integrate branch',
      }
    }

    for (const childId of childIds) {
      const child = this.children.get(childId)
      if (!child) continue
      const tip = await this.run(['rev-parse', child.branch])
      if (tip.exitCode !== 0) continue
      // Skip no-op branches that never committed beyond base.
      if (tip.stdout.trim() === this.baseSha) {
        merged.push(child.label)
        continue
      }
      const merge = await this.run([
        'merge',
        '--no-ff',
        '-m',
        `Merge Multitask ${child.label}`,
        child.branch,
      ])
      if (merge.exitCode !== 0) {
        const unmerged = await this.run(['diff', '--name-only', '--diff-filter=U'])
        const files = unmerged.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
        conflicts.push({
          childId: child.childId,
          label: child.label,
          branch: child.branch,
          files,
        })
        await this.run(['merge', '--abort']).catch(() => undefined)
        break
      }
      merged.push(child.label)
    }

    if (conflicts.length === 0) {
      // Fast-forward / merge integrate branch onto the original branch.
      const back = await this.run(['checkout', this.baseBranch === 'HEAD' ? this.baseSha : this.baseBranch])
      if (back.exitCode !== 0) {
        return {
          ok: false,
          merged,
          conflicts,
          integrateBranch,
          summary: `Merged children on ${integrateBranch}, but could not return to ${this.baseBranch}: ${back.stderr}`,
        }
      }
      const intoBase = await this.run([
        'merge',
        '--no-ff',
        '-m',
        'Merge parallel Multitask integration',
        integrateBranch,
      ])
      if (intoBase.exitCode !== 0) {
        const unmerged = await this.run(['diff', '--name-only', '--diff-filter=U'])
        const files = unmerged.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
        await this.run(['merge', '--abort']).catch(() => undefined)
        return {
          ok: false,
          merged,
          conflicts: [
            {
              childId: 'integrate',
              label: 'Integrate → primary',
              branch: integrateBranch,
              files,
            },
          ],
          integrateBranch,
          summary: `Child merges succeeded on ${integrateBranch}, but merging into ${this.baseBranch} conflicted: ${files.join(', ') || intoBase.stderr}`,
        }
      }
      return {
        ok: true,
        merged,
        conflicts,
        integrateBranch,
        summary: merged.length
          ? `Integrated ${merged.join(', ')} into ${this.baseBranch}.`
          : 'No child commits to integrate.',
      }
    }

    // Leave integrate branch at last good state; return to base cleanly.
    await this.run(['checkout', this.baseBranch === 'HEAD' ? this.baseSha : this.baseBranch]).catch(
      () => undefined,
    )
    const conflict = conflicts[0]!
    return {
      ok: false,
      merged,
      conflicts,
      integrateBranch,
      summary: [
        `Merged cleanly: ${merged.join(', ') || '(none)'}.`,
        `Conflict while merging ${conflict.label} (${conflict.branch}).`,
        conflict.files.length ? `Conflicted files: ${conflict.files.join(', ')}` : 'See git status.',
        `Inspect branch ${integrateBranch} and child branches under trie/mt/${this.parentShort}/.`,
      ].join(' '),
    }
  }

  async cleanup(removeBranches: boolean): Promise<void> {
    for (const child of this.children.values()) {
      await this.run(['worktree', 'remove', '--force', child.path]).catch(() => undefined)
      rmSync(child.path, { recursive: true, force: true })
      if (removeBranches) {
        await this.run(['branch', '-D', child.branch]).catch(() => undefined)
      }
    }
    if (removeBranches) {
      await this.run(['branch', '-D', `trie/mt/${this.parentShort}/integrate`]).catch(() => undefined)
    }
    this.children.clear()
    rmSync(this.baseDir, { recursive: true, force: true })
  }

  private run(args: string[], env?: Record<string, string>): Promise<GitResult> {
    return runGit(this.gitBinary, args, this.repoRoot, env)
  }

  private runIn(
    cwd: string,
    args: string[],
    env?: Record<string, string>,
  ): Promise<GitResult> {
    return runGit(this.gitBinary, args, cwd, env)
  }
}

function runGit(
  gitBinary: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      gitBinary,
      args,
      {
        cwd,
        timeout: 120_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ...env },
      },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code === 'number') {
          resolve({
            stdout: String(stdout),
            stderr: String(stderr),
            exitCode: (error as unknown as { code: number }).code,
          })
          return
        }
        if (error) {
          reject(new Error(`git ${args[0]} could not run: ${error.message}`))
          return
        }
        resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: 0 })
      },
    )
  })
}

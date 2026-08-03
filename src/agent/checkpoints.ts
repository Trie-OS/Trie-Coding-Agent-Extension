/**
 * Checkpoints — a slim port of the IDE's shadow-git system
 * (app/src/main/agent/checkpoints.ts).
 *
 * Same core trick: a git repository whose *git dir* is
 * `.trie-ide/shadow.git` and whose *work tree* is the workspace, scoped with
 * GIT_DIR/GIT_WORK_TREE environment variables so it can never touch the
 * user's real `.git`. Shadow commits use a fixed identity; the workspace's
 * `.gitignore` is honored so node_modules and friends are never snapshotted.
 *
 * Differences from the IDE version, on purpose:
 * - Fail-soft: if git is missing or the snapshot fails, the agent still runs
 *   — the extension surfaces "no checkpoint for this turn" instead of
 *   refusing to work. The IDE can afford fail-loud; a Marketplace extension
 *   should degrade gracefully.
 * - No pre-snapshot safety walk. A nested-repo workspace yields gitlinks
 *   (those subtrees are not restored); acceptable for v1 of the extension.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SHADOW_DIR = '.trie-ide'
const SHADOW_GIT_DIRNAME = 'shadow.git'

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Trie Coding Agent',
  GIT_AUTHOR_EMAIL: 'checkpoints@trie-ide.invalid',
  GIT_COMMITTER_NAME: 'Trie Coding Agent',
  GIT_COMMITTER_EMAIL: 'checkpoints@trie-ide.invalid',
}

interface GitResult {
  stdout: string
  stderr: string
  exitCode: number
}

export class ShadowRepo {
  readonly workspaceRoot: string
  private readonly gitBinary: string
  private readonly timeoutMs: number

  constructor(workspaceRoot: string, gitBinary = 'git', timeoutMs = 120_000) {
    this.workspaceRoot = workspaceRoot
    this.gitBinary = gitBinary
    this.timeoutMs = timeoutMs
  }

  get gitDir(): string {
    return join(this.workspaceRoot, SHADOW_DIR, SHADOW_GIT_DIRNAME)
  }

  private run(args: string[], scoped = true): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      execFile(
        this.gitBinary,
        args,
        {
          cwd: this.workspaceRoot,
          timeout: this.timeoutMs,
          maxBuffer: 64 * 1024 * 1024,
          env: {
            ...process.env,
            ...IDENTITY,
            ...(scoped ? { GIT_DIR: this.gitDir, GIT_WORK_TREE: this.workspaceRoot } : {}),
            GIT_CONFIG_NOSYSTEM: '1',
          },
        },
        (error, stdout, stderr) => {
          if (error && typeof (error as { code?: unknown }).code === 'number') {
            resolve({ stdout, stderr, exitCode: (error as unknown as { code: number }).code })
            return
          }
          if (error) {
            reject(new Error(`git ${args[0]} could not run: ${error.message}`))
            return
          }
          resolve({ stdout, stderr, exitCode: 0 })
        },
      )
    })
  }

  private async runOrThrow(args: string[], what: string, scoped = true): Promise<string> {
    const result = await this.run(args, scoped)
    if (result.exitCode !== 0) {
      throw new Error(
        `${what} failed (git exited ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
      )
    }
    return result.stdout
  }

  async isGitAvailable(): Promise<boolean> {
    try {
      const result = await this.run(['--version'], false)
      return result.exitCode === 0
    } catch {
      return false
    }
  }

  /** Create the shadow repo if it does not exist. Idempotent. */
  async ensureInitialized(): Promise<void> {
    if (existsSync(join(this.gitDir, 'HEAD'))) return

    mkdirSync(join(this.workspaceRoot, SHADOW_DIR), { recursive: true })
    await this.runOrThrow(['init', '--quiet', '--bare', this.gitDir], 'shadow repo init', false)
    await this.runOrThrow(['config', 'core.bare', 'false'], 'shadow repo config')
    await this.runOrThrow(['config', 'core.excludesFile', '/dev/null'], 'shadow repo config')
    await this.runOrThrow(['config', 'core.autocrlf', 'false'], 'shadow repo config')
    mkdirSync(join(this.gitDir, 'info'), { recursive: true })
    writeFileSync(join(this.gitDir, 'info', 'exclude'), `/${SHADOW_DIR}/\n`, 'utf8')
  }

  /** Commit the current workspace state; returns the checkpoint sha. */
  async snapshot(label: string): Promise<string> {
    await this.ensureInitialized()
    await this.runOrThrow(['add', '--all', '.'], 'staging the workspace')
    const staged = await this.run(['diff', '--cached', '--quiet'])
    if (staged.exitCode === 0) {
      const head = await this.run(['rev-parse', 'HEAD'])
      if (head.exitCode === 0) {
        return head.stdout.trim()
      }
    }
    await this.runOrThrow(
      ['commit', '--quiet', '--no-verify', '-m', label],
      'creating the checkpoint commit',
    )
    return (await this.runOrThrow(['rev-parse', 'HEAD'], 'reading the checkpoint sha')).trim()
  }

  /**
   * Restore the workspace to `ref`. Stages first so files created after the
   * checkpoint are known to the index and get deleted by the reset — the
   * byte-identical-tree contract from the IDE.
   */
  async restore(ref: string): Promise<void> {
    await this.ensureInitialized()
    await this.runOrThrow(['add', '--all', '.'], 'staging the workspace')
    await this.runOrThrow(['read-tree', '-u', '--reset', ref], `restoring ${ref}`)
    await this.runOrThrow(['reset', '--soft', ref], `moving shadow HEAD to ${ref}`)
  }

  /** Paths that differ between `ref` and the working tree. */
  async changedPaths(ref: string): Promise<string[]> {
    await this.runOrThrow(['add', '--all', '.'], 'staging the workspace')
    const out = await this.runOrThrow(
      ['diff', '--name-only', '--cached', ref, '--'],
      `listing changes since ${ref}`,
    )
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
  }

  /** Per-file added/deleted line counts between `ref` and the working tree. */
  async changedFileStats(ref: string): Promise<ChangedFileStat[]> {
    await this.runOrThrow(['add', '--all', '.'], 'staging the workspace')
    const out = await this.runOrThrow(
      ['diff', '--numstat', '--cached', ref, '--'],
      `diff stats since ${ref}`,
    )
    const stats: ChangedFileStat[] = []
    for (const line of out.split('\n')) {
      const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim())
      if (!match) continue
      stats.push({
        path: match[3],
        // Binary files report "-"; show them as 0/0 rather than lying.
        added: match[1] === '-' ? 0 : Number(match[1]),
        deleted: match[2] === '-' ? 0 : Number(match[2]),
      })
    }
    return stats
  }

  /** File content at `ref`, or null if the file did not exist there. */
  async readFileAtRef(ref: string, path: string): Promise<string | null> {
    const result = await this.run(['show', `${ref}:${path}`])
    return result.exitCode === 0 ? result.stdout : null
  }
}

export interface ChangedFileStat {
  path: string
  added: number
  deleted: number
}

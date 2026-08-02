/**
 * Persisted plan artifact for Plan mode — markdown under .trie-ide/plans/.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const PLANS_REL = path.join('.trie-ide', 'plans')

function slug(): string {
  return Math.random().toString(36).slice(2, 10)
}

export class PlanSession {
  private planRelPath: string | null = null
  private readonly workspaceRoot: string

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot
  }

  get relativePath(): string | null {
    return this.planRelPath
  }

  get absolutePath(): string | null {
    return this.planRelPath ? path.join(this.workspaceRoot, this.planRelPath) : null
  }

  /** Allocate a new plan file for this planning session. */
  ensurePlanFile(): string {
    if (this.planRelPath) return this.planRelPath
    const name = `${Date.now()}-${slug()}.md`
    this.planRelPath = path.join(PLANS_REL, name)
    const abs = path.join(this.workspaceRoot, this.planRelPath)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    if (!fs.existsSync(abs)) {
      fs.writeFileSync(abs, '# Implementation plan\n\n', 'utf8')
    }
    return this.planRelPath
  }

  read(): string | null {
    const abs = this.absolutePath
    if (!abs || !fs.existsSync(abs)) return null
    return fs.readFileSync(abs, 'utf8')
  }

  write(content: string): string {
    const rel = this.ensurePlanFile()
    fs.writeFileSync(path.join(this.workspaceRoot, rel), content, 'utf8')
    return rel
  }

  reset(): void {
    this.planRelPath = null
  }
}

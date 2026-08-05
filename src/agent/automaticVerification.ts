import * as fs from 'node:fs'
import * as path from 'node:path'

export interface AutomaticVerification {
  packagePath: string
  script: string
}

/** Exactly one model repair is allowed after automatic verification fails. */
export class AutomaticRepairGate {
  private attempted = false

  onFailure(): 'repair' | 'stop' {
    if (this.attempted) return 'stop'
    this.attempted = true
    return 'repair'
  }
}

const ALLOWED_SCRIPT =
  /^(?:test(?::[\w.-]+)?|typecheck|check(?::[\w.-]+)?|lint(?::[\w.-]+)?|build|e2e(?::[\w.-]+)?|visual(?::[\w.-]+)?|ui(?::[\w.-]+)?|harness(?::[\w.-]+)?|playwright|cypress|storybook:test)$/
const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|spec)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i

function nearestPackageRoot(workspaceRoot: string, relPath: string): string | null {
  const root = path.resolve(workspaceRoot)
  let dir = path.dirname(path.resolve(root, relPath))
  while (dir === root || dir.startsWith(`${root}${path.sep}`)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    if (dir === root) break
    dir = path.dirname(dir)
  }
  return fs.existsSync(path.join(root, 'package.json')) ? root : null
}

function scriptScore(
  name: string,
  changedPaths: readonly string[],
  useVisualHarness: boolean,
): number {
  if (!ALLOWED_SCRIPT.test(name)) return -1
  if (useVisualHarness && /^(?:visual|ui|e2e|playwright|cypress|storybook:test)/.test(name)) {
    return 120
  }
  const suffix = name.includes(':') ? name.slice(name.indexOf(':') + 1).toLowerCase() : ''
  if (
    suffix &&
    changedPaths.some((changedPath) =>
      changedPath
        .toLowerCase()
        .split(/[/_.-]+/)
        .includes(suffix),
    )
  ) {
    return 110
  }
  const testsChanged = changedPaths.some((changedPath) => TEST_PATH.test(changedPath))
  if (testsChanged && name === 'test') return 100
  if (name === 'typecheck') return 90
  if (name === 'test') return 80
  if (name.startsWith('test:')) return 75
  if (name === 'lint' || name.startsWith('check')) return 60
  if (name === 'build') return 50
  return 40
}

/**
 * Pick at most one safe package.json verification script per touched package.
 * Execution and permission approval remain in WorkspaceTools.run_verification.
 */
export function detectAutomaticVerifications(
  workspaceRoot: string,
  changedPaths: readonly string[],
  useVisualHarness: boolean,
): AutomaticVerification[] {
  const grouped = new Map<string, string[]>()
  for (const changedPath of changedPaths) {
    const packageRoot = nearestPackageRoot(workspaceRoot, changedPath)
    if (!packageRoot) continue
    const paths = grouped.get(packageRoot) ?? []
    paths.push(changedPath)
    grouped.set(packageRoot, paths)
  }

  const checks: AutomaticVerification[] = []
  for (const [packageRoot, packageChangedPaths] of grouped) {
    let parsed: { scripts?: Record<string, unknown> }
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
        scripts?: Record<string, unknown>
      }
    } catch {
      continue
    }
    const script = Object.entries(parsed.scripts ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([name]) => ({
        name,
        score: scriptScore(name, packageChangedPaths, useVisualHarness),
      }))
      .filter(({ score }) => score >= 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))[0]?.name
    if (!script) continue
    const relative = path.relative(workspaceRoot, packageRoot).split(path.sep).join('/')
    checks.push({ packagePath: relative || '.', script })
  }
  return checks.sort((a, b) => a.packagePath.localeCompare(b.packagePath))
}


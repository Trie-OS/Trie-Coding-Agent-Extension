import * as fs from 'node:fs'
import * as path from 'node:path'

const rootCache = new Map<string, Promise<string>>()

export async function realWorkspaceRoot(workspaceRoot: string): Promise<string> {
  const key = path.resolve(workspaceRoot)
  let pending = rootCache.get(key)
  if (!pending) {
    pending = fs.promises.realpath(key).catch(() => key)
    rootCache.set(key, pending)
  }
  return pending
}

/**
 * Resolve a workspace-relative or in-workspace absolute path to its canonical
 * location and reject symlink escapes outside the workspace root.
 */
export async function assertContainedInWorkspace(
  workspaceRoot: string,
  targetPath: string,
  options?: { allowMissing?: boolean },
): Promise<string> {
  const realRoot = await realWorkspaceRoot(workspaceRoot)
  const absolute = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(workspaceRoot, targetPath)

  try {
    const realTarget = await fs.promises.realpath(absolute)
    assertRelativeInside(realRoot, realTarget, targetPath)
    return realTarget
  } catch (error) {
    if (!options?.allowMissing) throw error
    if (!(error instanceof Error) || !/ENOENT|EISDIR/i.test(String(error))) {
      if (error instanceof Error && error.message.includes('escapes the workspace')) throw error
    }
    let dir = path.dirname(absolute)
    const stop = path.resolve(workspaceRoot)
    while (true) {
      try {
        const realDir = await fs.promises.realpath(dir)
        assertRelativeInside(realRoot, realDir, targetPath)
        return path.join(realDir, path.basename(absolute))
      } catch (inner) {
        if (inner instanceof Error && inner.message.includes('escapes the workspace')) throw inner
        if (path.resolve(dir) === stop || dir === path.dirname(dir)) break
        dir = path.dirname(dir)
      }
    }
    throw new Error(`Path escapes the workspace: ${targetPath}`)
  }
}

function assertRelativeInside(realRoot: string, realTarget: string, displayPath: string): void {
  const rel = path.relative(realRoot, realTarget)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes the workspace: ${displayPath}`)
  }
}

export function relativeFromRoot(workspaceRoot: string, absolutePath: string): string {
  return path.relative(workspaceRoot, absolutePath).split(path.sep).join('/')
}

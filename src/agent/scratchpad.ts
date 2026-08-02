/**
 * Session scratchpad — a workspace-local temp dir under `.trie-ide/scratchpad/`
 * where the agent can create intermediate scripts/data without polluting the
 * project tree. Inspired by Mistral Vibe's session scratchpad.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export const SCRATCHPAD_REL = path.join('.trie-ide', 'scratchpad')

export function scratchpadRoot(workspaceRoot: string, sessionId: string): string {
  return path.join(workspaceRoot, SCRATCHPAD_REL, sessionId)
}

export function scratchpadRelPrefix(sessionId: string): string {
  return path.join(SCRATCHPAD_REL, sessionId)
}

export function isScratchpadPath(relPath: string, sessionId: string): boolean {
  const normalized = relPath.replace(/\\/g, '/')
  const prefix = scratchpadRelPrefix(sessionId).replace(/\\/g, '/')
  return normalized === prefix || normalized.startsWith(`${prefix}/`)
}

export function ensureScratchpad(workspaceRoot: string, sessionId: string): string {
  const dir = scratchpadRoot(workspaceRoot, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Best-effort cleanup when a chat is deleted or reset. */
export function clearScratchpad(workspaceRoot: string, sessionId: string): void {
  const dir = scratchpadRoot(workspaceRoot, sessionId)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

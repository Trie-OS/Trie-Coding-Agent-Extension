/**
 * Session-scoped and persisted permission decisions for shell commands and sensitive writes.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

export type AgentProfileName = 'default' | 'accept-edits' | 'auto-approve' | 'explore'
export type PermissionDefault = 'allow' | 'ask' | 'deny'

export type PermissionDecision = 'allow' | 'deny'

const PERMISSIONS_REL = path.join('.trie-ide', 'permissions.json')

/** Shell metacharacters that make pattern-based session allow unsafe. */
const SHELL_METACHAR_RE = /&&|\|\||[;|`]|>\s|<\s|\$\(|\$\{|\n/

interface UserPersistedPermissionsFile {
  allowedCommands: string[]
  allowedPaths: string[]
  allowedCommandPatterns?: string[]
  allowedPathPatterns?: string[]
  allowedOutsideWorkspace?: string[]
  allowedUrlPatterns?: string[]
}

interface RepoRestrictivePermissionsFile {
  toolDefaults?: Record<string, PermissionDefault>
}

/** True when a persisted wildcard pattern is too broad to store safely. */
export function isOverbroadPattern(pattern: string): boolean {
  const normalized = SessionPermissionStore.normalize(pattern)
  if (normalized === '*') return true
  if (/^\S+ \*$/.test(normalized)) return true
  const pathKey = normalizePathKey(pattern)
  if (pathKey === '*') return true
  if (/^[^/]+\/\*$/.test(pathKey)) return true
  return false
}

function workspaceKey(workspaceRoot: string): string {
  return createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 16)
}

export class SessionPermissionStore {
  private readonly commandDecisions = new Map<string, PermissionDecision>()
  private readonly pathDecisions = new Map<string, PermissionDecision>()
  private readonly commandPatternDecisions = new Map<string, PermissionDecision>()
  private readonly pathPatternDecisions = new Map<string, PermissionDecision>()

  /** Normalize for stable keys: collapse whitespace, trim. */
  static normalize(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
  }

  static hasShellMetacharacters(command: string): boolean {
    if (SHELL_METACHAR_RE.test(command)) return true
    if (process.platform === 'win32' && /%/.test(command)) return true
    return false
  }

  /** Tokenize a simple command (no shell parsing — whitespace split). */
  static tokenize(command: string): string[] {
    return SessionPermissionStore.normalize(command).split(' ').filter(Boolean)
  }

  /**
   * True when `candidate` is allowed by an argv-safe session grant for `approved`.
   * Both must be simple (no metachar); candidate must share the approved argv prefix
   * and must not introduce extra shell operators.
   */
  static argvPrefixMatch(approved: string, candidate: string): boolean {
    if (SessionPermissionStore.hasShellMetacharacters(approved)) return false
    if (SessionPermissionStore.hasShellMetacharacters(candidate)) return false
    const a = SessionPermissionStore.tokenize(approved)
    const c = SessionPermissionStore.tokenize(candidate)
    if (c.length < a.length) return false
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== c[i]) return false
    }
    return true
  }

  rememberCommand(command: string, decision: PermissionDecision): void {
    const normalized = SessionPermissionStore.normalize(command)
    if (SessionPermissionStore.hasShellMetacharacters(normalized)) {
      this.commandDecisions.set(normalized, decision)
      return
    }
    // Simple commands: store exact; lookup also checks argv prefix of any prior allow.
    this.commandDecisions.set(normalized, decision)
  }

  lookupCommand(command: string): PermissionDecision | undefined {
    const normalized = SessionPermissionStore.normalize(command)
    if (this.commandDecisions.has(normalized)) {
      return this.commandDecisions.get(normalized)
    }
    for (const [pattern, decision] of this.commandPatternDecisions) {
      if (wildcardMatch(pattern, normalized)) return decision
    }
    if (SessionPermissionStore.hasShellMetacharacters(normalized)) return undefined
    for (const [approved, decision] of this.commandDecisions) {
      if (decision === 'allow' && SessionPermissionStore.argvPrefixMatch(approved, normalized)) {
        return 'allow'
      }
      if (decision === 'deny' && SessionPermissionStore.argvPrefixMatch(approved, normalized)) {
        return 'deny'
      }
    }
    return undefined
  }

  rememberPath(relPath: string, decision: PermissionDecision): void {
    this.pathDecisions.set(normalizePathKey(relPath), decision)
  }

  lookupPath(relPath: string): PermissionDecision | undefined {
    const key = normalizePathKey(relPath)
    const exact = this.pathDecisions.get(key)
    if (exact) return exact
    for (const [pattern, decision] of this.pathPatternDecisions) {
      if (wildcardMatch(pattern, key)) return decision
    }
    return undefined
  }

  rememberCommandPattern(pattern: string, decision: PermissionDecision): void {
    this.commandPatternDecisions.set(SessionPermissionStore.normalize(pattern), decision)
  }

  rememberPathPattern(pattern: string, decision: PermissionDecision): void {
    this.pathPatternDecisions.set(normalizePathKey(pattern), decision)
  }

  clear(): void {
    this.commandDecisions.clear()
    this.pathDecisions.clear()
    this.commandPatternDecisions.clear()
    this.pathPatternDecisions.clear()
  }
}

/** Session + user-persisted allows; repo file is restrictive-only (deny/ask toolDefaults). */
export class PersistentPermissionStore {
  private readonly session = new SessionPermissionStore()
  private userPersisted: UserPersistedPermissionsFile = { allowedCommands: [], allowedPaths: [] }
  private repoRestrictive: RepoRestrictivePermissionsFile = {}
  private userLoaded = false
  private repoLoaded = false
  private readonly workspaceRoot: string
  private readonly userStorageDir?: string

  constructor(workspaceRoot: string, userStorageDir?: string) {
    this.workspaceRoot = workspaceRoot
    this.userStorageDir = userStorageDir
  }

  private repoFilePath(): string {
    return path.join(this.workspaceRoot, PERMISSIONS_REL)
  }

  private userFilePath(): string | undefined {
    if (!this.userStorageDir) return undefined
    return path.join(this.userStorageDir, 'agent-permissions', `${workspaceKey(this.workspaceRoot)}.json`)
  }

  private ensureRepoLoaded(): void {
    if (this.repoLoaded) return
    this.repoLoaded = true
    const abs = this.repoFilePath()
    try {
      if (!fs.existsSync(abs)) return
      const raw = JSON.parse(fs.readFileSync(abs, 'utf8')) as Record<string, unknown>
      const toolDefaults =
        raw.toolDefaults && typeof raw.toolDefaults === 'object'
          ? Object.fromEntries(
              Object.entries(raw.toolDefaults as Record<string, unknown>).filter(
                (entry): entry is [string, PermissionDefault] =>
                  entry[1] === 'ask' || entry[1] === 'deny',
              ),
            )
          : {}
      this.repoRestrictive = { toolDefaults }
    } catch {
      this.repoRestrictive = {}
    }
  }

  private ensureUserLoaded(): void {
    if (this.userLoaded) return
    this.userLoaded = true
    const abs = this.userFilePath()
    if (!abs) return
    try {
      if (!fs.existsSync(abs)) return
      const raw = JSON.parse(fs.readFileSync(abs, 'utf8')) as Partial<UserPersistedPermissionsFile>
      this.userPersisted = {
        allowedCommands: Array.isArray(raw.allowedCommands)
          ? raw.allowedCommands.filter((c): c is string => typeof c === 'string')
          : [],
        allowedPaths: Array.isArray(raw.allowedPaths)
          ? raw.allowedPaths.filter((p): p is string => typeof p === 'string')
          : [],
        allowedCommandPatterns: Array.isArray(raw.allowedCommandPatterns)
          ? raw.allowedCommandPatterns.filter((p): p is string => typeof p === 'string')
          : [],
        allowedPathPatterns: Array.isArray(raw.allowedPathPatterns)
          ? raw.allowedPathPatterns.filter((p): p is string => typeof p === 'string')
          : [],
        allowedOutsideWorkspace: Array.isArray(raw.allowedOutsideWorkspace)
          ? raw.allowedOutsideWorkspace.filter((p): p is string => typeof p === 'string')
          : [],
        allowedUrlPatterns: Array.isArray(raw.allowedUrlPatterns)
          ? raw.allowedUrlPatterns.filter((p): p is string => typeof p === 'string')
          : [],
      }
    } catch {
      this.userPersisted = { allowedCommands: [], allowedPaths: [] }
    }
  }

  private save(): void {
    const abs = this.userFilePath()
    if (!abs) return
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, JSON.stringify(this.userPersisted, null, 2) + '\n', 'utf8')
  }

  private lookupPersistedCommand(command: string): PermissionDecision | undefined {
    this.ensureUserLoaded()
    const normalized = SessionPermissionStore.normalize(command)
    if (this.userPersisted.allowedCommands.includes(normalized)) return 'allow'
    for (const pattern of this.userPersisted.allowedCommandPatterns ?? []) {
      if (wildcardMatch(pattern, normalized)) return 'allow'
    }
    if (SessionPermissionStore.hasShellMetacharacters(normalized)) return undefined
    for (const approved of this.userPersisted.allowedCommands) {
      if (SessionPermissionStore.argvPrefixMatch(approved, normalized)) return 'allow'
    }
    return undefined
  }

  private lookupPersistedPath(relPath: string): PermissionDecision | undefined {
    this.ensureUserLoaded()
    const key = normalizePathKey(relPath)
    if (this.userPersisted.allowedPaths.includes(key)) return 'allow'
    for (const pattern of this.userPersisted.allowedPathPatterns ?? []) {
      if (wildcardMatch(pattern, key)) return 'allow'
    }
    return undefined
  }

  rememberCommand(command: string, decision: PermissionDecision): void {
    this.session.rememberCommand(command, decision)
  }

  rememberPath(relPath: string, decision: PermissionDecision): void {
    this.session.rememberPath(relPath, decision)
  }

  rememberCommandAlways(command: string): void {
    this.ensureUserLoaded()
    const normalized = SessionPermissionStore.normalize(command)
    this.session.rememberCommand(normalized, 'allow')
    if (!this.userPersisted.allowedCommands.includes(normalized)) {
      this.userPersisted.allowedCommands.push(normalized)
      this.save()
    }
  }

  rememberPathAlways(relPath: string): void {
    this.ensureUserLoaded()
    const key = normalizePathKey(relPath)
    this.session.rememberPath(key, 'allow')
    if (!this.userPersisted.allowedPaths.includes(key)) {
      this.userPersisted.allowedPaths.push(key)
      this.save()
    }
  }

  rememberCommandPattern(pattern: string, decision: PermissionDecision): void {
    this.session.rememberCommandPattern(pattern, decision)
  }

  rememberPathPattern(pattern: string, decision: PermissionDecision): void {
    this.session.rememberPathPattern(pattern, decision)
  }

  rememberCommandPatternAlways(pattern: string): void {
    if (isOverbroadPattern(pattern)) return
    this.ensureUserLoaded()
    const normalized = SessionPermissionStore.normalize(pattern)
    this.session.rememberCommandPattern(normalized, 'allow')
    const current = this.userPersisted.allowedCommandPatterns ?? []
    if (!current.includes(normalized)) {
      current.push(normalized)
      this.userPersisted.allowedCommandPatterns = current
      this.save()
    }
  }

  rememberPathPatternAlways(pattern: string): void {
    if (isOverbroadPattern(pattern)) return
    this.ensureUserLoaded()
    const normalized = normalizePathKey(pattern)
    this.session.rememberPathPattern(normalized, 'allow')
    const current = this.userPersisted.allowedPathPatterns ?? []
    if (!current.includes(normalized)) {
      current.push(normalized)
      this.userPersisted.allowedPathPatterns = current
      this.save()
    }
  }

  lookupOutsideWorkspace(absPath: string): PermissionDecision | undefined {
    this.ensureUserLoaded()
    const normalized = normalizePathKey(absPath)
    const session = this.session.lookupPath(normalized)
    if (session) return session
    for (const pattern of this.userPersisted.allowedOutsideWorkspace ?? []) {
      if (wildcardMatch(pattern, normalized)) return 'allow'
    }
    return undefined
  }

  rememberOutsideWorkspace(absPath: string, decision: PermissionDecision): void {
    this.session.rememberPath(normalizePathKey(absPath), decision)
  }

  rememberOutsideWorkspaceAlways(pattern: string): void {
    if (isOverbroadPattern(pattern)) return
    this.ensureUserLoaded()
    const normalized = normalizePathKey(pattern)
    this.session.rememberPathPattern(normalized, 'allow')
    const current = this.userPersisted.allowedOutsideWorkspace ?? []
    if (!current.includes(normalized)) {
      current.push(normalized)
      this.userPersisted.allowedOutsideWorkspace = current
      this.save()
    }
  }

  lookupUrl(url: string): PermissionDecision | undefined {
    this.ensureUserLoaded()
    const normalized = SessionPermissionStore.normalize(url)
    const session = this.session.lookupPath(normalized)
    if (session) return session
    for (const pattern of this.userPersisted.allowedUrlPatterns ?? []) {
      if (wildcardMatch(pattern, normalized)) return 'allow'
    }
    return undefined
  }

  rememberUrl(url: string, decision: PermissionDecision): void {
    this.session.rememberPath(SessionPermissionStore.normalize(url), decision)
  }

  rememberUrlPatternAlways(pattern: string): void {
    if (isOverbroadPattern(pattern)) return
    this.ensureUserLoaded()
    const normalized = SessionPermissionStore.normalize(pattern)
    this.session.rememberPathPattern(normalized, 'allow')
    const current = this.userPersisted.allowedUrlPatterns ?? []
    if (!current.includes(normalized)) {
      current.push(normalized)
      this.userPersisted.allowedUrlPatterns = current
      this.save()
    }
  }

  toolDefault(toolName: string, profile: AgentProfileName, fallback: PermissionDefault): PermissionDefault {
    this.ensureRepoLoaded()
    const override = this.repoRestrictive.toolDefaults?.[toolName]
    if (override) return override
    const profileDefaults = profilePermissionDefaults(profile)
    switch (toolName) {
      case 'run_command':
        return profileDefaults.shell
      case 'sensitive_write':
        return profileDefaults.sensitiveWrite
      case 'outside_workspace':
        return profileDefaults.outsideWorkspace
      default:
        return fallback
    }
  }

  lookupCommand(command: string): PermissionDecision | undefined {
    const session = this.session.lookupCommand(command)
    if (session) return session
    return this.lookupPersistedCommand(command)
  }

  lookupPath(relPath: string): PermissionDecision | undefined {
    const session = this.session.lookupPath(relPath)
    if (session) return session
    return this.lookupPersistedPath(relPath)
  }

  clear(): void {
    this.session.clear()
  }
}

function normalizePathKey(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\.\//, '')
}

function wildcardMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  const regex = new RegExp(`^${escaped}$`)
  return regex.test(value)
}

function profilePermissionDefaults(profile: AgentProfileName): {
  shell: PermissionDefault
  sensitiveWrite: PermissionDefault
  outsideWorkspace: PermissionDefault
} {
  switch (profile) {
    case 'accept-edits':
      return { shell: 'ask', sensitiveWrite: 'allow', outsideWorkspace: 'ask' }
    case 'auto-approve':
      return { shell: 'allow', sensitiveWrite: 'allow', outsideWorkspace: 'allow' }
    case 'explore':
      return { shell: 'deny', sensitiveWrite: 'deny', outsideWorkspace: 'ask' }
    default:
      return { shell: 'ask', sensitiveWrite: 'ask', outsideWorkspace: 'ask' }
  }
}

/** Cursor-like sensitive path gate — ask before writing these. */
export function isSensitivePath(relPath: string): boolean {
  const p = normalizePathKey(relPath).toLowerCase()
  const base = p.split('/').pop() ?? p
  if (/^\.env(\.|$)/.test(base)) return true
  if (/\.(pem|key|p12|keystore|pfx|jks)$/.test(base)) return true
  if (/^id_rsa/.test(base)) return true
  if (p.includes('.git/hooks/')) return true
  if (/credentials|secret|private[_-]?key/.test(p)) return true
  return false
}

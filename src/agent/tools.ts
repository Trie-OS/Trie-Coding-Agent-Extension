/**
 * Agent tools, adapted from Trie IDE's tool set (app/src/shared/agent.ts)
 * to run against the VS Code workspace. Same names and argument shapes so a
 * model tuned on Trie IDE prompts behaves identically here.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { readConfig, type WebSearchProvider } from '../config'
import { buildAddPreview, buildUnifiedDiffPreview, capLines } from './diffPreview'
import {
  findEditRange,
  findLineRange,
  reindentReplacement,
  type EditCandidate,
} from './editMatcher'
import {
  executeMultitaskTool,
  MULTITASK_TOOL_NAMES,
  MULTITASK_TOOL_SPECS,
  type MultitaskToolContext,
} from './multitaskBus'
import { parseToolCall as parseToolCallInner, extractJsonObject as extractJsonObjectInner } from './toolParse'
import { searchWorkspaceText } from './grepSearch'
import { assertContainedInWorkspace, relativeFromRoot } from './pathContainment'
import { PersistentPermissionStore, isSensitivePath } from './permissions'
import type { PlanSession } from './planSession'
import type { PermissionBroker, PermissionChoice, PermissionRequest } from './permissionBroker'
import type { QuestionBroker, UserQuestionPayload } from './questionBroker'
import { execFileWithSignal, shellExec } from './shellExec'
import { ensureScratchpad, isScratchpadPath } from './scratchpad'
import { getSymbolIndex, isIdentifierPattern } from './symbolIndex'
import { normalizeAgentProfile, type AgentProfileName } from './agentProfiles'
import { executeReadFilesBatch } from './readFilesBatch.ts'

export interface ToolSpec {
  name: string
  /** Rendered into the system prompt. */
  signature: string
  description: string
  mutating?: boolean
  control?: boolean
  /** Only offered to Multitask sibling sessions. */
  multitaskOnly?: boolean
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'read_file',
    signature: '{"path": string, "startLine"?: number, "endLine"?: number}',
    description: 'Read a file (optionally a 1-based line range).',
  },
  {
    name: 'read_files',
    signature: '{"paths": string[]}',
    description:
      'Read up to 8 related files in one call. The files share one result budget; use read_file for a larger window of one file.',
  },
  {
    name: 'list_dir',
    signature: '{"path": string}',
    description: 'List a directory. Use "" for the workspace root.',
  },
  {
    name: 'glob',
    signature: '{"pattern": string}',
    description: 'Find files by glob pattern, e.g. "src/**/*.ts".',
  },
  {
    name: 'grep',
    signature: '{"pattern": string, "glob"?: string}',
    description:
      'Search file contents with a regular expression. Simple identifiers also check the workspace symbol trie first.',
  },
  {
    name: 'search_symbols',
    signature: '{"query": string}',
    description:
      'Fast workspace symbol lookup via a prefix trie index. Matches names, prefixes, initials, typos, and multi-word queries like "auth token". Use to find where a function, class, or type is declared before grepping for usages.',
  },
  {
    name: 'edit_file',
    signature:
      '{"path": string, "replace": string, "startLine"?: number, "endLine"?: number, "search"?: string}',
    description:
      'Edit a file. Preferred (durable): after read_file, pass startLine/endLine + replace to rewrite that inclusive line range — no need to retype file bytes. Alternate: search + replace for a short unique snippet (exact or whitespace-normalized). On search failure, use the reported startLine/endLine with replace.',
    mutating: true,
  },
  {
    name: 'web_search',
    signature: '{"query": string}',
    description:
      'Search the internet when the active user request explicitly asks for web research or requires current/external factual information. Repository implementation, debugging, architecture, and missing local symbols stay local.',
  },
  {
    name: 'write_file',
    signature: '{"path": string, "content": string}',
    description:
      'Create a new file with the given content. Fails if the file already exists — use edit_file for existing files. Scratchpad paths under .trie-ide/scratchpad/<session>/ may be overwritten.',
    mutating: true,
  },
  {
    name: 'run_command',
    signature: '{"command": string}',
    description:
      'Run a shell command in the workspace root (requires user approval; session allow/deny is remembered). Use for tests, builds, git.',
    mutating: true,
  },
  {
    name: 'ask_user_question',
    signature:
      '{"questions": [{"question": string, "options": string[], "multiSelect"?: boolean}]}',
    description:
      'Ask the user one or more multiple-choice questions when a decision blocks progress (product intent, destructive choice, credentials, ambiguous requirements). Prefer this over guessing.',
  },
  {
    name: 'run_verification',
    signature:
      '{"packagePath"?: string, "script"?: string, "args"?: string[], "artifactPaths"?: string[], "skipReason"?: string}',
    description:
      'Autonomously run one focused test/typecheck/lint/build or UI/e2e/visual harness package script without a shell. The script must exist in package.json and have a verification-like name. artifactPaths can report generated screenshots/text reports inside the workspace. Prefer the narrowest relevant check; use skipReason only when verification is disproportionate.',
    mutating: true,
  },
  {
    name: 'update_plan',
    signature: '{"content": string}',
    description:
      'Write or replace the persisted plan markdown file (Plan mode only). Put the full numbered implementation plan here.',
    mutating: true,
  },
  {
    name: 'exit_plan_mode',
    signature: '{}',
    description:
      'Request user approval to finish planning and switch to Code mode to implement the plan. Call after update_plan when the plan is ready.',
    control: true,
  },
  {
    name: 'update_todos',
    signature: '{"todo": string[], "done"?: string[]}',
    description: 'Replace the working todo list; move finished items to `done`.',
  },
  {
    name: 'step_complete',
    signature: '{"summary": string}',
    description:
      'Finish the turn. `summary` is shown to the user — put your final answer or a summary of the changes here. When citing web results, include each title and full https URL.',
    control: true,
  },
  {
    name: 'step_failed',
    signature: '{"reason": string}',
    description: 'Finish the turn as failed when the task is impossible or blocked.',
    control: true,
  },
  ...MULTITASK_TOOL_SPECS.map(
    (tool): ToolSpec => ({
      name: tool.name,
      signature: tool.signature,
      description: tool.description,
      multitaskOnly: true,
    }),
  ),
]

const TOOL_NAMES = new Set(TOOL_SPECS.map((t) => t.name))
const MAX_RESULT_CHARS = 6000
const MAX_FILE_READ_BYTES = 512 * 1024
const MAX_GREP_HITS = 60
const DEFAULT_READ_LINE_LIMIT = 400
const GREP_EXCLUDE = '**/{node_modules,.git,dist,out,build,.next,coverage}/**'

export type ToolCall = import('./toolParse').ParsedToolCall

export function extractJsonObject(text: string): string | null {
  return extractJsonObjectInner(text, TOOL_NAMES)
}

export function parseToolCall(raw: string): ToolCall | { error: string } {
  return parseToolCallInner(raw, TOOL_NAMES)
}

export interface ToolOutcome {
  ok: boolean
  /** Fed back to the model as the tool result. */
  result: string
  /** One-line human summary for the UI card. */
  uiSummary: string
  /** Truncated detail for expandable tool rows in the webview. */
  uiDetail?: string
  /** User declined — show muted/skipped status instead of hard error until turn ends. */
  userSkipped?: boolean
  /** True when the prefix-trie symbol index answered the query — UI celebrates. */
  viaTrie?: boolean
  /** Measured trie lookup time (ms), when the trie was consulted. */
  trieMs?: number
  /** Measured full content-scan time (ms) from the same call — honest comparison. */
  scanMs?: number
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (value === undefined || value === null) {
    throw new Error(`\`${key}\` is required`)
  }
  if (typeof value === 'string') return value
  // Local models often emit bare numbers/booleans — coerce instead of failing the turn.
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  throw new Error(
    `\`${key}\` must be a string (got ${typeof value}). Example: "${key}": "your text here"`,
  )
}

function optNum(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number') throw new Error(`\`${key}\` must be a number`)
  return value
}

interface TruncationMeta {
  totalLines?: number
  startLine?: number
  endLine?: number
  matchCount?: number
  matchCap?: number
  hint?: string
}

/** Bound tool output and return enough metadata for the model to continue (Vibe-style). */
function truncate(text: string, max = MAX_RESULT_CHARS, meta?: TruncationMeta): string {
  const truncated = text.length > max
  const body = truncated ? text.slice(0, max) : text
  if (!truncated && !meta) return body
  const parts: string[] = []
  if (truncated) {
    parts.push(`[truncated] showing ${body.length} of ${text.length} chars`)
  }
  if (meta?.totalLines !== undefined) {
    const range =
      meta.startLine !== undefined
        ? ` lines ${meta.startLine}-${meta.endLine ?? meta.totalLines} of ${meta.totalLines}`
        : ` total_lines=${meta.totalLines}`
    parts.push(range.trim())
  }
  if (meta?.matchCount !== undefined && meta.matchCap !== undefined && meta.matchCount >= meta.matchCap) {
    parts.push(`matches capped at ${meta.matchCap}`)
  }
  if (meta?.hint) parts.push(meta.hint)
  if (parts.length === 0) return body
  return `${body}\n---\n${parts.join('; ')}.`
}

function formatEditCandidates(candidates: EditCandidate[]): string {
  if (candidates.length === 0) return '(no similar line window found)'
  return candidates
    .map((candidate, index) => {
      const score =
        candidate.score === undefined ? '' : `, similarity ${candidate.score.toFixed(2)}`
      return [
        `Candidate ${index + 1}: lines ${candidate.startLine}-${candidate.endLine}${score}`,
        candidate.text,
      ].join('\n')
    })
    .join('\n\n')
}

export interface WorkspaceToolsOptions {
  permissions?: PersistentPermissionStore
  sessionId?: string
  questionBroker?: QuestionBroker
  permissionBroker?: PermissionBroker
  planSession?: PlanSession
  profile?: AgentProfileName
  deadlineAt?: number
  abortSignal?: AbortSignal
}

export class WorkspaceTools {
  private readonly permissions: PersistentPermissionStore
  private readonly sessionId: string
  private readonly questionBroker: QuestionBroker | null
  private readonly permissionBroker: PermissionBroker | null
  readonly planSession: PlanSession | null
  private readonly profile: AgentProfileName
  private readonly deadlineAt: number | undefined
  private readonly abortSignal: AbortSignal | undefined
  /** Directories whose AGENTS.md has already been injected this session. */
  private readonly injectedAgentsMd = new Set<string>()

  constructor(
    private readonly root: string,
    private readonly multitask?: MultitaskToolContext,
    options: WorkspaceToolsOptions = {},
  ) {
    this.permissions = options.permissions ?? new PersistentPermissionStore(root)
    this.sessionId = options.sessionId ?? 'default'
    this.questionBroker = options.questionBroker ?? null
    this.permissionBroker = options.permissionBroker ?? null
    this.planSession = options.planSession ?? null
    this.profile = normalizeAgentProfile(options.profile)
    this.deadlineAt = options.deadlineAt
    this.abortSignal = options.abortSignal
  }

  /** Resolve a workspace-relative path; escapes and symlink hops are refused. */
  private async resolve(relPath: string, allowMissing = false): Promise<string> {
    if (path.isAbsolute(relPath)) throw new Error(`Absolute paths are not allowed: ${relPath}`)
    return assertContainedInWorkspace(this.root, relPath, { allowMissing })
  }

  /**
   * Outside-workspace access is a permission scope instead of an unconditional hard-refusal.
   * Safe defaults still require approval unless profile/default overrides allow it.
   */
  private async resolveWithScope(relPath: string, toolName: string, allowMissing = false): Promise<string> {
    if (!path.isAbsolute(relPath)) {
      try {
        return await assertContainedInWorkspace(this.root, relPath, { allowMissing })
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('escapes the workspace')) throw error
      }
    }
    const absolute = path.isAbsolute(relPath) ? path.resolve(relPath) : path.resolve(this.root, relPath)
    const realRoot = await assertContainedInWorkspace(this.root, '.')
    const rel = path.relative(realRoot, absolute)
    const inside = !(rel.startsWith('..') || path.isAbsolute(rel))
    if (inside) return absolute

    const defaultPolicy = this.permissions.toolDefault('outside_workspace', this.profile, 'ask')
    if (defaultPolicy === 'deny') {
      throw new Error(`Path resolves outside workspace and is denied by profile: ${relPath}`)
    }
    if (defaultPolicy === 'allow') return absolute

    const remembered = this.permissions.lookupOutsideWorkspace(absolute)
    if (remembered === 'allow') return absolute
    if (remembered === 'deny') {
      throw new Error(`Outside-workspace access denied for path: ${absolute}`)
    }
    const choice = await this.requestPermission({
      kind: 'scope',
      scope: 'outside-workspace',
      toolName,
      title: 'Allow tool access outside workspace?',
      preview: absolute,
      path: absolute,
    })
    if (choice === 'always') {
      this.permissions.rememberOutsideWorkspaceAlways(absolute)
      return absolute
    }
    if (choice === 'session' || choice === 'once') {
      this.permissions.rememberOutsideWorkspace(absolute, 'allow')
      return absolute
    }
    if (choice === 'deny') this.permissions.rememberOutsideWorkspace(absolute, 'deny')
    throw new Error(`Outside-workspace access denied for path: ${absolute}`)
  }

  /** Nested AGENTS.md files between workspace root and the read path (Vibe lazy injection). */
  private async collectAgentsMdExtras(fileAbs: string): Promise<string> {
    const sections: string[] = []
    let dir = path.dirname(fileAbs)
    const rootReal = await fs.promises.realpath(this.root).catch(() => this.root)
    while (true) {
      const agentsPath = path.join(dir, 'AGENTS.md')
      const key = path.resolve(agentsPath)
      if (!this.injectedAgentsMd.has(key)) {
        try {
          const stat = await fs.promises.stat(agentsPath)
          if (stat.isFile() && stat.size <= 64 * 1024) {
            const text = (await fs.promises.readFile(agentsPath, 'utf8')).trim()
            if (text) {
              this.injectedAgentsMd.add(key)
              const relDir = path.relative(this.root, dir) || '.'
              sections.push(
                `Contents of ${relDir}/AGENTS.md (project instructions for this directory):\n\n${text}`,
              )
            }
          }
        } catch {
          /* no AGENTS.md here */
        }
      }
      if (path.resolve(dir) === path.resolve(this.root) || path.resolve(dir) === rootReal) break
      const parent = path.dirname(dir)
      if (parent === dir) break
      // Stop if we walked above the workspace.
      const rel = path.relative(this.root, parent)
      if (rel.startsWith('..') || path.isAbsolute(rel)) break
      dir = parent
    }
    return sections.length > 0 ? `\n\n---\n${sections.join('\n\n')}` : ''
  }

  private assertPathWritable(relPath: string): void {
    if (!this.multitask) return
    const claim = this.multitask.bus.claimFor(relPath)
    if (!claim) {
      throw new Error(
        `Path "${relPath}" is unclaimed in Multitask mode. Claim it first with claim_paths before edit_file/write_file.`,
      )
    }
    if (claim.ownerId === this.multitask.agentId) return
    const owner = this.multitask.bus.ownerOf(relPath, this.multitask.agentId)
    if (!owner) return
    throw new Error(
      `Path "${relPath}" is claimed by sibling ${owner.ownerName}. Use claim_paths only for unclaimed files, or pick a different path.`,
    )
  }

  /** Cursor-like gate: auto-allow normal paths; ask for sensitive ones. */
  private async requestPermission(request: PermissionRequest): Promise<PermissionChoice | null> {
    if (this.permissionBroker) {
      return this.permissionBroker.ask(request)
    }
    const labels = ['Allow once', 'Allow for session', 'Always allow', 'Deny'] as const
    const choice = await vscode.window.showWarningMessage(request.title, { modal: true }, ...labels)
    if (choice === 'Allow once') return 'once'
    if (choice === 'Allow for session') return 'session'
    if (choice === 'Always allow') return 'always'
    if (choice === 'Deny') return 'deny'
    return null
  }

  private applyWritePermission(relPath: string, choice: PermissionChoice | null): void {
    if (choice === 'always') {
      this.permissions.rememberPathAlways(relPath)
      return
    }
    if (choice === 'session') {
      this.permissions.rememberPath(relPath, 'allow')
      return
    }
    if (choice === 'once') return
    if (choice === 'deny') {
      this.permissions.rememberPath(relPath, 'deny')
      throw new Error(`Write to sensitive path "${relPath}" denied by the user.`)
    }
    throw new Error(`Write to sensitive path "${relPath}" denied by the user.`)
  }

  private async assertWriteAllowed(
    relPath: string,
    action: 'edit' | 'write',
    diff?: { before?: string; after?: string },
  ): Promise<void> {
    if (isScratchpadPath(relPath, this.sessionId)) return
    const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '')
    if (normalized === '.trie-ide/permissions.json' || normalized === '.trie-ide/hooks.json') {
      throw new Error(`Writes to ${normalized} are blocked for security.`)
    }
    const canonical = relativeFromRoot(
      this.root,
      await this.resolve(relPath, action === 'write'),
    )
    if (!isSensitivePath(canonical)) return
    const defaultPolicy = this.permissions.toolDefault('sensitive_write', this.profile, 'ask')
    if (defaultPolicy === 'allow') return
    if (defaultPolicy === 'deny') {
      throw new Error(`Write to sensitive path "${relPath}" denied by active profile.`)
    }
    const remembered = this.permissions.lookupPath(canonical)
    if (remembered === 'allow') return
    if (remembered === 'deny') {
      throw new Error(`Write to sensitive path "${canonical}" was denied for this session.`)
    }
    const choice = await this.requestPermission({
      kind: 'write',
      title: `Allow ${action} on sensitive file?`,
      preview: canonical,
      path: canonical,
      action,
      toolName: action === 'edit' ? 'edit_file' : 'write_file',
      diff: diff
        ? {
            before: diff.before !== undefined ? capLines(diff.before, 40) : undefined,
            after: diff.after !== undefined ? capLines(diff.after, 40) : undefined,
          }
        : undefined,
    })
    this.applyWritePermission(canonical, choice)
  }

  async execute(call: ToolCall): Promise<ToolOutcome> {
    // `return await` is load-bearing: without it, async rejections (e.g. an
    // ENOENT stat) escape this try/catch and kill the whole turn instead of
    // coming back to the model as a recoverable tool failure.
    try {
      if (MULTITASK_TOOL_NAMES.has(call.tool)) {
        if (!this.multitask) {
          throw new Error(`${call.tool} is only available during Multitask sibling runs`)
        }
        return executeMultitaskTool(call.tool, call.args, this.multitask)
      }
      switch (call.tool) {
        case 'read_file':
          return await this.readFile(call.args)
        case 'read_files':
          return await this.readFiles(call.args)
        case 'list_dir':
          return await this.listDir(call.args)
        case 'glob':
          return await this.globFiles(call.args)
        case 'grep':
          return await this.grep(call.args)
        case 'search_symbols':
          return await this.searchSymbols(call.args)
        case 'edit_file':
          return await this.editFile(call.args)
        case 'write_file':
          return await this.writeFile(call.args)
        case 'run_command':
          return await this.runCommand(call.args)
        case 'run_verification':
          return await this.runVerification(call.args)
        case 'web_search':
          return await this.webSearch(call.args)
        case 'ask_user_question':
          return await this.askUserQuestion(call.args)
        case 'update_plan':
          return await this.updatePlan(call.args)
        default:
          throw new Error(`Tool ${call.tool} is not executable here`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, result: `Error: ${message}`, uiSummary: message }
    }
  }

  private async readFile(args: Record<string, unknown>): Promise<ToolOutcome> {
    const relPath = str(args, 'path')
    const absolute = await this.resolveWithScope(relPath, 'read_file')
    const stat = await fs.promises.stat(absolute)
    if (stat.size > MAX_FILE_READ_BYTES) {
      throw new Error(`File too large to read whole (${stat.size} bytes); use startLine/endLine`)
    }
    const content = await fs.promises.readFile(absolute, 'utf8')
    const lines = content.split('\n')
    const lineCount = lines.length
    const startLine = optNum(args, 'startLine')
    const endLine = optNum(args, 'endLine')
    const from = Math.max(1, startLine ?? 1)
    // Default page size when reading a whole large file without a range.
    const defaultTo =
      startLine === undefined && endLine === undefined && lineCount > DEFAULT_READ_LINE_LIMIT
        ? DEFAULT_READ_LINE_LIMIT
        : lineCount
    const to = Math.min(lineCount, endLine ?? defaultTo)
    const selected = lines.slice(from - 1, to).join('\n')
    const wasRangeTruncated = to < lineCount || from > 1
    const hint =
      to < lineCount
        ? `next: read_file path="${relPath}" startLine=${to + 1} endLine=${Math.min(lineCount, to + DEFAULT_READ_LINE_LIMIT)}`
        : undefined
    const agentsExtra = await this.collectAgentsMdExtras(absolute)
    return {
      ok: true,
      result:
        truncate(selected, MAX_RESULT_CHARS, {
          totalLines: lineCount,
          startLine: from,
          endLine: to,
          hint: wasRangeTruncated ? hint : undefined,
        }) + agentsExtra,
      uiSummary: `${relPath} (${from}-${to}/${lineCount} lines)`,
    }
  }

  private async readFiles(args: Record<string, unknown>): Promise<ToolOutcome> {
    const batch = await executeReadFilesBatch({
      root: this.root,
      paths: args['paths'],
      resolvePath: (relPath) => this.resolveWithScope(relPath, 'read_files'),
      maxResultChars: MAX_RESULT_CHARS,
      lineWindow: DEFAULT_READ_LINE_LIMIT,
      maxFileBytes: MAX_FILE_READ_BYTES,
    })
    return {
      ok: batch.ok,
      result: batch.text,
      uiSummary: batch.uiSummary,
    }
  }

  private async listDir(args: Record<string, unknown>): Promise<ToolOutcome> {
    const relPath = typeof args['path'] === 'string' ? (args['path'] as string) : ''
    const absolute = await this.resolveWithScope(relPath, 'list_dir')
    const entries = await fs.promises.readdir(absolute, { withFileTypes: true })
    const lines = entries
      .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    return {
      ok: true,
      result: truncate(lines.join('\n') || '(empty)'),
      uiSummary: `${relPath || '.'} — ${lines.length} entries`,
    }
  }

  private async globFiles(args: Record<string, unknown>): Promise<ToolOutcome> {
    const pattern = str(args, 'pattern')
    const uris = await vscode.workspace.findFiles(pattern, GREP_EXCLUDE, 200)
    const rels = uris.map((u) => path.relative(this.root, u.fsPath)).sort()
    return {
      ok: true,
      result: truncate(rels.join('\n') || 'No files matched.'),
      uiSummary: `${pattern} — ${rels.length} files`,
    }
  }

  private async searchSymbols(args: Record<string, unknown>): Promise<ToolOutcome> {
    const query = str(args, 'query')
    const indexCfg = readConfig().index
    if (!indexCfg.enabled) {
      return {
        ok: true,
        result:
          'Codebase indexing is disabled in Settings, so search_symbols is unavailable. Use grep to find declarations instead.',
        uiSummary: 'indexing disabled',
      }
    }
    const t0 = performance.now()
    const hits = await getSymbolIndex(this.root).search(
      query,
      indexCfg.maxResults,
      indexCfg.scoreThreshold,
    )
    const trieMs = performance.now() - t0
    if (hits.length === 0) {
      return {
        ok: true,
        result: `search_symbols "${query}": no declarations found in the symbol trie. Try grep for usages or a shorter prefix.`,
        uiSummary: `${query} — no symbols`,
      }
    }
    const lines = hits.map((h) => `${h.path}:${h.line}\t${h.kind} ${h.name}`)
    return {
      ok: true,
      result: truncate(`search_symbols "${query}" — ${hits.length} declarations:\n${lines.join('\n')}`),
      uiSummary: `${query} — ${hits.length} symbols`,
      viaTrie: true,
      trieMs,
    }
  }

  private async grep(args: Record<string, unknown>): Promise<ToolOutcome> {
    const pattern = str(args, 'pattern')
    const glob = typeof args['glob'] === 'string' && args['glob'] ? (args['glob'] as string) : '**/*'
    const trieStart = performance.now()
    const symbolHits =
      readConfig().index.enabled && isIdentifierPattern(pattern)
        ? await getSymbolIndex(this.root).search(pattern, 10)
        : []
    const trieMs = performance.now() - trieStart
    const scanStart = performance.now()
    const prefixHits = symbolHits.map(
      (h) => `${h.path}:${h.line}: [symbol trie] ${h.kind} ${h.name}`,
    )
    const search = await searchWorkspaceText({
      root: this.root,
      pattern,
      glob,
      exclude: GREP_EXCLUDE,
      maxHits: Math.max(0, MAX_GREP_HITS - prefixHits.length),
      maxFileBytes: MAX_FILE_READ_BYTES,
      deadlineAt: this.deadlineAt,
      signal: this.abortSignal,
    })
    const scanMs = performance.now() - scanStart
    if (search.cancelled) {
      return {
        ok: false,
        result: 'Cancelled.',
        uiSummary: `cancelled grep: /${pattern}/`,
        userSkipped: true,
      }
    }
    const hits = [...prefixHits, ...search.hits.map((h) => h.line)]
    const capped = search.capped || hits.length >= MAX_GREP_HITS
    return {
      ok: true,
      result: truncate(hits.join('\n') || 'No matches.', MAX_RESULT_CHARS, {
        matchCount: hits.length,
        matchCap: MAX_GREP_HITS,
        hint: capped
          ? 'narrow with glob or a more specific pattern; results may be incomplete'
          : undefined,
      }),
      uiSummary: `/${pattern}/ — ${hits.length}${capped ? '+' : ''} matches`,
      viaTrie: symbolHits.length > 0,
      ...(symbolHits.length > 0 ? { trieMs, scanMs } : {}),
    }
  }

  private async editFile(args: Record<string, unknown>): Promise<ToolOutcome> {
    const relPath = str(args, 'path')
    const replace = str(args, 'replace')
    const search = typeof args['search'] === 'string' ? (args['search'] as string) : ''
    const startLine = optNum(args, 'startLine')
    const endLine = optNum(args, 'endLine')
    const hasLineRange = startLine !== undefined && endLine !== undefined
    if (!hasLineRange && !search.trim()) {
      throw new Error(
        'Provide startLine+endLine+replace (preferred) or search+replace. To create a new file, use write_file (create-only).',
      )
    }
    if ((startLine !== undefined) !== (endLine !== undefined)) {
      throw new Error('startLine and endLine must be provided together.')
    }
    this.assertPathWritable(relPath)
    const absolute = await this.resolveWithScope(relPath, 'edit_file')
    let content: string
    try {
      content = await fs.promises.readFile(absolute, 'utf8')
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        throw new Error(
          `File does not exist: ${relPath}. Use write_file to create a new file, or read_file/list_dir first to confirm the path.`,
        )
      }
      throw error
    }

    if (hasLineRange) {
      const match = findLineRange(content, startLine!, endLine!)
      if ('error' in match) {
        const lineCount = content.split('\n').length
        throw new Error(
          `Invalid line range ${startLine}-${endLine} for ${relPath} (${lineCount} lines). Re-read the file and use inclusive 1-based startLine/endLine.`,
        )
      }
      // Optional search acts as a safety check when the model also supplies it.
      if (search.trim()) {
        const current = content.slice(match.start, match.end).replace(/\r\n/g, '\n').replace(/\n$/, '')
        const wanted = search.replace(/\r\n/g, '\n').replace(/\n$/, '')
        const same =
          current === wanted ||
          current.split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).join('\n') ===
            wanted.split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).join('\n')
        if (!same) {
          throw new Error(
            [
              `Line range ${startLine}-${endLine} in ${relPath} no longer matches the provided search; no edit was made.`,
              'Re-read those lines, then call edit_file with startLine/endLine + replace only (omit search).',
              '--- current lines ---',
              content.slice(match.start, match.end).replace(/\n$/, ''),
            ].join('\n'),
          )
        }
      }
      const beforeText = content.slice(match.start, match.end).replace(/\r\n/g, '\n').replace(/\n$/, '')
      await this.assertWriteAllowed(relPath, 'edit', { before: beforeText, after: replace })
      const eol = match.fileEol
      let replacement = replace.replace(/\r\n/g, '\n')
      if (eol === '\r\n') replacement = replacement.replace(/\n/g, '\r\n')
      // Keep a trailing newline when replacing a mid-file line window.
      if (match.end < content.length && !replacement.endsWith(eol) && !replacement.endsWith('\n')) {
        replacement += eol === '\r\n' ? '\r\n' : '\n'
      }
      const updated = content.slice(0, match.start) + replacement + content.slice(match.end)
      await fs.promises.writeFile(absolute, updated, 'utf8')
      return {
        ok: true,
        result: `Edited ${relPath} lines ${startLine}-${endLine}.`,
        uiSummary: relPath,
        uiDetail: buildUnifiedDiffPreview(beforeText, replace),
      }
    }

    const match = findEditRange(content, search)
    if ('error' in match) {
      const candidates = formatEditCandidates(match.candidates)
      if (match.error === 'ambiguous') {
        const matchMode =
          match.ambiguity === 'exact' ? 'exactly' : 'after whitespace normalization'
        throw new Error(
          [
            `\`search\` matches multiple places ${matchMode}; no edit was made.`,
            candidates,
            `Recovery: call read_file for a candidate range, then edit_file with startLine/endLine + replace (no search).`,
          ].join('\n\n'),
        )
      }
      const nearest = match.candidates[0]
      const recovery = nearest
        ? [
            'Durable recovery (preferred): rewrite those lines by number — no search retyping:',
            `{"path":"${relPath}","startLine":${nearest.startLine},"endLine":${nearest.endLine},"replace":"<your new content>"}`,
            '',
            `--- exact file text lines ${nearest.startLine}-${nearest.endLine} ---`,
            nearest.text,
            '--- end ---',
          ].join('\n')
        : `Recovery: call read_file for "${relPath}", then edit_file with startLine/endLine + replace.`
      throw new Error(
        [
          '`search` was not found; no edit was made.',
          candidates,
          recovery,
          'Do not retry a guessed or reformatted search. Prefer startLine/endLine + replace.',
        ].join('\n\n'),
      )
    }
    const beforeText = content.slice(match.start, match.end).replace(/\r\n/g, '\n').replace(/\n$/, '')
    await this.assertWriteAllowed(relPath, 'edit', { before: beforeText, after: replace })
    const replacement =
      match.kind === 'exact'
        ? replace
        : reindentReplacement(replace, match.fileIndent, match.searchIndent, match.fileEol)
    const updated = content.slice(0, match.start) + replacement + content.slice(match.end)
    await fs.promises.writeFile(absolute, updated, 'utf8')
    const note =
      match.kind === 'whitespace'
        ? ' (unique whitespace-normalized match)'
        : match.kind === 'lines'
          ? ` lines ${match.matchedStartLine}-${match.matchedEndLine}`
          : ''
    return {
      ok: true,
      result: `Edited ${relPath}.${note}`,
      uiSummary: relPath,
      uiDetail: buildUnifiedDiffPreview(beforeText, replace),
    }
  }

  private async writeFile(args: Record<string, unknown>): Promise<ToolOutcome> {
    const relPath = str(args, 'path')
    const content = str(args, 'content')
    this.assertPathWritable(relPath)
    await this.assertWriteAllowed(relPath, 'write', { after: content })
    const absolute = await this.resolveWithScope(relPath, 'write_file', true)
    const scratch = isScratchpadPath(relPath, this.sessionId)
    if (scratch) ensureScratchpad(this.root, this.sessionId)
    let exists = false
    try {
      await fs.promises.stat(absolute)
      exists = true
    } catch {
      exists = false
    }
    if (exists && !scratch) {
      throw new Error(
        `File already exists: ${relPath}. Use edit_file (startLine/endLine + replace) to modify existing files. write_file is create-only.`,
      )
    }
    await fs.promises.mkdir(path.dirname(absolute), { recursive: true })
    await fs.promises.writeFile(absolute, content, 'utf8')
    const note = scratch ? ' (scratchpad)' : ''
    return {
      ok: true,
      result: `Wrote ${relPath} (${content.length} chars)${note}.`,
      uiSummary: relPath,
      uiDetail: buildAddPreview(content),
    }
  }

  private async webSearch(args: Record<string, unknown>): Promise<ToolOutcome> {
    const query = str(args, 'query')
    const { provider, apiKey, maxResults } = readConfig().webSearch
    if (provider === 'none' || !apiKey) {
      throw new Error(
        'Web search is not configured. The user must set trie-ide.webSearch.provider and trie-ide.webSearch.apiKey in settings. Continue without searching.',
      )
    }
    const results = await runWebSearch(provider, apiKey, query, maxResults)
    if (results.length === 0) {
      return { ok: true, result: 'No results.', uiSummary: `${provider}: ${query} — no results` }
    }
    const text = results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join('\n')
    return {
      ok: true,
      result: truncate(text),
      uiSummary: `${provider}: ${query} — ${results.length} results`,
    }
  }

  private async runCommand(args: Record<string, unknown>): Promise<ToolOutcome> {
    const command = str(args, 'command')
    for (const url of extractUrls(command)) {
      const rememberedUrl = this.permissions.lookupUrl(url)
      if (rememberedUrl === 'deny') {
        return {
          ok: false,
          result: `Command denied by URL rule: ${url}`,
          uiSummary: `denied URL: ${url}`,
        }
      }
      if (rememberedUrl !== 'allow') {
        const choice = await this.requestPermission({
          kind: 'scope',
          scope: 'url-pattern',
          toolName: 'run_command',
          title: 'Allow command touching this URL host?',
          preview: url,
          command,
          cwd: this.root,
        })
        if (choice === 'always') {
          this.permissions.rememberUrlPatternAlways(urlPatternForHost(url))
        } else if (choice === 'session' || choice === 'once') {
          this.permissions.rememberUrl(url, 'allow')
        } else {
          if (choice === 'deny') this.permissions.rememberUrl(url, 'deny')
          return {
            ok: false,
            result: `Command denied for URL: ${url}`,
            uiSummary: `denied URL: ${url}`,
            userSkipped: true,
          }
        }
      }
    }
    const defaultPolicy = this.permissions.toolDefault('run_command', this.profile, 'ask')
    if (defaultPolicy === 'deny') {
      return {
        ok: false,
        result: 'Command denied by active profile.',
        uiSummary: `denied by profile: ${command}`,
      }
    }
    const remembered = this.permissions.lookupCommand(command)
    if (remembered === 'deny') {
      return {
        ok: false,
        result: 'Command denied by a prior session decision. Ask the user to re-approve if needed.',
        uiSummary: `denied (session): ${command}`,
      }
    }
    if (remembered !== 'allow' && defaultPolicy !== 'allow') {
      const choice = await this.requestPermission({
        kind: 'shell',
        title: 'Allow shell command?',
        preview: command,
        command,
        cwd: this.root,
        toolName: 'run_command',
      })
      if (choice === 'always') {
        this.permissions.rememberCommandAlways(command)
      } else if (choice === 'session') {
        this.permissions.rememberCommand(command, 'allow')
      } else if (choice === 'once') {
        // one-shot — do not persist
      } else {
        if (choice === 'deny') this.permissions.rememberCommand(command, 'deny')
        return {
          ok: false,
          result: 'Command denied by the user.',
          uiSummary: `denied: ${command}`,
          userSkipped: true,
        }
      }
    }
    const timeoutMs = Math.max(
      1,
      Math.min(120_000, this.deadlineAt ? this.deadlineAt - Date.now() : 120_000),
    )
    const output = await shellExec(command, this.root, timeoutMs, 1024 * 1024, this.abortSignal)
    if (output.cancelled) {
      return {
        ok: false,
        result: 'Cancelled.',
        uiSummary: `cancelled: ${command}`,
      }
    }
    const body = `${output.ok ? 'Exit 0' : 'Command failed'}\n${output.text}`
    const detail = truncate(body, 4000, {
      hint:
        body.length > 4000
          ? 'output truncated; re-run with a narrower command or pipe to a scratchpad file and read_file'
          : undefined,
    })
    return {
      ok: output.ok,
      result: truncate(body, MAX_RESULT_CHARS, {
        hint:
          body.length > MAX_RESULT_CHARS
            ? 'output truncated; re-run with a narrower command or pipe to a scratchpad file and read_file'
            : undefined,
      }),
      uiSummary: command,
      uiDetail: detail,
    }
  }

  private async askUserQuestion(args: Record<string, unknown>): Promise<ToolOutcome> {
    const raw = args['questions']
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error('`questions` must be a non-empty array of {question, options[]}.')
    }
    const questions: UserQuestionPayload[] = []
    for (const item of raw.slice(0, 4)) {
      if (typeof item !== 'object' || item === null) {
        throw new Error('Each question must be an object with question and options.')
      }
      const q = item as Record<string, unknown>
      const question = typeof q['question'] === 'string' ? q['question'].trim() : ''
      if (!question) throw new Error('Each question needs a non-empty `question` string.')
      const options = Array.isArray(q['options'])
        ? q['options'].filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
        : []
      if (options.length < 2) {
        throw new Error(`Question "${question}" needs at least 2 options.`)
      }
      questions.push({
        question,
        options,
        multiSelect: q['multiSelect'] === true,
      })
    }

    if (this.questionBroker) {
      const answers = await this.questionBroker.ask(questions)
      if (!answers || answers.length === 0) {
        return {
          ok: false,
          result: 'User cancelled without answering.',
          uiSummary: 'question cancelled',
        }
      }
      const lines = answers.map(
        (a) => `"${a.question}" → ${a.isOther ? '(Other) ' : ''}${a.answer}`,
      )
      return {
        ok: true,
        result: `User answers:\n${lines.join('\n')}`,
        uiSummary: lines.length === 1 ? lines[0] : `Asked ${lines.length} questions`,
      }
    }

    // Fallback when no webview broker is wired (tests / headless).
    return {
      ok: false,
      result: 'Question UI is unavailable. Ask the user in step_complete or try again from the chat panel.',
      uiSummary: 'question UI unavailable',
    }
  }

  private async updatePlan(args: Record<string, unknown>): Promise<ToolOutcome> {
    if (!this.planSession) {
      throw new Error('update_plan is only available in Plan mode.')
    }
    const content = str(args, 'content')
    const rel = this.planSession.write(content)
    return {
      ok: true,
      result: `Plan updated at ${rel} (${content.length} chars). Call exit_plan_mode when ready for the user to approve implementation.`,
      uiSummary: rel,
    }
  }

  /**
   * Autonomous verification is intentionally separate from run_command. It
   * invokes an existing, verification-named package script directly via
   * execFile: no shell, operators, arbitrary executables, or silent expansion
   * of the general command approval surface.
   */
  private async runVerification(args: Record<string, unknown>): Promise<ToolOutcome> {
    const skipReason = typeof args['skipReason'] === 'string' ? args['skipReason'].trim() : ''
    if (skipReason) {
      if (skipReason.length < 12) throw new Error('skipReason must explain why verification is not pragmatic.')
      const skipChoice = await this.requestPermission({
        kind: 'verification',
        title: 'Skip verification?',
        preview: skipReason,
        toolName: 'run_verification',
      })
      if (skipChoice !== 'once' && skipChoice !== 'session') {
        return {
          ok: false,
          result: 'Verification skip denied by the user.',
          uiSummary: 'skip denied',
          userSkipped: true,
        }
      }
      return {
        ok: true,
        result: `Verification explicitly skipped: ${skipReason}`,
        uiSummary: `Skipped verification — ${truncate(skipReason, 120)}`,
      }
    }

    const script = str(args, 'script').trim()
    if (
      !/^(?:test(?::[\w.-]+)?|typecheck|check(?::[\w.-]+)?|lint(?::[\w.-]+)?|build|e2e(?::[\w.-]+)?|visual(?::[\w.-]+)?|ui(?::[\w.-]+)?|harness(?::[\w.-]+)?|playwright|cypress|storybook:test)$/.test(script)
    ) {
      throw new Error(
        `Script "${script}" is not an allowed verification script. Use test/test:*, typecheck, check:*, lint:*, build, e2e:*, visual:*, ui:*, harness:*, playwright, cypress, or storybook:test.`,
      )
    }
    const packagePath =
      typeof args['packagePath'] === 'string' && args['packagePath'].trim()
        ? args['packagePath'].trim()
        : '.'
    const realRoot = await assertContainedInWorkspace(this.root, '.')
    const realPackageRoot = await assertContainedInWorkspace(this.root, packagePath)
    const packageRelative = path.relative(realRoot, realPackageRoot).split(path.sep).join('/')
    if (packageRelative.startsWith('..') || path.isAbsolute(packageRelative)) {
      throw new Error('Verification packagePath resolves outside the workspace.')
    }
    const verifyKey = `${packageRelative}:${script}`
    const rememberedVerify = this.permissions.lookupPath(verifyKey)
    if (rememberedVerify === 'deny') {
      return {
        ok: false,
        result: 'Verification denied by a prior session decision.',
        uiSummary: `denied: ${script}`,
        userSkipped: true,
      }
    }
    if (rememberedVerify !== 'allow') {
      const runner = await detectPackageRunner(realPackageRoot)
      const previewDisplay = `${runner} run ${script}`
      const choice = await this.requestPermission({
        kind: 'verification',
        title: 'Allow verification script?',
        preview: previewDisplay,
        path: verifyKey,
        toolName: 'run_verification',
      })
      if (choice === 'always') {
        this.permissions.rememberPathAlways(verifyKey)
      } else if (choice === 'session' || choice === 'once') {
        this.permissions.rememberPath(verifyKey, 'allow')
      } else {
        if (choice === 'deny') this.permissions.rememberPath(verifyKey, 'deny')
        return {
          ok: false,
          result: 'Verification denied by the user.',
          uiSummary: `denied: ${script}`,
          userSkipped: true,
        }
      }
    }
    const manifestPath = path.join(realPackageRoot, 'package.json')
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as {
      scripts?: Record<string, unknown>
    }
    if (typeof manifest.scripts?.[script] !== 'string') {
      throw new Error(`package.json at ${packagePath} has no "${script}" script.`)
    }

    const rawArgs = args['args']
    if (rawArgs !== undefined && (!Array.isArray(rawArgs) || rawArgs.some((value) => typeof value !== 'string'))) {
      throw new Error('`args` must be an array of strings.')
    }
    const scriptArgs = (rawArgs as string[] | undefined) ?? []
    if (scriptArgs.length > 20 || scriptArgs.some((value) => value.length > 240 || value.includes('\u0000'))) {
      throw new Error('Verification args are too large.')
    }

    const runner = await detectPackageRunner(realPackageRoot)
    const runnerArgs =
      runner === 'yarn'
        ? ['run', script, ...scriptArgs]
        : runner === 'bun'
          ? ['run', script, ...scriptArgs]
          : ['run', script, ...(scriptArgs.length > 0 ? ['--', ...scriptArgs] : [])]
    const display = `${runner} ${runnerArgs.join(' ')}`
    const timeoutMs = Math.max(
      1,
      Math.min(120_000, this.deadlineAt ? this.deadlineAt - Date.now() : 120_000),
    )
    const output = await execFileWithSignal(
      runner,
      runnerArgs,
      realPackageRoot,
      timeoutMs,
      1024 * 1024,
      this.abortSignal,
    )
    if (output.cancelled) {
      return {
        ok: false,
        result: 'Cancelled.',
        uiSummary: `cancelled: ${display}`,
      }
    }
    const artifactPaths = optionalStringArray(args, 'artifactPaths', 10)
    const artifacts = await this.describeVerificationArtifacts(artifactPaths)
    return {
      ok: output.ok,
      result: truncate(
        `${output.ok ? 'Verification passed' : 'Verification failed'}: ${display}\n${output.text}` +
          (artifacts ? `\n\nArtifacts:\n${artifacts}` : ''),
      ),
      uiSummary: `${output.ok ? 'Passed' : 'Failed'} — ${display}`,
    }
  }

  private async describeVerificationArtifacts(paths: string[]): Promise<string> {
    if (paths.length === 0) return ''
    const descriptions: string[] = []
    const realWorkspaceRoot = await assertContainedInWorkspace(this.root, '.')
    for (const relPath of paths) {
      try {
        const realArtifact = await assertContainedInWorkspace(this.root, relPath)
        const relative = path.relative(realWorkspaceRoot, realArtifact).split(path.sep).join('/')
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          descriptions.push(`${relPath}: unavailable (resolves outside the workspace)`)
          continue
        }
        const stat = await fs.promises.stat(realArtifact)
        if (!stat.isFile()) {
          descriptions.push(`${relPath}: not a file`)
          continue
        }
        const base = `${relPath}: ${stat.size} bytes`
        if (/\.(?:txt|log|json|xml|html?|md|csv)$/i.test(relPath) && stat.size <= 128 * 1024) {
          const preview = (await fs.promises.readFile(realArtifact, 'utf8')).slice(0, 2000)
          descriptions.push(`${base}\n${preview}`)
        } else {
          descriptions.push(base)
        }
      } catch (error) {
        descriptions.push(
          `${relPath}: unavailable (${error instanceof Error ? error.message : String(error)})`,
        )
      }
    }
    return descriptions.join('\n')
  }
}

type PackageRunner = 'npm' | 'pnpm' | 'yarn' | 'bun'

function optionalStringArray(
  args: Record<string, unknown>,
  key: string,
  maxItems: number,
): string[] {
  const value = args[key]
  if (value === undefined) return []
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 240)
  ) {
    throw new Error(`\`${key}\` must be an array of at most ${maxItems} non-empty paths.`)
  }
  return value as string[]
}

async function detectPackageRunner(packageRoot: string): Promise<PackageRunner> {
  const candidates: Array<[string, PackageRunner]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
  ]
  for (const [lockfile, runner] of candidates) {
    try {
      await fs.promises.access(path.join(packageRoot, lockfile))
      return runner
    } catch {
      /* try the next lockfile */
    }
  }
  return 'npm'
}

interface SearchResult {
  title: string
  url: string
  snippet: string
}

/** Call the configured search provider directly from this machine. */
async function runWebSearch(
  provider: Exclude<WebSearchProvider, 'none'>,
  apiKey: string,
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  let url: string
  let headers: Record<string, string>
  let body: Record<string, unknown>
  switch (provider) {
    case 'exa':
      url = 'https://api.exa.ai/search'
      headers = { 'x-api-key': apiKey }
      body = { query, numResults: maxResults, contents: { text: { maxCharacters: 700 } } }
      break
    case 'tavily':
      url = 'https://api.tavily.com/search'
      headers = { Authorization: `Bearer ${apiKey}` }
      body = { query, max_results: maxResults }
      break
    case 'ceramic':
      url = 'https://api.ceramic.ai/search'
      headers = { Authorization: `Bearer ${apiKey}` }
      body = { query }
      break
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300)
    throw new Error(`${provider} search failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`)
  }
  const data = (await response.json()) as Record<string, unknown>
  return normalizeSearchResults(data, maxResults)
}

/** Tolerant of provider response shapes: Exa/Tavily use top-level `results`; Ceramic nests under `result.results`. */
function normalizeSearchResults(data: Record<string, unknown>, max: number): SearchResult[] {
  const raw = extractSearchResultEntries(data)
  return raw.slice(0, max).map((entry) => {
    const r = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
    const pick = (...keys: string[]): string => {
      for (const key of keys) {
        const value = r[key]
        if (typeof value === 'string' && value.trim()) return value
      }
      return ''
    }
    return {
      title: pick('title') || pick('url', 'link') || 'Untitled',
      url: pick('url', 'link'),
      snippet: pick('text', 'content', 'snippet', 'description').replace(/\s+/g, ' ').slice(0, 700),
    }
  })
}

function extractSearchResultEntries(data: Record<string, unknown>): unknown[] {
  if (Array.isArray(data['results'])) return data['results'] as unknown[]
  const nested = data['result']
  if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
    const inner = nested as Record<string, unknown>
    if (Array.isArray(inner['results'])) return inner['results'] as unknown[]
  }
  return []
}

/** One-line arg summary for UI tool cards. */
export function summarizeArgs(call: ToolCall): string {
  const a = call.args
  switch (call.tool) {
    case 'read_file':
    case 'edit_file':
    case 'write_file':
      return typeof a['path'] === 'string' ? (a['path'] as string) : ''
    case 'read_files':
      return Array.isArray(a['paths'])
        ? a['paths'].filter((item): item is string => typeof item === 'string').join(', ')
        : ''
    case 'list_dir':
      return typeof a['path'] === 'string' && a['path'] ? (a['path'] as string) : '.'
    case 'glob':
    case 'grep':
      return typeof a['pattern'] === 'string' ? (a['pattern'] as string) : ''
    case 'web_search':
    case 'search_symbols':
      return typeof a['query'] === 'string' ? (a['query'] as string) : ''
    case 'run_command':
      return typeof a['command'] === 'string' ? (a['command'] as string) : ''
    case 'ask_user_question': {
      const qs = Array.isArray(a['questions']) ? a['questions'] : []
      const first = qs[0] as { question?: string } | undefined
      return typeof first?.question === 'string' ? first.question : `${qs.length} question(s)`
    }
    case 'update_plan':
      return 'plan file'
    case 'exit_plan_mode':
      return 'exit plan'
    case 'run_verification':
      return typeof a['skipReason'] === 'string'
        ? (a['skipReason'] as string)
        : `${typeof a['packagePath'] === 'string' ? (a['packagePath'] as string) : '.'}:${
            typeof a['script'] === 'string' ? (a['script'] as string) : ''
          }`
    default:
      return ''
  }
}

function basename(relPath: string): string {
  const parts = relPath.split(/[/\\]/)
  return parts[parts.length - 1] || relPath
}

function countLines(text: string): number {
  return text ? text.split('\n').length : 0
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s"'`]+/g)
  if (!matches) return []
  return [...new Set(matches)]
}

function urlPatternForHost(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}/*`
  } catch {
    return url
  }
}

/** Human row label for the activity accordion (Cursor-style). */
export function formatToolRow(call: ToolCall): string {
  const a = call.args
  switch (call.tool) {
    case 'read_file': {
      const rel = typeof a['path'] === 'string' ? (a['path'] as string) : ''
      const name = basename(rel)
      const start = optNum(a, 'startLine')
      const end = optNum(a, 'endLine')
      if (start !== undefined || end !== undefined) {
        const from = start ?? 1
        const to = end ?? from
        return `Read ${name} L${from}${to !== from ? `-${to}` : ''}`
      }
      return `Read ${name}`
    }
    case 'read_files': {
      const paths = Array.isArray(a['paths'])
        ? a['paths'].filter((item): item is string => typeof item === 'string')
        : []
      return `Read ${paths.length} file${paths.length === 1 ? '' : 's'}`
    }
    case 'list_dir':
      return `List ${typeof a['path'] === 'string' && a['path'] ? basename(a['path'] as string) : '.'}`
    case 'glob':
      return `Glob ${typeof a['pattern'] === 'string' ? (a['pattern'] as string) : ''}`
    case 'grep':
      return `Search ${typeof a['pattern'] === 'string' ? (a['pattern'] as string) : ''}`
    case 'search_symbols':
      return `Symbols ${typeof a['query'] === 'string' ? (a['query'] as string) : ''}`
    case 'web_search':
      return `Web ${typeof a['query'] === 'string' ? (a['query'] as string) : ''}`
    case 'edit_file':
      return typeof a['path'] === 'string' ? basename(a['path'] as string) : 'edit_file'
    case 'write_file':
      return typeof a['path'] === 'string' ? `Wrote ${basename(a['path'] as string)}` : 'write_file'
    case 'run_command': {
      const cmd = typeof a['command'] === 'string' ? (a['command'] as string) : ''
      return cmd.length > 72 ? cmd.slice(0, 69) + '…' : cmd
    }
    case 'ask_user_question': {
      const qs = Array.isArray(a['questions']) ? a['questions'] : []
      const first = qs[0] as { question?: string } | undefined
      if (typeof first?.question === 'string') {
        return first.question.length > 72 ? `Ask ${first.question.slice(0, 69)}…` : `Ask ${first.question}`
      }
      return 'Ask user'
    }
    case 'update_plan':
      return 'Update plan'
    case 'exit_plan_mode':
      return 'Exit plan mode'
    case 'run_verification': {
      if (typeof a['skipReason'] === 'string') return 'Skipped verification'
      const script = typeof a['script'] === 'string' ? (a['script'] as string) : 'verification'
      return `Verify ${script}`
    }
    case 'post_finding':
      return 'Post sibling finding'
    case 'read_sibling_updates':
      return 'Read sibling updates'
    case 'claim_paths': {
      const paths = Array.isArray(a['paths']) ? a['paths'].filter((p): p is string => typeof p === 'string') : []
      return paths.length ? `Claim ${paths.map((p) => basename(p)).join(', ')}` : 'Claim paths'
    }
    case 'release_paths': {
      const paths = Array.isArray(a['paths']) ? a['paths'].filter((p): p is string => typeof p === 'string') : []
      return paths.length ? `Release ${paths.map((p) => basename(p)).join(', ')}` : 'Release paths'
    }
    default:
      return call.tool
  }
}

/** Line delta for edit/write tools — feeds the turn summary +/− stats. */
export function toolLineDelta(call: ToolCall): { added: number; deleted: number } {
  const a = call.args
  if (call.tool === 'edit_file') {
    const replace = typeof a['replace'] === 'string' ? a['replace'] : ''
    const search = typeof a['search'] === 'string' ? a['search'] : ''
    const startLine = typeof a['startLine'] === 'number' ? a['startLine'] : undefined
    const endLine = typeof a['endLine'] === 'number' ? a['endLine'] : undefined
    const deleted =
      startLine !== undefined && endLine !== undefined && endLine >= startLine
        ? endLine - startLine + 1
        : countLines(search)
    return { added: countLines(replace), deleted }
  }
  if (call.tool === 'write_file') {
    const content = typeof a['content'] === 'string' ? a['content'] : ''
    return { added: countLines(content), deleted: 0 }
  }
  return { added: 0, deleted: 0 }
}

/** True when this call will (or did) consult the prefix-trie symbol index. */
export function isTrieToolCall(call: ToolCall): boolean {
  if (call.tool === 'search_symbols') return true
  if (call.tool === 'grep') {
    const pattern = call.args['pattern']
    return typeof pattern === 'string' && isIdentifierPattern(pattern)
  }
  return false
}

/** File path key for grouping consecutive edits on the same file. */
export function toolGroupKey(call: ToolCall): string | undefined {
  if (call.tool === 'edit_file' || call.tool === 'write_file') {
    return typeof call.args['path'] === 'string' ? (call.args['path'] as string) : undefined
  }
  return undefined
}

/**
 * Agent tools, adapted from Trie IDE's tool set (app/src/shared/agent.ts)
 * to run against the VS Code workspace. Same names and argument shapes so a
 * model tuned on Trie IDE prompts behaves identically here.
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { readConfig, type WebSearchProvider } from '../config'
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
import { getSymbolIndex, isIdentifierPattern } from './symbolIndex'

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
    description: 'Create or overwrite a file with the given content.',
    mutating: true,
  },
  {
    name: 'run_command',
    signature: '{"command": string}',
    description:
      'Run a shell command in the workspace root (requires user approval). Use for tests, builds, git.',
    mutating: true,
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

function truncate(text: string, max = MAX_RESULT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`
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

export class WorkspaceTools {
  constructor(
    private readonly root: string,
    private readonly multitask?: MultitaskToolContext,
  ) {}

  /** Resolve a workspace-relative path; escapes are refused (Trie IDE's PATH_OUTSIDE_WORKSPACE policy). */
  private resolve(relPath: string): string {
    if (path.isAbsolute(relPath)) throw new Error(`Absolute paths are not allowed: ${relPath}`)
    const absolute = path.resolve(this.root, relPath)
    const rel = path.relative(this.root, absolute)
    if (rel.startsWith('..')) throw new Error(`Path escapes the workspace: ${relPath}`)
    return absolute
  }

  private assertPathWritable(relPath: string): void {
    if (!this.multitask) return
    const owner = this.multitask.bus.ownerOf(relPath, this.multitask.agentId)
    if (!owner) return
    throw new Error(
      `Path "${relPath}" is claimed by sibling ${owner.ownerName}. Use claim_paths only for unclaimed files, or pick a different path.`,
    )
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
    const absolute = this.resolve(relPath)
    const stat = await fs.promises.stat(absolute)
    if (stat.size > MAX_FILE_READ_BYTES) {
      throw new Error(`File too large to read whole (${stat.size} bytes); use startLine/endLine`)
    }
    const content = await fs.promises.readFile(absolute, 'utf8')
    const startLine = optNum(args, 'startLine')
    const endLine = optNum(args, 'endLine')
    let selected = content
    if (startLine !== undefined || endLine !== undefined) {
      const lines = content.split('\n')
      const from = Math.max(1, startLine ?? 1)
      const to = Math.min(lines.length, endLine ?? lines.length)
      selected = lines.slice(from - 1, to).join('\n')
    }
    const lineCount = content.split('\n').length
    return {
      ok: true,
      result: truncate(selected),
      uiSummary: `${relPath} (${lineCount} lines)`,
    }
  }

  private async listDir(args: Record<string, unknown>): Promise<ToolOutcome> {
    const relPath = typeof args['path'] === 'string' ? (args['path'] as string) : ''
    const absolute = this.resolve(relPath)
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
    const regex = new RegExp(pattern)
    // Trie fast path: a bare identifier is usually "where is X declared" —
    // answer from the symbol index first, then append content matches. Both
    // paths are timed so the UI can show the honest speed difference.
    const trieStart = performance.now()
    const symbolHits =
      readConfig().index.enabled && isIdentifierPattern(pattern)
        ? await getSymbolIndex(this.root).search(pattern, 10)
        : []
    const trieMs = performance.now() - trieStart
    const scanStart = performance.now()
    const uris = await vscode.workspace.findFiles(glob, GREP_EXCLUDE, 2000)
    const hits: string[] = symbolHits.map(
      (h) => `${h.path}:${h.line}: [symbol trie] ${h.kind} ${h.name}`,
    )
    for (const uri of uris) {
      if (hits.length >= 60) break
      let content: string
      try {
        const stat = await fs.promises.stat(uri.fsPath)
        if (stat.size > MAX_FILE_READ_BYTES) continue
        content = await fs.promises.readFile(uri.fsPath, 'utf8')
      } catch {
        continue
      }
      if (content.includes('\u0000')) continue // binary
      const lines = content.split('\n')
      for (let i = 0; i < lines.length && hits.length < 60; i++) {
        if (regex.test(lines[i])) {
          hits.push(`${path.relative(this.root, uri.fsPath)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
        }
      }
    }
    const scanMs = performance.now() - scanStart
    return {
      ok: true,
      result: truncate(hits.join('\n') || 'No matches.'),
      uiSummary: `/${pattern}/ — ${hits.length} matches`,
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
        'Provide startLine+endLine+replace (preferred) or search+replace. To create or fully overwrite a file, use write_file.',
      )
    }
    if ((startLine !== undefined) !== (endLine !== undefined)) {
      throw new Error('startLine and endLine must be provided together.')
    }
    this.assertPathWritable(relPath)
    const absolute = this.resolve(relPath)
    const content = await fs.promises.readFile(absolute, 'utf8')

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
    }
  }

  private async writeFile(args: Record<string, unknown>): Promise<ToolOutcome> {
    const relPath = str(args, 'path')
    const content = str(args, 'content')
    this.assertPathWritable(relPath)
    const absolute = this.resolve(relPath)
    await fs.promises.mkdir(path.dirname(absolute), { recursive: true })
    await fs.promises.writeFile(absolute, content, 'utf8')
    return { ok: true, result: `Wrote ${relPath} (${content.length} chars).`, uiSummary: relPath }
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
    const choice = await vscode.window.showWarningMessage(
      `Trie Coding Agent wants to run:\n\n${command}`,
      { modal: true },
      'Run',
    )
    if (choice !== 'Run') {
      return { ok: false, result: 'Command denied by the user.', uiSummary: `denied: ${command}` }
    }
    const output = await new Promise<{ ok: boolean; text: string }>((resolvePromise) => {
      execFile(
        '/bin/sh',
        ['-c', command],
        { cwd: this.root, timeout: 120_000, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          const text = [stdout, stderr].filter(Boolean).join('\n')
          resolvePromise({ ok: !error, text: text || (error ? String(error) : '(no output)') })
        },
      )
    })
    return {
      ok: output.ok,
      result: truncate(`${output.ok ? 'Exit 0' : 'Command failed'}\n${output.text}`),
      uiSummary: command,
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
    const packageRoot = this.resolve(packagePath)
    const [realWorkspaceRoot, realPackageRoot] = await Promise.all([
      fs.promises.realpath(this.root),
      fs.promises.realpath(packageRoot),
    ])
    const packageRelative = path.relative(realWorkspaceRoot, realPackageRoot)
    if (packageRelative.startsWith('..') || path.isAbsolute(packageRelative)) {
      throw new Error('Verification packagePath resolves outside the workspace.')
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
    const output = await execFileResult(runner, runnerArgs, realPackageRoot)
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
    const realWorkspaceRoot = await fs.promises.realpath(this.root)
    for (const relPath of paths) {
      const absolute = this.resolve(relPath)
      try {
        const realArtifact = await fs.promises.realpath(absolute)
        const relative = path.relative(realWorkspaceRoot, realArtifact)
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

function execFileResult(
  executable: string,
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      executable,
      args,
      { cwd, timeout: 120_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const text = [stdout, stderr].filter(Boolean).join('\n')
        resolvePromise({ ok: !error, text: text || (error ? String(error) : '(no output)') })
      },
    )
  })
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

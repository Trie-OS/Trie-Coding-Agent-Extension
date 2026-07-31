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
import { getSymbolIndex, isIdentifierPattern } from './symbolIndex'

export interface ToolSpec {
  name: string
  /** Rendered into the system prompt. */
  signature: string
  description: string
  mutating?: boolean
  control?: boolean
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
      'Fast workspace symbol lookup via a prefix trie index. Use to find where a function, class, or type is declared before grepping for usages.',
  },
  {
    name: 'edit_file',
    signature: '{"path": string, "search": string, "replace": string}',
    description:
      'Replace the first occurrence of `search` with `replace`. Read the file first and copy `search` exactly; small whitespace differences are tolerated.',
    mutating: true,
  },
  {
    name: 'web_search',
    signature: '{"query": string}',
    description:
      'Search the internet. Returns titles, URLs, and snippets. Use for current documentation, APIs, libraries, or error messages.',
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
    name: 'update_todos',
    signature: '{"todo": string[], "done"?: string[]}',
    description: 'Replace the working todo list; move finished items to `done`.',
  },
  {
    name: 'step_complete',
    signature: '{"summary": string}',
    description:
      'Finish the turn. `summary` is shown to the user — put your final answer or a summary of the changes here.',
    control: true,
  },
  {
    name: 'step_failed',
    signature: '{"reason": string}',
    description: 'Finish the turn as failed when the task is impossible or blocked.',
    control: true,
  },
]

const TOOL_NAMES = new Set(TOOL_SPECS.map((t) => t.name))
const MAX_RESULT_CHARS = 6000
const MAX_FILE_READ_BYTES = 512 * 1024
const GREP_EXCLUDE = '**/{node_modules,.git,dist,out,build,.next,coverage}/**'

export interface ToolCall {
  thought: string
  tool: string
  args: Record<string, unknown>
}

export interface ToolOutcome {
  ok: boolean
  /** Fed back to the model as the tool result. */
  result: string
  /** One-line human summary for the UI card. */
  uiSummary: string
  /** True when the prefix-trie symbol index answered the query — UI celebrates. */
  viaTrie?: boolean
}

/** Extract the first balanced JSON object from model output (tolerates fences/prose). */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  // Truncated output: try closing an open string and any open braces.
  let candidate = text.slice(start)
  if (inString) candidate += '"'
  candidate += '}'.repeat(Math.max(depth, 0))
  try {
    JSON.parse(candidate)
    return candidate
  } catch {
    return null
  }
}

export function parseToolCall(raw: string): ToolCall | { error: string } {
  const json = extractJsonObject(raw)
  if (!json) return { error: 'No JSON object found in the response.' }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    return { error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof parsed !== 'object' || parsed === null) return { error: 'Response is not an object.' }
  const obj = parsed as Record<string, unknown>
  const tool = obj['tool']
  if (typeof tool !== 'string' || !TOOL_NAMES.has(tool)) {
    return { error: `Unknown tool: ${String(tool)}. Use one of: ${[...TOOL_NAMES].join(', ')}` }
  }
  const args = obj['args']
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { error: '`args` must be an object.' }
  }
  const thought = typeof obj['thought'] === 'string' ? obj['thought'] : ''
  return { thought, tool, args: args as Record<string, unknown> }
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string') throw new Error(`\`${key}\` must be a string`)
  return value
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

type EditRange =
  | { start: number; end: number; fuzzy: boolean; reindent: ((replace: string) => string) | null }
  | { error: string }

/**
 * Locate `search` in `content`. Local models often get whitespace slightly
 * wrong, so after an exact match we fall back to line-based matching that
 * tolerates trailing whitespace, then indentation differences — but only when
 * the fuzzy match is unique in the file.
 */
function findEditRange(content: string, search: string): EditRange {
  const exact = content.indexOf(search)
  if (exact !== -1) return { start: exact, end: exact + search.length, fuzzy: false, reindent: null }

  const contentLines = content.split('\n')
  const searchLines = search.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
  const n = searchLines.length

  const findLineMatches = (norm: (line: string) => string): number[] => {
    const target = searchLines.map(norm)
    const hits: number[] = []
    for (let i = 0; i + n <= contentLines.length; i++) {
      let all = true
      for (let j = 0; j < n; j++) {
        if (norm(contentLines[i + j]) !== target[j]) {
          all = false
          break
        }
      }
      if (all) hits.push(i)
    }
    return hits
  }

  const passes: Array<{ norm: (line: string) => string; reindents: boolean }> = [
    { norm: (l) => l.trimEnd(), reindents: false },
    { norm: (l) => l.trim(), reindents: true },
  ]
  for (const pass of passes) {
    const hits = findLineMatches(pass.norm)
    if (hits.length > 1) {
      return {
        error: `\`search\` matches ${hits.length} places in the file (with whitespace tolerance). Include more surrounding lines to make it unique.`,
      }
    }
    if (hits.length === 1) {
      const line = hits[0]
      const start = contentLines.slice(0, line).reduce((sum, l) => sum + l.length + 1, 0)
      const matched = contentLines.slice(line, line + n).join('\n')
      let reindent: ((replace: string) => string) | null = null
      if (pass.reindents) {
        const fileIndent = (contentLines[line].match(/^[ \t]*/) as RegExpMatchArray)[0]
        const searchIndent = (searchLines[0].match(/^[ \t]*/) as RegExpMatchArray)[0]
        if (fileIndent !== searchIndent) {
          reindent = (replace) =>
            replace
              .split('\n')
              .map((l) => (l.startsWith(searchIndent) ? fileIndent + l.slice(searchIndent.length) : l))
              .join('\n')
        }
      }
      return { start, end: start + matched.length, fuzzy: true, reindent }
    }
  }

  // Nothing matched, even with whitespace tolerance — the model most likely
  // guessed the file contents instead of reading them. Telling it to "re-read"
  // costs a turn and often repeats the guess, so hand it the real text now:
  // the whole file when it is small, otherwise the closest-matching region.
  if (content.length <= SMALL_FILE_ERROR_CHARS) {
    return {
      error:
        '`search` not found in the file. Here is the ACTUAL file content — copy your `search` text exactly from it (or rewrite the whole file with write_file):\n' +
        content,
    }
  }
  const nearest = nearestMatch(content, search)
  if (nearest) {
    return {
      error:
        `\`search\` not found in the file. The nearest text starts at line ${nearest.startLine} — copy it exactly:\n` +
        nearest.text,
    }
  }
  return {
    error:
      '`search` not found in the file, and nothing in it resembles your text. Read the file with read_file before editing it.',
  }
}

/** Files at or under this size are embedded whole in a failed-edit error. */
const SMALL_FILE_ERROR_CHARS = 3_000

/**
 * Character-trigram Dice coefficient — cheap, deterministic similarity.
 * Ported from Trie IDE's writeTools so both agents recover the same way.
 */
function similarity(a: string, b: string): number {
  const trigrams = (text: string): Map<string, number> => {
    const padded = `  ${text.trim()} `
    const counts = new Map<string, number>()
    for (let i = 0; i + 3 <= padded.length; i += 1) {
      const key = padded.slice(i, i + 3)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }
  const left = trigrams(a)
  const right = trigrams(b)
  const leftTotal = [...left.values()].reduce((sum, n) => sum + n, 0)
  const rightTotal = [...right.values()].reduce((sum, n) => sum + n, 0)
  if (leftTotal === 0 || rightTotal === 0) return a.trim() === b.trim() ? 1 : 0
  let shared = 0
  for (const [key, count] of left) shared += Math.min(count, right.get(key) ?? 0)
  return (2 * shared) / (leftTotal + rightTotal)
}

/**
 * The line-window in `content` most similar to `search`, so a failed edit can
 * point the model at the region it probably meant. A 0.35 score floor keeps
 * "nothing resembles it" a real answer instead of a random line-1 hit.
 */
function nearestMatch(
  content: string,
  search: string,
): { startLine: number; text: string; score: number } | null {
  const contentLines = content.split('\n')
  const searchLines = search.split('\n')
  const window = Math.max(1, searchLines.length)
  if (contentLines.length === 0 || search.trim() === '') return null

  let best: { startLine: number; text: string; score: number } | null = null
  const lastStart = Math.max(0, contentLines.length - window)
  for (let i = 0; i <= lastStart; i += 1) {
    const slice = contentLines.slice(i, i + window)
    let total = 0
    for (let j = 0; j < window; j += 1) total += similarity(slice[j] ?? '', searchLines[j] ?? '')
    const score = total / window
    if (score >= 0.35 && (best === null || score > best.score)) {
      best = { startLine: i + 1, text: slice.join('\n'), score }
    }
  }
  return best
}

export class WorkspaceTools {
  constructor(private readonly root: string) {}

  /** Resolve a workspace-relative path; escapes are refused (Trie IDE's PATH_OUTSIDE_WORKSPACE policy). */
  private resolve(relPath: string): string {
    if (path.isAbsolute(relPath)) throw new Error(`Absolute paths are not allowed: ${relPath}`)
    const absolute = path.resolve(this.root, relPath)
    const rel = path.relative(this.root, absolute)
    if (rel.startsWith('..')) throw new Error(`Path escapes the workspace: ${relPath}`)
    return absolute
  }

  async execute(call: ToolCall): Promise<ToolOutcome> {
    try {
      switch (call.tool) {
        case 'read_file':
          return this.readFile(call.args)
        case 'list_dir':
          return this.listDir(call.args)
        case 'glob':
          return this.globFiles(call.args)
        case 'grep':
          return this.grep(call.args)
        case 'search_symbols':
          return this.searchSymbols(call.args)
        case 'edit_file':
          return this.editFile(call.args)
        case 'write_file':
          return this.writeFile(call.args)
        case 'run_command':
          return this.runCommand(call.args)
        case 'web_search':
          return this.webSearch(call.args)
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
    const hits = await getSymbolIndex(this.root).search(query, 30)
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
    }
  }

  private async grep(args: Record<string, unknown>): Promise<ToolOutcome> {
    const pattern = str(args, 'pattern')
    const glob = typeof args['glob'] === 'string' && args['glob'] ? (args['glob'] as string) : '**/*'
    const regex = new RegExp(pattern)
    // Trie fast path: a bare identifier is usually "where is X declared" —
    // answer from the symbol index first, then append content matches.
    const symbolHits = isIdentifierPattern(pattern)
      ? await getSymbolIndex(this.root).search(pattern, 10)
      : []
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
    return {
      ok: true,
      result: truncate(hits.join('\n') || 'No matches.'),
      uiSummary: `/${pattern}/ — ${hits.length} matches`,
      viaTrie: symbolHits.length > 0,
    }
  }

  private async editFile(args: Record<string, unknown>): Promise<ToolOutcome> {
    const relPath = str(args, 'path')
    const search = str(args, 'search')
    const replace = str(args, 'replace')
    if (!search.trim()) {
      throw new Error('`search` must not be empty. To create or fully overwrite a file, use write_file.')
    }
    const absolute = this.resolve(relPath)
    const content = await fs.promises.readFile(absolute, 'utf8')
    const match = findEditRange(content, search)
    if ('error' in match) throw new Error(match.error)
    const replacement = match.reindent ? match.reindent(replace) : replace
    const updated = content.slice(0, match.start) + replacement + content.slice(match.end)
    await fs.promises.writeFile(absolute, updated, 'utf8')
    return {
      ok: true,
      result: `Edited ${relPath}.${match.fuzzy ? ' (matched with whitespace tolerance)' : ''}`,
      uiSummary: relPath,
    }
  }

  private async writeFile(args: Record<string, unknown>): Promise<ToolOutcome> {
    const relPath = str(args, 'path')
    const content = str(args, 'content')
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

/** Tolerant of provider response shapes: results under `results`, fields title/url/text|content|snippet. */
function normalizeSearchResults(data: Record<string, unknown>, max: number): SearchResult[] {
  const raw = Array.isArray(data['results']) ? (data['results'] as unknown[]) : []
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
    default:
      return call.tool
  }
}

/** Line delta for edit/write tools — feeds the turn summary +/− stats. */
export function toolLineDelta(call: ToolCall): { added: number; deleted: number } {
  const a = call.args
  if (call.tool === 'edit_file') {
    const search = typeof a['search'] === 'string' ? a['search'] : ''
    const replace = typeof a['replace'] === 'string' ? a['replace'] : ''
    return { added: countLines(replace), deleted: countLines(search) }
  }
  if (call.tool === 'write_file') {
    const content = typeof a['content'] === 'string' ? a['content'] : ''
    return { added: countLines(content), deleted: 0 }
  }
  return { added: 0, deleted: 0 }
}

/** File path key for grouping consecutive edits on the same file. */
export function toolGroupKey(call: ToolCall): string | undefined {
  if (call.tool === 'edit_file' || call.tool === 'write_file') {
    return typeof call.args['path'] === 'string' ? (call.args['path'] as string) : undefined
  }
  return undefined
}

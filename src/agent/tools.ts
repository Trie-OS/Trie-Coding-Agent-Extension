/**
 * Agent tools, adapted from Trie IDE's tool set (app/src/shared/agent.ts)
 * to run against the VS Code workspace. Same names and argument shapes so a
 * model tuned on Trie IDE prompts behaves identically here.
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'

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
    description: 'Search file contents with a regular expression.',
  },
  {
    name: 'edit_file',
    signature: '{"path": string, "search": string, "replace": string}',
    description:
      'Replace the first exact occurrence of `search` with `replace`. Read the file first; `search` must match exactly, including whitespace.',
    mutating: true,
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
        case 'edit_file':
          return this.editFile(call.args)
        case 'write_file':
          return this.writeFile(call.args)
        case 'run_command':
          return this.runCommand(call.args)
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

  private async grep(args: Record<string, unknown>): Promise<ToolOutcome> {
    const pattern = str(args, 'pattern')
    const glob = typeof args['glob'] === 'string' && args['glob'] ? (args['glob'] as string) : '**/*'
    const regex = new RegExp(pattern)
    const uris = await vscode.workspace.findFiles(glob, GREP_EXCLUDE, 2000)
    const hits: string[] = []
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
    }
  }

  private async editFile(args: Record<string, unknown>): Promise<ToolOutcome> {
    const relPath = str(args, 'path')
    const search = str(args, 'search')
    const replace = str(args, 'replace')
    const absolute = this.resolve(relPath)
    const content = await fs.promises.readFile(absolute, 'utf8')
    const index = content.indexOf(search)
    if (index === -1) {
      throw new Error(
        '`search` not found in the file. Re-read the file and copy the exact text, including whitespace.',
      )
    }
    const updated = content.slice(0, index) + replace + content.slice(index + search.length)
    await fs.promises.writeFile(absolute, updated, 'utf8')
    return { ok: true, result: `Edited ${relPath}.`, uiSummary: relPath }
  }

  private async writeFile(args: Record<string, unknown>): Promise<ToolOutcome> {
    const relPath = str(args, 'path')
    const content = str(args, 'content')
    const absolute = this.resolve(relPath)
    await fs.promises.mkdir(path.dirname(absolute), { recursive: true })
    await fs.promises.writeFile(absolute, content, 'utf8')
    return { ok: true, result: `Wrote ${relPath} (${content.length} chars).`, uiSummary: relPath }
  }

  private async runCommand(args: Record<string, unknown>): Promise<ToolOutcome> {
    const command = str(args, 'command')
    const choice = await vscode.window.showWarningMessage(
      `Trie IDE agent wants to run:\n\n${command}`,
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
    case 'run_command':
      return typeof a['command'] === 'string' ? (a['command'] as string) : ''
    default:
      return ''
  }
}

import * as fs from 'node:fs'
import * as path from 'node:path'
import { assertContainedInWorkspace } from './pathContainment.ts'

export const READ_FILES_MAX_PATHS = 8
const READ_FILES_OVERHEAD_CHARS = 300
const DEFAULT_MAX_RESULT_CHARS = 6000
const DEFAULT_LINE_WINDOW = 400
const DEFAULT_MAX_FILE_BYTES = 512 * 1024

export interface ReadFilesBatchOptions {
  root: string
  paths: unknown
  resolvePath: (relPath: string) => Promise<string>
  maxResultChars?: number
  lineWindow?: number
  maxFileBytes?: number
}

export interface ReadFilesBatchResult {
  ok: boolean
  text: string
  uiSummary: string
  succeeded: number
  requested: number
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 12)}\n[truncated]`
}

function isWorkspaceEscapeError(message: string): boolean {
  return /escapes the workspace|outside workspace|absolute paths are not allowed/i.test(message)
}

function normalizePaths(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('`paths` must contain 1-8 non-empty workspace-relative file paths.')
  }
  if (raw.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error('`paths` must contain 1-8 non-empty workspace-relative file paths.')
  }
  return [...new Set((raw as string[]).map((item) => item.trim()))]
}

async function readFileSection(
  relPath: string,
  resolvePath: (relPath: string) => Promise<string>,
  lineWindow: number,
  maxFileBytes: number,
  sectionBudget: number,
): Promise<string> {
  const absolute = await resolvePath(relPath)
  const stat = await fs.promises.stat(absolute)
  if (!stat.isFile()) throw new Error('path is not a file')
  if (stat.size > maxFileBytes) {
    throw new Error(`file is ${stat.size} bytes; use grep or a focused read_file range`)
  }
  const content = await fs.promises.readFile(absolute, 'utf8')
  if (content.includes('\u0000')) throw new Error('binary file')
  const lines = content.split('\n')
  const end = Math.min(lines.length, lineWindow)
  const width = String(end).length
  const body = lines
    .slice(0, end)
    .map((line, index) => `${String(index + 1).padStart(width, ' ')}\t${line}`)
    .join('\n')
  const remaining = lines.length - end
  const footer =
    remaining > 0
      ? `\n… ${remaining} more line${remaining === 1 ? '' : 's'} (use read_file path="${relPath}" startLine=${end + 1})`
      : ''
  const section = `--- ${relPath} lines 1-${end} of ${lines.length} ---\n${body}${footer}`
  if (section.length <= sectionBudget) return section
  const cutNote = `\n… [cut to fit batch budget; use read_file ${JSON.stringify(relPath)} for a full window]`
  return section.slice(0, Math.max(0, sectionBudget - cutNote.length)) + cutNote
}

export async function executeReadFilesBatch(options: ReadFilesBatchOptions): Promise<ReadFilesBatchResult> {
  const maxResultChars = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS
  const lineWindow = options.lineWindow ?? DEFAULT_LINE_WINDOW
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const paths = normalizePaths(options.paths)
  const kept = paths.slice(0, READ_FILES_MAX_PATHS)
  const skipped = paths.length - kept.length
  const perFileBudget = Math.max(
    500,
    Math.floor((maxResultChars - READ_FILES_OVERHEAD_CHARS) / Math.max(1, kept.length)),
  )
  const sections: string[] = []
  let succeeded = 0
  for (const relPath of kept) {
    try {
      sections.push(
        await readFileSection(relPath, options.resolvePath, lineWindow, maxFileBytes, perFileBudget),
      )
      succeeded += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isWorkspaceEscapeError(message)) throw error
      sections.push(`--- ${relPath} ---\nError: ${message}`)
    }
  }
  const footer =
    skipped > 0
      ? `\n\n… ${skipped} more path${skipped === 1 ? '' : 's'} not read (max ${READ_FILES_MAX_PATHS} per call)`
      : ''
  const text = truncate(
    `read_files: ${succeeded}/${paths.length} files read\n\n${sections.join('\n\n')}${footer}`,
    maxResultChars,
  )
  return {
    ok: succeeded > 0,
    text,
    uiSummary: `${succeeded}/${paths.length} files`,
    succeeded,
    requested: paths.length,
  }
}

export async function resolveWorkspaceReadPath(
  root: string,
  relPath: string,
  allowMissing = false,
): Promise<string> {
  if (path.isAbsolute(relPath)) throw new Error(`Absolute paths are not allowed: ${relPath}`)
  return assertContainedInWorkspace(root, relPath, { allowMissing })
}

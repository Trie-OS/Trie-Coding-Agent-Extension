import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'

const MAX_FILE_SCAN = 2000

export interface GrepHit {
  line: string
}

export interface GrepSearchOptions {
  root: string
  pattern: string
  glob: string
  exclude: string
  maxHits: number
  maxFileBytes: number
  deadlineAt?: number
  signal?: AbortSignal
}

export async function searchWorkspaceText(options: GrepSearchOptions): Promise<{
  hits: GrepHit[]
  capped: boolean
  cancelled: boolean
}> {
  if (options.signal?.aborted) {
    return { hits: [], capped: false, cancelled: true }
  }
  const rg = await searchWithRipgrep(options)
  if (rg) return rg
  return searchWithCancellation(options)
}

async function searchWithRipgrep(
  options: GrepSearchOptions,
): Promise<{ hits: GrepHit[]; capped: boolean; cancelled: boolean } | null> {
  const executable = process.platform === 'win32' ? 'rg.exe' : 'rg'
  return new Promise((resolve) => {
    let settled = false
    const hits: GrepHit[] = []
    let capped = false
    let cancelled = false
    const finish = (value: { hits: GrepHit[]; capped: boolean; cancelled: boolean } | null): void => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const args = [
      '--no-heading',
      '--line-number',
      '--max-count',
      String(options.maxHits),
      '--glob',
      options.glob,
      '--glob',
      `!${options.exclude.replace(/\*\*\//g, '').replace(/\/\*\*$/, '')}`,
      '--',
      options.pattern,
      options.root,
    ]
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(executable, args, { cwd: options.root })
    } catch {
      finish(null)
      return
    }
    let buffer = ''
    const onAbort = (): void => {
      cancelled = true
      child.kill('SIGTERM')
      finish({ hits, capped, cancelled: true })
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
        capped = true
        child.kill('SIGTERM')
        return
      }
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) {
          hits.push({ line })
          if (hits.length >= options.maxHits) {
            capped = true
            child.kill('SIGTERM')
            break
          }
        }
        newline = buffer.indexOf('\n')
      }
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => {
      if (cancelled) return
      if (code === 0 || code === 1) finish({ hits, capped, cancelled: false })
      else finish(null)
    })
  })
}

async function searchWithCancellation(
  options: GrepSearchOptions,
): Promise<{ hits: GrepHit[]; capped: boolean; cancelled: boolean }> {
  const regex = new RegExp(options.pattern)
  const uris = await vscode.workspace.findFiles(options.glob, options.exclude, MAX_FILE_SCAN)
  const hits: GrepHit[] = []
  let capped = false
  for (const uri of uris) {
    if (options.signal?.aborted) {
      return { hits, capped, cancelled: true }
    }
    if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
      capped = true
      break
    }
    if (hits.length >= options.maxHits) {
      capped = true
      break
    }
    let content: string
    try {
      const stat = await fs.promises.stat(uri.fsPath)
      if (stat.size > options.maxFileBytes) continue
      content = await fs.promises.readFile(uri.fsPath, 'utf8')
    } catch {
      continue
    }
    if (content.includes('\u0000')) continue
    const rel = path.relative(options.root, uri.fsPath).split(path.sep).join('/')
    const lines = content.split('\n')
    for (let i = 0; i < lines.length && hits.length < options.maxHits; i++) {
      if (regex.test(lines[i])) {
        hits.push({ line: `${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}` })
      }
    }
    if (hits.length >= options.maxHits) capped = true
  }
  return { hits, capped, cancelled: false }
}

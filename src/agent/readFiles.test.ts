import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  executeReadFilesBatch,
  READ_FILES_MAX_PATHS,
  resolveWorkspaceReadPath,
} from './readFilesBatch.ts'

const MAX_RESULT_CHARS = 6000

function write(root: string, relPath: string, content: string): void {
  const absolute = path.join(root, relPath)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content, 'utf8')
}

describe('executeReadFilesBatch', () => {
  it('reads several files in one call with numbered sections', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trie-read-files-'))
    try {
      write(
        root,
        'src/theme.ts',
        [
          "import { useState } from 'react'",
          '',
          'export function useTheme() {',
          '  return "light"',
          '}',
        ].join('\n'),
      )
      write(root, 'src/app.tsx', 'export const App = () => <div className="bg-white" />\n')
      const batch = await executeReadFilesBatch({
        root,
        paths: ['src/theme.ts', 'src/app.tsx'],
        resolvePath: (relPath) => resolveWorkspaceReadPath(root, relPath),
      })
      assert.equal(batch.ok, true)
      assert.match(batch.text, /read_files: 2\/2 files read/)
      assert.match(batch.text, /--- src\/theme.ts lines 1-5 of 5 ---/)
      assert.match(batch.text, /3\texport function useTheme\(\)/)
      assert.match(batch.text, /--- src\/app.tsx lines 1-2 of 2 ---/)
      assert.match(batch.text, /bg-white/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('inlines a per-path error instead of discarding the rest of the batch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trie-read-files-'))
    try {
      write(root, 'src/theme.ts', 'export const theme = "light"')
      const batch = await executeReadFilesBatch({
        root,
        paths: ['nope.ts', 'src/theme.ts'],
        resolvePath: (relPath) => resolveWorkspaceReadPath(root, relPath),
      })
      assert.equal(batch.ok, true)
      assert.match(batch.text, /--- nope\.ts ---\nError:/)
      assert.match(batch.text, /--- src\/theme\.ts lines 1-1 of 1 ---/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('caps the batch at READ_FILES_MAX_PATHS and reports skipped paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trie-read-files-'))
    try {
      const paths = Array.from({ length: READ_FILES_MAX_PATHS + 3 }, (_, index) => `many/f${index}.ts`)
      for (const relPath of paths) write(root, relPath, `export const v = ${relPath.length}\n`)
      const batch = await executeReadFilesBatch({
        root,
        paths,
        resolvePath: (relPath) => resolveWorkspaceReadPath(root, relPath),
      })
      assert.equal(batch.ok, true)
      assert.match(batch.text, new RegExp(`read_files: ${READ_FILES_MAX_PATHS}\\/${paths.length} files read`))
      assert.match(
        batch.text,
        new RegExp(`3 more paths not read \\(max ${READ_FILES_MAX_PATHS} per call\\)`),
      )
      assert.doesNotMatch(batch.text, new RegExp(`f${READ_FILES_MAX_PATHS}\\.ts lines`))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('splits one result budget across the batch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trie-read-files-'))
    try {
      const chunky = `${'export const padding = "xxxxxxxxxxxxxxxxxxxxxxxx"\n'.repeat(220)}`
      const paths = ['big/a.ts', 'big/b.ts', 'big/c.ts', 'big/d.ts']
      for (const relPath of paths) write(root, relPath, chunky)
      const batch = await executeReadFilesBatch({
        root,
        paths,
        resolvePath: (relPath) => resolveWorkspaceReadPath(root, relPath),
        maxResultChars: MAX_RESULT_CHARS,
      })
      assert.equal(batch.ok, true)
      assert.ok(batch.text.length <= MAX_RESULT_CHARS)
      for (const relPath of paths) {
        assert.match(batch.text, new RegExp(`--- ${relPath.replace('.', '\\.')} lines`))
        assert.match(batch.text, /cut to fit batch budget/)
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('de-duplicates repeated paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trie-read-files-'))
    try {
      write(root, 'src/theme.ts', 'export const theme = "light"')
      const batch = await executeReadFilesBatch({
        root,
        paths: ['src/theme.ts', 'src/theme.ts'],
        resolvePath: (relPath) => resolveWorkspaceReadPath(root, relPath),
      })
      assert.equal(batch.ok, true)
      assert.match(batch.text, /read_files: 1\/1 files read/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails the whole batch on a workspace-escape path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trie-read-files-'))
    try {
      write(root, 'src/theme.ts', 'export const theme = "light"')
      await assert.rejects(
        () =>
          executeReadFilesBatch({
            root,
            paths: ['/etc/passwd', 'src/theme.ts'],
            resolvePath: (relPath) => resolveWorkspaceReadPath(root, relPath),
          }),
        /escapes the workspace|Absolute paths are not allowed/,
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects empty paths arrays', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trie-read-files-'))
    try {
      await assert.rejects(
        () =>
          executeReadFilesBatch({
            root,
            paths: [],
            resolvePath: (relPath) => resolveWorkspaceReadPath(root, relPath),
          }),
        /1-8 non-empty workspace-relative file paths/,
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

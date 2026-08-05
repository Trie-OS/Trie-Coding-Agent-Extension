import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const temp = await mkdtemp(join(tmpdir(), 'trie-coding-smoke-'))
const outfile = join(temp, 'coding-smoke.mjs')

try {
  await build({
    entryPoints: [resolve('bench/coding-smoke.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    alias: {
      vscode: resolve('test-stubs/vscode/index.js'),
    },
    logLevel: 'warning',
  })
  await import(pathToFileURL(outfile).href)
} finally {
  await rm(temp, { recursive: true, force: true })
}


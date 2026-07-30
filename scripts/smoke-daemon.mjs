/**
 * Protocol smoke test: run against a live localforged (fake inference is fine):
 *   cd ../app && npm run daemon:local
 *   node scripts/smoke-daemon.mjs [port]
 */
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = process.argv[2] ?? '7841'
const dir = mkdtempSync(join(tmpdir(), 'lf-smoke-'))
const entry = join(dir, 'entry.mjs')

writeFileSync(
  entry,
  `
import { DaemonClient } from '${new URL('../src/inference/daemonClient.ts', import.meta.url).pathname}'

const client = new DaemonClient('http://127.0.0.1:${port}')

const hs = await client.handshake()
console.log('handshake ok:', JSON.stringify(hs))

const status = await client.status()
console.log('status ok:', JSON.stringify(status))

try {
  const result = await client.generate(
    [
      { role: 'system', content: 'You are a test.' },
      { role: 'user', content: 'Say hi.' },
    ],
    { temperature: 0.2, topP: 0.95, maxTokens: 64 },
    () => {},
    new AbortController().signal,
  )
  console.log('generate ok:', JSON.stringify(result).slice(0, 200))
} catch (error) {
  console.log('generate path exercised:', error.message)
}
console.log('SMOKE PASS')
`,
)

const outfile = join(dir, 'bundle.mjs')
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile })
try {
  await import(outfile)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

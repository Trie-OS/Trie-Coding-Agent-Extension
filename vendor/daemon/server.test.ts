import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { DaemonServer } from './server'
import { DaemonClient } from '../main/services/remote/daemonClient'

describe('DaemonServer', () => {
  let server: DaemonServer | null = null
  let storeRoot: string | null = null

  afterEach(async () => {
    await server?.stop()
    server = null
    if (storeRoot) {
      rmSync(storeRoot, { recursive: true, force: true })
      storeRoot = null
    }
    delete process.env['TRIE_FAKE_INFERENCE']
  })

  it('handshake returns protocol version', async () => {
    process.env['TRIE_FAKE_INFERENCE'] = '1'
    server = new DaemonServer()
    const { port } = await server.start()
    const client = new DaemonClient(`http://127.0.0.1:${port}`)
    const hs = await client.handshake()
    expect(hs.ramBytes).toBeGreaterThan(0)
    expect(hs.platform).toContain('-')
  })

  it('init store, bench, and list downloads', async () => {
    process.env['TRIE_FAKE_INFERENCE'] = '1'
    storeRoot = mkdtempSync(join(tmpdir(), 'trie-ide-daemon-store-'))
    server = new DaemonServer()
    const { port } = await server.start()
    const client = new DaemonClient(`http://127.0.0.1:${port}`)

    const store = await client.initStore(storeRoot, 'test-store')
    expect(store.storeId).toBeTruthy()
    expect(store.volumePath).toBe(storeRoot)

    const fetched = await client.getStore(storeRoot)
    expect(fetched?.storeId).toBe(store.storeId)

    const bench = await client.bench(storeRoot)
    expect(bench.readMbps).toBeGreaterThanOrEqual(0)

    const job = await client.submitDownload({
      storePath: storeRoot,
      repoId: 'org/model',
      groupKey: 'model-Q4.gguf',
      totalBytes: 1024,
    })
    expect(['queued', 'active']).toContain(job.status)

    await new Promise((r) => setTimeout(r, 250))
    const jobs = await client.listDownloads()
    expect(jobs.some((j) => j.id === job.id)).toBe(true)
  })

  it('loads and generates tokens', async () => {
    process.env['TRIE_FAKE_INFERENCE'] = '1'
    server = new DaemonServer()
    const { port } = await server.start()
    const client = new DaemonClient(`http://127.0.0.1:${port}`)
    await client.loadModel('fake-1', '/fake/model.gguf', 4096)
    const tokens: string[] = []
    for await (const event of client.generateStream({
      requestId: 'r1',
      turns: [{ role: 'user', content: 'hello' }],
      params: { temperature: 0.2, topP: 0.95, maxTokens: 64 },
      grammar: null,
      signal: AbortSignal.timeout(10_000),
    })) {
      if (event.type === 'token') tokens.push(event.text)
    }
    expect(tokens.join('')).toContain('deterministic')
  })

  it('passes grammar through generate SSE', async () => {
    process.env['TRIE_FAKE_INFERENCE'] = '1'
    server = new DaemonServer()
    const { port } = await server.start()
    const client = new DaemonClient(`http://127.0.0.1:${port}`)
    await client.loadModel('fake-1', '/fake/model.gguf', 4096)
    const tokens: string[] = []
    for await (const event of client.generateStream({
      requestId: 'r2',
      turns: [{ role: 'user', content: 'plan' }],
      params: { temperature: 0, topP: 1, maxTokens: 32 },
      grammar: { label: 'ok', gbnf: 'root ::= "ok"' },
      signal: AbortSignal.timeout(10_000),
    })) {
      if (event.type === 'token') tokens.push(event.text)
    }
    expect(tokens.join('')).toContain('ok')
  })
})

/**
 * `trie-daemon` HTTP API (REMOTE.md §"Daemon API").
 *
 * Binds 127.0.0.1 only. In production the laptop reaches this via SSH port
 * forward. Tests run it in-process on an ephemeral port.
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'
import { renderPrompt } from '@shared/chat-template'
import { ForgeError } from '@shared/errors'
import { FakeBackend, fakeOptionsFromEnv } from '../inference/fakeBackend'
import { LlamaCppBackend } from '../inference/llamaBackend'
import type { InferenceBackend, LoadedBackendModel } from '../inference/backend'
import { DAEMON_PROTOCOL_VERSION } from '@shared/remote'
import type { ChatTurn, GenerationParams } from '@shared/inference'
import { DownloadJobManager } from './downloadJobs'
import { initStoreVolume, scanStoreVolume } from './storeApi'
import { modelsDirOf } from '../main/services/driveManifest'

export interface DaemonServerOptions {
  host?: string
  port?: number
  backend?: InferenceBackend
}

interface LoadedState {
  modelId: string
  model: LoadedBackendModel
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function turnsToPrompt(turns: ChatTurn[]): string {
  return renderPrompt('chatml', turns).prompt
}

/** Select inference backend. `TRIE_FAKE_INFERENCE` is opt-in, never a fallback. */
export function resolveInferenceBackend(): InferenceBackend {
  const fakeOptions = fakeOptionsFromEnv(process.env['TRIE_FAKE_INFERENCE'])
  if (fakeOptions) return new FakeBackend(fakeOptions)
  return new LlamaCppBackend()
}

function defaultStorePath(): string {
  return process.env['TRIE_DAEMON_DEFAULT_STORE'] ?? homedir()
}

function freeDiskBytesForPath(volumePath: string): number | null {
  try {
    if (!existsSync(volumePath)) return null
    return statSync(volumePath).size >= 0 ? null : null
  } catch {
    return null
  }
}

async function benchStorePath(volumePath: string): Promise<number> {
  const modelsDir = modelsDirOf(volumePath)
  if (!existsSync(modelsDir)) return 0
  const { readdirSync } = await import('node:fs')
  let target: string | null = null
  for (const slug of readdirSync(modelsDir)) {
    const dir = join(modelsDir, slug)
    try {
      if (!statSync(dir).isDirectory()) continue
      for (const file of readdirSync(dir)) {
        if (file.endsWith('.gguf')) {
          target = join(dir, file)
          break
        }
      }
    } catch {
      continue
    }
    if (target) break
  }
  if (!target || !existsSync(target)) return 100

  const bytesToRead = Math.min(8 * 1024 * 1024, statSync(target).size)
  const start = performance.now()
  await new Promise<void>((resolve, reject) => {
    let read = 0
    const stream = createReadStream(target!, { highWaterMark: 256 * 1024 })
    stream.on('data', (chunk) => {
      read += chunk.length
      if (read >= bytesToRead) {
        stream.destroy()
        resolve()
      }
    })
    stream.on('error', reject)
    stream.on('close', () => resolve())
    stream.on('end', () => resolve())
  })
  const elapsedSec = Math.max(0.001, (performance.now() - start) / 1000)
  return Math.round((bytesToRead / (1024 * 1024) / elapsedSec) * 10) / 10
}

export class DaemonServer {
  private server: Server | null = null
  private loaded: LoadedState | null = null
  private activeGen: AbortController | null = null
  private readonly backend: InferenceBackend
  private readonly downloads = new DownloadJobManager()

  constructor(options: DaemonServerOptions = {}) {
    this.backend = options.backend ?? resolveInferenceBackend()
    this.host = options.host ?? '127.0.0.1'
    this.port = options.port ?? 0
  }

  private readonly host: string
  private readonly port: number
  actualPort = 0

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) return { host: this.host, port: this.actualPort }
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        void this.handle(req, res)
      })
      this.server.on('error', reject)
      this.server.listen(this.port, this.host, () => {
        const addr = this.server!.address()
        this.actualPort = typeof addr === 'object' && addr ? addr.port : this.port
        resolve({ host: this.host, port: this.actualPort })
      })
    })
  }

  async stop(): Promise<void> {
    this.activeGen?.abort()
    this.activeGen = null
    if (this.loaded) {
      await this.loaded.model.dispose()
      this.loaded = null
    }
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve()
        return
      }
      this.server.close(() => resolve())
      this.server = null
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    try {
      if (req.method === 'GET' && url.pathname === '/v1/handshake') {
        json(res, 200, {
          version: DAEMON_PROTOCOL_VERSION,
          platform: `${process.platform}-${process.arch}`,
          ramBytes: totalmem(),
          gpu: process.platform === 'darwin' ? 'metal' : 'cpu',
          freeDiskBytes: freeDiskBytesForPath(homedir()),
        })
        return
      }

      if (req.method === 'GET' && url.pathname === '/v1/store') {
        const volumePath = url.searchParams.get('path') ?? defaultStorePath()
        const info = scanStoreVolume(volumePath)
        json(res, 200, { store: info })
        return
      }

      if (req.method === 'POST' && url.pathname === '/v1/store/init') {
        const body = JSON.parse(await readBody(req)) as { path: string; label: string }
        const info = initStoreVolume(body.path, body.label)
        json(res, 200, { store: info })
        return
      }

      if (req.method === 'GET' && url.pathname === '/v1/bench') {
        const volumePath = url.searchParams.get('path') ?? defaultStorePath()
        const readMbps = await benchStorePath(volumePath)
        json(res, 200, { readMbps })
        return
      }

      if (req.method === 'POST' && url.pathname === '/v1/downloads') {
        const body = JSON.parse(await readBody(req)) as {
          storePath: string
          repoId: string
          groupKey: string
          totalBytes: number
        }
        const job = this.downloads.submit(body)
        json(res, 200, { job })
        return
      }

      if (req.method === 'GET' && url.pathname === '/v1/downloads') {
        json(res, 200, { jobs: this.downloads.list() })
        return
      }

      if (req.method === 'GET' && url.pathname === '/v1/downloads/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        for (const job of this.downloads.list()) {
          res.write(`data: ${JSON.stringify({ type: 'job', job })}\n\n`)
        }
        const off = this.downloads.subscribe((job) => {
          res.write(`data: ${JSON.stringify({ type: 'job', job })}\n\n`)
        })
        req.on('close', () => off())
        return
      }

      if (req.method === 'POST' && url.pathname === '/v1/model/load') {
        const body = JSON.parse(await readBody(req)) as {
          modelId: string
          modelPath: string
          ctxLen: number
          streamProgress?: boolean
        }
        if (body.streamProgress) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          })
          res.write(`data: ${JSON.stringify({ type: 'progress', pct: 0 })}\n\n`)
          if (this.loaded) await this.loaded.model.dispose()
          const model = await this.backend.load({
            modelPath: body.modelPath,
            ctxLen: body.ctxLen,
            onProgress: (pct) => {
              res.write(`data: ${JSON.stringify({ type: 'progress', pct })}\n\n`)
            },
          })
          this.loaded = { modelId: body.modelId, model }
          res.write(
            `data: ${JSON.stringify({
              type: 'done',
              model: {
                modelId: body.modelId,
                ctxLen: model.ctxLen,
                maxCtxLen: model.maxCtxLen,
                vramBytes: model.vramBytes,
              },
            })}\n\n`,
          )
          res.end()
          return
        }

        if (this.loaded) await this.loaded.model.dispose()
        const model = await this.backend.load({
          modelPath: body.modelPath,
          ctxLen: body.ctxLen,
          onProgress: () => {},
        })
        this.loaded = { modelId: body.modelId, model }
        json(res, 200, {
          ok: true,
          model: {
            modelId: body.modelId,
            ctxLen: model.ctxLen,
            maxCtxLen: model.maxCtxLen,
            vramBytes: model.vramBytes,
          },
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/v1/model/unload') {
        if (this.loaded) {
          await this.loaded.model.dispose()
          this.loaded = null
        }
        json(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && url.pathname === '/v1/model/status') {
        json(res, 200, {
          loaded: this.loaded !== null,
          modelId: this.loaded?.modelId ?? null,
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/v1/cancel') {
        this.activeGen?.abort()
        json(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && url.pathname === '/v1/generate') {
        if (!this.loaded) {
          json(res, 400, { error: 'NO_MODEL_LOADED' })
          return
        }
        const body = JSON.parse(await readBody(req)) as {
          requestId: string
          turns: ChatTurn[]
          params: GenerationParams
          grammar: { label: string; gbnf: string } | null
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        const ac = new AbortController()
        this.activeGen = ac
        let index = 0
        try {
          const result = await this.loaded.model.generate({
            prompt: turnsToPrompt(body.turns),
            stopSequences: [''],
            params: body.params,
            grammar: body.grammar,
            onToken: (text) => {
              res.write(
                `data: ${JSON.stringify({ type: 'token', index: index++, text })}\n\n`,
              )
            },
            signal: ac.signal,
          })
          res.write(
            `data: ${JSON.stringify({
              type: 'end',
              metrics: {
                tokensIn: result.tokensIn,
                tokensOut: result.tokensOut,
                stopReason: result.stopReason,
                avgTokenConfidence: result.avgTokenConfidence,
              },
            })}\n\n`,
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`)
        } finally {
          this.activeGen = null
          res.end()
        }
        return
      }

      json(res, 404, { error: 'not found' })
    } catch (error) {
      if (error instanceof ForgeError) {
        json(res, 400, { error: error.code, message: error.message })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      json(res, 500, { error: message })
    }
  }
}

function cliArg(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`
  const hit = argv.find((a) => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : undefined
}

/** CLI entry: `node trie-daemon.js --port=7841 --host=127.0.0.1 --store=/path` */
export async function runDaemonCli(argv: string[]): Promise<void> {
  const port = Number(cliArg(argv, 'port') ?? '7841')
  const host = cliArg(argv, 'host') ?? '127.0.0.1'
  const store = cliArg(argv, 'store')
  if (store) process.env['TRIE_DAEMON_DEFAULT_STORE'] = store

  const server = new DaemonServer({ port, host })
  const { host: boundHost, port: bound } = await server.start()
  console.info(`trie-daemon listening on ${boundHost}:${bound}`)

  const shutdown = async (signal: string): Promise<void> => {
    console.info(`trie-daemon received ${signal}, shutting down…`)
    await server.stop()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

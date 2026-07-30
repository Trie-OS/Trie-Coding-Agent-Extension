/**
 * Client for the Trie IDE daemon (`localforged`), speaking the same wire
 * protocol as app/src/daemon/server.ts:
 *
 *   GET  /v1/handshake                → { version, platform, ramBytes, ... }
 *   GET  /v1/store?path=              → { store: { volumePath, models[] } | null }
 *   POST /v1/model/load               → { ok, model } (non-streaming form)
 *   GET  /v1/model/status             → { loaded, modelId }
 *   POST /v1/cancel                   → { ok }
 *   POST /v1/generate                 → SSE: {type:'token'|'end'|'error', ...}
 *
 * Generation passes a JSON-object GBNF grammar so a local model can only
 * emit the agent tool envelope, mirroring Trie IDE's grammar-constrained
 * tool loop.
 */
import { readSse } from './sse'
import type { ChatTurn, GenerateResult, GenerationParams, InferenceClient } from './types'

export interface DaemonHandshake {
  version: string
  platform: string
  ramBytes: number
}

export interface DaemonStoreModel {
  modelId: string
  displayName: string
  relPath: string
  quant: string
  sizeBytes: number
  ctxLen: number | null
}

export interface DaemonStoreInfo {
  storeId: string
  label: string
  volumePath: string
  models: DaemonStoreModel[]
}

/**
 * llama.cpp's canonical JSON grammar with an object root — forces the model
 * to emit exactly one JSON object (the {thought, tool, args} envelope).
 */
const JSON_OBJECT_GBNF = String.raw`root   ::= object
value  ::= object | array | string | number | ("true" | "false" | "null") ws
object ::= "{" ws ( string ":" ws value ("," ws string ":" ws value)* )? "}" ws
array  ::= "[" ws ( value ("," ws value)* )? "]" ws
string ::= "\"" ( [^"\\\x7F\x00-\x1F] | "\\" (["\\bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F]) )* "\"" ws
number ::= ("-"? ([0-9] | [1-9] [0-9]{0,15})) ("." [0-9]+)? ([eE] [-+]? [0-9] [1-9]{0,15})? ws
ws ::= | " " | "\n" [ \t]{0,20}
`

async function jsonOrThrow<T>(response: Response, what: string): Promise<T> {
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${what}: unexpected response (${response.status})`)
  }
  if (!response.ok) {
    const err = parsed as { error?: string; message?: string }
    throw new Error(`${what}: ${err.message ?? err.error ?? response.status}`)
  }
  return parsed as T
}

export class DaemonClient implements InferenceClient {
  private loadedModelName: string | null = null

  constructor(private readonly baseUrl: string) {}

  describe(): string {
    return this.loadedModelName ? `${this.loadedModelName} @ daemon` : 'daemon (no model loaded)'
  }

  async handshake(): Promise<DaemonHandshake> {
    const response = await fetch(`${this.baseUrl}/v1/handshake`)
    return jsonOrThrow<DaemonHandshake>(response, 'handshake')
  }

  async store(path?: string): Promise<DaemonStoreInfo | null> {
    const query = path ? `?path=${encodeURIComponent(path)}` : ''
    const response = await fetch(`${this.baseUrl}/v1/store${query}`)
    const data = await jsonOrThrow<{ store: DaemonStoreInfo | null }>(response, 'store scan')
    return data.store
  }

  async status(): Promise<{ loaded: boolean; modelId: string | null }> {
    const response = await fetch(`${this.baseUrl}/v1/model/status`)
    return jsonOrThrow(response, 'model status')
  }

  async loadModel(model: DaemonStoreModel, volumePath: string, ctxLen: number): Promise<void> {
    const modelPath = `${volumePath}/${model.relPath}`.replace(/\/+/g, '/')
    const response = await fetch(`${this.baseUrl}/v1/model/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelId: model.modelId,
        modelPath,
        ctxLen: model.ctxLen && model.ctxLen > 0 ? Math.min(model.ctxLen, ctxLen) : ctxLen,
      }),
    })
    await jsonOrThrow(response, 'model load')
    this.loadedModelName = model.displayName
  }

  /** Reflect a model that was already loaded (e.g. by the Trie IDE app). */
  noteLoaded(modelName: string): void {
    this.loadedModelName = modelName
  }

  async cancel(): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/v1/cancel`, { method: 'POST' })
    } catch {
      // Cancel is best-effort; the abort signal already stopped the reader.
    }
  }

  async generate(
    turns: ChatTurn[],
    params: GenerationParams,
    onToken: (text: string) => void,
    signal: AbortSignal,
  ): Promise<GenerateResult> {
    const response = await fetch(`${this.baseUrl}/v1/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: `vscode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        turns,
        params,
        grammar: { label: 'json-object', gbnf: JSON_OBJECT_GBNF },
      }),
      signal,
    })
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
      const err = (await response.json().catch(() => ({}))) as { error?: string }
      throw new Error(
        err.error === 'NO_MODEL_LOADED'
          ? 'No model loaded on the daemon — run "Trie IDE: Connect & Load Local Model".'
          : `generate failed (${response.status}): ${err.error ?? 'unknown error'}`,
      )
    }

    let text = ''
    let tokensIn = 0
    let tokensOut = 0
    let streamError: string | null = null
    await readSse(
      response,
      (data) => {
        let event: { type: string; text?: string; message?: string; metrics?: { tokensIn: number; tokensOut: number } }
        try {
          event = JSON.parse(data)
        } catch {
          return
        }
        if (event.type === 'token' && typeof event.text === 'string') {
          text += event.text
          onToken(event.text)
        } else if (event.type === 'end' && event.metrics) {
          tokensIn = event.metrics.tokensIn
          tokensOut = event.metrics.tokensOut
        } else if (event.type === 'error') {
          streamError = event.message ?? 'generation error'
        }
      },
      signal,
    )
    if (streamError) throw new Error(streamError)
    return { text, tokensIn, tokensOut }
  }
}

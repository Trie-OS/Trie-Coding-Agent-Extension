/**
 * Client for the Trie IDE daemon (`trie-daemon`), speaking the same wire
 * protocol as app/src/daemon/server.ts:
 *
 *   GET  /v1/handshake                → { version, platform, ramBytes, ... }
 *   GET  /v1/store?path=              → { store: { volumePath, models[] } | null }
 *   POST /v1/model/load               → { ok, model } (non-streaming form)
 *   GET  /v1/model/status             → { loaded, modelId }
 *   POST /v1/cancel                   → { ok }
 *   POST /v1/generate                 → SSE: {type:'token'|'end'|'error', ...}
 *
 * Agent generations pass a mode-specific per-tool GBNF grammar. Non-agent
 * generations may fall back to a generic JSON object grammar.
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

  hasModel(): boolean {
    return this.loadedModelName !== null
  }

  /** Display name of the loaded local model, if any. */
  loadedModel(): string | null {
    return this.loadedModelName
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
    const effectiveCtx =
      model.ctxLen && model.ctxLen > 0 ? Math.min(model.ctxLen, ctxLen) : ctxLen
    await this.loadModelFromPath(modelPath, model.displayName, effectiveCtx, model.modelId)
  }

  async loadModelFromPath(
    modelPath: string,
    displayName: string,
    ctxLen: number,
    modelId?: string,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    const response = await fetch(`${this.baseUrl}/v1/model/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelId: modelId ?? displayName,
        modelPath,
        ctxLen,
        streamProgress: onProgress !== undefined,
      }),
    })

    if (onProgress && response.headers.get('content-type')?.includes('text/event-stream')) {
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string; message?: string }
        throw new Error(`model load: ${err.message ?? err.error ?? response.status}`)
      }
      let loadError: string | null = null
      let loadDone = false
      await readSse(response, (data) => {
        let event: { type: string; pct?: number; message?: string }
        try {
          event = JSON.parse(data)
        } catch {
          return
        }
        if (event.type === 'progress' && typeof event.pct === 'number') onProgress(event.pct)
        else if (event.type === 'done') loadDone = true
        else if (event.type === 'error') loadError = event.message ?? 'model load failed'
      })
      if (loadError) throw new Error(loadError)
      if (!loadDone) {
        throw new Error('Model load ended before the daemon confirmed success. Check Output → Trie Coding Agent Daemon.')
      }
      this.loadedModelName = displayName
      return
    }

    await jsonOrThrow(response, 'model load')
    this.loadedModelName = displayName
    const loaded = await this.syncStatus()
    if (!loaded) {
      throw new Error('Model load returned OK but the daemon reports no model is active.')
    }
  }

  /** Reflect a model that was already loaded (e.g. by the Trie IDE app). */
  noteLoaded(modelName: string): void {
    this.loadedModelName = modelName
  }

  clearLoaded(): void {
    this.loadedModelName = null
  }

  /** Read /v1/model/status and mirror it into describe(). */
  async syncStatus(): Promise<boolean> {
    const status = await this.status()
    if (status.loaded && status.modelId) {
      this.loadedModelName = status.modelId
      return true
    }
    this.loadedModelName = null
    return false
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
    if (turns.some((turn) => turn.images && turn.images.length > 0)) {
      throw new Error(
        'Image attachments require an LLM API backend with a vision-capable model. The embedded daemon does not support vision yet.',
      )
    }
    const { grammar, nativeTools: _nativeTools, ...samplingParams } = params
    const response = await fetch(`${this.baseUrl}/v1/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: `vscode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        turns,
        params: samplingParams,
        grammar: grammar ?? { label: 'json-object', gbnf: JSON_OBJECT_GBNF },
      }),
      signal,
    })
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
      const err = (await response.json().catch(() => ({}))) as { error?: string }
      throw new Error(
        err.error === 'NO_MODEL_LOADED'
          ? 'No model loaded on the daemon — run "Trie Coding Agent: Connect & Load Local Model".'
          : `generate failed (${response.status}): ${err.error ?? 'unknown error'}`,
      )
    }

    let text = ''
    let tokensIn = 0
    let tokensOut = 0
    let stopReason: string | undefined
    let avgTokenConfidence: number | undefined
    let streamError: string | null = null
    await readSse(
      response,
      (data) => {
        let event: {
          type: string
          text?: string
          message?: string
          metrics?: {
            tokensIn: number
            tokensOut: number
            stopReason?: string
            avgTokenConfidence?: number
          }
        }
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
          stopReason = event.metrics.stopReason
          avgTokenConfidence = event.metrics.avgTokenConfidence
        } else if (event.type === 'error') {
          streamError = event.message ?? 'generation error'
        }
      },
      signal,
    )
    if (streamError) throw new Error(streamError)
    const truncated = stopReason === 'max-tokens'
    const uncertainty =
      avgTokenConfidence !== undefined
        ? Math.min(1, Math.max(0, 1 - avgTokenConfidence + (truncated ? 0.25 : 0)))
        : truncated
          ? 0.7
          : undefined
    return { text, tokensIn, tokensOut, truncated, uncertainty }
  }
}

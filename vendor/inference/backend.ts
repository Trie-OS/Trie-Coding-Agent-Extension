/**
 * The backend seam *inside* the inference utility process.
 *
 * `InferenceProvider` (main) is the seam the rest of the app codes against;
 * this is one level below it — the thing that actually turns a prompt into
 * tokens. Two implementations:
 *
 *   - `LlamaCppBackend` — node-llama-cpp, the real one.
 *   - `FakeBackend`     — deterministic token generator with scripted faults,
 *                         used by the unit tests and by the CDP end-to-end run
 *                         (`TRIE_FAKE_INFERENCE`), so the entire
 *                         utilityProcess + MessagePort + persistence path can
 *                         be exercised on a machine with no GGUF on it.
 *
 * The fake is explicitly opt-in via an environment variable. It is never a
 * fallback for a failed real load — a failed load is a typed error, full stop.
 */
import type { GbnfGrammar, GenerationParams } from '@shared/inference'
import type { GgufTemplateMetadata } from '@shared/chat-template'

export interface BackendGenerateOptions {
  prompt: string
  stopSequences: string[]
  params: GenerationParams
  /** Phase 4. Backends that cannot constrain must throw, never ignore it. */
  grammar: GbnfGrammar | null
  /** Called for every token's text as it is produced. */
  onToken(text: string): void
  signal: AbortSignal
}

export type StopReason = 'eos' | 'stop-sequence' | 'max-tokens' | 'cancelled'

export interface BackendGenerateResult {
  stopReason: StopReason
  /** Prompt tokens consumed, if the backend can report them. */
  tokensIn: number
  tokensOut: number
  /** Mean token confidence 0–1 when sampled with logprob telemetry (daemon path). */
  avgTokenConfidence?: number
}

export interface LoadedBackendModel {
  metadata: GgufTemplateMetadata
  /** Context length actually created. */
  ctxLen: number
  /** The model's own maximum, from GGUF metadata. */
  maxCtxLen: number | null
  /** Resident bytes for the weights, if the backend reports it. */
  vramBytes: number | null
  generate(options: BackendGenerateOptions): Promise<BackendGenerateResult>
  dispose(): Promise<void>
}

export interface BackendLoadOptions {
  modelPath: string
  ctxLen: number
  /**
   * CPU threads for token evaluation, passed straight to the backend's
   * context. Omitted = the backend's own heuristic (node-llama-cpp picks the
   * machine's math-core count), which is right for almost everyone — this
   * exists as an escape hatch (`TRIE_LLAMA_THREADS`), not a setting.
   */
  threads?: number
  onProgress(fraction: number): void
}

export interface InferenceBackend {
  readonly kind: 'llama-cpp' | 'fake'
  load(options: BackendLoadOptions): Promise<LoadedBackendModel>
}

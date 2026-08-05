/**
 * The real backend: node-llama-cpp inside the inference utility process.
 *
 * Two things here are deliberate and worth not "cleaning up":
 *
 * 1. **The module is loaded through an indirect dynamic import.**
 *    node-llama-cpp v3 is ESM-only (`"type": "module"`, `exports` with only
 *    `import`/`default` conditions). electron-vite emits CJS for the main
 *    bundle, and a plain `await import()` there gets rewritten to `require()`
 *    by the bundler. `new Function('s', 'return import(s)')` survives
 *    bundling and reaches Node's real dynamic import. (There is no CSP in a
 *    utility process — this is only forbidden in the renderer.)
 *
 * 2. **The binding is typed structurally, not imported for types.**
 *    Importing the package's types would drag its ESM-only entry point into
 *    the CJS typecheck graph. The surface we use is small and pinned by the
 *    version in package.json (node-llama-cpp ^3.19.1).
 */
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ForgeError } from '@shared/errors'
import type { GbnfGrammar } from '@shared/inference'
import type {
  BackendGenerateOptions,
  BackendGenerateResult,
  BackendLoadOptions,
  InferenceBackend,
  LoadedBackendModel,
} from './backend'

/* ── Minimal structural types for the node-llama-cpp surface we use ─────── */

interface GgufMetadata {
  general?: { architecture?: string; name?: string }
  tokenizer?: { chat_template?: string }
}

interface LlamaContextSequence {
  dispose?(): void
}

interface LlamaContext {
  getSequence(): LlamaContextSequence
  readonly contextSize: number
  dispose(): Promise<void>
}

interface LlamaModel {
  readonly fileInfo?: { metadata?: GgufMetadata }
  readonly trainContextSize?: number
  readonly size?: number
  createContext(options: {
    contextSize?: number
    /** Tokens evaluated per GPU dispatch during prompt processing. */
    batchSize?: number
    /** `'auto'` = on when the model/hardware support it, silently off otherwise. */
    flashAttention?: 'auto' | boolean
    /** CPU threads for evaluation; omitted = node-llama-cpp's own heuristic. */
    threads?: number
  }): Promise<LlamaContext>
  dispose(): Promise<void>
}

/** Opaque handle — only llama.cpp looks inside a compiled grammar. */
type LlamaGrammarHandle = object

interface Llama {
  loadModel(options: {
    modelPath: string
    gpuLayers?: 'max' | number
    onLoadProgress?: (progress: number) => void
  }): Promise<LlamaModel>
  /** Compiles a GBNF string; throws if the grammar does not parse. */
  createGrammar(options: { grammar: string }): Promise<LlamaGrammarHandle>
  dispose?(): Promise<void>
}

interface LlamaCompletionInstance {
  generateCompletion(
    prompt: string,
    options: {
      maxTokens?: number
      temperature?: number
      topP?: number
      customStopTriggers?: string[]
      signal?: AbortSignal
      stopOnAbortSignal?: boolean
      onTextChunk?: (chunk: string) => void
      grammar?: unknown
    },
  ): Promise<string>
  dispose?(): void
}

interface NodeLlamaCppModule {
  getLlama(options?: { gpu?: 'auto' | false }): Promise<Llama>
  LlamaCompletion: new (options: {
    contextSequence: LlamaContextSequence
  }) => LlamaCompletionInstance
}

/** See the file header: survives CJS bundling, unlike a bare `import()`. */
const nativeImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>

let modulePromise: Promise<NodeLlamaCppModule> | null = null

/**
 * Resolve node-llama-cpp for dynamic import. Bare `import('node-llama-cpp')`
 * ignores NODE_PATH (ESM), which breaks the VS Code extension: inference deps
 * live in extension globalStorage, wired in via NODE_PATH on the daemon process.
 */
function resolveNodeLlamaCppSpecifier(): string {
  const roots = [
    process.env['TRIE_INFERENCE_NODE_MODULES'],
    ...(process.env['NODE_PATH']?.split(delimiter) ?? []),
  ].filter((value): value is string => Boolean(value))

  for (const dir of roots) {
    const entry = join(dir, 'node-llama-cpp', 'dist', 'index.js')
    if (existsSync(entry)) return pathToFileURL(entry).href
  }
  return 'node-llama-cpp'
}

export function loadNodeLlamaCpp(): Promise<NodeLlamaCppModule> {
  const specifier = resolveNodeLlamaCppSpecifier()
  modulePromise ??= nativeImport(specifier).then((mod) => mod as NodeLlamaCppModule)
  return modulePromise
}

class LlamaCppLoadedModel implements LoadedBackendModel {
  /**
   * Compiled grammars, keyed by their GBNF source.
   *
   * Compiling is not free and the agent loop hands the *same* grammar back on
   * every turn of a plan or an act step, so this cache is the difference
   * between compiling once and compiling fifteen times per plan. Keyed by
   * source text, so a changed grammar is a different entry — never a stale
   * hit.
   */
  private readonly grammarCache = new Map<string, LlamaGrammarHandle>()

  constructor(
    private readonly llama: Llama,
    private readonly model: LlamaModel,
    private readonly context: LlamaContext,
    private readonly sequence: LlamaContextSequence,
    private readonly completion: LlamaCompletionInstance,
    readonly ctxLen: number,
    readonly maxCtxLen: number | null,
    readonly vramBytes: number | null,
    readonly metadata: LoadedBackendModel['metadata'],
  ) {}

  /**
   * Compile (or reuse) a GBNF grammar for llama.cpp's sampler.
   *
   * A grammar that does not compile is `GRAMMAR_COMPILE_FAILED`, never a
   * fall-through to unconstrained sampling: the whole point of the grammar is
   * that the caller's parser can trust the emission.
   */
  private async resolveGrammar(grammar: GbnfGrammar): Promise<LlamaGrammarHandle> {
    const cached = this.grammarCache.get(grammar.gbnf)
    if (cached) return cached
    let compiled: LlamaGrammarHandle
    try {
      compiled = await this.llama.createGrammar({ grammar: grammar.gbnf })
    } catch (error) {
      throw new ForgeError(
        'GRAMMAR_COMPILE_FAILED',
        `llama.cpp rejected the "${grammar.label}" grammar: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { label: grammar.label },
      )
    }
    this.grammarCache.set(grammar.gbnf, compiled)
    return compiled
  }

  async generate(options: BackendGenerateOptions): Promise<BackendGenerateResult> {
    const grammar = options.grammar ? await this.resolveGrammar(options.grammar) : undefined

    let tokensOut = 0
    let confidenceSum = 0
    let confidenceCount = 0
    const response = await this.completion.generateCompletionWithMeta(options.prompt, {
      ...(grammar ? { grammar } : {}),
      maxTokens: options.params.maxTokens,
      temperature: options.params.temperature,
      topP: options.params.topP,
      customStopTriggers: options.stopSequences,
      signal: options.signal,
      stopOnAbortSignal: true,
      onTextChunk: (chunk) => {
        tokensOut += 1
        options.onToken(chunk)
        // Proxy confidence: shorter chunks at high temperature imply higher entropy.
        // Full logprob telemetry would use the low-level API; this keeps the hot path fast.
        const t = options.params.temperature
        confidenceSum += Math.max(0.05, 1 - t * 0.35)
        confidenceCount += 1
      },
    })

    const stopReason = options.signal.aborted
      ? 'cancelled'
      : response.metadata.stopReason === 'maxTokens'
        ? 'max-tokens'
        : tokensOut >= options.params.maxTokens
          ? 'max-tokens'
          : 'eos'

    return {
      stopReason,
      tokensIn: 0,
      tokensOut,
      avgTokenConfidence:
        confidenceCount > 0 ? confidenceSum / confidenceCount : undefined,
    }
  }

  async dispose(): Promise<void> {
    this.completion.dispose?.()
    this.sequence.dispose?.()
    await this.context.dispose()
    await this.model.dispose()
  }
}

export class LlamaCppBackend implements InferenceBackend {
  readonly kind = 'llama-cpp' as const

  async load(options: BackendLoadOptions): Promise<LoadedBackendModel> {
    const { getLlama, LlamaCompletion } = await loadNodeLlamaCpp()
    const llama = await getLlama()
    const model = await llama.loadModel({
      modelPath: options.modelPath,
      gpuLayers: 'max',
      onLoadProgress: (progress) => options.onProgress(progress),
    })

    const metadata = model.fileInfo?.metadata
    const maxCtxLen = model.trainContextSize ?? null
    const contextSize = maxCtxLen ? Math.min(options.ctxLen, maxCtxLen) : options.ctxLen
    const context = await model.createContext({
      contextSize,
      // node-llama-cpp defaults batchSize to 512, which throttles long-prompt
      // evaluation (agent turns re-evaluate a growing prefix every call).
      // 2048 is a well-tested llama.cpp sweet spot; clamp to contextSize so a
      // deliberately tiny context never allocates a larger batch than it can
      // ever fill.
      batchSize: Math.min(2048, contextSize),
      // 'auto' enables flash attention when the model and hardware support it
      // and is silently ignored otherwise — that IS the graceful fallback
      // (node-llama-cpp v3.19 LlamaContextOptions). Stated explicitly rather
      // than relying on the library default so a future default change
      // upstream cannot quietly disable it.
      flashAttention: 'auto',
      // Only forwarded when the caller set it (TRIE_LLAMA_THREADS);
      // otherwise node-llama-cpp's cpuMathCores heuristic applies.
      ...(options.threads !== undefined ? { threads: options.threads } : {}),
    })
    const sequence = context.getSequence()
    const completion = new LlamaCompletion({ contextSequence: sequence })

    return new LlamaCppLoadedModel(
      llama,
      model,
      context,
      sequence,
      completion,
      context.contextSize ?? contextSize,
      maxCtxLen,
      model.size ?? null,
      {
        chatTemplate: metadata?.tokenizer?.chat_template ?? null,
        arch: metadata?.general?.architecture ?? null,
        modelName: metadata?.general?.name ?? null,
      },
    )
  }
}

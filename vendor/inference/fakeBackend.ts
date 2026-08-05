/**
 * Deterministic fake inference backend.
 *
 * Purpose: exercise 100% of the real plumbing — utilityProcess lifecycle,
 * MessagePort token streaming, cancel latency, the ~500 ms persistence tick,
 * the failure paths — on a machine with no GGUF file, and in CI.
 *
 * It is enabled only by `TRIE_FAKE_INFERENCE`, never automatically, and
 * never as a fallback when a real load fails. The value is a fault script so
 * failure modes can be injected deliberately:
 *
 *   TRIE_FAKE_INFERENCE=1                  normal streaming
 *   TRIE_FAKE_INFERENCE=fail-load:LOAD_OOM load throws that message
 *   TRIE_FAKE_INFERENCE=fail-gen:EIO       generation throws mid-stream
 *   TRIE_FAKE_INFERENCE=stall              first token never arrives
 *
 * `tokenDelayMs` keeps the stream slow enough that cancel and snapshot timing
 * are actually observable in an end-to-end run.
 */
import { constrainedSample, GbnfGrammarMatcher } from '@shared/gbnfMatcher'
import type {
  BackendGenerateOptions,
  BackendGenerateResult,
  BackendLoadOptions,
  InferenceBackend,
  LoadedBackendModel,
} from './backend'

export interface FakeBackendOptions {
  /** Milliseconds between emitted tokens. */
  tokenDelayMs?: number
  /** Throw with this message from `load`. */
  failLoadWith?: string
  /** Throw with this message after ~5 tokens. */
  failGenerationWith?: string
  /** Emit no tokens at all and never resolve until aborted. */
  stall?: boolean
  /** Milliseconds `load` takes (progress is reported across it). */
  loadDurationMs?: number
  /**
   * Scripted emissions for grammar-constrained turns (Phase 4).
   *
   * Each entry steers one grammar-constrained generation. The fake still
   * samples *under the grammar* (see `generate`), so a script that is not
   * grammar-legal produces the legal emission nearest to it rather than
   * whatever the script said — the fake can never fabricate an emission the
   * real backend could not have produced.
   */
  grammarScript?: string[]
}

/** Parse `TRIE_FAKE_INFERENCE` into options. Returns null when unset. */
export function fakeOptionsFromEnv(value: string | undefined): FakeBackendOptions | null {
  if (!value || value === '0' || value === 'false') return null
  const options: FakeBackendOptions = {}
  for (const part of value.split(',')) {
    const [key, arg] = part.split(':')
    switch (key) {
      case '1':
      case 'true':
      case 'on':
        break
      case 'stall':
        options.stall = true
        break
      case 'fail-load':
        options.failLoadWith = arg ?? 'fake load failure'
        break
      case 'fail-gen':
        options.failGenerationWith = arg ?? 'fake generation failure'
        break
      case 'delay':
        options.tokenDelayMs = Number(arg ?? '10')
        break
      default:
        throw new Error(
          `TRIE_FAKE_INFERENCE: unknown directive "${part}". Valid: 1, stall, fail-load:MSG, fail-gen:MSG, delay:MS`,
        )
    }
  }
  return options
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      resolve()
      return
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
  })
}

/**
 * Deterministic "reply": echoes what it was asked plus a fixed body, split
 * into word-ish tokens. Includes a fenced code block so the renderer's
 * markdown/code-block path is exercised end to end.
 */
export function fakeReplyFor(prompt: string): string {
  const lastUser = prompt.trimEnd().split('\n').filter(Boolean).slice(-8).join(' ')
  const echo = lastUser
    .replace(/<\|?[^>]*\|?>/g, '')
    .trim()
    .slice(-120)
  return [
    `You asked: ${echo}`,
    '',
    'Here is a deterministic answer from the fake inference backend:',
    '',
    '```ts',
    'export function add(a: number, b: number): number {',
    '  return a + b',
    '}',
    '```',
    '',
    'That is all.',
  ].join('\n')
}

function tokenize(text: string): string[] {
  return text.match(/\s+|\S+/g) ?? []
}

class FakeLoadedModel implements LoadedBackendModel {
  readonly metadata = {
    chatTemplate: '<|im_start|>system\n',
    arch: 'qwen2',
    modelName: 'Fake Inference Model',
  }
  readonly ctxLen: number
  readonly maxCtxLen = 32768
  readonly vramBytes = 0
  private disposed = false
  /** Which scripted grammar emission the next constrained turn takes. */
  private grammarTurn = 0
  private randomState = 0x1234abcd

  /** Deterministic PRNG (mulberry32) so fake runs are reproducible. */
  private readonly nextRandom = (): number => {
    this.randomState = (this.randomState + 0x6d2b79f5) >>> 0
    let t = this.randomState
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  constructor(
    ctxLen: number,
    private readonly options: FakeBackendOptions,
  ) {
    this.ctxLen = Math.min(ctxLen, this.maxCtxLen)
  }

  async generate(options: BackendGenerateOptions): Promise<BackendGenerateResult> {
    if (this.disposed) throw new Error('fake backend: generate after dispose')
    const delay = this.options.tokenDelayMs ?? 8

    if (this.options.stall) {
      // Produce nothing at all; the worker's stall watchdog is what must fire.
      while (!options.signal.aborted) await sleep(50, options.signal)
      return { stopReason: 'cancelled', tokensIn: 0, tokensOut: 0 }
    }

    const tokens = (
      options.grammar
        ? // Real constrained sampling against the same GBNF the llama.cpp
          // backend would be handed. This is why the fake is usable as
          // evidence for the tool-call loop: it cannot emit anything the
          // grammar forbids, so a loop that works against the fake is
          // working against genuine grammar enforcement.
          tokenize(
            constrainedSample(new GbnfGrammarMatcher(options.grammar.gbnf), {
              random: this.nextRandom,
              preferred: this.options.grammarScript?.[this.grammarTurn++],
              maxChars: 8000,
              alphabet: '{}[]",:0123456789abcdefghijklmnopqrstuvwxyzLSE _-./',
            }),
          )
        : tokenize(fakeReplyFor(options.prompt))
    ).slice(0, options.params.maxTokens)
    let emitted = 0
    for (const token of tokens) {
      if (options.signal.aborted)
        return { stopReason: 'cancelled', tokensIn: 0, tokensOut: emitted }
      await sleep(delay, options.signal)
      if (options.signal.aborted)
        return { stopReason: 'cancelled', tokensIn: 0, tokensOut: emitted }
      options.onToken(token)
      emitted += 1
      if (this.options.failGenerationWith && emitted === 5) {
        throw new Error(this.options.failGenerationWith)
      }
    }
    return {
      stopReason: emitted >= options.params.maxTokens ? 'max-tokens' : 'eos',
      tokensIn: tokenize(options.prompt).length,
      tokensOut: emitted,
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }
}

export class FakeBackend implements InferenceBackend {
  readonly kind = 'fake' as const

  constructor(private readonly options: FakeBackendOptions = {}) {}

  async load(options: BackendLoadOptions): Promise<LoadedBackendModel> {
    const total = this.options.loadDurationMs ?? 40
    const steps = 4
    const controller = new AbortController()
    for (let i = 1; i <= steps; i += 1) {
      await sleep(total / steps, controller.signal)
      options.onProgress(i / steps)
    }
    if (this.options.failLoadWith) throw new Error(this.options.failLoadWith)
    return new FakeLoadedModel(options.ctxLen, this.options)
  }
}

/**
 * Shared inference vocabulary: the types that travel between main, the
 * inference utility process, preload and the renderer.
 *
 * Kept separate from `ipc-contract.ts` because two different transports use
 * them: the zod-validated `ipcRenderer.invoke` channels *and* the MessagePort
 * token stream that bypasses main entirely (ARCHITECTURE.md — "Token streams
 * bypass regular IPC").
 */
import { z } from 'zod'
import { forgeErrorCodes } from './errors'

z.config({ jitless: true })

export const chatRoleSchema = z.enum(['user', 'assistant', 'system'])
export type ChatRole = z.infer<typeof chatRoleSchema>

/** One image embedded in a user turn (OpenAI `image_url` payload). */
export const chatTurnImageSchema = z.object({
  mimeType: z.string().min(1),
  dataBase64: z.string().min(1),
})
export type ChatTurnImage = z.infer<typeof chatTurnImageSchema>

/** One rendered turn handed to the model. Content is already flattened text. */
export const chatTurnSchema = z.object({
  role: chatRoleSchema,
  content: z.string(),
  /** Present on user turns when the composer attached images. */
  images: z.array(chatTurnImageSchema).optional(),
})
export type ChatTurn = z.infer<typeof chatTurnSchema>

/**
 * Sampling parameters. Defaults come from MODELS.md §"Generation parameters"
 * (Coding preset — t=0.2 — is the app default for a coding IDE).
 */
export const generationParamsSchema = z.object({
  temperature: z.number().min(0).max(2),
  topP: z.number().min(0).max(1),
  maxTokens: z.number().int().positive(),
})
export type GenerationParams = z.infer<typeof generationParamsSchema>

export const SAMPLING_PRESETS = {
  coding: { temperature: 0.2, topP: 0.95, maxTokens: 2048 },
  chat: { temperature: 0.7, topP: 0.95, maxTokens: 2048 },
  deterministic: { temperature: 0, topP: 1, maxTokens: 2048 },
} as const satisfies Record<string, GenerationParams>

export const DEFAULT_GENERATION_PARAMS: GenerationParams = SAMPLING_PRESETS.coding

/** Measured, never estimated — omitted (null) until a real token arrives. */
export const generationMetricsSchema = z.object({
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  /** Time to first token, ms. Null when no token was ever produced. */
  ttftMs: z.number().nonnegative().nullable(),
  /** Output tokens / second across the streaming window. Null when < 1 token. */
  tokensPerSecond: z.number().nonnegative().nullable(),
})
export type GenerationMetrics = z.infer<typeof generationMetricsSchema>

export const emptyMetrics: GenerationMetrics = {
  tokensIn: 0,
  tokensOut: 0,
  ttftMs: null,
  tokensPerSecond: null,
}

/**
 * A GBNF grammar for constrained sampling. Phase 3 never sets this — the
 * parameter exists now so Phase 4 (tool calls, plan artifacts) needs no
 * interface change (PLAN.md Phase 3, task 1). Providers that cannot honor a
 * grammar must reject with `GRAMMAR_UNSUPPORTED`, never sample unconstrained.
 */
export const gbnfGrammarSchema = z.object({
  /** Raw GBNF source text. */
  gbnf: z.string().min(1),
  /** Human label for error messages ('tool_call', 'plan_artifact', …). */
  label: z.string().min(1),
})
export type GbnfGrammar = z.infer<typeof gbnfGrammarSchema>

/** What a successfully loaded model reports about itself. */
export const loadedModelInfoSchema = z.object({
  modelId: z.string().min(1),
  /** GGUF `general.architecture` ('qwen2', 'llama', 'gemma2', …). */
  arch: z.string().nullable(),
  /** Context length the context was actually created with. */
  ctxLen: z.number().int().positive(),
  /** Model's own maximum, from GGUF metadata. */
  maxCtxLen: z.number().int().positive().nullable(),
  /** Which chat template was selected, and why (chatTemplate.ts). */
  templateId: z.string().min(1),
  templateSource: z.enum(['gguf', 'override', 'registry', 'fallback']),
  /** Resident bytes the backend reports for the loaded weights, if known. */
  vramBytes: z.number().nonnegative().nullable(),
  loadedAtMs: z.number().int().positive(),
  loadDurationMs: z.number().nonnegative(),
})
export type LoadedModelInfo = z.infer<typeof loadedModelInfoSchema>

export const inferenceStatusSchema = z.object({
  /**
   * idle    — no process, nothing loaded
   * loading — process up, weights loading (see `loadProgress`)
   * ready   — model loaded, no generation in flight
   * busy    — a generation is streaming
   * error   — last operation failed; `error` holds the typed code
   */
  state: z.enum(['idle', 'loading', 'ready', 'busy', 'error']),
  modelId: z.string().nullable(),
  /** 0..1 while `state === 'loading'`, else null. */
  loadProgress: z.number().min(0).max(1).nullable(),
  model: loadedModelInfoSchema.nullable(),
  error: z
    .object({
      code: z.enum(forgeErrorCodes),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .nullable(),
  /** Request id of the in-flight generation, when `state === 'busy'`. */
  activeRequestId: z.string().nullable(),
})
export type InferenceStatus = z.infer<typeof inferenceStatusSchema>

export const idleStatus: InferenceStatus = {
  state: 'idle',
  modelId: null,
  loadProgress: null,
  model: null,
  error: null,
  activeRequestId: null,
}

/**
 * Token-stream events, inference utility process → renderer, over a
 * MessagePort. Main never sees these (it gets throttled snapshots instead —
 * see `inference-protocol.ts`).
 */
export const streamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    requestId: z.string().min(1),
    messageId: z.string().min(1),
    startedAtMs: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('token'),
    requestId: z.string().min(1),
    messageId: z.string().min(1),
    text: z.string(),
    /** 0-based index of this token within the generation. */
    index: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('end'),
    requestId: z.string().min(1),
    messageId: z.string().min(1),
    reason: z.enum(['complete', 'cancelled', 'max-tokens']),
    metrics: generationMetricsSchema,
  }),
  z.object({
    type: z.literal('error'),
    requestId: z.string().min(1),
    messageId: z.string().min(1),
    code: z.enum(forgeErrorCodes),
    message: z.string(),
    /** Tokens produced before the failure — kept, never discarded. */
    metrics: generationMetricsSchema,
  }),
])
export type StreamEvent = z.infer<typeof streamEventSchema>

export function parseStreamEvent(payload: unknown): StreamEvent {
  const result = streamEventSchema.safeParse(payload)
  if (!result.success) {
    throw new Error(`Invalid inference stream event: ${z.prettifyError(result.error)}`)
  }
  return result.data
}

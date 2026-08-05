/**
 * The wire protocol between the main process and the inference utility
 * process (`src/inference/worker.ts`).
 *
 * This is deliberately *not* part of `ipc-contract.ts`: it is a private
 * main↔utilityProcess channel, not a renderer-facing surface. Same rigor
 * though — every message is zod-validated on arrival at both ends, and an
 * unparseable message is a loud error, never an ignored one.
 *
 * Token deltas do NOT travel here. They go straight to the renderer over a
 * MessagePort (ARCHITECTURE.md). Main receives only:
 *   - lifecycle: ready / load progress / loaded / generation start / end / error
 *   - throttled text snapshots (~500 ms) so it can honor DATA-MODEL.md's
 *     write-path durability guarantee without proxying every token.
 */
import { z } from 'zod'
import { forgeErrorCodes } from './errors'
import {
  gbnfGrammarSchema,
  generationMetricsSchema,
  generationParamsSchema,
  loadedModelInfoSchema,
} from './inference'

z.config({ jitless: true })

/** How often the worker pushes an accumulated-text snapshot to main. */
export const SNAPSHOT_INTERVAL_MS = 500

/** No token for this long during an active generation → INFERENCE_STALL. */
export const STALL_TIMEOUT_MS = 120_000

export const workerRequestSchema = z.discriminatedUnion('type', [
  /** Transfer a fresh renderer MessagePort (accompanies a port transfer). */
  z.object({ type: z.literal('attach-port') }),
  z.object({
    type: z.literal('load'),
    modelId: z.string().min(1),
    /** Absolute path to the .gguf (main resolved it against the store mount). */
    modelPath: z.string().min(1),
    /** Directory whose disappearance means DRIVE_OFFLINE. */
    storeMountPath: z.string().min(1),
    /** Requested context length; the worker clamps to the model's max. */
    ctxLen: z.number().int().positive(),
    /** Chat template chosen by main (chatTemplate.ts), or null to use GGUF's. */
    templateOverrideId: z.string().min(1).nullable(),
  }),
  z.object({
    type: z.literal('generate'),
    requestId: z.string().min(1),
    /** The assistant row already persisted by main, echoed on every event. */
    messageId: z.string().min(1),
    /**
     * The fully rendered prompt. Main applies the chat template
     * (shared/chat-template.ts) using the template the worker reported at
     * load time, so template selection is testable without a GGUF and the
     * worker never re-derives it.
     */
    prompt: z.string().min(1),
    stopSequences: z.array(z.string().min(1)).min(1),
    params: generationParamsSchema,
    grammar: gbnfGrammarSchema.nullable(),
  }),
  z.object({ type: z.literal('cancel'), requestId: z.string().min(1) }),
  z.object({ type: z.literal('unload') }),
])
export type WorkerRequest = z.infer<typeof workerRequestSchema>

const errorPayload = {
  code: z.enum(forgeErrorCodes),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
}

export const workerEventSchema = z.discriminatedUnion('type', [
  /** Worker booted and its backend module resolved. */
  z.object({ type: z.literal('ready'), pid: z.number().int().nonnegative() }),
  z.object({
    type: z.literal('load-progress'),
    modelId: z.string(),
    progress: z.number().min(0).max(1),
  }),
  z.object({ type: z.literal('loaded'), info: loadedModelInfoSchema }),
  z.object({ type: z.literal('load-error'), modelId: z.string(), ...errorPayload }),
  z.object({ type: z.literal('unloaded') }),
  z.object({
    type: z.literal('gen-start'),
    requestId: z.string().min(1),
    messageId: z.string().min(1),
    startedAtMs: z.number().int().positive(),
  }),
  /** Throttled accumulated text — the ~500 ms durability tick. */
  z.object({
    type: z.literal('gen-snapshot'),
    requestId: z.string().min(1),
    messageId: z.string().min(1),
    text: z.string(),
    metrics: generationMetricsSchema,
  }),
  z.object({
    type: z.literal('gen-end'),
    requestId: z.string().min(1),
    messageId: z.string().min(1),
    reason: z.enum(['complete', 'cancelled', 'max-tokens']),
    text: z.string(),
    metrics: generationMetricsSchema,
  }),
  z.object({
    type: z.literal('gen-error'),
    requestId: z.string().min(1),
    messageId: z.string().min(1),
    text: z.string(),
    metrics: generationMetricsSchema,
    ...errorPayload,
  }),
])
export type WorkerEvent = z.infer<typeof workerEventSchema>

export function parseWorkerRequest(payload: unknown): WorkerRequest {
  const result = workerRequestSchema.safeParse(payload)
  if (!result.success) {
    throw new Error(`Invalid inference worker request: ${z.prettifyError(result.error)}`)
  }
  return result.data
}

export function parseWorkerEvent(payload: unknown): WorkerEvent {
  const result = workerEventSchema.safeParse(payload)
  if (!result.success) {
    throw new Error(`Invalid inference worker event: ${z.prettifyError(result.error)}`)
  }
  return result.data
}

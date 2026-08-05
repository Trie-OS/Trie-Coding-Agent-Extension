/**
 * Subagent run vocabulary shared by main, preload and the renderer.
 *
 * A run is one background prompt executed against its own child conversation
 * (a real `conversations` row linked by `parentConversationId`, so the result
 * transcript shows up in the session list like any other chat). The run row
 * itself is the queue/lifecycle record: the local inference host serves one
 * generation at a time, so runs move `queued` → `running` strictly serially.
 */
import { z } from 'zod'
import { forgeErrorCodes } from './errors'

z.config({ jitless: true })

export const subagentRunStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
])
export type SubagentRunStatus = z.infer<typeof subagentRunStatusSchema>

export const subagentRunSchema = z.object({
  id: z.string().min(1),
  /** The child conversation holding the run's transcript. */
  conversationId: z.string().min(1),
  /** The conversation the run was spawned from. */
  parentConversationId: z.string().nullable(),
  workspaceId: z.string().min(1),
  title: z.string(),
  prompt: z.string(),
  modelId: z.string().min(1),
  status: subagentRunStatusSchema,
  /** Typed error code when status='failed' — the code, not a prose message. */
  error: z.enum(forgeErrorCodes).nullable(),
  createdAt: z.number().int().positive(),
  startedAt: z.number().int().positive().nullable(),
  finishedAt: z.number().int().positive().nullable(),
})
export type SubagentRun = z.infer<typeof subagentRunSchema>

/** Runs that occupy (or will occupy) the inference queue. */
export function isActiveRun(run: SubagentRun): boolean {
  return run.status === 'queued' || run.status === 'running'
}

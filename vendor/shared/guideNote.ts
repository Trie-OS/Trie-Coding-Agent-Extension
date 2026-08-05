/**
 * Frontier Assist annotations — advisory notes shown in chat and review cards.
 */
import { z } from 'zod'

z.config({ jitless: true })

export const guideNoteCheckpointSchema = z.enum([
  'stuck_hint',
  'plan_critique',
  'step_check',
  'final_review',
])
export type GuideNoteCheckpoint = z.infer<typeof guideNoteCheckpointSchema>

export const guideNoteVerdictSchema = z.enum(['ok', 'concerns', 'hint'])
export type GuideNoteVerdict = z.infer<typeof guideNoteVerdictSchema>

export const guideNoteSchema = z.object({
  checkpoint: guideNoteCheckpointSchema,
  verdict: guideNoteVerdictSchema,
  text: z.string(),
})
export type GuideNote = z.infer<typeof guideNoteSchema>

/** Parse model JSON critique; fall back to plain hint text. */
export function parseGuideNoteResponse(
  checkpoint: GuideNoteCheckpoint,
  raw: string,
): GuideNote | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    const withCheckpoint = guideNoteSchema.safeParse(parsed)
    if (withCheckpoint.success) return withCheckpoint.data
    const body = z
      .object({ verdict: guideNoteVerdictSchema, text: z.string() })
      .safeParse(parsed)
    if (body.success) return { checkpoint, ...body.data }
  } catch {
    // fall through
  }
  const lower = trimmed.toLowerCase()
  const verdict: GuideNoteVerdict =
    lower.includes('concern') || lower.includes('risk') || lower.includes('issue')
      ? 'concerns'
      : checkpoint === 'stuck_hint'
        ? 'hint'
        : lower.includes('ok') || lower.includes('looks good')
          ? 'ok'
          : 'concerns'
  return { checkpoint, verdict, text: trimmed.slice(0, 2000) }
}

export function guideNoteLabel(note: GuideNote): string {
  switch (note.checkpoint) {
    case 'stuck_hint':
      return 'Hybrid · suggestion for local model'
    case 'plan_critique':
      return note.verdict === 'concerns' ? 'Hybrid · plan concerns' : 'Hybrid · plan ok'
    case 'step_check':
      return note.verdict === 'concerns' ? 'Hybrid · step concerns' : 'Hybrid · step ok'
    case 'final_review':
      return note.verdict === 'concerns'
        ? 'Hybrid · review concerns'
        : 'Hybrid · review of local work'
  }
}

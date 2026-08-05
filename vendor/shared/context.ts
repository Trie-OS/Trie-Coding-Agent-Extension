/**
 * Context Engine vocabulary (PLAN.md Phase 5).
 *
 * Shared between main (packing), preload, and the renderer (@-mention chips,
 * truncation toasts). Kept separate from chat.ts so message blocks stay
 * persistence-shaped while packing/report types stay engine-shaped.
 */
import { z } from 'zod'

z.config({ jitless: true })

/** A file, folder, or symbol the user pinned for this turn. */
export const contextRefInputSchema = z.object({
  kind: z.enum(['file', 'folder', 'symbol']),
  path: z.string().min(1),
  /** When kind='symbol', the symbol name within `path`. */
  symbol: z.string().min(1).optional(),
  pinned: z.boolean(),
})
export type ContextRefInput = z.infer<typeof contextRefInputSchema>

/** One image attached to the next chat send (base64 payload from renderer). */
export const imageAttachmentInputSchema = z.object({
  name: z.string().min(1),
  mimeType: z.string().min(1),
  /** Raw base64 bytes (no data: URL prefix). */
  dataBase64: z.string().min(1),
})
export type ImageAttachmentInput = z.infer<typeof imageAttachmentInputSchema>

/** What the budget manager dropped to fit the model's context window. */
export const truncationReportSchema = z.object({
  ctxBudget: z.number().int().positive(),
  tokensUsed: z.number().int().nonnegative(),
  droppedTurnCount: z.number().int().nonnegative(),
  droppedContextRefs: z.array(z.string()),
  summarizedTurnCount: z.number().int().nonnegative(),
  /** Human-readable one-liner for the chat UI. */
  summary: z.string(),
})
export type TruncationReport = z.infer<typeof truncationReportSchema>

/** One symbol entry in the workspace index. */
export const symbolHitSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  kind: z.string().min(1),
  name: z.string().min(1),
})
export type SymbolHit = z.infer<typeof symbolHitSchema>

/**
 * Chat history vocabulary shared by main, preload and the renderer
 * (DATA-MODEL.md §"Chat history" / §"Message content blocks").
 *
 * `messages.content` is a JSON array of blocks rather than a string so one
 * assistant message can interleave prose, tool activity and context
 * references without schema churn. Phase 3 only produces `text` blocks; the
 * other three are defined now because the schema is already committed to and
 * a partial union would mean a breaking change in Phase 4.
 */
import { z } from 'zod'
import { forgeErrorCodes } from './errors'
import { guideNoteCheckpointSchema, guideNoteVerdictSchema, type GuideNote } from './guideNote'

z.config({ jitless: true })

export const messageBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  /** Pointer into `tool_calls`; args/results are stored once, there. */
  z.object({ type: z.literal('tool_use'), toolCallId: z.string().min(1) }),
  /** What @-mentions/pins were in effect, so old transcripts stay faithful. */
  z.object({
    type: z.literal('context_ref'),
    kind: z.enum(['file', 'folder', 'symbol']),
    path: z.string().min(1),
    pinned: z.boolean(),
  }),
  z.object({
    type: z.literal('plan_ref'),
    planId: z.string().min(1),
    revision: z.number().int().positive(),
    /** Workspace-relative markdown path written by the planner agent. */
    relPath: z.string().min(1).optional(),
  }),
  /** User-attached image persisted in the transcript. */
  z.object({
    type: z.literal('image'),
    name: z.string().min(1),
    mimeType: z.string().min(1),
    dataBase64: z.string().min(1),
  }),
  /** Frontier Assist advisory note (stuck hint, plan critique, etc.). */
  z.object({
    type: z.literal('guide_note'),
    checkpoint: guideNoteCheckpointSchema,
    verdict: guideNoteVerdictSchema,
    text: z.string(),
  }),
])
export type MessageBlock = z.infer<typeof messageBlockSchema>

export const messageBlocksSchema = z.array(messageBlockSchema)

export const messageStatusSchema = z.enum(['complete', 'interrupted', 'error'])
export type MessageStatus = z.infer<typeof messageStatusSchema>

export const messageSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  role: z.enum(['user', 'assistant', 'system']),
  blocks: messageBlocksSchema,
  status: messageStatusSchema,
  /** Typed error code when status='error' — the code, not a prose message. */
  error: z.enum(forgeErrorCodes).nullable(),
  modelId: z.string().nullable(),
  tokensIn: z.number().int().nonnegative().nullable(),
  tokensOut: z.number().int().nonnegative().nullable(),
  tokPerSec: z.number().nonnegative().nullable(),
  createdAt: z.number().int().positive(),
})
export type Message = z.infer<typeof messageSchema>

export const conversationModeSchema = z.enum(['ask', 'agent', 'plan'])
export type ConversationMode = z.infer<typeof conversationModeSchema>

/** Normalize legacy persisted `chat` rows to `ask`. */
export function normalizeConversationMode(mode: string): ConversationMode {
  if (mode === 'chat') return 'ask'
  return conversationModeSchema.parse(mode)
}

export const conversationSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  title: z.string(),
  mode: conversationModeSchema,
  modelId: z.string().nullable(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  archived: z.boolean(),
})
export type Conversation = z.infer<typeof conversationSchema>

/** One FTS hit: enough to render a result row and jump to the message. */
export const chatSearchHitSchema = z.object({
  messageId: z.string().min(1),
  conversationId: z.string().min(1),
  conversationTitle: z.string(),
  workspaceId: z.string().min(1),
  role: z.enum(['user', 'assistant', 'system']),
  /** Plain-text excerpt around the match. */
  snippet: z.string(),
  createdAt: z.number().int().positive(),
})
export type ChatSearchHit = z.infer<typeof chatSearchHitSchema>

/** The flattened text of a message — what FTS indexes and what the model sees. */
export function flattenBlocks(blocks: MessageBlock[]): string {
  return blocks
    .filter((block): block is Extract<MessageBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** A single text block, the shape Phase 3 always produces. */
export function textBlocks(text: string): MessageBlock[] {
  return [{ type: 'text', text }]
}

/** Persist a Frontier Assist note as a message block. */
export function guideNoteBlock(note: GuideNote): MessageBlock {
  return {
    type: 'guide_note',
    checkpoint: note.checkpoint,
    verdict: note.verdict,
    text: note.text,
  }
}

/** User message blocks: pinned @-context refs, images, plus the typed text. */
export function userMessageBlocks(
  text: string,
  refs: readonly { kind: 'file' | 'folder' | 'symbol'; path: string; symbol?: string; pinned: boolean }[],
  images: readonly { name: string; mimeType: string; dataBase64: string }[] = [],
): MessageBlock[] {
  const blocks: MessageBlock[] = refs.map((ref) => ({
    type: 'context_ref' as const,
    kind: ref.kind,
    path: ref.kind === 'symbol' && ref.symbol ? `${ref.path}#${ref.symbol}` : ref.path,
    pinned: ref.pinned,
  }))
  for (const image of images) {
    blocks.push({
      type: 'image',
      name: image.name,
      mimeType: image.mimeType,
      dataBase64: image.dataBase64,
    })
  }
  if (text !== '') blocks.push({ type: 'text', text })
  return blocks
}

/** Render message blocks for the transcript, including context chips. */
export function formatBlocksForDisplay(blocks: MessageBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && block.text !== '') parts.push(block.text)
    if (block.type === 'context_ref') {
      parts.push(`[@${block.kind} ${block.path}${block.pinned ? ' (pinned)' : ''}]`)
    }
    if (block.type === 'image') {
      parts.push(`[image: ${block.name}]`)
    }
    if (block.type === 'guide_note') {
      parts.push(`[guide: ${block.checkpoint}] ${block.text}`)
    }
  }
  return parts.join('\n')
}

/** Auto-title from the first user message (DATA-MODEL.md: editable later). */
export function deriveTitle(firstUserText: string): string {
  const oneLine = firstUserText.replace(/\s+/g, ' ').trim()
  if (oneLine === '') return 'New conversation'
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine
}

/** Shown when chat/plan/subagent actions need an open workspace folder. */
export const NO_WORKSPACE_CHAT_MESSAGE = 'Open a folder to start chatting.'

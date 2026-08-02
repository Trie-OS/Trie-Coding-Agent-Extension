/**
 * Transactional memory compaction helpers — adapted from Mistral Vibe's
 * CompactionManager: summarize a copy, only commit on success, preserve recent
 * user task messages verbatim, and drop whole oldest rounds on overflow.
 */
import type { ChatTurn } from '../inference/types'

/** Recent turns kept verbatim through a compaction. */
export const KEEP_RECENT_TURNS = 8

/** Cap on verbatim previous user-task text embedded in the compaction envelope. */
const PREVIOUS_USER_CHARS = 12_000

export function estimateTokens(turns: readonly ChatTurn[]): number {
  let total = 0
  for (const turn of turns) total += Math.ceil(turn.content.length / 4) + 8
  return total
}

/** True when a user turn looks like a real task (not a tool result / injection). */
export function isUserTaskTurn(turn: ChatTurn): boolean {
  if (turn.role !== 'user') return false
  const c = turn.content
  if (c.startsWith('Result of ') || c.startsWith('FAILED result of ')) return false
  if (c.startsWith('[Memory compacted]')) return false
  if (c.startsWith('Your last response was invalid')) return false
  return c.startsWith('Task:') || c.includes('\nTask:') || /^Task:/m.test(c)
}

/**
 * Collect recent user task messages from the middle (to-be-summarized) region,
 * newest-first then reversed, capped by character budget.
 */
export function collectPreviousUserTasks(
  middle: readonly ChatTurn[],
  maxChars = PREVIOUS_USER_CHARS,
): string[] {
  const tasks: string[] = []
  let used = 0
  for (let i = middle.length - 1; i >= 0; i--) {
    const turn = middle[i]
    if (!isUserTaskTurn(turn)) continue
    const text = turn.content.trim()
    if (!text) continue
    if (used + text.length > maxChars && tasks.length > 0) break
    const clipped =
      text.length > maxChars - used
        ? `${text.slice(0, Math.max(200, maxChars - used - 20))}…`
        : text
    tasks.push(clipped)
    used += clipped.length
  }
  return tasks.reverse()
}

/**
 * Drop the oldest task round after the system prompt.
 * A round starts at a real user task (`Task: …`) and includes the following
 * assistant / tool-result turns until the next user task. Tool results are
 * stored as `role: user` in this harness, so we key off task turns — not every
 * user-role message.
 * Returns null when only the system + most recent round remain.
 */
export function dropOldestRound(messages: readonly ChatTurn[]): ChatTurn[] | null {
  if (messages.length < 3) return null
  let start = 1
  while (start < messages.length && !isUserTaskTurn(messages[start])) start++
  if (start >= messages.length) return null
  let end = start + 1
  while (end < messages.length && !isUserTaskTurn(messages[end])) end++
  if (end >= messages.length) return null
  return [messages[0], ...messages.slice(end)]
}

export function renderCompactionEnvelope(summary: string, previousUserTasks: string[]): string {
  const lines = [
    '[Memory compacted] You are continuing after a context compaction.',
    '',
    'Recent user tasks (verbatim — prior context, not new requests):',
  ]
  if (previousUserTasks.length === 0) {
    lines.push('(none captured)')
  } else {
    for (const task of previousUserTasks) {
      lines.push('---')
      lines.push(task)
    }
  }
  lines.push('---')
  lines.push('')
  lines.push('Summary of earlier work:')
  lines.push(summary)
  return lines.join('\n')
}

export const COMPACTION_SUMMARY_PROMPT =
  'Summarize this coding-agent transcript in under 300 words. Keep: the original task, files read/edited (exact paths), key findings, decisions made, and current todo state. Drop: raw file contents, tool call syntax, repeated attempts. Write plain prose inside <summary>...</summary> tags only.'

export function extractSummary(text: string): string | null {
  const match = /<summary>([\s\S]*?)<\/summary>/i.exec(text)
  if (match) {
    const inner = match[1].trim()
    if (inner) return inner
  }
  const trimmed = text.trim()
  if (!trimmed) return null
  // Accept bare prose if the model omitted tags (local models often do).
  if (/^\s*\{/.test(trimmed)) return null // looks like a tool call — reject
  return trimmed
}

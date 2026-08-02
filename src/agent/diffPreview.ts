/**
 * Small helpers for permission cards and expandable tool rows.
 */

const DIFF_LINE_PREFIX_DEL = '\u2212' // −
const DIFF_LINE_PREFIX_ADD = '+' // +

/** Cap text to at most `maxLines` lines, appending ellipsis when truncated. */
export function capLines(text: string, maxLines: number): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.length <= maxLines) return lines.join('\n')
  return lines.slice(0, maxLines).join('\n') + '\n…'
}

/** Unified −/+ preview for tool rows and permission diffs. */
export function buildUnifiedDiffPreview(before: string, after: string, maxLines = 80): string {
  const parts: string[] = []
  const beforeLines = before.replace(/\r\n/g, '\n').split('\n').filter((l, i, a) => l.length > 0 || i < a.length - 1)
  const afterLines = after.replace(/\r\n/g, '\n').split('\n').filter((l, i, a) => l.length > 0 || i < a.length - 1)
  for (const line of beforeLines) {
    parts.push(`${DIFF_LINE_PREFIX_DEL}${line}`)
  }
  for (const line of afterLines) {
    parts.push(`${DIFF_LINE_PREFIX_ADD}${line}`)
  }
  return capLines(parts.join('\n'), maxLines)
}

/** Add-only preview for new file writes. */
export function buildAddPreview(content: string, maxLines = 80): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const prefixed = lines.map((line) => `${DIFF_LINE_PREFIX_ADD}${line}`)
  return capLines(prefixed.join('\n'), maxLines)
}

export function isUnifiedDiffDetail(text: string): boolean {
  return /^[\u2212+]/.test(text.trim())
}

export { DIFF_LINE_PREFIX_ADD, DIFF_LINE_PREFIX_DEL }

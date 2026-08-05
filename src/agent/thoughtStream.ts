/** Incrementally extract the `thought` string from a partial tool-call JSON envelope. */
export class ThoughtStreamParser {
  private buffer = ''
  private emitted = 0

  push(chunk: string): string {
    if (!chunk) return ''
    this.buffer += chunk
    const thought = extractPartialThoughtField(this.buffer)
    if (thought.length <= this.emitted) return ''
    const delta = thought.slice(this.emitted)
    this.emitted = thought.length
    return delta
  }

  finalThought(): string {
    return extractPartialThoughtField(this.buffer)
  }

  reset(): void {
    this.buffer = ''
    this.emitted = 0
  }

  /** True when buffered output looks like a JSON tool-call envelope. */
  inToolEnvelope(): boolean {
    const buffer = this.buffer
    return (
      buffer.includes('{') ||
      /"thought"\s*:/.test(buffer) ||
      /"tool"\s*:/.test(buffer) ||
      /"args"\s*:/.test(buffer)
    )
  }
}

export function isToolCallEnvelope(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return false
  return /"tool"\s*:/.test(trimmed) && /"args"\s*:/.test(trimmed)
}

/** User-facing thought text — never show a raw tool-call JSON envelope. */
export function sanitizeThoughtDisplay(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const fromPartial = extractPartialThoughtField(trimmed)
  if (fromPartial.trim()) return fromPartial.trim()
  if (isToolCallEnvelope(trimmed)) return ''
  if (!trimmed.startsWith('{')) return trimmed
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end <= start) return trimmed
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>
    if (typeof parsed['thought'] === 'string' && parsed['thought'].trim()) {
      return parsed['thought'].trim()
    }
  } catch {
    // fall through
  }
  return isToolCallEnvelope(trimmed) ? '' : trimmed
}

function terminalReplyFromEnvelope(
  value: Record<string, unknown>,
  depth: number,
): string {
  if (depth > 3) return ''
  const tool = typeof value['tool'] === 'string' ? value['tool'] : ''
  const args =
    typeof value['args'] === 'object' && value['args'] !== null && !Array.isArray(value['args'])
      ? (value['args'] as Record<string, unknown>)
      : null
  if (!args) return ''

  if (tool === 'step_complete' && typeof args['summary'] === 'string') {
    return sanitizeReplyText(args['summary'], depth + 1)
  }
  if (tool === 'step_failed' && typeof args['reason'] === 'string') {
    return sanitizeReplyText(args['reason'], depth + 1)
  }

  // Some OpenAI-compatible servers put the complete envelope in
  // function.arguments instead of returning only the tool's arguments.
  if (typeof args['tool'] === 'string' && typeof args['args'] === 'object') {
    return terminalReplyFromEnvelope(args, depth + 1)
  }
  return ''
}

/** Final assistant reply — unwrap terminal calls, but never expose internal tool JSON. */
export function sanitizeReplyText(text: string, depth = 0): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  if (!trimmed.startsWith('{')) return trimmed
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const envelope = parsed as Record<string, unknown>
      if (typeof envelope['tool'] === 'string') {
        return terminalReplyFromEnvelope(envelope, depth)
      }
    }
  } catch {
    // Malformed or prose-like text remains visible unless it clearly exposes a tool call.
  }
  if (/"tool"\s*:/.test(trimmed)) return ''
  return trimmed
}

export function extractPartialThoughtField(text: string): string {
  const match = text.match(/"thought"\s*:\s*"/)
  if (!match || match.index === undefined) return ''
  let i = match.index + match[0].length
  let result = ''
  let escaped = false
  while (i < text.length) {
    const ch = text[i]!
    if (escaped) {
      if (ch === 'n') result += '\n'
      else if (ch === 't') result += '\t'
      else if (ch === 'r') result += '\r'
      else result += ch
      escaped = false
    } else if (ch === '\\') {
      escaped = true
    } else if (ch === '"') {
      break
    } else {
      result += ch
    }
    i++
  }
  return result
}

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

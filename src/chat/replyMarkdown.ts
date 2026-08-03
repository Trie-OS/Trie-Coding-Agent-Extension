/** Normalize model prose so block markdown (lists, tables) renders correctly in the webview. */
export function normalizeReplyMarkdownStructure(text: string): string {
  let s = text.replace(/\r\n/g, '\n').trim()
  if (!s) return s

  // "1. foo, 2. bar" or "1. foo; 2. bar" → one item per line
  s = s.replace(/,\s*(?=\d+\.\s+\S)/g, '\n')
  s = s.replace(/;\s*(?=\d+\.\s+\S)/g, '\n')

  // Sentence end then next numbered item on the same line
  s = s.replace(/([.!?])\s+(?=\d+\.\s+\S)/g, '$1\n')

  // "- item - item" inline bullets
  s = s.replace(/([.!?])\s+(?=-\s+\S)/g, '$1\n')

  return s
}

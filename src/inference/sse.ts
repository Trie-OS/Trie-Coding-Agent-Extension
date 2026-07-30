/**
 * Minimal SSE reader over fetch. Both the Trie IDE daemon and
 * OpenAI-compatible servers stream `data: <json>\n\n` frames.
 */
export async function readSse(
  response: Response,
  onData: (data: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const body = response.body
  if (!body) throw new Error('Streaming response has no body')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ')) onData(line.slice(6))
          else if (line.startsWith('data:')) onData(line.slice(5))
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

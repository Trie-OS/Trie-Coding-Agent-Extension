import type { ChatTurn } from './types'

type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** Map turns to OpenAI chat messages, including multimodal user turns. */
export function buildOpenAiMessages(
  turns: readonly ChatTurn[],
): Array<{ role: ChatTurn['role']; content: string | OpenAiContentPart[] }> {
  return turns.map((turn) => {
    if (turn.role === 'user' && turn.images && turn.images.length > 0) {
      const parts: OpenAiContentPart[] = []
      if (turn.content.trim() !== '') {
        parts.push({ type: 'text', text: turn.content })
      }
      for (const image of turn.images) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` },
        })
      }
      return { role: turn.role, content: parts }
    }
    return { role: turn.role, content: turn.content }
  })
}

/**
 * OpenAI-compatible /v1/chat/completions streaming client — same endpoint
 * shape Trie IDE's ApiProvider uses, so it works against llama-server,
 * LM Studio, Ollama, or any cloud endpoint that speaks the protocol.
 */
import { readSse } from './sse'
import type { ChatTurn, GenerateResult, GenerationParams, InferenceClient } from './types'

export class OpenAiCompatibleClient implements InferenceClient {
  constructor(
    private readonly baseUrl: string,
    private readonly modelName: string,
    private readonly apiKey: string,
  ) {}

  describe(): string {
    return `${this.modelName || 'model'} @ ${this.baseUrl}`
  }

  async generate(
    turns: ChatTurn[],
    params: GenerationParams,
    onToken: (text: string) => void,
    signal: AbortSignal,
  ): Promise<GenerateResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.modelName,
        messages: turns.map((t) => ({ role: t.role, content: t.content })),
        temperature: params.temperature,
        top_p: params.topP,
        max_tokens: params.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal,
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`chat completion failed (${response.status}): ${body.slice(0, 300)}`)
    }

    let text = ''
    let tokensIn = 0
    let tokensOut = 0
    await readSse(
      response,
      (data) => {
        if (data.trim() === '[DONE]') return
        let chunk: {
          choices?: Array<{ delta?: { content?: string | null } }>
          usage?: { prompt_tokens?: number; completion_tokens?: number } | null
        }
        try {
          chunk = JSON.parse(data)
        } catch {
          return
        }
        const delta = chunk.choices?.[0]?.delta?.content
        if (typeof delta === 'string' && delta.length > 0) {
          text += delta
          onToken(delta)
        }
        if (chunk.usage) {
          tokensIn = chunk.usage.prompt_tokens ?? tokensIn
          tokensOut = chunk.usage.completion_tokens ?? tokensOut
        }
      },
      signal,
    )
    return { text, tokensIn, tokensOut }
  }
}

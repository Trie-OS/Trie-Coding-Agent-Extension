/**
 * OpenAI-compatible /v1/chat/completions streaming client — same endpoint
 * shape Trie IDE's ApiProvider uses, so it works against llama-server,
 * LM Studio, Ollama, or any cloud endpoint that speaks the protocol.
 */
import { readSse } from './sse'
import { buildOpenAiMessages } from './openAiMessages'
import { isOutputTruncatedFinishReason } from './truncation'
import type { ChatTurn, GenerateResult, GenerationParams, InferenceClient } from './types'

interface ToolCallDelta {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

function accumulateToolCallDeltas(
  state: Map<number, { name: string; arguments: string }>,
  deltas: readonly ToolCallDelta[],
): void {
  for (const delta of deltas) {
    const index = typeof delta.index === 'number' ? delta.index : 0
    const existing = state.get(index) ?? { name: '', arguments: '' }
    if (typeof delta.function?.name === 'string' && delta.function.name.length > 0) {
      existing.name = delta.function.name
    }
    if (typeof delta.function?.arguments === 'string') {
      existing.arguments += delta.function.arguments
    }
    state.set(index, existing)
  }
}

function toolCallsToEnvelope(
  calls: Array<{ name: string; arguments: string }>,
  thought: string,
): string {
  const call = calls[0]!
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(call.arguments || '{}') as Record<string, unknown>
  } catch {
    args = {}
  }
  return JSON.stringify({
    thought: thought.trim() || 'Function call',
    tool: call.name,
    args,
  })
}

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
        messages: buildOpenAiMessages(turns),
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
    let finishReason: string | null = null
    const toolCallState = new Map<number, { name: string; arguments: string }>()
    await readSse(
      response,
      (data) => {
        if (data.trim() === '[DONE]') return
        let chunk: {
          choices?: Array<{
            delta?: {
              content?: string | null
              tool_calls?: ToolCallDelta[]
            }
            finish_reason?: string | null
          }>
          usage?: { prompt_tokens?: number; completion_tokens?: number } | null
        }
        try {
          chunk = JSON.parse(data)
        } catch {
          return
        }
        const delta = chunk.choices?.[0]?.delta
        const reason = chunk.choices?.[0]?.finish_reason
        if (typeof reason === 'string') finishReason = reason
        if (typeof delta?.content === 'string' && delta.content.length > 0) {
          text += delta.content
          onToken(delta.content)
        }
        if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
          accumulateToolCallDeltas(toolCallState, delta.tool_calls)
        }
        if (chunk.usage) {
          tokensIn = chunk.usage.prompt_tokens ?? tokensIn
          tokensOut = chunk.usage.completion_tokens ?? tokensOut
        }
      },
      signal,
    )

    const finalizedCalls = [...toolCallState.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call)
      .filter((call) => call.name.length > 0)

    if (finalizedCalls.length > 0 && text.trim() === '') {
      text = toolCallsToEnvelope(finalizedCalls, text)
      onToken(text)
    }

    return {
      text,
      tokensIn,
      tokensOut,
      truncated: isOutputTruncatedFinishReason(finishReason),
    }
  }
}

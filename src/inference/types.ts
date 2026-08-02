/** Mirrors Trie IDE's shared inference wire types (app/src/shared/inference.ts). */

export type ChatRole = 'user' | 'assistant' | 'system'

export interface ChatTurnImage {
  mimeType: string
  dataBase64: string
}

export interface ChatTurn {
  role: ChatRole
  content: string
  /** Present on user turns when the composer attached images. */
  images?: ChatTurnImage[]
}

export interface GenerationParams {
  temperature: number
  topP: number
  maxTokens: number
}

export interface GenerateResult {
  text: string
  tokensIn: number
  tokensOut: number
  /** 0 = confident, 1 = uncertain — from daemon token confidence or heuristics. */
  uncertainty?: number
  /** True when generation hit max_tokens (often correlates with flailing). */
  truncated?: boolean
}

export interface InferenceClient {
  /** Human-readable label of what is serving tokens ("Qwen…​ @ daemon", "kimi @ http://…"). */
  describe(): string
  generate(
    turns: ChatTurn[],
    params: GenerationParams,
    onToken: (text: string) => void,
    signal: AbortSignal,
  ): Promise<GenerateResult>
}

/** Mirrors Trie IDE's shared inference wire types (app/src/shared/inference.ts). */

export type ChatRole = 'user' | 'assistant' | 'system'

export interface ChatTurn {
  role: ChatRole
  content: string
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

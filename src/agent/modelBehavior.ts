/** Models tuned to emit long hidden reasoning often need earlier action nudges. */
const REASONING_MODEL_PATTERN =
  /(?:^|[/_.:\s-])(?:reasoning|reasoner|thinking|deepseek[-_.]?r1|qwq|o1|o3|o4)(?:$|[/_.:\s-])/i

export function isReasoningModel(label: string): boolean {
  return REASONING_MODEL_PATTERN.test(label)
}

export function explorationNudgeLimit(reasoningModel: boolean): number {
  return reasoningModel ? 5 : 10
}

export function stallNudgeLimit(reasoningModel: boolean): number {
  return reasoningModel ? 4 : 6
}

export const REASONING_STREAM_CHAR_CAP = 1200

export function capReasoningChunk(
  chunk: string,
  visibleChars: number,
  reasoningModel: boolean,
): string {
  if (!reasoningModel) return chunk
  const remaining = Math.max(0, REASONING_STREAM_CHAR_CAP - visibleChars)
  return remaining > 0 ? chunk.slice(0, remaining) : ''
}


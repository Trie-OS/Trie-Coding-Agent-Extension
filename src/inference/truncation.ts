export function isOutputTruncatedFinishReason(reason: string | null | undefined): boolean {
  return reason === 'length' || reason === 'max_tokens'
}

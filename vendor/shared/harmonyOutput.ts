/**
 * Parse gpt-oss Harmony-format assistant output into thinking + final answer.
 * @see https://github.com/openai/harmony/blob/main/docs/format.md
 */

export function looksLikeHarmonyOutput(text: string): boolean {
  return (
    text.includes('<|channel|>') ||
    text.includes('<|start|>assistant') ||
    text.includes('<|message|>')
  )
}

/** Plain-text chain-of-thought when the wrong template was used. */
export function looksLikeMetaReasoning(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  if (/^(The user says:|User asks:)/i.test(trimmed)) return true
  if (/^This request is (a|an)\b/i.test(trimmed) && !trimmed.includes('<|channel|>final')) {
    return true
  }
  return false
}

export function parseHarmonyAssistantOutput(raw: string): {
  thinking: string
  answer: string
  hasHarmonyMarkers: boolean
} {
  if (!looksLikeHarmonyOutput(raw)) {
    return { thinking: '', answer: raw, hasHarmonyMarkers: false }
  }

  const thinkingParts: string[] = []
  const analysisRe = /<\|channel\|>analysis<\|message\|>([\s\S]*?)<\|end\|>/gi
  let analysisMatch: RegExpExecArray | null
  while ((analysisMatch = analysisRe.exec(raw)) !== null) {
    const chunk = (analysisMatch[1] ?? '').trim()
    if (chunk.length > 0) thinkingParts.push(chunk)
  }

  const finalMatch =
    /<\|channel\|>final<\|message\|>([\s\S]*?)(?:<\|return\|>|<\|end\|>|$)/i.exec(raw)
  const answer = (finalMatch?.[1] ?? '').trim()

  if (thinkingParts.length === 0 && answer.length === 0) {
    const partialAnalysis =
      /<\|channel\|>analysis<\|message\|>([\s\S]*)$/i.exec(raw)?.[1]?.trim() ?? ''
    if (partialAnalysis.length > 0) {
      return { thinking: partialAnalysis, answer: '', hasHarmonyMarkers: true }
    }
  }

  return {
    thinking: thinkingParts.join('\n\n'),
    answer,
    hasHarmonyMarkers: true,
  }
}

/** Convert Harmony output to markdown with `<thinking>` blocks for the UI. */
export function harmonyToMarkdown(raw: string): string {
  const { thinking, answer, hasHarmonyMarkers } = parseHarmonyAssistantOutput(raw)
  if (!hasHarmonyMarkers) {
    if (looksLikeMetaReasoning(raw)) {
      return `<thinking>\n${raw.trim()}\n</thinking>\n\n_(The model stopped before producing a final answer. Try sending again or reload the model so Harmony template is applied.)_`
    }
    return raw
  }

  const parts: string[] = []
  if (thinking.trim().length > 0) {
    parts.push(`<thinking>\n${thinking.trim()}\n</thinking>`)
  }
  if (answer.trim().length > 0) {
    parts.push(answer.trim())
  } else if (thinking.trim().length > 0) {
    parts.push(
      '_(The model stopped during reasoning before a final answer. Try again or increase max tokens.)_',
    )
  }
  return parts.length > 0 ? parts.join('\n\n') : raw
}

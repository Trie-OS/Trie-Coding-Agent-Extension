/**
 * Normalize raw model assistant text for chat rendering and persistence.
 */
import { harmonyToMarkdown, looksLikeHarmonyOutput, looksLikeMetaReasoning } from './harmonyOutput'
import { stripEmojis } from './text'
import { stripLeakedTemplateTokens } from './templateLeaks'

export function sanitizeAssistantOutput(text: string): string {
  const stripped = stripLeakedTemplateTokens(stripEmojis(text))
  if (looksLikeHarmonyOutput(stripped) || looksLikeMetaReasoning(stripped)) {
    return harmonyToMarkdown(stripped)
  }
  return stripped
}

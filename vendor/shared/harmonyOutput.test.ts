import { describe, expect, it } from 'vitest'
import {
  harmonyToMarkdown,
  looksLikeHarmonyOutput,
  looksLikeMetaReasoning,
  parseHarmonyAssistantOutput,
} from './harmonyOutput'

describe('harmonyOutput', () => {
  it('detects harmony markers', () => {
    expect(looksLikeHarmonyOutput('<|channel|>analysis<|message|>hi')).toBe(true)
  })

  it('splits analysis and final channels', () => {
    const raw =
      '<|channel|>analysis<|message|>User asks about the project.<|end|>' +
      '<|start|>assistant<|channel|>final<|message|>Trie IDE is a local IDE.<|return|>'
    expect(parseHarmonyAssistantOutput(raw)).toMatchObject({
      thinking: 'User asks about the project.',
      answer: 'Trie IDE is a local IDE.',
      hasHarmonyMarkers: true,
    })
  })

  it('converts harmony output to thinking markdown', () => {
    const raw =
      '<|channel|>analysis<|message|>Planning…<|end|>' +
      '<|channel|>final<|message|>Hello!<|return|>'
    const md = harmonyToMarkdown(raw)
    expect(md).toContain('<thinking>')
    expect(md).toContain('Planning…')
    expect(md).toContain('Hello!')
  })

  it('salvages plain meta-reasoning without harmony tokens', () => {
    const raw =
      'The user says: "Tell me about this project". This request is a request for a description.'
    expect(looksLikeMetaReasoning(raw)).toBe(true)
    expect(harmonyToMarkdown(raw)).toContain('<thinking>')
    expect(harmonyToMarkdown(raw)).toContain('Try sending again')
  })
})

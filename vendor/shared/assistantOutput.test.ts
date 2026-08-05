import { describe, expect, it } from 'vitest'
import { sanitizeAssistantOutput } from './assistantOutput'

describe('sanitizeAssistantOutput', () => {
  it('strips mistral leaks before rendering', () => {
    expect(sanitizeAssistantOutput('colors\n<s> file.swift')).toBe('colors\n file.swift')
  })
})

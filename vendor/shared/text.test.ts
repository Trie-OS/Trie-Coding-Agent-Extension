import { describe, expect, it } from 'vitest'
import { stripEmojis } from './text'

describe('stripEmojis', () => {
  it('removes pictographic emoji from text', () => {
    expect(stripEmojis('Hello 😊 world')).toBe('Hello  world')
    expect(stripEmojis('Done ✅')).toBe('Done ')
  })

  it('leaves plain ASCII unchanged', () => {
    expect(stripEmojis('Hello world')).toBe('Hello world')
  })
})

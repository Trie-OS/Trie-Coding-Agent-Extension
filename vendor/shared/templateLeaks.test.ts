import { describe, expect, it } from 'vitest'
import { stripLeakedTemplateTokens } from './templateLeaks'

describe('stripLeakedTemplateTokens', () => {
  it('removes inline <s> but keeps following text', () => {
    const raw = 'light green: `90EE90`\n<s> IOS_LowPowerMode.swift and IOS.swift'
    expect(stripLeakedTemplateTokens(raw)).toBe(
      'light green: `90EE90`\n IOS_LowPowerMode.swift and IOS.swift',
    )
  })

  it('truncates at </s>', () => {
    expect(stripLeakedTemplateTokens('Done.\n</s>more garbage')).toBe('Done.\n')
  })

  it('truncates at [INST]', () => {
    expect(stripLeakedTemplateTokens('Summary here[INST] follow up')).toBe('Summary here')
  })

  it('leaves clean markdown unchanged', () => {
    const md = '**3 files changed:**\n- `foo.ts`'
    expect(stripLeakedTemplateTokens(md)).toBe(md)
  })
})

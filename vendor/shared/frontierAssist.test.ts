import { describe, expect, it } from 'vitest'
import {
  defaultFrontierAssistModel,
  frontierAssistModelForProviderChange,
  resolveFrontierAssistModel,
} from './frontierAssist'
import { defaultFrontierAssistSettings } from './appSettings'

describe('frontierAssist', () => {
  it('defaults to gpt-4o for OpenAI', () => {
    expect(defaultFrontierAssistModel('openai')).toBe('gpt-4o')
  })

  it('defaults to Claude Sonnet for Anthropic', () => {
    expect(defaultFrontierAssistModel('anthropic')).toBe('claude-sonnet-4-20250514')
  })

  it('resolves explicit model when set', () => {
    expect(
      resolveFrontierAssistModel({
        ...defaultFrontierAssistSettings,
        provider: 'openai',
        model: 'gpt-4-turbo',
      }),
    ).toBe('gpt-4-turbo')
  })

  it('falls back to provider default when model is empty', () => {
    expect(
      resolveFrontierAssistModel({
        ...defaultFrontierAssistSettings,
        provider: 'anthropic',
        model: '',
      }),
    ).toBe('claude-sonnet-4-20250514')
  })

  it('clears model on provider change when it matched the old default', () => {
    expect(
      frontierAssistModelForProviderChange('', 'openai', 'anthropic'),
    ).toBe('')
    expect(
      frontierAssistModelForProviderChange('gpt-4o', 'openai', 'anthropic'),
    ).toBe('')
  })

  it('keeps custom model on provider change', () => {
    expect(
      frontierAssistModelForProviderChange('gpt-4-turbo', 'openai', 'anthropic'),
    ).toBe('gpt-4-turbo')
  })
})

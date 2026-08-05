import { describe, expect, it } from 'vitest'
import {
  clampStoredAgentMaxToolCalls,
  normalizeLoopMaxCalls,
  resolveAgentMaxToolCalls,
  UNLIMITED_AGENT_MAX_TOOL_CALLS,
} from './agentLimits'

describe('resolveAgentMaxToolCalls', () => {
  it('returns unlimited when unset or zero', () => {
    expect(resolveAgentMaxToolCalls(undefined)).toBe(Infinity)
    expect(resolveAgentMaxToolCalls({})).toBe(Infinity)
    expect(resolveAgentMaxToolCalls({ agentMaxToolCalls: 0 })).toBe(Infinity)
  })

  it('uses explicit caps when set', () => {
    expect(resolveAgentMaxToolCalls({ agentMaxToolCalls: 25 })).toBe(25)
    expect(resolveAgentMaxToolCalls({ agentMaxToolCalls: 5 })).toBe(5)
  })
})

describe('clampStoredAgentMaxToolCalls', () => {
  it('preserves zero as unlimited', () => {
    expect(clampStoredAgentMaxToolCalls(0)).toBe(UNLIMITED_AGENT_MAX_TOOL_CALLS)
  })

  it('clamps positive values', () => {
    expect(clampStoredAgentMaxToolCalls(5)).toBe(5)
    expect(clampStoredAgentMaxToolCalls(0.9)).toBe(1)
    expect(clampStoredAgentMaxToolCalls(99999)).toBe(9999)
  })
})

describe('normalizeLoopMaxCalls', () => {
  it('maps zero and undefined to unlimited', () => {
    expect(normalizeLoopMaxCalls(undefined)).toBe(Infinity)
    expect(normalizeLoopMaxCalls(0)).toBe(Infinity)
  })
})

import { describe, expect, it } from 'vitest'
import {
  ipcContract,
  IpcValidationError,
  isKnownChannel,
  parseRequest,
  parseResponse,
} from './ipc-contract'

describe('ipc-contract', () => {
  it('accepts a valid app:ping request', () => {
    expect(parseRequest('app:ping', { nonce: 'abc' })).toEqual({ nonce: 'abc' })
  })

  it('rejects an app:ping request with a missing nonce', () => {
    expect(() => parseRequest('app:ping', {})).toThrow(IpcValidationError)
  })

  it('rejects an app:ping request with an empty nonce', () => {
    expect(() => parseRequest('app:ping', { nonce: '' })).toThrow(IpcValidationError)
  })

  it('rejects an app:ping request of the wrong type entirely', () => {
    expect(() => parseRequest('app:ping', 'nonce')).toThrow(IpcValidationError)
  })

  it('strips unknown keys from a request rather than passing them through', () => {
    const parsed = parseRequest('app:ping', { nonce: 'abc', extra: 'smuggled' })
    expect(parsed).toEqual({ nonce: 'abc' })
  })

  it('accepts partial frontierAssist and apiProvider updates', () => {
    expect(
      parseRequest('app:update-settings', {
        settings: { frontierAssist: { apiKey: 'sk-test', model: 'gpt-4o' } },
      }),
    ).toEqual({
      settings: { frontierAssist: { apiKey: 'sk-test', model: 'gpt-4o' } },
    })
    expect(
      parseRequest('app:update-settings', {
        settings: { apiProvider: { modelName: 'kimi-k3' } },
      }),
    ).toEqual({
      settings: { apiProvider: { modelName: 'kimi-k3' } },
    })
  })

  it('accepts a valid app:ping response', () => {
    const response = { nonce: 'abc', mainPid: 123, receivedAt: Date.now() }
    expect(parseResponse('app:ping', response)).toEqual(response)
  })

  it('rejects an app:ping response with a non-integer pid', () => {
    expect(() =>
      parseResponse('app:ping', { nonce: 'abc', mainPid: 1.5, receivedAt: Date.now() }),
    ).toThrow(IpcValidationError)
  })

  it('reports channel, side, and code on validation failure', () => {
    try {
      parseResponse('app:ping', { nonce: 'abc' })
      expect.unreachable('parseResponse should have thrown')
    } catch (error) {
      const e = error as IpcValidationError
      expect(e).toBeInstanceOf(IpcValidationError)
      expect(e.code).toBe('IPC_VALIDATION_FAILED')
      expect(e.channel).toBe('app:ping')
      expect(e.side).toBe('response')
      expect(e.message).toContain('app:ping')
    }
  })

  it('knows its own channels and nothing else', () => {
    expect(isKnownChannel('app:ping')).toBe(true)
    expect(isKnownChannel('app:teleport')).toBe(false)
  })

  it('defines request and response schemas for every channel', () => {
    for (const [channel, schemas] of Object.entries(ipcContract)) {
      expect(schemas.request, `${channel} request schema`).toBeDefined()
      expect(schemas.response, `${channel} response schema`).toBeDefined()
    }
  })
})

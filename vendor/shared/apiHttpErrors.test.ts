import { describe, expect, it } from 'vitest'
import {
  apiRetryDelayMs,
  forgeErrorCodeForApiHttpStatus,
  isApiProviderTransientBusy,
  isRetryableApiHttpStatus,
  parseRetryAfterMs,
  userFacingApiRateLimitHint,
} from './apiHttpErrors'

describe('apiHttpErrors', () => {
  it('treats Kimi overload 429 as transient busy', () => {
    const message = 'HTTP 429: The engine is currently overloaded, please try again later'
    expect(isApiProviderTransientBusy(429, message)).toBe(true)
    expect(userFacingApiRateLimitHint(message)).toContain('not a billing issue')
  })

  it('retries common transient HTTP statuses', () => {
    expect(isRetryableApiHttpStatus(429)).toBe(true)
    expect(isRetryableApiHttpStatus(503)).toBe(true)
    expect(isRetryableApiHttpStatus(400)).toBe(false)
  })

  it('maps HTTP statuses to forge error codes', () => {
    expect(forgeErrorCodeForApiHttpStatus(429)).toBe('API_RATE_LIMIT')
    expect(forgeErrorCodeForApiHttpStatus(401)).toBe('API_AUTH_ERROR')
    expect(forgeErrorCodeForApiHttpStatus(500)).toBe('API_SERVER_ERROR')
  })

  it('parses Retry-After seconds', () => {
    expect(parseRetryAfterMs('3')).toBe(3000)
  })

  it('uses exponential backoff when Retry-After is absent', () => {
    expect(apiRetryDelayMs(0, null)).toBe(2000)
    expect(apiRetryDelayMs(2, null)).toBe(8000)
  })
})

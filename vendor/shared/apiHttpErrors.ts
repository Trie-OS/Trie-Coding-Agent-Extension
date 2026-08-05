import type { ForgeErrorCode } from './errors'

/** HTTP statuses worth retrying for OpenAI-compatible API providers. */
export function isRetryableApiHttpStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504
}

/**
 * Kimi/Moonshot often return 429 with "engine is currently overloaded" — that is
 * transient capacity, not billing/quota exhaustion.
 */
export function isApiProviderTransientBusy(status: number, message: string): boolean {
  if (status === 502 || status === 503 || status === 504) return true
  if (status !== 429) return false
  const lower = message.toLowerCase()
  return (
    lower.includes('overloaded') ||
    lower.includes('try again') ||
    lower.includes('capacity') ||
    lower.includes('too many requests') ||
    lower.includes('busy')
  )
}

export function parseRetryAfterMs(header: string | null | undefined): number | null {
  if (!header?.trim()) return null
  const trimmed = header.trim()
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.max(seconds, 1) * 1000, 60_000)
  }
  const dateMs = Date.parse(trimmed)
  if (Number.isFinite(dateMs)) {
    return Math.max(0, Math.min(dateMs - Date.now(), 60_000))
  }
  return null
}

/** Backoff for API retries: honor Retry-After when present, else exponential. */
export function apiRetryDelayMs(
  attempt: number,
  retryAfterHeader: string | null | undefined,
): number {
  return parseRetryAfterMs(retryAfterHeader) ?? Math.min(2000 * 2 ** attempt, 30_000)
}

export function forgeErrorCodeForApiHttpStatus(status: number): ForgeErrorCode {
  if (status === 429) return 'API_RATE_LIMIT'
  if (status === 401 || status === 403) return 'API_AUTH_ERROR'
  if (status === 400) return 'API_BAD_REQUEST'
  if (status >= 500) return 'API_SERVER_ERROR'
  return 'HOST_UNREACHABLE'
}

export function userFacingApiRateLimitHint(message: string): string {
  if (isApiProviderTransientBusy(429, message)) {
    return 'API provider is temporarily busy (server overload) — wait a moment and retry. This is not a billing issue.'
  }
  return 'API provider quota or rate limit exceeded — check your plan/billing.'
}

const MAX_USER_ERROR_CHARS = 500

/** Convert unknown failures to safe, actionable UI text without exposing credentials. */
export function sanitizeUserError(error: unknown, fallback = 'Unknown error.'): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const redacted = raw
    .replace(/\b(Bearer)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(
      /\b(api[_-]?key|authorization|x-api-key)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1$2[redacted]',
    )
    .replace(/\b[A-Za-z0-9+/_=-]{48,}\b/g, '[redacted token]')
    .replace(/\s+/g, ' ')
    .trim()
  return (redacted || fallback).slice(0, MAX_USER_ERROR_CHARS)
}

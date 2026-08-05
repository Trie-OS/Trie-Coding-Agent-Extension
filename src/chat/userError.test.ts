import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeUserError } from './userError.ts'

test('sanitizeUserError preserves useful context and redacts credentials', () => {
  const message = sanitizeUserError(
    new Error('HTTP 401 Authorization: Bearer secret-token-value; apiKey=abc123 failed'),
  )
  assert.match(message, /HTTP 401/)
  assert.match(message, /failed/)
  assert.doesNotMatch(message, /secret-token-value|abc123/)
})

test('sanitizeUserError handles unknown and oversized values', () => {
  assert.equal(sanitizeUserError(null, 'Operation failed.'), 'Operation failed.')
  assert.equal(sanitizeUserError('error '.repeat(120)).length, 500)
})

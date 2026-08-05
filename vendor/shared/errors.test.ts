import { describe, expect, it } from 'vitest'
import { deserializeForgeError, ForgeError, serializeForgeError } from './errors'

describe('ForgeError envelope', () => {
  it('round-trips code, message, and details', () => {
    const original = new ForgeError('PATH_OUTSIDE_WORKSPACE', 'escape attempt', {
      relPath: '../../etc/passwd',
    })
    const revived = deserializeForgeError(serializeForgeError(original))
    expect(revived).toBeInstanceOf(ForgeError)
    expect(revived?.code).toBe('PATH_OUTSIDE_WORKSPACE')
    expect(revived?.message).toBe('escape attempt')
    expect(revived?.details).toEqual({ relPath: '../../etc/passwd' })
  })

  it('round-trips without details', () => {
    const revived = deserializeForgeError(
      serializeForgeError(new ForgeError('FILE_NOT_FOUND', 'gone')),
    )
    expect(revived?.code).toBe('FILE_NOT_FOUND')
    expect(revived?.details).toBeUndefined()
  })

  it('returns null for ordinary payloads (not everything is an error)', () => {
    expect(deserializeForgeError({ ok: true })).toBeNull()
    expect(deserializeForgeError(null)).toBeNull()
    expect(deserializeForgeError('string')).toBeNull()
    expect(
      deserializeForgeError({ __forgeError: { code: 'NOT_A_REAL_CODE', message: 'x' } }),
    ).toBeNull()
  })
})

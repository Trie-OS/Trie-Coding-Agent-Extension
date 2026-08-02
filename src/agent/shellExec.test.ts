import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shellCommandSpec } from './shellExec.ts'

describe('shellCommandSpec', () => {
  it('uses sh on posix platforms', { skip: process.platform === 'win32' }, () => {
    const spec = shellCommandSpec('npm test', '/tmp', 1000, 1024)
    assert.equal(spec.file, '/bin/sh')
    assert.deepEqual(spec.args, ['-c', 'npm test'])
  })

  it('uses cmd.exe on Windows', { skip: process.platform !== 'win32' }, () => {
    const spec = shellCommandSpec('npm test', 'C:\\repo', 1000, 1024)
    assert.match(spec.file.toLowerCase(), /cmd\.exe$/)
    assert.deepEqual(spec.args, ['/d', '/s', '/c', 'npm test'])
    assert.equal(spec.options.windowsVerbatimArguments, true)
  })
})

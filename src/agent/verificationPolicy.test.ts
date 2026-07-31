import assert from 'node:assert/strict'
import test from 'node:test'
import { verificationPolicy, verificationReminder } from './verificationPolicy.ts'

test('requires verification and encourages tests for a bug fix', () => {
  const policy = verificationPolicy('Fix the parser regression', ['src/parser.ts'])
  assert.equal(policy.needed, true)
  assert.equal(policy.encourageTests, true)
  assert.match(verificationReminder(policy), /focused regression test/)
})

test('requires running a changed focused test', () => {
  const policy = verificationPolicy('Update coverage', ['src/parser.test.ts'])
  assert.deepEqual(
    { needed: policy.needed, encourageTests: policy.encourageTests },
    { needed: true, encourageTests: false },
  )
})

test('skips pure docs, assets, visual CSS, and low-risk config', () => {
  for (const path of ['README.md', 'media/icon.svg', 'media/theme.css', 'tsconfig.json']) {
    assert.equal(verificationPolicy('Update presentation', [path]).needed, false, path)
  }
})

test('risk makes config-only changes worth verifying', () => {
  const policy = verificationPolicy('Fix the production build config', ['tsconfig.json'])
  assert.equal(policy.needed, true)
})

test('unknown changed files are verified conservatively', () => {
  assert.equal(verificationPolicy('Update generated behavior', ['templates/runtime.tpl']).needed, true)
})

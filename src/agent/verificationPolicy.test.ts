import assert from 'node:assert/strict'
import test from 'node:test'
import {
  VerificationTracker,
  verificationPolicy,
  verificationReminder,
} from './verificationPolicy.ts'

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
  assert.equal(verificationPolicy('Fix the production build config', ['tsconfig.json']).needed, true)
})

test('unknown changed files are verified conservatively', () => {
  assert.equal(verificationPolicy('Update generated behavior', ['templates/runtime.tpl']).needed, true)
})

test('later edits invalidate successful verification', () => {
  const tracker = new VerificationTracker()
  tracker.noteMutation()
  tracker.noteVerification()
  assert.equal(tracker.hasCurrentEvidence(), true)
  tracker.noteMutation()
  assert.equal(tracker.hasCurrentEvidence(), false)
})

test('completion gets one verification nudge, not an infinite loop', () => {
  const tracker = new VerificationTracker()
  tracker.noteMutation()
  const policy = verificationPolicy('Fix logic', ['src/logic.ts'])
  const reminder = tracker.takeCompletionNudge(policy)
  assert.ok(reminder)
  assert.match(reminder, /Verification is still stale/)
  assert.equal(tracker.takeCompletionNudge(policy), null)
})

test('an explicit skip is current until another edit', () => {
  const tracker = new VerificationTracker()
  tracker.noteMutation()
  tracker.noteVerification(true)
  assert.equal(tracker.hasCurrentEvidence(), true)
  tracker.noteMutation()
  assert.equal(tracker.hasCurrentEvidence(), false)
})

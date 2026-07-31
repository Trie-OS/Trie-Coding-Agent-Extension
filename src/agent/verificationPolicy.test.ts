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

test('requests visual harness verification for webview behavior', () => {
  const policy = verificationPolicy(
    'Fix the prompt and status layout collision in the webview',
    ['media/src/main.ts', 'media/main.css'],
  )
  assert.equal(policy.needed, true)
  assert.equal(policy.useVisualHarness, true)
  assert.match(verificationReminder(policy), /visual\/e2e\/UI harness/)
})

test('requests visual verification for consequential layout-only CSS', () => {
  const policy = verificationPolicy(
    'Fix responsive overflow and truncation at narrow breakpoints',
    ['src/styles/chat.css'],
  )
  assert.deepEqual(
    { needed: policy.needed, useVisualHarness: policy.useVisualHarness },
    { needed: true, useVisualHarness: true },
  )
})

test('does not demand a visual harness for trivial cosmetic CSS or assets', () => {
  const policy = verificationPolicy('Update the icon color', ['media/theme.css', 'media/icon.svg'])
  assert.equal(policy.needed, false)
  assert.equal(policy.useVisualHarness, false)
})

test('uses focused non-visual verification for backend logic', () => {
  const policy = verificationPolicy('Fix queue cancellation logic', ['src/agent/queue.ts'])
  assert.equal(policy.needed, true)
  assert.equal(policy.useVisualHarness, false)
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

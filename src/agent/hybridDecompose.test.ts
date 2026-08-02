import assert from 'node:assert/strict'
import test from 'node:test'
import { DECOMPOSE_TIMEOUT_MS, shouldDecompose } from './hybridDecomposePolicy.ts'

test('shouldDecompose triggers on long Multitask-style prompts', () => {
  const long =
    'You are Agent 1 · Architecture, one isolated child in a coordinated Multitask run. ' +
    'Map the relevant architecture, entry points, state ownership, and cross-file data flow. ' +
    'Coordinate by reporting concise structured findings for the next sibling and final coordinator.'
  assert.equal(shouldDecompose(long, 0), true)
  assert.equal(shouldDecompose('fix typo', 0), false)
})

test('decompose timeout budget matches frontier assist (30s)', () => {
  assert.equal(DECOMPOSE_TIMEOUT_MS, 30_000)
})

test('AbortSignal.timeout aborts hung async work quickly', async () => {
  const started = Date.now()
  await assert.rejects(
    () =>
      new Promise<void>((_resolve, reject) => {
        const signal = AbortSignal.timeout(50)
        signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')))
      }),
  )
  assert.ok(Date.now() - started < 2_000)
})

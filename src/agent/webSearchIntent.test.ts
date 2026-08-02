import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NewFeatureDiscoveryGuard,
  StuckRecoveryGate,
  taskAddsNewFeature,
} from './taskIntent.ts'
import { classifyWebSearchIntent, taskNeedsWebSearch } from './webSearchIntent.ts'

test('keeps ordinary new-feature implementation local', () => {
  for (const task of [
    'we should allow drag and drop image support for our extension',
    'Add drag-and-drop uploads to the composer',
    'Implement image attachment support in this app',
    'Build a research panel in our extension',
  ]) {
    assert.equal(taskNeedsWebSearch(task), false, task)
    assert.equal(taskAddsNewFeature(task), true, task)
  }
})

test('allows explicit web research and current external facts', () => {
  for (const task of [
    'Search the web for the official VS Code drag and drop API docs',
    'Research browser drag and drop security restrictions',
    'What is the latest stable VS Code API version?',
    'Check the official documentation for DropEditProvider',
    'Find current vulnerability advisories for this dependency',
  ]) {
    assert.equal(taskNeedsWebSearch(task), true, task)
  }
})

test('does not mistake ambiguous repository phrases for web intent', () => {
  for (const task of [
    'Add web search support to this extension',
    'Fix the search component',
    'Implement a browse files button',
    'Update the current implementation',
    'Compare the two providers in this repo',
    'Look up the DropEditProvider symbol locally',
  ]) {
    assert.deepEqual(classifyWebSearchIntent(task), { allowed: false, reason: 'local-default' }, task)
  }
})

test('bounds nonexistent-feature searches and pivots to integration points', () => {
  const guard = new NewFeatureDiscoveryGuard(
    'we should allow drag and drop image support for our extension',
  )

  assert.equal(guard.beforeSearch('drag and drop image'), null)
  assert.match(
    guard.afterSearch('drag and drop image', 'No matches.'),
    /no existing implementation is expected/i,
  )
  assert.equal(guard.beforeSearch('drop event'), null)
  assert.match(
    guard.afterSearch('drop event', 'search_symbols "drop event": no declarations found'),
    /discovery is complete/i,
  )
  assert.match(guard.beforeSearch('drag') ?? '', /Skipped repeated feature-existence search/)

  for (const integrationQuery of ['composer', 'webview provider', 'message attachment input']) {
    assert.equal(guard.beforeSearch(integrationQuery), null, integrationQuery)
  }
})

test('deduplicates Hybrid recovery and stays local when Hybrid is disabled', () => {
  const gate = new StuckRecoveryGate()
  assert.equal(gate.claim(false), false)
  assert.equal(gate.claim(true), true)
  assert.equal(gate.claim(true), false)
  gate.reset()
  assert.equal(gate.claim(true), true)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { executeMultitaskTool, MultitaskBus } from './multitaskBus.ts'

test('first path claim wins; sibling is denied', () => {
  const bus = new MultitaskBus()
  const a = bus.claimPaths('a', 'Agent A', ['src/foo.ts', 'src/bar.ts'])
  assert.equal(a.ok, true)
  assert.deepEqual(a.claimed, ['src/foo.ts', 'src/bar.ts'])

  const b = bus.claimPaths('b', 'Agent B', ['src/foo.ts', 'src/baz.ts'])
  assert.equal(b.ok, false)
  assert.deepEqual(b.claimed, ['src/baz.ts'])
  assert.equal(b.denied.length, 1)
  assert.equal(b.denied[0]?.path, 'src/foo.ts')
  assert.equal(b.denied[0]?.ownerName, 'Agent A')

  assert.equal(bus.ownerOf('src/foo.ts', 'b')?.ownerName, 'Agent A')
  assert.equal(bus.ownerOf('src/foo.ts', 'a'), null)
  assert.equal(bus.ownerOf('src/baz.ts', 'a')?.ownerName, 'Agent B')
})

test('release_paths frees ownership for another sibling', () => {
  const bus = new MultitaskBus()
  bus.claimPaths('a', 'Agent A', ['src/foo.ts'])
  const released = bus.releasePaths('a', 'Agent A', ['src/foo.ts'])
  assert.deepEqual(released, ['src/foo.ts'])
  const b = bus.claimPaths('b', 'Agent B', ['src/foo.ts'])
  assert.equal(b.ok, true)
})

test('post_finding and read_sibling_updates exchange messages', () => {
  const bus = new MultitaskBus()
  const cursor = { value: 0 }
  const post = executeMultitaskTool(
    'post_finding',
    { text: 'Entry point is ChatViewProvider', paths: ['src/chat/ChatViewProvider.ts'] },
    { agentId: 'a', agentName: 'Architecture', bus, cursor },
  )
  assert.equal(post.ok, true)

  const read = executeMultitaskTool(
    'read_sibling_updates',
    { sinceId: 0 },
    { agentId: 'b', agentName: 'Implementation', bus, cursor: { value: 0 } },
  )
  assert.equal(read.ok, true)
  assert.match(read.result, /Architecture/)
  assert.match(read.result, /Entry point is ChatViewProvider/)
})

test('digest includes recent claims and findings', () => {
  const bus = new MultitaskBus()
  bus.claimPaths('a', 'Architecture', ['src/a.ts'])
  bus.post('finding', 'a', 'Architecture', 'Mapped the scheduler')
  const digest = bus.digest()
  assert.match(digest, /path_claim/)
  assert.match(digest, /Mapped the scheduler/)
})

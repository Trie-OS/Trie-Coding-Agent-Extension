import { beforeEach, afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { HookManager } from './hooks.ts'
import type { ToolCall } from './tools.ts'

describe('HookManager', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'trie-hooks-'))
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function writeHooks(payload: unknown): void {
    const file = path.join(root, '.trie-ide', 'hooks.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
  }

  const runCommandCall: ToolCall = {
    thought: 'test',
    tool: 'run_command',
    args: { command: 'npm test' },
  }

  it('rewrites args in pre-tool hooks', () => {
    writeHooks({
      preTool: [{ tool: 'run_command', rewriteArgs: { command: 'npm test -- --watch=false' } }],
    })
    const hooks = new HookManager(root)
    const pre = hooks.preTool(runCommandCall)
    assert.equal(pre.rewritten.args['command'], 'npm test -- --watch=false')
  })

  it('can replace output in post-tool hooks', () => {
    writeHooks({
      postTool: [{ tool: 'run_command', replaceOutput: 'sanitized output' }],
    })
    const hooks = new HookManager(root)
    const out = hooks.postTool(runCommandCall, { ok: true, result: 'raw', uiSummary: 'ok' })
    assert.equal(out.result, 'sanitized output')
  })

  it('can deny completion in post-agent hooks', () => {
    writeHooks({
      postAgent: [{ when: 'step_complete', deny: 'Need manual review' }],
    })
    const hooks = new HookManager(root)
    const verdict = hooks.postAgent('step_complete', 'done')
    assert.equal(verdict.denied, 'Need manual review')
  })
})

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AgentSession, type LoopEvents } from '../src/agent/loop.ts'
import type { FrontierAssist } from '../src/agent/frontierAssist.ts'
import type { GenerationParams, InferenceClient } from '../src/inference/types.ts'

interface SmokeTask {
  id: string
  prompt: string
  responses: string[]
  setup(root: string): void
  verify(root: string): boolean
}

const tasks: SmokeTask[] = [
  {
    id: 'read-edit-complete',
    prompt: 'Change the exported value in src/value.ts from 1 to 2.',
    responses: [
      '{"thought":"Read the target.","tool":"read_file","args":{"path":"src/value.ts"}}',
      '{"thought":"Apply the requested value.","tool":"edit_file","args":{"path":"src/value.ts","startLine":1,"endLine":1,"replace":"export const value = 2"}}',
      '{"thought":"Done.","tool":"step_complete","args":{"summary":"Changed value to 2."}}',
    ],
    setup(root) {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true })
      fs.writeFileSync(path.join(root, 'src/value.ts'), 'export const value = 1\n', 'utf8')
    },
    verify(root) {
      return fs.readFileSync(path.join(root, 'src/value.ts'), 'utf8').trim() === 'export const value = 2'
    },
  },
  {
    id: 'write-new-file',
    prompt: 'Create src/answer.ts exporting answer as 42.',
    responses: [
      '{"thought":"Create the requested module.","tool":"write_file","args":{"path":"src/answer.ts","content":"export const answer = 42\\n"}}',
      '{"thought":"Done.","tool":"step_complete","args":{"summary":"Created src/answer.ts."}}',
    ],
    setup(root) {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    },
    verify(root) {
      return fs.readFileSync(path.join(root, 'src/answer.ts'), 'utf8') === 'export const answer = 42\n'
    },
  },
]

function scriptedClient(responses: string[]): InferenceClient {
  let index = 0
  return {
    describe: () => 'scripted-coder',
    async generate(_turns, _params, onToken) {
      const text = responses[index++]
      if (!text) throw new Error(`Scripted model exhausted after ${index - 1} generations.`)
      onToken(text)
      return { text, tokensIn: 1, tokensOut: 1, truncated: false }
    },
  }
}

const frontier = {
  callsThisTurn: 0,
  resetTurn() {},
  enabled: () => false,
  getSkipReason: () => undefined,
} as unknown as FrontierAssist

const events: LoopEvents = {
  onGenerating() {},
  onToolCall() {},
  onToolResult() {},
  onTodos() {},
  onHybridChecking() {},
  onGuideNote() {},
}

const params: GenerationParams = { temperature: 0, topP: 1, maxTokens: 512 }
const results: Array<{ id: string; passed: boolean; detail: string }> = []

for (const task of tasks) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trie-extension-bench-'))
  try {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"' } }),
      'utf8',
    )
    task.setup(root)
    const session = new AgentSession(root, 'coding-smoke', frontier, {
      userPermissionsDir: path.join(root, '.permissions'),
    })
    session.permissions.rememberPath('.:typecheck', 'allow')
    const result = await session.runTurn(
      task.prompt,
      'code',
      scriptedClient(task.responses),
      params,
      20,
      events,
      new AbortController().signal,
    )
    const passed = result.ok && task.verify(root)
    results.push({ id: task.id, passed, detail: result.summary })
  } catch (error) {
    results.push({
      id: task.id,
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const passed = results.filter((result) => result.passed).length
console.log(JSON.stringify({ passed, total: results.length, results }, null, 2))
if (passed !== results.length) process.exitCode = 1


import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compileOpenAiTools, compileToolGrammar } from './toolGrammar.ts'
import type { ToolSpec } from './tools.ts'

function specs(...names: string[]): ToolSpec[] {
  return names.map((name) => ({ name, signature: '', description: '' }))
}

describe('compileToolGrammar', () => {
  it('constrains tool names and typed arguments', () => {
    const grammar = compileToolGrammar(specs('read_file', 'read_files', 'edit_file'))
    assert.match(grammar.label, /read_files/)
    assert.match(grammar.gbnf, /"\\"read_files\\""/)
    assert.match(grammar.gbnf, /"\\"paths\\""/)
    assert.match(grammar.gbnf, /\{0,7\}/)
    assert.match(grammar.gbnf, /"\\"startLine\\""/)
    assert.doesNotMatch(grammar.gbnf, /step_complete/)
  })

  it('supports empty control arguments', () => {
    const grammar = compileToolGrammar(specs('exit_plan_mode'))
    assert.match(grammar.gbnf, /"\{" space "\}" space/)
  })
})

describe('compileOpenAiTools', () => {
  it('uses the grammar IR as native function schemas', () => {
    const tools = compileOpenAiTools(specs('read_files', 'grep', 'step_complete'))
    assert.deepEqual(tools.map((tool) => tool.function.name), [
      'read_files',
      'grep',
      'step_complete',
    ])
    const readFiles = tools[0]!.function.parameters as {
      properties: { paths: { type: string; minItems: number; maxItems: number } }
      required: string[]
    }
    assert.deepEqual(readFiles.required, ['paths'])
    assert.equal(readFiles.properties.paths.type, 'array')
    assert.equal(readFiles.properties.paths.minItems, 1)
    assert.equal(readFiles.properties.paths.maxItems, 8)
  })

  it('preserves union argument shapes', () => {
    const [edit] = compileOpenAiTools(specs('edit_file'))
    const parameters = edit!.function.parameters as { oneOf: unknown[] }
    assert.equal(parameters.oneOf.length, 2)
  })
})

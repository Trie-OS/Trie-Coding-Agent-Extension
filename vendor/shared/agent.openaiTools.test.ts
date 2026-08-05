import { describe, expect, it } from 'vitest'
import { ForgeError } from './errors'
import {
  openaiToolDefinitions,
  parseOpenAiToolCalls,
  toolCallFromOpenAi,
  toolSpecs,
  type ToolName,
} from './agent'

describe('openaiToolDefinitions', () => {
  it('projects each tool into an OpenAI function definition', () => {
    const tools: ToolName[] = ['read_file', 'done_exploring', 'step_complete', 'step_failed']
    const defs = openaiToolDefinitions(tools)
    expect(defs.map((d) => d.function.name)).toEqual(tools)
    for (const def of defs) {
      expect(def.type).toBe('function')
      expect(def.function.description).toBe(toolSpecs[def.function.name].description)
      expect(def.function.parameters.type).toBe('object')
      expect(def.function.parameters.additionalProperties).toBe(false)
    }
  })

  it('marks required vs optional args from the IR', () => {
    const [read] = openaiToolDefinitions(['read_file'])
    expect(read!.function.parameters.required).toEqual(['path'])
    expect(read!.function.parameters.properties.path).toMatchObject({ type: 'string' })
    expect(read!.function.parameters.properties.startLine).toMatchObject({ type: 'integer' })
  })

  it('includes control tools so the loop can terminate', () => {
    const names = openaiToolDefinitions(['read_file', 'step_complete']).map((d) => d.function.name)
    expect(names).toContain('step_complete')
  })
})

describe('toolCallFromOpenAi / parseOpenAiToolCalls', () => {
  const allowed = ['read_file', 'step_complete', 'step_failed'] as const

  it('converts a valid OpenAI tool_calls entry into the internal ToolCall shape', () => {
    const call = toolCallFromOpenAi(
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"src/theme.ts","startLine":1}' },
      },
      allowed,
      'inspect the theme',
    )
    expect(call).toEqual({
      thought: 'inspect the theme',
      tool: 'read_file',
      args: { path: 'src/theme.ts', startLine: 1 },
    })
  })

  it('defaults thought when the assistant content is empty', () => {
    const call = toolCallFromOpenAi(
      {
        function: { name: 'step_complete', arguments: '{"summary":"done"}' },
      },
      allowed,
      '   ',
    )
    expect(call.thought).toBe('Function call')
    expect(call.tool).toBe('step_complete')
  })

  it('rejects unknown tools, bad args, and malformed argument JSON', () => {
    expect(() =>
      toolCallFromOpenAi({ function: { name: 'delete_repo', arguments: '{}' } }, allowed),
    ).toThrowError(expect.objectContaining({ code: 'TOOL_UNKNOWN' }) as unknown as ForgeError)

    expect(() =>
      toolCallFromOpenAi({ function: { name: 'read_file', arguments: '{"path":7}' } }, allowed),
    ).toThrowError(expect.objectContaining({ code: 'TOOL_ARGS_INVALID' }) as unknown as ForgeError)

    expect(() =>
      toolCallFromOpenAi({ function: { name: 'read_file', arguments: '{"path":' } }, allowed),
    ).toThrowError(
      expect.objectContaining({
        code: 'TOOL_CALL_MALFORMED',
        details: expect.objectContaining({ truncated: true }),
      }) as unknown as ForgeError,
    )
  })

  it('parses multiple tool calls', () => {
    expect(() => parseOpenAiToolCalls([], allowed)).toThrowError(
      expect.objectContaining({ code: 'TOOL_CALL_MALFORMED' }) as unknown as ForgeError,
    )
    const calls = parseOpenAiToolCalls(
      [
        { function: { name: 'read_file', arguments: '{"path":"a"}' } },
        { function: { name: 'step_complete', arguments: '{"summary":"s"}' } },
      ],
      allowed,
    )
    expect(calls).toHaveLength(2)
    expect(calls[0]!.tool).toBe('read_file')
    expect(calls[1]!.tool).toBe('step_complete')
  })
})

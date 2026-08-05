import type { ToolSpec } from './tools'
import type { OpenAiToolDefinition } from '../inference/types'

type JsonIr =
  | { kind: 'string'; minLength?: number; maxLength?: number }
  | { kind: 'integer' }
  | { kind: 'boolean' }
  | { kind: 'const'; value: string }
  | { kind: 'enum'; values: string[] }
  | { kind: 'array'; items: JsonIr; minItems?: number; maxItems?: number }
  | { kind: 'object'; props: Array<{ name: string; schema: JsonIr; optional?: boolean }> }
  | { kind: 'union'; variants: JsonIr[] }

const string: JsonIr = { kind: 'string' }
const integer: JsonIr = { kind: 'integer' }
const boolean: JsonIr = { kind: 'boolean' }
const strings = (minItems = 0, maxItems?: number): JsonIr => ({
  kind: 'array',
  items: string,
  minItems,
  maxItems,
})
const object = (
  props: Array<{ name: string; schema: JsonIr; optional?: boolean }>,
): JsonIr => ({ kind: 'object', props })

const TOOL_ARGS: Record<string, JsonIr> = {
  read_file: {
    kind: 'union',
    variants: [
      object([{ name: 'path', schema: string }]),
      object([
        { name: 'path', schema: string },
        { name: 'startLine', schema: integer },
        { name: 'endLine', schema: integer },
      ]),
    ],
  },
  read_files: object([{ name: 'paths', schema: strings(1, 8) }]),
  list_dir: object([{ name: 'path', schema: string }]),
  glob: object([{ name: 'pattern', schema: string }]),
  grep: object([
    { name: 'pattern', schema: string },
    { name: 'glob', schema: string, optional: true },
  ]),
  search_symbols: object([{ name: 'query', schema: string }]),
  edit_file: {
    kind: 'union',
    variants: [
      object([
        { name: 'path', schema: string },
        { name: 'replace', schema: string },
        { name: 'startLine', schema: integer },
        { name: 'endLine', schema: integer },
      ]),
      object([
        { name: 'path', schema: string },
        { name: 'replace', schema: string },
        { name: 'search', schema: string },
      ]),
    ],
  },
  web_search: object([{ name: 'query', schema: string }]),
  write_file: object([
    { name: 'path', schema: string },
    { name: 'content', schema: string },
  ]),
  run_command: object([{ name: 'command', schema: string }]),
  ask_user_question: object([
    {
      name: 'questions',
      schema: {
        kind: 'array',
        minItems: 1,
        maxItems: 4,
        items: object([
          { name: 'question', schema: string },
          { name: 'options', schema: strings(2) },
          { name: 'multiSelect', schema: boolean, optional: true },
        ]),
      },
    },
  ]),
  run_verification: {
    kind: 'union',
    variants: [
      object([
        { name: 'packagePath', schema: string, optional: true },
        { name: 'script', schema: string },
        { name: 'args', schema: strings(), optional: true },
        { name: 'artifactPaths', schema: strings(), optional: true },
      ]),
      object([{ name: 'skipReason', schema: string }]),
    ],
  },
  update_plan: object([{ name: 'content', schema: string }]),
  exit_plan_mode: object([]),
  update_todos: object([
    { name: 'todo', schema: strings() },
    { name: 'done', schema: strings(), optional: true },
  ]),
  step_complete: object([{ name: 'summary', schema: string }]),
  step_failed: object([{ name: 'reason', schema: string }]),
  post_finding: object([
    { name: 'text', schema: string },
    { name: 'paths', schema: strings(), optional: true },
  ]),
  read_sibling_updates: object([{ name: 'sinceId', schema: integer, optional: true }]),
  claim_paths: object([{ name: 'paths', schema: strings(1) }]),
  release_paths: object([{ name: 'paths', schema: strings(1) }]),
}

function jsonSchema(ir: JsonIr): Record<string, unknown> {
  switch (ir.kind) {
    case 'string':
      return {
        type: 'string',
        ...(ir.minLength !== undefined ? { minLength: ir.minLength } : {}),
        ...(ir.maxLength !== undefined ? { maxLength: ir.maxLength } : {}),
      }
    case 'integer':
      return { type: 'integer' }
    case 'boolean':
      return { type: 'boolean' }
    case 'const':
      return { type: 'string', const: ir.value }
    case 'enum':
      return { type: 'string', enum: ir.values }
    case 'array':
      return {
        type: 'array',
        items: jsonSchema(ir.items),
        ...(ir.minItems !== undefined ? { minItems: ir.minItems } : {}),
        ...(ir.maxItems !== undefined ? { maxItems: ir.maxItems } : {}),
      }
    case 'union':
      return { oneOf: ir.variants.map(jsonSchema) }
    case 'object': {
      const required = ir.props.filter((prop) => !prop.optional).map((prop) => prop.name)
      return {
        type: 'object',
        properties: Object.fromEntries(
          ir.props.map((prop) => [prop.name, jsonSchema(prop.schema)]),
        ),
        required,
        additionalProperties: false,
      }
    }
  }
}

/** Native function-calling definitions generated from the same IR as daemon GBNF. */
export function compileOpenAiTools(tools: readonly ToolSpec[]): OpenAiToolDefinition[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: jsonSchema(TOOL_ARGS[tool.name] ?? object([])),
    },
  }))
}

function gbnfLiteral(value: string): string {
  let out = '"'
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (code < 0x20) out += `\\x${code.toString(16).padStart(2, '0')}`
    else out += ch
  }
  return `${out}"`
}

function jsonStringLiteral(value: string): string {
  return gbnfLiteral(JSON.stringify(value))
}

class Compiler {
  private readonly rules: string[] = []
  private readonly memo = new Map<string, string>()
  private counter = 0

  private define(hint: string, body: string): string {
    const existing = this.memo.get(body)
    if (existing) return existing
    const name = `${hint}-${++this.counter}`
    this.memo.set(body, name)
    this.rules.push(`${name} ::= ${body}`)
    return name
  }

  compile(ir: JsonIr): string {
    switch (ir.kind) {
      case 'string': {
        if (ir.maxLength === undefined) return 'string'
        return this.define(
          'str',
          `"\\"" char{${ir.minLength ?? 0},${ir.maxLength}} "\\"" space`,
        )
      }
      case 'integer':
        return 'integer'
      case 'boolean':
        return 'boolean'
      case 'const':
        return this.define('const', `${jsonStringLiteral(ir.value)} space`)
      case 'enum':
        return this.define(
          'enum',
          `(${ir.values.map(jsonStringLiteral).join(' | ')}) space`,
        )
      case 'array': {
        const item = this.compile(ir.items)
        const min = ir.minItems ?? 0
        const max = ir.maxItems
        if (max !== undefined) {
          if (max < min) throw new Error('Invalid bounded array grammar.')
          const tail = `("," space ${item}){${Math.max(0, min - 1)},${max - 1}}`
          return this.define(
            'array',
            min > 0
              ? `"[" space ${item} ${tail} "]" space`
              : `"[" space (${item} ("," space ${item}){0,${max - 1}})? "]" space`,
          )
        }
        const requiredTail =
          min > 1 ? `("," space ${item}){${min - 1}}` : ''
        const tail = `("," space ${item})*`
        return this.define(
          'array',
          min > 0
            ? `"[" space ${item}${requiredTail ? ` ${requiredTail}` : ''} ${tail} "]" space`
            : `"[" space (${item} ${tail})? "]" space`,
        )
      }
      case 'union':
        return this.define('union', ir.variants.map((variant) => this.compile(variant)).join(' | '))
      case 'object': {
        const required = ir.props.filter((prop) => !prop.optional)
        const optional = ir.props.filter((prop) => prop.optional)
        const variants = 2 ** optional.length
        const bodies: string[] = []
        for (let mask = 0; mask < variants; mask++) {
          const selected = ir.props.filter(
            (prop) => !prop.optional || Boolean(mask & (1 << optional.indexOf(prop))),
          )
          if (required.some((prop) => !selected.includes(prop))) continue
          const fields = selected.map(
            (prop) =>
              `${jsonStringLiteral(prop.name)} space ":" space ${this.compile(prop.schema)}`,
          )
          const inside = fields.join(' "," space ')
          bodies.push(`"{" space${inside ? ` ${inside} ` : ' '}"}" space`)
        }
        return this.define('obj', bodies.length === 1 ? bodies[0]! : `(${bodies.join(' | ')})`)
      }
    }
  }

  finish(root: string): string {
    const prelude = [
      'space ::= | " " | "\\n" [ \\t]{0,20}',
      'char ::= [^"\\\\\\x7F\\x00-\\x1F] | "\\\\" (["\\\\bfnrt/] | "u" [0-9a-fA-F]{4})',
      'string ::= "\\"" char* "\\"" space',
      'integer ::= ("-"? ([0-9] | [1-9] [0-9]{0,15})) space',
      'boolean ::= ("true" | "false") space',
    ]
    return [`root ::= ${root}`, ...this.rules, ...prelude].join('\n')
  }
}

export function compileToolGrammar(tools: readonly ToolSpec[]): {
  label: string
  gbnf: string
} {
  if (tools.length === 0) throw new Error('Cannot compile an empty tool grammar.')
  const variants = tools.map<JsonIr>((tool) =>
    object([
      { name: 'thought', schema: { kind: 'string', minLength: 1, maxLength: 300 } },
      { name: 'tool', schema: { kind: 'const', value: tool.name } },
      { name: 'args', schema: TOOL_ARGS[tool.name] ?? object([]) },
    ]),
  )
  const compiler = new Compiler()
  const root = compiler.compile(
    variants.length === 1 ? variants[0]! : { kind: 'union', variants },
  )
  return {
    label: `tool-call(${tools.map((tool) => tool.name).join('|')})`,
    gbnf: compiler.finish(root),
  }
}

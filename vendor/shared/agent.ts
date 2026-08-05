/**
 * Agent vocabulary shared by main, preload and renderer (PLANNING-MODE.md).
 *
 * Three things live here because all three processes need them:
 *
 *  1. **The tool catalogue** — names, human descriptions, and the JSON-IR
 *     description of each tool's arguments. The IR is the *single* source for
 *     both the GBNF grammar (shared/gbnf.ts) and runtime validation, so a
 *     grammar-legal emission is by construction an args-valid emission. There
 *     is no second hand-written schema to drift.
 *  2. **The plan artifact schema** — same IR, so the plan grammar is compiled
 *     from the same description the parser validates against.
 *  3. **Wire shapes** for plans, steps, checkpoints and tool calls.
 *
 * Fail-loudly note: nothing in here coerces. `parseToolCall` and
 * `parsePlanArtifact` either return a fully typed value or throw a
 * `ForgeError`. A model that somehow emits something out of grammar (an
 * unconstrained provider, a truncated stream) produces a loud
 * `TOOL_CALL_MALFORMED` / `PLAN_ARTIFACT_INVALID`, never a partially-filled
 * object.
 */
import { z } from 'zod'
import { ForgeError } from './errors'

z.config({ jitless: true })

/* ── JSON IR ──────────────────────────────────────────────────────────────
 * A deliberately tiny subset of JSON Schema: enough to describe every tool
 * argument list and the plan artifact, small enough that the GBNF compiler is
 * a hundred lines and fully testable. Adding a case here means adding a case
 * to the compiler and to `irToZod` — both are exhaustive switches, so the
 * compiler tells you.
 */
export type JsonIr =
  | { kind: 'string'; description?: string; minLength?: number; maxLength?: number }
  | { kind: 'integer'; description?: string; min?: number }
  | { kind: 'boolean'; description?: string }
  | { kind: 'enum'; values: readonly string[]; description?: string }
  | { kind: 'const'; value: string }
  | { kind: 'array'; items: JsonIr; minItems?: number; description?: string }
  | { kind: 'object'; props: readonly IrProp[]; description?: string }
  | { kind: 'union'; variants: readonly JsonIr[] }

/**
 * Hard caps on large tool-call strings.
 *
 * Unbounded `search` / `replace` / `content` let a local model spend the whole
 * `maxTokens` budget inside one JSON string; llama.cpp then stops mid-emit and
 * the grammar cannot finish the object. Caps keep a complete envelope
 * samplable within the default token budget.
 */
export const TOOL_STRING_LIMITS = {
  thought: 400,
  search: 1600,
  replace: 3200,
  content: 6000,
  prompt: 2000,
} as const

export interface IrProp {
  name: string
  schema: JsonIr
  /** Optional properties are emitted as ordered optional suffixes in GBNF. */
  optional?: boolean
}

/** Build a zod validator from the same IR the grammar is compiled from. */
export function irToZod(ir: JsonIr): z.ZodType {
  switch (ir.kind) {
    case 'string': {
      let schema = z.string()
      if (ir.minLength !== undefined) schema = schema.min(ir.minLength)
      if (ir.maxLength !== undefined) schema = schema.max(ir.maxLength)
      return schema
    }
    case 'integer': {
      const base = z.number().int()
      return ir.min !== undefined ? base.min(ir.min) : base
    }
    case 'boolean':
      return z.boolean()
    case 'enum':
      return z.enum([...ir.values] as [string, ...string[]])
    case 'const':
      return z.literal(ir.value)
    case 'array': {
      const base = z.array(irToZod(ir.items))
      return ir.minItems !== undefined ? base.min(ir.minItems) : base
    }
    case 'object': {
      const shape: Record<string, z.ZodType> = {}
      for (const prop of ir.props) {
        shape[prop.name] = prop.optional ? irToZod(prop.schema).optional() : irToZod(prop.schema)
      }
      // strict(): a key the grammar cannot produce must not be silently kept.
      return z.strictObject(shape)
    }
    case 'union': {
      const variants = ir.variants.map(irToZod)
      if (variants.length < 2) {
        throw new ForgeError('GRAMMAR_COMPILE_FAILED', 'A union IR needs at least two variants.')
      }
      return z.union(variants as [z.ZodType, z.ZodType, ...z.ZodType[]])
    }
  }
}

/* ── Tool catalogue (PLANNING-MODE.md §"Tool definitions (v1)") ─────────── */

export const readToolNames = [
  'read_file',
  'read_files',
  'list_dir',
  'grep',
  'glob',
  'outline',
  'search_symbols',
] as const
/**
 * Internet search. Kept out of `readToolNames` because it is only offered
 * when the user has configured a provider — `toolsForPhase` appends it, so an
 * unconfigured install never wastes grammar space (or model calls) on it.
 */
export const webToolNames = ['web_search'] as const
export const writeToolNames = ['edit_file', 'write_file', 'run_command'] as const
/** Checklist + background-task tools (Cursor TodoWrite / Task workflow). */
export const metaToolNames = ['update_todos', 'spawn_task'] as const
/** Control emissions: how the model ends a turn. Not filesystem tools. */
export const controlToolNames = ['done_exploring', 'step_complete', 'step_failed'] as const

export const toolNames = [
  ...readToolNames,
  ...webToolNames,
  ...writeToolNames,
  ...metaToolNames,
  ...controlToolNames,
] as const
export type ToolName = (typeof toolNames)[number]

export interface ToolSpec {
  name: ToolName
  /** One line, shown to the model in the system prompt and to the user in the UI. */
  description: string
  args: Extract<JsonIr, { kind: 'object' }>
  /** Control tools produce no filesystem effect and terminate the loop. */
  control: boolean
  /** Write tools are only offered during Act. */
  mutating: boolean
}

const relPathArg: JsonIr = {
  kind: 'string',
  minLength: 1,
  description: 'Workspace-relative POSIX path.',
}

export const toolSpecs: Readonly<Record<ToolName, ToolSpec>> = {
  read_file: {
    name: 'read_file',
    description:
      'Read a text file, returning numbered lines. Defaults to the first 300 lines; pass startLine/endLine for a window.',
    control: false,
    mutating: false,
    args: {
      kind: 'object',
      props: [
        { name: 'path', schema: relPathArg },
        { name: 'startLine', schema: { kind: 'integer', min: 1 }, optional: true },
        { name: 'endLine', schema: { kind: 'integer', min: 1 }, optional: true },
      ],
    },
  },
  read_files: {
    name: 'read_files',
    description:
      'Read several related files in ONE call (first 300 lines of each, sharing one result budget). Prefer this over a chain of read_file calls when exploring; up to 8 paths per call.',
    control: false,
    mutating: false,
    args: {
      kind: 'object',
      props: [
        {
          name: 'paths',
          schema: {
            kind: 'array',
            items: relPathArg,
            minItems: 1,
            description: 'Workspace-relative POSIX paths, up to 8 per call.',
          },
        },
      ],
    },
  },
  list_dir: {
    name: 'list_dir',
    description:
      "List a directory's contents, .gitignore-filtered. Use '' for the workspace root; depth defaults to 1.",
    control: false,
    mutating: false,
    args: {
      kind: 'object',
      props: [
        { name: 'path', schema: { kind: 'string', description: relPathArg.description } },
        { name: 'depth', schema: { kind: 'integer', min: 1 }, optional: true },
      ],
    },
  },
  grep: {
    name: 'grep',
    description:
      'Search file contents with a regular expression (ripgrep). Simple identifiers also check the workspace symbol trie first. Capped at 50 matches.',
    control: false,
    mutating: false,
    args: {
      kind: 'object',
      props: [
        { name: 'pattern', schema: { kind: 'string', minLength: 1 } },
        { name: 'glob', schema: { kind: 'string', minLength: 1 }, optional: true },
      ],
    },
  },
  glob: {
    name: 'glob',
    description: 'Find files by name pattern, e.g. "src/**/*.tsx". Respects .gitignore.',
    control: false,
    mutating: false,
    args: {
      kind: 'object',
      props: [{ name: 'pattern', schema: { kind: 'string', minLength: 1 } }],
    },
  },
  outline: {
    name: 'outline',
    description: 'List the symbols (functions, classes, exports) declared in a file, with lines.',
    control: false,
    mutating: false,
    args: { kind: 'object', props: [{ name: 'path', schema: relPathArg }] },
  },
  search_symbols: {
    name: 'search_symbols',
    description:
      'Fast workspace symbol lookup via a prefix trie index. Use to find where a function, class, or type is declared before grepping for usages.',
    control: false,
    mutating: false,
    args: {
      kind: 'object',
      props: [{ name: 'query', schema: { kind: 'string', minLength: 1 } }],
    },
  },
  web_search: {
    name: 'web_search',
    description:
      'Search the internet. Returns titles, URLs, and snippets. Use for research papers, current docs, APIs, libraries, blog posts, or error messages — anything not in the repo.',
    control: false,
    mutating: false,
    args: {
      kind: 'object',
      props: [
        {
          name: 'query',
          schema: { kind: 'string', minLength: 1, maxLength: TOOL_STRING_LIMITS.thought },
        },
      ],
    },
  },
  edit_file: {
    name: 'edit_file',
    description:
      'Edit a file. Preferred: startLine/endLine + replace after read_file (no retyping bytes). Alternate: short unique search + replace. On search mismatch the tool shows nearest lines and the durable startLine/endLine retry.',
    control: false,
    mutating: true,
    args: {
      kind: 'object',
      props: [
        { name: 'path', schema: relPathArg },
        {
          name: 'replace',
          schema: { kind: 'string', maxLength: TOOL_STRING_LIMITS.replace },
        },
        {
          name: 'search',
          schema: {
            kind: 'string',
            minLength: 1,
            maxLength: TOOL_STRING_LIMITS.search,
          },
          optional: true,
        },
        { name: 'startLine', schema: { kind: 'integer', min: 1 }, optional: true },
        { name: 'endLine', schema: { kind: 'integer', min: 1 }, optional: true },
      ],
    },
  },
  write_file: {
    name: 'write_file',
    description:
      'Create a new file or fully rewrite a small one (< 200 lines). Prefer edit_file for existing files. Keep content compact — large rewrites blow the token budget.',
    control: false,
    mutating: true,
    args: {
      kind: 'object',
      props: [
        { name: 'path', schema: relPathArg },
        {
          name: 'content',
          schema: { kind: 'string', maxLength: TOOL_STRING_LIMITS.content },
        },
      ],
    },
  },
  run_command: {
    name: 'run_command',
    description:
      'Run a shell command in the workspace. Always requires the user to approve it first.',
    control: false,
    mutating: true,
    args: {
      kind: 'object',
      props: [
        { name: 'command', schema: { kind: 'string', minLength: 1 } },
        { name: 'cwd', schema: { kind: 'string' }, optional: true },
      ],
    },
  },
  update_todos: {
    name: 'update_todos',
    description:
      'Create or update the to-do checklist for this turn. Pass every open item in `todo` and every finished item in `done`. Call when you start a multi-step task and whenever progress changes.',
    control: false,
    mutating: false,
    args: {
      kind: 'object',
      props: [
        {
          name: 'todo',
          schema: {
            kind: 'array',
            minItems: 1,
            items: { kind: 'string', minLength: 1 },
            description: 'Open checklist items, short phrases.',
          },
        },
        {
          name: 'done',
          schema: {
            kind: 'array',
            items: { kind: 'string', minLength: 1 },
            description: 'Completed checklist items.',
          },
          optional: true,
        },
      ],
    },
  },
  spawn_task: {
    name: 'spawn_task',
    description:
      'Delegate a focused research or exploration subtask to a background agent. Returns immediately; the subagent runs when the model is free. Use for parallel investigation — do your own file edits in this turn.',
    control: false,
    mutating: false,
    args: {
      kind: 'object',
      props: [
        {
          name: 'title',
          schema: { kind: 'string', minLength: 1, description: 'Short card title for the UI.' },
        },
        {
          name: 'prompt',
          schema: {
            kind: 'string',
            minLength: 1,
            maxLength: TOOL_STRING_LIMITS.prompt,
            description: 'Full instructions for the background agent.',
          },
        },
      ],
    },
  },
  done_exploring: {
    name: 'done_exploring',
    description: 'Stop exploring — you have read enough to write the plan.',
    control: true,
    mutating: false,
    args: {
      kind: 'object',
      props: [{ name: 'summary', schema: { kind: 'string', minLength: 1 } }],
    },
  },
  step_complete: {
    name: 'step_complete',
    description:
      'Default way to finish — declare the task done and summarize what you changed or answered.',
    control: true,
    mutating: false,
    args: {
      kind: 'object',
      props: [{ name: 'summary', schema: { kind: 'string', minLength: 1 } }],
    },
  },
  step_failed: {
    name: 'step_failed',
    description:
      'LAST RESORT ONLY. Use only when genuinely blocked: missing credentials or API keys, permission denied, destructive ambiguity (would delete unrelated work), or hard impossibility (required file missing). NEVER for unspecified details, unclear requirements, or minor ambiguity — pick a reasonable default and call step_complete instead.',
    control: true,
    mutating: false,
    args: { kind: 'object', props: [{ name: 'reason', schema: { kind: 'string', minLength: 1 } }] },
  },
}

/** Patterns in step_failed reasons that indicate the model gave up prematurely. */
const PREMATURE_STEP_FAILED_PATTERN =
  /\b(ambiguous|unclear|unspecified|not\s+specified|clarification|need\s+(more\s+)?(info|information|details|context)|more\s+(info|information|details)|ask\s+(the\s+)?user|user\s+should|which\s+(one|option)|not\s+sure\s+(which|what|how)|cannot\s+determine|can't\s+determine|without\s+knowing|need\s+to\s+know|unsure\s+(about|what|which|how)|lack(?:s|ing)?(?:\s+of)?\s+(?:info|information|details|context)|uncertain|vague|under[- ]?specified)\b/i

/** True when a step_failed reason looks like ambiguity/clarification rather than a real blocker. */
export function isPrematureStepFailedReason(reason: string): boolean {
  return PREMATURE_STEP_FAILED_PATTERN.test(reason.trim())
}

/**
 * The tool-call envelope IR for a given tool subset.
 *
 * `thought` is **required**, and deliberately so: forcing one sentence of
 * rationale before the call measurably steadies small models, and keeping
 * every envelope property required keeps the compiled grammar unambiguous.
 * Property order in the grammar is the order here — thought, then tool, then
 * args — so the rationale is generated *before* the call it justifies.
 */
export function toolCallEnvelopeIr(tools: readonly ToolName[]): JsonIr {
  if (tools.length === 0) {
    throw new ForgeError('GRAMMAR_COMPILE_FAILED', 'A tool grammar needs at least one tool.')
  }
  const variants = tools.map<JsonIr>((name) => ({
    kind: 'object',
    props: [
      {
        name: 'thought',
        schema: {
          kind: 'string',
          minLength: 1,
          maxLength: TOOL_STRING_LIMITS.thought,
        },
      },
      { name: 'tool', schema: { kind: 'const', value: name } },
      { name: 'args', schema: toolSpecs[name].args },
    ],
  }))
  const [first] = variants
  if (first === undefined) {
    throw new ForgeError('GRAMMAR_COMPILE_FAILED', 'A tool grammar needs at least one tool.')
  }
  return variants.length === 1 ? first : { kind: 'union', variants }
}

export interface ToolCall<N extends ToolName = ToolName> {
  thought: string
  tool: N
  args: Record<string, unknown>
}

/** True when a JSON.parse failure looks like the emission was cut mid-stream. */
export function isIncompleteJsonError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Unterminated string|Unexpected end of JSON|Expected .* after/i.test(message)
}

/**
 * Best-effort close of a truncated JSON value: finish an open string and any
 * unmatched `{` / `[`. Returns null when the prefix is not salvageable.
 *
 * Used only as a recovery path when the model hit max-tokens mid-envelope;
 * the repaired value still goes through the normal zod validators.
 */
export function tryCloseTruncatedJson(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  const start = trimmed[0]
  if (start !== '{' && start !== '[') return null

  let inString = false
  let escape = false
  const stack: string[] = []

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!
    if (inString) {
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\') {
        escape = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') {
      if (stack[stack.length - 1] !== ch) return null
      stack.pop()
    }
  }

  let repaired = trimmed
  if (escape) repaired = repaired.slice(0, -1)
  if (inString) repaired += '"'
  while (stack.length > 0) repaired += stack.pop()

  try {
    JSON.parse(repaired)
    return repaired
  } catch {
    return null
  }
}

const INCOMPLETE_JSON_HINT =
  'The model returned incomplete JSON; try a smaller request or increase max tokens.'

/**
 * Parse a model emission into a validated tool call.
 *
 * Under a compiled grammar this never fails for a *complete* emission; the
 * paths that reject are a provider that ignored the grammar, or a stream
 * truncated by max-tokens (grammar cannot finish an object once sampling stops).
 */
export function parseToolCall(raw: string, allowed: readonly ToolName[]): ToolCall {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    const incomplete = isIncompleteJsonError(error)
    throw new ForgeError(
      'TOOL_CALL_MALFORMED',
      incomplete
        ? `${INCOMPLETE_JSON_HINT} (${error instanceof Error ? error.message : String(error)})`
        : `Model emission is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { raw: raw.slice(0, 2000), truncated: incomplete },
    )
  }
  const envelope = z
    .object({ thought: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()) })
    .safeParse(json)
  if (!envelope.success) {
    throw new ForgeError('TOOL_CALL_MALFORMED', 'Model emission is not a {thought, tool, args}.', {
      raw: raw.slice(0, 2000),
      issues: z.prettifyError(envelope.error),
    })
  }
  const { thought, tool, args } = envelope.data
  return validateToolCall(thought, tool, args, allowed)
}

function validateToolCall(
  thought: string,
  tool: string,
  args: Record<string, unknown>,
  allowed: readonly ToolName[],
): ToolCall {
  if (!allowed.includes(tool as ToolName)) {
    throw new ForgeError(
      'TOOL_UNKNOWN',
      `Model called "${tool}", which is not available in this phase. Available: ${allowed.join(', ')}.`,
      { tool, allowed },
    )
  }
  const name = tool as ToolName
  const parsedArgs = irToZod(toolSpecs[name].args).safeParse(args)
  if (!parsedArgs.success) {
    throw new ForgeError('TOOL_ARGS_INVALID', `Invalid arguments for ${name}.`, {
      tool: name,
      issues: z.prettifyError(parsedArgs.error),
    })
  }
  return { thought, tool: name, args: parsedArgs.data as Record<string, unknown> }
}

/* ── OpenAI function-calling bridge (API providers) ───────────────────────
 * Local/remote providers constrain tool calls with GBNF. Hosted OpenAI-
 * compatible APIs (Kimi, opencodex, …) instead take `tools` / `tool_calls`.
 * The IR stays the single source of truth: we project it to JSON Schema for
 * the request, then validate the response args with the same zod path.
 */

/** Minimal JSON Schema subset emitted for OpenAI `function.parameters`. */
export type JsonSchema =
  | { type: 'string'; description?: string; minLength?: number; maxLength?: number }
  | { type: 'integer'; description?: string; minimum?: number }
  | { type: 'boolean'; description?: string }
  | { type: 'string'; enum: string[]; description?: string }
  | { const: string; description?: string }
  | {
      type: 'array'
      items: JsonSchema
      minItems?: number
      description?: string
    }
  | {
      type: 'object'
      properties: Record<string, JsonSchema>
      required: string[]
      additionalProperties: false
      description?: string
    }
  | { anyOf: JsonSchema[]; description?: string }

/** Convert our JSON-IR into an OpenAI-compatible JSON Schema fragment. */
export function irToJsonSchema(ir: JsonIr): JsonSchema {
  switch (ir.kind) {
    case 'string': {
      const schema: Extract<JsonSchema, { type: 'string' }> = { type: 'string' }
      if (ir.description !== undefined) schema.description = ir.description
      if (ir.minLength !== undefined) schema.minLength = ir.minLength
      if (ir.maxLength !== undefined) schema.maxLength = ir.maxLength
      return schema
    }
    case 'integer': {
      const schema: Extract<JsonSchema, { type: 'integer' }> = { type: 'integer' }
      if (ir.description !== undefined) schema.description = ir.description
      if (ir.min !== undefined) schema.minimum = ir.min
      return schema
    }
    case 'boolean': {
      const schema: Extract<JsonSchema, { type: 'boolean' }> = { type: 'boolean' }
      if (ir.description !== undefined) schema.description = ir.description
      return schema
    }
    case 'enum': {
      const schema: Extract<JsonSchema, { enum: string[] }> = {
        type: 'string',
        enum: [...ir.values],
      }
      if (ir.description !== undefined) schema.description = ir.description
      return schema
    }
    case 'const':
      return { const: ir.value }
    case 'array': {
      const schema: Extract<JsonSchema, { type: 'array' }> = {
        type: 'array',
        items: irToJsonSchema(ir.items),
      }
      if (ir.description !== undefined) schema.description = ir.description
      if (ir.minItems !== undefined) schema.minItems = ir.minItems
      return schema
    }
    case 'object': {
      const properties: Record<string, JsonSchema> = {}
      const required: string[] = []
      for (const prop of ir.props) {
        properties[prop.name] = irToJsonSchema(prop.schema)
        if (!prop.optional) required.push(prop.name)
      }
      const schema: Extract<JsonSchema, { type: 'object' }> = {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      }
      if (ir.description !== undefined) schema.description = ir.description
      return schema
    }
    case 'union': {
      if (ir.variants.length < 2) {
        throw new ForgeError('GRAMMAR_COMPILE_FAILED', 'A union IR needs at least two variants.')
      }
      return { anyOf: ir.variants.map(irToJsonSchema) }
    }
  }
}

/** OpenAI chat-completions `tools[]` entry (`type: "function"`). */
export interface OpenAiToolDefinition {
  type: 'function'
  function: {
    name: ToolName
    description: string
    parameters: Extract<JsonSchema, { type: 'object' }>
  }
}

/** One element of an OpenAI `message.tool_calls` array. */
export interface OpenAiToolCall {
  id?: string
  type?: 'function' | string
  function: {
    name: string
    /** JSON-encoded argument object. */
    arguments: string
  }
}

/**
 * Project a tool subset into OpenAI function definitions.
 *
 * Control tools (`done_exploring`, `step_complete`, `step_failed`) are included
 * so the API path can terminate the loop the same way the GBNF path does.
 */
export function openaiToolDefinitions(tools: readonly ToolName[]): OpenAiToolDefinition[] {
  if (tools.length === 0) {
    throw new ForgeError('GRAMMAR_COMPILE_FAILED', 'A tool list needs at least one tool.')
  }
  return tools.map((name) => {
    const spec = toolSpecs[name]
    const parameters = irToJsonSchema(spec.args)
    if (!('type' in parameters) || parameters.type !== 'object') {
      throw new ForgeError(
        'GRAMMAR_COMPILE_FAILED',
        `Tool ${name} args IR did not project to a JSON Schema object.`,
      )
    }
    return {
      type: 'function' as const,
      function: {
        name,
        description: spec.description,
        parameters,
      },
    }
  })
}

/**
 * Convert one OpenAI `tool_calls[]` entry into the internal `ToolCall` shape.
 *
 * `thought` is not part of the OpenAI function protocol; callers typically pass
 * the assistant message `content` (when present) or a short placeholder.
 */
export function toolCallFromOpenAi(
  call: OpenAiToolCall,
  allowed: readonly ToolName[],
  thought = 'Function call',
): ToolCall {
  const name = call.function?.name
  if (typeof name !== 'string' || name.length === 0) {
    throw new ForgeError('TOOL_CALL_MALFORMED', 'OpenAI tool call is missing function.name.', {
      call,
    })
  }
  const rawArgs = call.function.arguments
  let args: unknown
  try {
    args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs
  } catch (error) {
    const incomplete = isIncompleteJsonError(error)
    throw new ForgeError(
      'TOOL_CALL_MALFORMED',
      incomplete
        ? `${INCOMPLETE_JSON_HINT} (${error instanceof Error ? error.message : String(error)})`
        : `OpenAI tool call arguments are not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
      { tool: name, raw: String(rawArgs).slice(0, 2000), truncated: incomplete },
    )
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new ForgeError(
      'TOOL_CALL_MALFORMED',
      'OpenAI tool call arguments must be a JSON object.',
      {
        tool: name,
        raw: String(rawArgs).slice(0, 2000),
      },
    )
  }
  const trimmedThought = thought.trim() || 'Function call'
  return validateToolCall(
    trimmedThought.slice(0, TOOL_STRING_LIMITS.thought),
    name,
    args as Record<string, unknown>,
    allowed,
  )
}

/**
 * Convert every OpenAI tool call in a response into internal ToolCalls.
 *
 * The GBNF path emits exactly one call per generation, but API providers
 * (Kimi, etc.) often return several parallel calls. We execute them in order.
 */
export function parseOpenAiToolCalls(
  calls: readonly OpenAiToolCall[],
  allowed: readonly ToolName[],
  thought = 'Function call',
): ToolCall[] {
  if (calls.length === 0) {
    throw new ForgeError('TOOL_CALL_MALFORMED', 'OpenAI response contained no tool_calls.', {
      truncated: false,
    })
  }
  return calls.map((call) => toolCallFromOpenAi(call, allowed, thought))
}

/* ── Plan artifact (PLANNING-MODE.md §"Plan artifact schema") ───────────── */

export const planActionTypes = ['create', 'edit', 'delete', 'command'] as const
export const verificationTypes = ['command', 'manual'] as const

const planActionIr: Extract<JsonIr, { kind: 'object' }> = {
  kind: 'object',
  props: [
    { name: 'type', schema: { kind: 'enum', values: planActionTypes } },
    {
      name: 'path',
      schema: {
        kind: 'string',
        minLength: 1,
        description: relPathArg.description,
      },
    },
    { name: 'description', schema: { kind: 'string', minLength: 1 } },
  ],
}

const verificationIr: Extract<JsonIr, { kind: 'object' }> = {
  kind: 'object',
  props: [
    { name: 'type', schema: { kind: 'enum', values: verificationTypes } },
    { name: 'command', schema: { kind: 'string' }, optional: true },
    { name: 'manual', schema: { kind: 'string' }, optional: true },
  ],
}

const planStepIr: Extract<JsonIr, { kind: 'object' }> = {
  kind: 'object',
  props: [
    { name: 'id', schema: { kind: 'string', minLength: 1 } },
    { name: 'title', schema: { kind: 'string', minLength: 1 } },
    { name: 'intent', schema: { kind: 'string', minLength: 1 } },
    { name: 'files', schema: { kind: 'array', items: { kind: 'string', minLength: 1 } } },
    { name: 'actions', schema: { kind: 'array', items: planActionIr, minItems: 1 } },
    // Required by the grammar on purpose: it forces the model to answer
    // "how do I know this worked" for every step (PLANNING-MODE.md).
    { name: 'verification', schema: verificationIr },
  ],
}

export const planArtifactIr: Extract<JsonIr, { kind: 'object' }> = {
  kind: 'object',
  props: [
    { name: 'title', schema: { kind: 'string', minLength: 1 } },
    { name: 'summary', schema: { kind: 'string', minLength: 1 } },
    { name: 'assumptions', schema: { kind: 'array', items: { kind: 'string', minLength: 1 } } },
    { name: 'open_questions', schema: { kind: 'array', items: { kind: 'string', minLength: 1 } } },
    { name: 'steps', schema: { kind: 'array', items: planStepIr, minItems: 1 } },
    // Optional suffixes keep lighter plans samplable without inventing filler.
    { name: 'risks', schema: { kind: 'array', items: { kind: 'string', minLength: 1 } }, optional: true },
    {
      name: 'out_of_scope',
      schema: { kind: 'array', items: { kind: 'string', minLength: 1 } },
      optional: true,
    },
  ],
}

/** Workspace-relative POSIX path (same policy as tool `relPathArg`). */
export function isWorkspaceRelPath(value: string): boolean {
  const path = value.trim()
  if (!path) return false
  if (path.includes('\0') || path.includes('\\')) return false
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false
  if (path.split('/').includes('..')) return false
  return true
}

const workspaceRelPathSchema = z
  .string()
  .min(1)
  .refine(isWorkspaceRelPath, {
    message: 'Must be a workspace-relative POSIX path (no absolute paths, drive letters, or .. segments).',
  })

export const planActionSchema = z.object({
  type: z.enum(planActionTypes).describe('create | edit | delete | command'),
  path: workspaceRelPathSchema.describe('Workspace-relative POSIX path for the action target.'),
  description: z.string().min(1).describe('What this action does.'),
})
export type PlanAction = z.infer<typeof planActionSchema>

export const verificationSchema = z.object({
  type: z.enum(verificationTypes).describe('command | manual'),
  command: z
    .string()
    .min(1)
    .optional()
    .describe('Shell command to run when type is command.'),
  manual: z
    .string()
    .min(1)
    .optional()
    .describe('Human-check instructions when type is manual.'),
})
export type PlanVerification = z.infer<typeof verificationSchema>

export const planStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  intent: z.string().min(1),
  files: z.array(workspaceRelPathSchema),
  actions: z.array(planActionSchema).min(1),
  verification: verificationSchema,
  /** Free-text note added during review; the executor sees it. Not model-generated. */
  note: z.string().optional(),
})
export type PlanStepBody = z.infer<typeof planStepSchema>

export const planArtifactSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  assumptions: z.array(z.string().min(1)),
  open_questions: z.array(z.string().min(1)),
  steps: z.array(planStepSchema).min(1),
  risks: z.array(z.string().min(1)).default([]),
  out_of_scope: z.array(z.string().min(1)).default([]),
})
export type PlanArtifact = z.infer<typeof planArtifactSchema>

function formatPlanSchemaIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
      if (issue.code === 'invalid_type' && issue.input === undefined) {
        return `Missing required field: ${path}`
      }
      if (issue.code === 'too_small' && issue.origin === 'string') {
        return `Empty or too-short string at ${path}`
      }
      if (issue.code === 'too_small' && issue.origin === 'array') {
        return `Array at ${path} needs at least ${String(issue.minimum)} item(s)`
      }
      if (issue.code === 'invalid_value' || issue.code === 'invalid_union') {
        return `Invalid value at ${path}: ${issue.message}`
      }
      return `${path}: ${issue.message}`
    })
    .join('; ')
}

function parsePlanJson(raw: string): { json: unknown; recoveredTruncation: boolean } {
  const trimmed = raw.trim()
  // Salvage truncated payloads before treating parse failures as schema errors.
  const closed = tryCloseTruncatedJson(trimmed)

  try {
    return { json: JSON.parse(trimmed), recoveredTruncation: false }
  } catch (firstError) {
    if (closed) {
      try {
        return {
          json: JSON.parse(closed),
          recoveredTruncation: true,
        }
      } catch (secondError) {
        throw new ForgeError(
          'PLAN_ARTIFACT_INVALID',
          `Truncated JSON: ${INCOMPLETE_JSON_HINT} (${secondError instanceof Error ? secondError.message : String(secondError)})`,
          { raw: raw.slice(0, 4000), truncated: true, reason: 'truncated_json' },
        )
      }
    }
    const incomplete = isIncompleteJsonError(firstError)
    throw new ForgeError(
      'PLAN_ARTIFACT_INVALID',
      incomplete
        ? `Truncated JSON: ${INCOMPLETE_JSON_HINT} (${firstError instanceof Error ? firstError.message : String(firstError)})`
        : `Invalid JSON: ${firstError instanceof Error ? firstError.message : String(firstError)}`,
      {
        raw: raw.slice(0, 4000),
        truncated: incomplete,
        reason: incomplete ? 'truncated_json' : 'invalid_json',
      },
    )
  }
}

function lintPlanArtifact(artifact: PlanArtifact): void {
  const nonEmpty = (value: string, label: string): void => {
    if (!value.trim()) {
      throw new ForgeError('PLAN_ARTIFACT_INVALID', `Lint: ${label} is empty or whitespace-only.`, {
        reason: 'lint_empty_string',
        field: label,
      })
    }
  }

  nonEmpty(artifact.title, 'title')
  nonEmpty(artifact.summary, 'summary')

  for (const [index, item] of artifact.assumptions.entries()) {
    nonEmpty(item, `assumptions[${index}]`)
  }
  for (const [index, item] of artifact.open_questions.entries()) {
    nonEmpty(item, `open_questions[${index}]`)
  }
  for (const [index, item] of artifact.risks.entries()) {
    nonEmpty(item, `risks[${index}]`)
  }
  for (const [index, item] of artifact.out_of_scope.entries()) {
    nonEmpty(item, `out_of_scope[${index}]`)
  }

  for (const step of artifact.steps) {
    nonEmpty(step.id, `steps[${step.id}].id`)
    nonEmpty(step.title, `step "${step.id}" title`)
    nonEmpty(step.intent, `step "${step.id}" intent`)
    for (const [index, file] of step.files.entries()) {
      if (!isWorkspaceRelPath(file)) {
        throw new ForgeError(
          'PLAN_ARTIFACT_INVALID',
          `Lint: step "${step.id}" files[${index}] is not a workspace-relative path: ${file}`,
          { reason: 'lint_path', stepId: step.id, path: file },
        )
      }
    }
    for (const [index, action] of step.actions.entries()) {
      nonEmpty(action.description, `step "${step.id}" actions[${index}].description`)
      if (!isWorkspaceRelPath(action.path)) {
        throw new ForgeError(
          'PLAN_ARTIFACT_INVALID',
          `Lint: step "${step.id}" actions[${index}].path is not a workspace-relative path: ${action.path}`,
          { reason: 'lint_path', stepId: step.id, path: action.path },
        )
      }
    }
    if (step.verification.type === 'command' && !step.verification.command?.trim()) {
      throw new ForgeError(
        'PLAN_ARTIFACT_INVALID',
        `Lint: step "${step.id}" declares a command verification with no command.`,
        { reason: 'lint_verification', stepId: step.id },
      )
    }
    if (step.verification.type === 'manual' && !step.verification.manual?.trim()) {
      throw new ForgeError(
        'PLAN_ARTIFACT_INVALID',
        `Lint: step "${step.id}" declares a manual verification with no instructions.`,
        { reason: 'lint_verification', stepId: step.id },
      )
    }
  }

  const ids = artifact.steps.map((s) => s.id)
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i)
  if (duplicate !== undefined) {
    throw new ForgeError('PLAN_ARTIFACT_INVALID', `Lint: duplicate step id "${duplicate}".`, {
      reason: 'lint_duplicate_step_id',
      stepId: duplicate,
    })
  }
}

/** Parse a grammar-constrained plan emission. Throws PLAN_ARTIFACT_INVALID. */
export function parsePlanArtifact(raw: string): PlanArtifact {
  const { json, recoveredTruncation } = parsePlanJson(raw)
  const parsed = planArtifactSchema.safeParse(json)
  if (!parsed.success) {
    const prefix = recoveredTruncation
      ? 'Truncated JSON was repaired but still incomplete. '
      : ''
    throw new ForgeError(
      'PLAN_ARTIFACT_INVALID',
      `${prefix}Schema mismatch: ${formatPlanSchemaIssues(parsed.error)}`,
      {
        issues: z.prettifyError(parsed.error),
        reason: recoveredTruncation ? 'truncated_json' : 'schema_mismatch',
        truncated: recoveredTruncation,
      },
    )
  }
  lintPlanArtifact(parsed.data)
  return parsed.data
}

/* ── Persistence / wire shapes ─────────────────────────────────────────── */

export const planStatuses = [
  'draft',
  'approved',
  'executing',
  'completed',
  'failed',
  'abandoned',
] as const
export const planStepStatuses = [
  'pending',
  'running',
  'awaiting_review',
  'applied',
  'rejected',
  'failed',
  'skipped',
] as const
export const execModes = ['step', 'auto'] as const
export type ExecMode = (typeof execModes)[number]

export const planSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  workspaceId: z.string().min(1),
  revision: z.number().int().positive(),
  parentPlanId: z.string().nullable(),
  artifact: planArtifactSchema,
  status: z.enum(planStatuses),
  execMode: z.enum(execModes).nullable(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
})
export type Plan = z.infer<typeof planSchema>

export const planStepRowSchema = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  idx: z.number().int().nonnegative(),
  step: planStepSchema,
  status: z.enum(planStepStatuses),
  checkpointId: z.string().nullable(),
  diff: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.number().int().positive().nullable(),
  finishedAt: z.number().int().positive().nullable(),
})
export type PlanStepRow = z.infer<typeof planStepRowSchema>

export const checkpointSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  gitRef: z.string().min(1),
  label: z.string(),
  createdAt: z.number().int().positive(),
})
export type Checkpoint = z.infer<typeof checkpointSchema>

export const toolCallRecordSchema = z.object({
  id: z.string().min(1),
  messageId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  result: z.string().nullable(),
  status: z.enum(['ok', 'error', 'denied', 'pending']),
  startedAt: z.number().int().positive(),
  finishedAt: z.number().int().positive().nullable(),
})
export type ToolCallRecord = z.infer<typeof toolCallRecordSchema>

/** A workspace check command the verification runner found (and its allow state). */
export const checkCommandSchema = z.object({
  /** Stable id, e.g. 'npm:typecheck' or 'tsc'. */
  id: z.string().min(1),
  command: z.string().min(1),
  /** Where it came from, for the approval UI: 'package.json script', 'tsconfig', … */
  source: z.string().min(1),
  kind: z.enum(['typecheck', 'lint', 'test', 'build', 'other']),
  allowed: z.boolean(),
})
export type CheckCommand = z.infer<typeof checkCommandSchema>

/** Result of one verification command run. */
export const verificationResultSchema = z.object({
  command: z.string().min(1),
  exitCode: z.number().int(),
  /** Truncated combined output — what gets fed back on the repair attempt. */
  output: z.string(),
  durationMs: z.number().int().nonnegative(),
})
export type VerificationResult = z.infer<typeof verificationResultSchema>

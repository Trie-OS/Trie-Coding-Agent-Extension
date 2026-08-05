import { describe, expect, it } from 'vitest'
import { ForgeError } from './errors'
import {
  parsePlanArtifact,
  parseToolCall,
  planArtifactIr,
  readToolNames,
  tryCloseTruncatedJson,
  toolCallEnvelopeIr,
  toolNames,
  type JsonIr,
  type ToolName,
} from './agent'
import { compileGbnf } from './gbnf'
import { constrainedSample, GbnfGrammarMatcher } from './gbnfMatcher'

function matcherFor(ir: JsonIr): GbnfGrammarMatcher {
  return new GbnfGrammarMatcher(compileGbnf(ir))
}

/** Deterministic PRNG so a failure is reproducible from the seed alone. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('tryCloseTruncatedJson', () => {
  it('closes an unterminated string and unmatched braces', () => {
    const closed = tryCloseTruncatedJson(
      '{"thought": "look", "tool": "read_file", "args": {"path": "src/a.ts',
    )
    expect(closed).toBe('{"thought": "look", "tool": "read_file", "args": {"path": "src/a.ts"}}')
    expect(JSON.parse(closed!)).toMatchObject({ tool: 'read_file' })
  })

  it('returns null for prose that is not JSON', () => {
    expect(tryCloseTruncatedJson('Sure, I will help')).toBeNull()
  })
})

describe('compileGbnf — primitives', () => {
  it('accepts an object with required properties and rejects a missing one', () => {
    const m = matcherFor({
      kind: 'object',
      props: [
        { name: 'path', schema: { kind: 'string' } },
        { name: 'depth', schema: { kind: 'integer' } },
      ],
    })
    expect(m.accepts('{"path": "src/a.ts", "depth": 2}')).toBe(true)
    expect(m.accepts('{"path":"src/a.ts","depth":2}')).toBe(true)
    expect(m.accepts('{"path": "src/a.ts"}')).toBe(false)
    expect(m.accepts('{"depth": 2, "path": "src/a.ts"}')).toBe(false)
  })

  it('accepts ordered optional properties, in order, and rejects out-of-order ones', () => {
    const m = matcherFor({
      kind: 'object',
      props: [
        { name: 'path', schema: { kind: 'string' } },
        { name: 'startLine', schema: { kind: 'integer' }, optional: true },
        { name: 'endLine', schema: { kind: 'integer' }, optional: true },
      ],
    })
    expect(m.accepts('{"path": "a"}')).toBe(true)
    expect(m.accepts('{"path": "a", "startLine": 1}')).toBe(true)
    expect(m.accepts('{"path": "a", "endLine": 9}')).toBe(true)
    expect(m.accepts('{"path": "a", "startLine": 1, "endLine": 9}')).toBe(true)
    expect(m.accepts('{"path": "a", "endLine": 9, "startLine": 1}')).toBe(false)
    expect(m.accepts('{"path": "a", "startLine": "one"}')).toBe(false)
  })

  it('constrains enums to their literal values', () => {
    const m = matcherFor({ kind: 'enum', values: ['create', 'edit'] })
    expect(m.accepts('"create"')).toBe(true)
    expect(m.accepts('"edit"')).toBe(true)
    expect(m.accepts('"delete"')).toBe(false)
    expect(m.accepts('"creat"')).toBe(false)
  })

  it('enforces minItems on arrays', () => {
    const nonEmpty = matcherFor({ kind: 'array', items: { kind: 'string' }, minItems: 1 })
    expect(nonEmpty.accepts('["a"]')).toBe(true)
    expect(nonEmpty.accepts('["a", "b"]')).toBe(true)
    expect(nonEmpty.accepts('[]')).toBe(false)
    const maybeEmpty = matcherFor({ kind: 'array', items: { kind: 'string' } })
    expect(maybeEmpty.accepts('[]')).toBe(true)
  })

  it('rejects prose, trailing text, and unterminated JSON — the failure modes grammars exist to kill', () => {
    const m = matcherFor({
      kind: 'object',
      props: [{ name: 'path', schema: { kind: 'string' } }],
    })
    expect(m.accepts('Sure! Here is the call: {"path": "a"}')).toBe(false)
    expect(m.accepts('{"path": "a"} and then I will also...')).toBe(false)
    expect(m.accepts('{"path": "a"')).toBe(false)
    expect(m.accepts('{path: "a"}')).toBe(false)
    expect(m.accepts("{'path': 'a'}")).toBe(false)
  })

  it('escapes literals so a quote inside an enum value cannot break the grammar', () => {
    const m = matcherFor({ kind: 'const', value: 'say "hi"' })
    expect(m.accepts('"say \\"hi\\""')).toBe(true)
    expect(m.accepts('"say "hi""')).toBe(false)
  })

  it('refuses to compile an all-optional object rather than emit an ambiguous grammar', () => {
    expect(() =>
      compileGbnf({
        kind: 'object',
        props: [{ name: 'a', schema: { kind: 'string' }, optional: true }],
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'GRAMMAR_COMPILE_FAILED' }) as unknown as ForgeError,
    )
  })
})

describe('tool-call grammar', () => {
  const allTools = [...toolNames]
  const matcher = matcherFor(toolCallEnvelopeIr(allTools))

  const samples: Record<ToolName, string> = {
    read_file: '{"thought": "look", "tool": "read_file", "args": {"path": "src/a.ts"}}',
    read_files:
      '{"thought": "look", "tool": "read_files", "args": {"paths": ["src/a.ts", "src/b.ts"]}}',
    list_dir: '{"thought": "look", "tool": "list_dir", "args": {"path": ""}}',
    grep: '{"thought": "look", "tool": "grep", "args": {"pattern": "useTheme"}}',
    glob: '{"thought": "look", "tool": "glob", "args": {"pattern": "src/**/*.tsx"}}',
    outline: '{"thought": "look", "tool": "outline", "args": {"path": "src/a.ts"}}',
    search_symbols: '{"thought": "look", "tool": "search_symbols", "args": {"query": "useTheme"}}',
    web_search:
      '{"thought": "research", "tool": "web_search", "args": {"query": "vite plugin api"}}',
    edit_file:
      '{"thought": "fix", "tool": "edit_file", "args": {"path": "a.ts", "replace": "y", "search": "x"}}',
    write_file:
      '{"thought": "new", "tool": "write_file", "args": {"path": "a.ts", "content": "hi"}}',
    run_command: '{"thought": "check", "tool": "run_command", "args": {"command": "npm test"}}',
    update_todos:
      '{"thought": "plan", "tool": "update_todos", "args": {"todo": ["explore", "edit"], "done": ["boot"]}}',
    spawn_task:
      '{"thought": "delegate", "tool": "spawn_task", "args": {"title": "Explore UX", "prompt": "Map the review flow"}}',
    done_exploring: '{"thought": "enough", "tool": "done_exploring", "args": {"summary": "s"}}',
    step_complete: '{"thought": "done", "tool": "step_complete", "args": {"summary": "s"}}',
    step_failed: '{"thought": "stuck", "tool": "step_failed", "args": {"reason": "r"}}',
  }

  it('accepts a well-formed call to each tool', () => {
    for (const tool of allTools) {
      expect(matcher.accepts(samples[tool]), `${tool} sample`).toBe(true)
      expect(parseToolCall(samples[tool], allTools).tool).toBe(tool)
    }
  })

  it('makes a hallucinated tool name unsamplable', () => {
    expect(matcher.accepts('{"thought": "t", "tool": "delete_repo", "args": {"path": "a"}}')).toBe(
      false,
    )
  })

  it('makes the wrong argument set for a real tool unsamplable', () => {
    // grep's args are {pattern, glob?} — `path` belongs to read_file.
    expect(matcher.accepts('{"thought": "t", "tool": "grep", "args": {"path": "a"}}')).toBe(false)
    // edit_file needs path + replace (search/line range optional at grammar level).
    expect(matcher.accepts('{"thought": "t", "tool": "edit_file", "args": {"path": "a"}}')).toBe(
      false,
    )
  })

  it('only offers the tools of the current phase', () => {
    const readOnly = matcherFor(toolCallEnvelopeIr([...readToolNames, 'done_exploring']))
    expect(readOnly.accepts('{"thought": "t", "tool": "read_file", "args": {"path": "a"}}')).toBe(
      true,
    )
    expect(
      readOnly.accepts(
        '{"thought": "t", "tool": "write_file", "args": {"path": "a", "content": "x"}}',
      ),
    ).toBe(false)
  })

  it('rejects a tool that is grammar-legal but not phase-allowed, loudly', () => {
    expect(() =>
      parseToolCall(
        '{"thought": "t", "tool": "write_file", "args": {"path": "a", "content": "x"}}',
        [...readToolNames],
      ),
    ).toThrowError(expect.objectContaining({ code: 'TOOL_UNKNOWN' }) as unknown as ForgeError)
  })

  it('rejects malformed JSON loudly instead of guessing', () => {
    expect(() => parseToolCall('{"thought": "t", "tool":', allTools)).toThrowError(
      expect.objectContaining({ code: 'TOOL_CALL_MALFORMED' }) as unknown as ForgeError,
    )
    expect(() =>
      parseToolCall('{"thought": "t", "tool": "read_file", "args": {"path": 7}}', allTools),
    ).toThrowError(expect.objectContaining({ code: 'TOOL_ARGS_INVALID' }) as unknown as ForgeError)
  })

  it('surfaces a clear truncated-JSON error when a string is cut mid-emit', () => {
    expect(() =>
      parseToolCall(
        '{"thought": "look", "tool": "write_file", "args": {"path": "a", "content": "hi',
        allTools,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'TOOL_CALL_MALFORMED',
        message: expect.stringContaining('incomplete JSON'),
        details: expect.objectContaining({ truncated: true }),
      }) as unknown as ForgeError,
    )
  })

  it('bounds small-maxLength strings but allows large-maxLength strings to fall back to unbounded', () => {
    // edit_file search/replace are over the 1000-grammar cap, so they are now
    // unbounded and parsed by the zod validator instead of the grammar.
    const huge = 'x'.repeat(2000)
    expect(
      matcher.accepts(
        JSON.stringify({
          thought: 'fix',
          tool: 'edit_file',
          args: { path: 'a.ts', replace: 'y', search: huge },
        }),
      ),
    ).toBe(true)
    // thought stays grammar-bounded (max 400), so an oversized thought is
    // still rejected by the grammar itself.
    const hugeThought = 'x'.repeat(500)
    expect(
      matcher.accepts(
        JSON.stringify({
          thought: hugeThought,
          tool: 'read_file',
          args: { path: 'a.ts' },
        }),
      ),
    ).toBe(false)
    expect(
      matcher.accepts(
        JSON.stringify({
          thought: 'fix',
          tool: 'edit_file',
          args: { path: 'a.ts', replace: 'y', search: 'short' },
        }),
      ),
    ).toBe(true)
  })

  /**
   * PLAN.md Phase 4 done-criterion: "50-turn synthetic run: 0 malformed tool
   * calls". `constrainedSample` is real grammar-constrained decoding (see
   * gbnfMatcher.ts) driven by a PRNG instead of a model's logits, so this
   * measures grammar enforcement rather than a model's manners: every one of
   * the 50 emissions must parse *and* name a real tool with valid args.
   */
  it('50 grammar-constrained synthetic turns produce 0 malformed tool calls', () => {
    const random = mulberry32(0xf0f0)
    const m = new GbnfGrammarMatcher(compileGbnf(toolCallEnvelopeIr(allTools)))
    const seen = new Set<string>()
    for (let turn = 0; turn < 50; turn += 1) {
      // Steer toward a different tool each turn; the sampler may only follow
      // the preference where the grammar allows it, and it keeps sampling
      // freely once the preference runs out.
      const target = allTools[turn % allTools.length] as ToolName
      const emission = constrainedSample(m, {
        random,
        preferred: samples[target],
        maxChars: 2000,
      })
      expect(m.accepts(emission), `turn ${turn} emission: ${emission}`).toBe(true)
      const call = parseToolCall(emission, allTools)
      expect(allTools).toContain(call.tool)
      seen.add(call.tool)
    }
    // Sanity: the run actually covered a spread of tools, not one repeated.
    expect(seen.size).toBe(allTools.length)
  })

  /**
   * The same criterion with *no* steering at all: 50 emissions sampled purely
   * from the grammar. Every one must be parseable JSON naming a real tool —
   * the property grammar-constrained decoding buys us. (String `minLength` is
   * not expressible in GBNF, so an unsteered sampler can legally emit an empty
   * string argument; that is caught by the zod pass, which is why the
   * assertion here is at JSON/tool-name level.)
   *
   * Only a handful of turns: unsteered sampling costs one full backtracking
   * re-parse per candidate character, so it is ~2 s per emission. The 50-turn
   * criterion above is the steered one, which exercises the same enforcement.
   */
  it('unsteered grammar-constrained emissions are all parseable calls to real tools', () => {
    const random = mulberry32(0xbeef)
    const m = new GbnfGrammarMatcher(compileGbnf(toolCallEnvelopeIr(allTools)))
    for (let turn = 0; turn < 2; turn += 1) {
      const emission = constrainedSample(m, {
        random,
        maxChars: 400,
        alphabet: '{}[]",:0123456789abcdefghijklmnopqrstuvwxyzLSE _-./',
      })
      const parsed = JSON.parse(emission) as { tool: string; thought: string; args: unknown }
      expect(allTools, `turn ${turn}: ${emission}`).toContain(parsed.tool)
      expect(typeof parsed.thought).toBe('string')
      expect(typeof parsed.args).toBe('object')
    }
    // An explicit budget: unsteered sampling is ~2 s per emission (one full
    // backtracking re-parse per candidate character), which sits right on
    // vitest's 5 s default and goes flaky under parallel load.
  }, 60_000)
})

describe('plan-artifact grammar', () => {
  const matcher = matcherFor(planArtifactIr)
  const validPlan = {
    title: 'Add dark mode toggle',
    summary: 'Introduce a theme context and a toggle in the header.',
    assumptions: ['Tailwind is configured with class-based dark mode'],
    open_questions: ['Persist per-device or per-account?'],
    steps: [
      {
        id: 's1',
        title: 'Create ThemeContext',
        intent: 'Central place to read and write the theme.',
        files: ['src/theme/ThemeContext.tsx'],
        actions: [
          { type: 'create', path: 'src/theme/ThemeContext.tsx', description: 'Context + hook' },
        ],
        verification: { type: 'command', command: 'npm run typecheck' },
      },
    ],
    risks: ['14 components hardcode bg-white'],
    out_of_scope: ['Refactoring the color tokens'],
  }

  it('accepts the schema from PLANNING-MODE.md', () => {
    expect(matcher.accepts(JSON.stringify(validPlan))).toBe(true)
    expect(parsePlanArtifact(JSON.stringify(validPlan)).steps).toHaveLength(1)
  })

  it('allows omitting optional risks and out_of_scope', () => {
    const light = {
      title: validPlan.title,
      summary: validPlan.summary,
      assumptions: validPlan.assumptions,
      open_questions: validPlan.open_questions,
      steps: validPlan.steps,
    }
    expect(matcher.accepts(JSON.stringify(light))).toBe(true)
    const parsed = parsePlanArtifact(JSON.stringify(light))
    expect(parsed.risks).toEqual([])
    expect(parsed.out_of_scope).toEqual([])
  })

  it('names truncated JSON distinctly from schema mismatches', () => {
    expect(() => parsePlanArtifact('{"title":"Add dark mode')).toThrowError(
      expect.objectContaining({
        code: 'PLAN_ARTIFACT_INVALID',
        message: expect.stringMatching(/Truncated JSON/i) as unknown as string,
        details: expect.objectContaining({ truncated: true, reason: 'truncated_json' }) as unknown as object,
      }) as unknown as ForgeError,
    )
  })

  it('rejects absolute action paths at parse/lint time', () => {
    const bad = {
      ...validPlan,
      steps: [
        {
          ...validPlan.steps[0],
          actions: [{ type: 'edit', path: '/etc/passwd', description: 'nope' }],
        },
      ],
    }
    expect(() => parsePlanArtifact(JSON.stringify(bad))).toThrowError(
      expect.objectContaining({
        code: 'PLAN_ARTIFACT_INVALID',
        message: expect.stringMatching(/workspace-relative|Schema mismatch/i) as unknown as string,
      }) as unknown as ForgeError,
    )
  })

  it('lints whitespace-only assumption strings', () => {
    const bad = { ...validPlan, assumptions: ['   '] }
    expect(() => parsePlanArtifact(JSON.stringify(bad))).toThrowError(
      expect.objectContaining({
        code: 'PLAN_ARTIFACT_INVALID',
        message: expect.stringMatching(/Lint:|Empty or too-short/i) as unknown as string,
      }) as unknown as ForgeError,
    )
  })

  it('makes a step without verification unsamplable — the grammar forces the question', () => {
    const noVerification = {
      ...validPlan,
      steps: [{ ...validPlan.steps[0], verification: undefined }],
    }
    expect(matcher.accepts(JSON.stringify(noVerification))).toBe(false)
  })

  it('makes a plan with zero steps unsamplable', () => {
    expect(matcher.accepts(JSON.stringify({ ...validPlan, steps: [] }))).toBe(false)
  })

  it('rejects an unknown action type', () => {
    const bad = {
      ...validPlan,
      steps: [
        {
          ...validPlan.steps[0],
          actions: [{ type: 'refactor', path: 'a', description: 'd' }],
        },
      ],
    }
    expect(matcher.accepts(JSON.stringify(bad))).toBe(false)
  })

  it('rejects a command verification with no command — grammar cannot express it, the parser can', () => {
    const bad = {
      ...validPlan,
      steps: [{ ...validPlan.steps[0], verification: { type: 'command' } }],
    }
    // Grammar-legal (command is optional in the IR)…
    expect(matcher.accepts(JSON.stringify(bad))).toBe(true)
    // …and caught loudly by the semantic pass.
    expect(() => parsePlanArtifact(JSON.stringify(bad))).toThrowError(
      expect.objectContaining({ code: 'PLAN_ARTIFACT_INVALID' }) as unknown as ForgeError,
    )
  })

  it('rejects duplicate step ids', () => {
    const bad = {
      ...validPlan,
      steps: [validPlan.steps[0], { ...validPlan.steps[0], title: 'Other' }],
    }
    expect(() => parsePlanArtifact(JSON.stringify(bad))).toThrowError(
      expect.objectContaining({ code: 'PLAN_ARTIFACT_INVALID' }) as unknown as ForgeError,
    )
  })

  it('a grammar-constrained synthetic plan emission always parses', () => {
    const random = mulberry32(7)
    const m = new GbnfGrammarMatcher(compileGbnf(planArtifactIr))
    const emission = constrainedSample(m, {
      random,
      preferred: JSON.stringify(validPlan),
      maxChars: 4000,
    })
    expect(() => parsePlanArtifact(emission)).not.toThrow()
  })
})

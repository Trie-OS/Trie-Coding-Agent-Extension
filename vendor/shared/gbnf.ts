/**
 * JSON-IR → GBNF compiler.
 *
 * This is the load-bearing piece of Phase 4 (PLANNING-MODE.md §"Why
 * grammar-constrained everything"): llama.cpp samples only tokens the grammar
 * allows, so a model constrained by the output of this file *cannot* emit
 * malformed JSON, a hallucinated tool name, prose where a call belongs, or a
 * mistyped argument. The class of failure disappears rather than being
 * retried around.
 *
 * Design choices worth keeping:
 *
 * - **Ordered properties.** Object properties are emitted in IR order, and
 *   optional ones as ordered optional suffixes. This is a strict subset of
 *   what llama.cpp's own json-schema-to-grammar accepts (it permits arbitrary
 *   key order) and it is *deliberately* narrower: a fixed order means the
 *   grammar is unambiguous, the compiler stays auditable, and — for tool
 *   calls — the model is forced to emit its `thought` before the call it
 *   justifies.
 * - **No all-optional objects.** An object with zero required properties
 *   needs comma bookkeeping the ordered-suffix form can't express. Rather
 *   than emit a subtly wrong grammar we throw `GRAMMAR_COMPILE_FAILED`. No IR
 *   in the app needs one.
 * - **Bounded whitespace.** `space` allows at most one newline plus a little
 *   indentation, matching llama.cpp's convention; unbounded whitespace lets a
 *   model spend its whole token budget on spaces.
 */
import { ForgeError } from './errors'
import type { JsonIr } from './agent'

/** Primitive rules every compiled grammar gets. Lifted from llama.cpp's json.gbnf. */
const PRELUDE = [
  'space ::= | " " | "\\n" [ \\t]{0,20}',
  'char ::= [^"\\\\\\x7F\\x00-\\x1F] | "\\\\" (["\\\\bfnrt/] | "u" [0-9a-fA-F]{4})',
  'string ::= "\\"" char* "\\"" space',
  'integer ::= ("-"? ([0-9] | [1-9] [0-9]{0,15})) space',
  'boolean ::= ("true" | "false") space',
].join('\n')

/** Escape a JS string for use as a GBNF literal terminal. */
export function gbnfLiteral(value: string): string {
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

/** A JSON string literal (i.e. the quotes are part of the emitted text). */
function jsonStringLiteral(value: string): string {
  return gbnfLiteral(JSON.stringify(value))
}

class Compiler {
  private readonly rules: string[] = []
  private readonly memo = new Map<string, string>()
  private counter = 0

  /** Register a rule body under a fresh name, deduplicating identical bodies. */
  private define(hint: string, body: string): string {
    const existing = this.memo.get(body)
    if (existing) return existing
    this.counter += 1
    const name = `${hint}-${this.counter}`
    this.memo.set(body, name)
    this.rules.push(`${name} ::= ${body}`)
    return name
  }

  /** Compile `ir`, returning a rule *reference* (a name or an inline terminal). */
  compile(ir: JsonIr): string {
    switch (ir.kind) {
      case 'string': {
        // Unbounded strings share the prelude `string` rule. When maxLength is
        // small we emit a bounded `char{min,max}` so llama.cpp cannot spend the
        // whole token budget inside one field (truncation mid-JSON).
        //
        // Recent llama.cpp builds (b990e4d9+) enforce a `MAX_REPETITION_THRESHOLD`
        // of 2000; large bounded repetitions make the grammar fail to parse.
        // For very large limits we fall back to an unbounded repetition and let
        // the zod validator that runs after sampling enforce the real maxLength.
        const MAX_GRAMMAR_REPETITION = 1000
        if (ir.maxLength === undefined) {
          // minLength alone stays a zod check: empty string is rare under a
          // grammar that already requires the field, and char+ would reject
          // legitimate empty values on fields that allow them.
          return 'string'
        }
        const min = ir.minLength ?? 0
        if (ir.maxLength < min) {
          throw new ForgeError(
            'GRAMMAR_COMPILE_FAILED',
            `string maxLength (${ir.maxLength}) is less than minLength (${min}).`,
          )
        }
        if (ir.maxLength > MAX_GRAMMAR_REPETITION) {
          const body = min === 0 ? 'string' : `"\\"" char{${min},} "\\"" space`
          return this.define('str', body)
        }
        return this.define('str', `"\\"" char{${min},${ir.maxLength}} "\\"" space`)
      }
      case 'integer':
        return 'integer'
      case 'boolean':
        return 'boolean'
      case 'enum': {
        if (ir.values.length === 0) {
          throw new ForgeError('GRAMMAR_COMPILE_FAILED', 'An enum IR needs at least one value.')
        }
        const body = `(${ir.values.map(jsonStringLiteral).join(' | ')}) space`
        return this.define('enum', body)
      }
      case 'const':
        return this.define('const', `${jsonStringLiteral(ir.value)} space`)
      case 'array': {
        const item = this.compile(ir.items)
        const tail = `("," space ${item})*`
        const body =
          (ir.minItems ?? 0) >= 1
            ? `"[" space ${item} ${tail} "]" space`
            : `"[" space (${item} ${tail})? "]" space`
        return this.define('array', body)
      }
      case 'union': {
        if (ir.variants.length < 2) {
          throw new ForgeError('GRAMMAR_COMPILE_FAILED', 'A union IR needs at least two variants.')
        }
        const body = ir.variants.map((v) => this.compile(v)).join(' | ')
        return this.define('union', body)
      }
      case 'object': {
        const required = ir.props.filter((p) => !p.optional)
        const optional = ir.props.filter((p) => p.optional)
        if (ir.props.length === 0) {
          throw new ForgeError(
            'GRAMMAR_COMPILE_FAILED',
            'An object IR needs at least one property.',
          )
        }
        if (required.length === 0) {
          throw new ForgeError(
            'GRAMMAR_COMPILE_FAILED',
            'An object IR with only optional properties cannot be compiled unambiguously; make at least one property required.',
            { props: ir.props.map((p) => p.name) },
          )
        }
        const kv = (name: string, schema: JsonIr): string =>
          `${jsonStringLiteral(name)} space ":" space ${this.compile(schema)}`
        const parts: string[] = []
        required.forEach((prop, index) => {
          parts.push(`${index === 0 ? '' : '"," space '}${kv(prop.name, prop.schema)}`)
        })
        for (const prop of optional) {
          parts.push(`("," space ${kv(prop.name, prop.schema)})?`)
        }
        return this.define('obj', `"{" space ${parts.join(' ')} "}" space`)
      }
    }
  }

  finish(rootRef: string): string {
    return [`root ::= ${rootRef}`, ...this.rules, PRELUDE].join('\n')
  }
}

/**
 * Compile a JSON IR into a complete GBNF grammar whose `root` rule matches
 * exactly the JSON values the IR describes.
 */
export function compileGbnf(ir: JsonIr): string {
  const compiler = new Compiler()
  const root = compiler.compile(ir)
  return compiler.finish(root)
}

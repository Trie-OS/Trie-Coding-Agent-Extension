/**
 * A GBNF parser + matcher for the subset `gbnf.ts` emits.
 *
 * **This is a verification instrument, not the production sampling path.** In
 * production llama.cpp's own grammar engine constrains sampling inside the
 * inference process. This module exists so that:
 *
 *  1. unit tests can assert that a compiled grammar *accepts* exactly the
 *     JSON we intend and *rejects* malformed output — otherwise "we generate a
 *     grammar" is an unverified claim;
 *  2. `FakeBackend` can do genuine grammar-constrained sampling (see
 *     `constrainedSample`), so the 50-turn synthetic tool-call run exercises
 *     the same grammar the real backend hands to llama.cpp rather than a
 *     hand-written happy-path string.
 *
 * The subset: alternation, sequences, string literals, rule references,
 * groups, character classes (with negation and ranges) and the `*`, `+`, `?`,
 * `{m,n}` repetition suffixes. Anything else in the input is a loud parse
 * error, which is exactly what we want if `gbnf.ts` ever grows a construct
 * this file does not understand.
 */

interface Alt {
  kind: 'alt'
  options: Node[]
}
interface Seq {
  kind: 'seq'
  items: Node[]
}
interface Lit {
  kind: 'lit'
  text: string
}
interface Ref {
  kind: 'ref'
  name: string
}
interface CharClass {
  kind: 'class'
  negated: boolean
  ranges: [number, number][]
}
interface Rep {
  kind: 'rep'
  node: Node
  min: number
  max: number
}
type Node = Alt | Seq | Lit | Ref | CharClass | Rep

export class GbnfParseError extends Error {}

class Parser {
  private pos = 0

  constructor(private readonly src: string) {}

  private ws(): void {
    while (this.pos < this.src.length) {
      const ch = this.src.charAt(this.pos)
      if (ch === ' ' || ch === '\t') this.pos += 1
      else if (ch === '#') {
        while (this.pos < this.src.length && this.src.charAt(this.pos) !== '\n') this.pos += 1
      } else break
    }
  }

  /** Skip whitespace including newlines — only used between rules. */
  private wsAll(): void {
    for (;;) {
      this.ws()
      if (this.src.charAt(this.pos) === '\n' || this.src.charAt(this.pos) === '\r') this.pos += 1
      else break
    }
  }

  parseGrammar(): Map<string, Node> {
    const rules = new Map<string, Node>()
    this.wsAll()
    while (this.pos < this.src.length) {
      const name = this.parseName()
      this.ws()
      if (this.src.slice(this.pos, this.pos + 3) !== '::=') {
        throw new GbnfParseError(`Expected '::=' after rule "${name}" at ${this.pos}`)
      }
      this.pos += 3
      rules.set(name, this.parseAlt())
      this.wsAll()
    }
    return rules
  }

  private parseName(): string {
    this.ws()
    const start = this.pos
    while (this.pos < this.src.length && /[A-Za-z0-9_-]/.test(this.src.charAt(this.pos)))
      this.pos += 1
    if (this.pos === start) throw new GbnfParseError(`Expected a rule name at ${this.pos}`)
    return this.src.slice(start, this.pos)
  }

  /** True when the parser is at something that cannot continue a sequence. */
  private atSeqEnd(): boolean {
    if (this.pos >= this.src.length) return true
    const ch = this.src.charAt(this.pos)
    if (ch === '|' || ch === ')') return true
    if (ch === '\n' || ch === '\r') {
      // A newline ends a rule unless the next non-space line continues an
      // alternation — `gbnf.ts` never emits continuations, so keep it strict.
      return true
    }
    return false
  }

  private parseAlt(): Node {
    const first = this.parseSeq()
    const options: Node[] = [first]
    for (;;) {
      this.ws()
      if (this.src.charAt(this.pos) !== '|') break
      this.pos += 1
      options.push(this.parseSeq())
    }
    return options.length === 1 ? first : { kind: 'alt', options }
  }

  private parseSeq(): Seq {
    const items: Node[] = []
    for (;;) {
      this.ws()
      if (this.atSeqEnd()) break
      items.push(this.parseSuffixed())
    }
    return { kind: 'seq', items }
  }

  private parseSuffixed(): Node {
    const node = this.parseAtom()
    const ch = this.src.charAt(this.pos)
    if (ch === '*') {
      this.pos += 1
      return { kind: 'rep', node, min: 0, max: Infinity }
    }
    if (ch === '+') {
      this.pos += 1
      return { kind: 'rep', node, min: 1, max: Infinity }
    }
    if (ch === '?') {
      this.pos += 1
      return { kind: 'rep', node, min: 0, max: 1 }
    }
    if (ch === '{') {
      const close = this.src.indexOf('}', this.pos)
      if (close < 0) throw new GbnfParseError(`Unterminated repetition at ${this.pos}`)
      const body = this.src.slice(this.pos + 1, close)
      this.pos = close + 1
      const [minRaw, maxRaw] = body.split(',')
      const min = Number(minRaw)
      const max = maxRaw === undefined ? min : maxRaw.trim() === '' ? Infinity : Number(maxRaw)
      if (!Number.isFinite(min)) throw new GbnfParseError(`Bad repetition "{${body}}"`)
      return { kind: 'rep', node, min, max }
    }
    return node
  }

  private parseAtom(): Node {
    const ch = this.src.charAt(this.pos)
    if (ch === '(') {
      this.pos += 1
      const inner = this.parseAlt()
      this.ws()
      if (this.src.charAt(this.pos) !== ')') throw new GbnfParseError(`Expected ')' at ${this.pos}`)
      this.pos += 1
      return inner
    }
    if (ch === '"') return this.parseLiteral()
    if (ch === '[') return this.parseClass()
    return { kind: 'ref', name: this.parseName() }
  }

  private readEscape(): number {
    // Caller has consumed the backslash.
    const ch = this.src.charAt(this.pos)
    this.pos += 1
    switch (ch) {
      case 'n':
        return 0x0a
      case 'r':
        return 0x0d
      case 't':
        return 0x09
      case 'x': {
        const hex = this.src.slice(this.pos, this.pos + 2)
        this.pos += 2
        return parseInt(hex, 16)
      }
      case 'u': {
        const hex = this.src.slice(this.pos, this.pos + 4)
        this.pos += 4
        return parseInt(hex, 16)
      }
      default:
        return ch.codePointAt(0) ?? 0
    }
  }

  private parseLiteral(): Lit {
    this.pos += 1 // opening quote
    let text = ''
    while (this.pos < this.src.length && this.src.charAt(this.pos) !== '"') {
      if (this.src.charAt(this.pos) === '\\') {
        this.pos += 1
        text += String.fromCodePoint(this.readEscape())
      } else {
        text += this.src.charAt(this.pos)
        this.pos += 1
      }
    }
    if (this.src.charAt(this.pos) !== '"') throw new GbnfParseError('Unterminated string literal')
    this.pos += 1
    return { kind: 'lit', text }
  }

  private parseClass(): CharClass {
    this.pos += 1 // '['
    const negated = this.src.charAt(this.pos) === '^'
    if (negated) this.pos += 1
    const ranges: [number, number][] = []
    while (this.pos < this.src.length && this.src.charAt(this.pos) !== ']') {
      let lo: number
      if (this.src.charAt(this.pos) === '\\') {
        this.pos += 1
        lo = this.readEscape()
      } else {
        lo = this.src.codePointAt(this.pos) ?? 0
        this.pos += String.fromCodePoint(lo).length
      }
      if (this.src.charAt(this.pos) === '-' && this.src.charAt(this.pos + 1) !== ']') {
        this.pos += 1
        let hi: number
        if (this.src.charAt(this.pos) === '\\') {
          this.pos += 1
          hi = this.readEscape()
        } else {
          hi = this.src.codePointAt(this.pos) ?? 0
          this.pos += String.fromCodePoint(hi).length
        }
        ranges.push([lo, hi])
      } else {
        ranges.push([lo, lo])
      }
    }
    if (this.src.charAt(this.pos) !== ']') throw new GbnfParseError('Unterminated character class')
    this.pos += 1
    return { kind: 'class', negated, ranges }
  }
}

export class GbnfGrammarMatcher {
  private readonly rules: Map<string, Node>

  constructor(grammar: string) {
    this.rules = new Parser(grammar).parseGrammar()
    if (!this.rules.has('root')) throw new GbnfParseError('Grammar has no `root` rule.')
  }

  /**
   * All positions in `text` at which a match of `node` starting at `pos` can
   * end. Lazy so that `prefixAccepts` can stop at the first success.
   */
  private *walk(node: Node, text: string, pos: number): Generator<number> {
    switch (node.kind) {
      case 'lit': {
        if (text.startsWith(node.text, pos)) yield pos + node.text.length
        return
      }
      case 'ref': {
        const rule = this.rules.get(node.name)
        if (!rule) throw new GbnfParseError(`Undefined rule reference: ${node.name}`)
        yield* this.walk(rule, text, pos)
        return
      }
      case 'class': {
        if (pos >= text.length) return
        const code = text.codePointAt(pos) ?? 0
        const width = String.fromCodePoint(code).length
        const inRange = node.ranges.some(([lo, hi]) => code >= lo && code <= hi)
        if (inRange !== node.negated) yield pos + width
        return
      }
      case 'alt': {
        const seen = new Set<number>()
        for (const option of node.options) {
          for (const end of this.walk(option, text, pos)) {
            if (!seen.has(end)) {
              seen.add(end)
              yield end
            }
          }
        }
        return
      }
      case 'seq': {
        yield* this.walkSeq(node.items, 0, text, pos)
        return
      }
      case 'rep': {
        yield* this.walkRep(node, text, pos, 0)
        return
      }
    }
  }

  private *walkSeq(items: Node[], index: number, text: string, pos: number): Generator<number> {
    const item = items[index]
    if (item === undefined) {
      yield pos
      return
    }
    for (const end of this.walk(item, text, pos)) {
      yield* this.walkSeq(items, index + 1, text, end)
    }
  }

  private *walkRep(node: Rep, text: string, pos: number, count: number): Generator<number> {
    if (count >= node.min) yield pos
    if (count >= node.max) return
    for (const end of this.walk(node.node, text, pos)) {
      // Zero-width repetition would loop forever; a well-formed grammar from
      // gbnf.ts never has one, but guard rather than hang.
      if (end === pos) return
      yield* this.walkRep(node, text, end, count + 1)
    }
  }

  /** Does the grammar match `text` in its entirety? */
  accepts(text: string): boolean {
    const root = this.rules.get('root')
    if (!root) throw new GbnfParseError('Grammar has no `root` rule.')
    for (const end of this.walk(root, text, 0)) {
      if (end === text.length) return true
    }
    return false
  }

  /**
   * Can `text` still become a full match with more characters appended?
   *
   * Implemented by matching against `text` and treating "ran out of input" as
   * a live possibility: `walk` simply produces no ends past the input, so we
   * ask whether *any* partial derivation consumed the entire prefix. This is
   * what a constrained sampler needs.
   */
  prefixAccepts(text: string): boolean {
    if (this.accepts(text)) return true
    const root = this.rules.get('root')
    if (!root) throw new GbnfParseError('Grammar has no `root` rule.')
    return this.reachesEnd(root, text, 0)
  }

  /**
   * True when some derivation of `node` consumes exactly `text` from `pos` to
   * its end without failing — i.e. the prefix is still viable.
   */
  private reachesEnd(node: Node, text: string, pos: number): boolean {
    if (pos === text.length) return true
    switch (node.kind) {
      case 'lit': {
        // *Strictly* partial only. A literal that matches in full has not
        // "reached the end of the input" — the sequence containing it must
        // continue, which the `seq` case does via `walk`. Treating a full
        // match as viable here would make every prefix look acceptable.
        const rest = text.slice(pos)
        return rest.length < node.text.length && node.text.startsWith(rest)
      }
      case 'ref': {
        const rule = this.rules.get(node.name)
        if (!rule) throw new GbnfParseError(`Undefined rule reference: ${node.name}`)
        return this.reachesEnd(rule, text, pos)
      }
      case 'class': {
        const code = text.codePointAt(pos) ?? 0
        const width = String.fromCodePoint(code).length
        const inRange = node.ranges.some(([lo, hi]) => code >= lo && code <= hi)
        return inRange !== node.negated && pos + width === text.length
      }
      case 'alt':
        return node.options.some((option) => this.reachesEnd(option, text, pos))
      case 'seq':
        return this.seqReachesEnd(node.items, 0, text, pos)
      case 'rep':
        return this.repReachesEnd(node, text, pos, 0)
    }
  }

  private seqReachesEnd(items: Node[], index: number, text: string, pos: number): boolean {
    if (pos === text.length) return true
    const item = items[index]
    if (item === undefined) return false
    if (this.reachesEnd(item, text, pos)) return true
    for (const end of this.walk(item, text, pos)) {
      if (this.seqReachesEnd(items, index + 1, text, end)) return true
    }
    return false
  }

  private repReachesEnd(node: Rep, text: string, pos: number, count: number): boolean {
    if (pos === text.length) return true
    if (count >= node.max) return false
    if (this.reachesEnd(node.node, text, pos)) return true
    for (const end of this.walk(node.node, text, pos)) {
      if (end === pos) return false
      if (this.repReachesEnd(node, text, end, count + 1)) return true
    }
    return false
  }
}

/**
 * Genuine grammar-constrained sampling, character at a time.
 *
 * At every position it asks the grammar which of a candidate alphabet may come
 * next and picks one — exactly the shape of what llama.cpp does with tokens
 * and logits, minus the model. `FakeBackend` uses this so grammar-constrained
 * paths can be exercised end-to-end with no GGUF present, and so the
 * "0 malformed tool calls over 50 turns" criterion is measured against real
 * grammar enforcement.
 *
 * `preferred` biases the sampler toward a target string (so tests can steer
 * *which* legal emission comes out) while never allowing an illegal character.
 */
export function constrainedSample(
  matcher: GbnfGrammarMatcher,
  options: {
    random: () => number
    maxChars?: number
    preferred?: string
    /**
     * Candidate alphabet. Small by default and for a reason: every candidate
     * costs one full backtracking re-parse of the emission so far, so this is
     * the dominant term in the sampler's runtime. It only has to be rich
     * enough to reach every construct in the grammar, not to be Unicode.
     */
    alphabet?: string
  },
): string {
  const alphabet = [...(options.alphabet ?? '{}[]",:019abzAZ -_./')]
  const maxChars = options.maxChars ?? 4000
  let out = ''
  for (let i = 0; i < maxChars; i += 1) {
    if (matcher.accepts(out)) {
      // Stop as soon as the emission is complete — the analogue of the model
      // emitting EOS under a satisfied grammar.
      return out
    }
    const wanted = options.preferred?.[out.length]
    if (wanted !== undefined && matcher.prefixAccepts(out + wanted)) {
      out += wanted
      continue
    }
    const candidates: string[] = []
    for (const ch of alphabet) {
      if (matcher.prefixAccepts(out + ch)) candidates.push(ch)
    }
    if (candidates.length === 0) {
      throw new GbnfParseError(
        `Constrained sampling dead-ended after ${JSON.stringify(out.slice(-60))}`,
      )
    }
    // Termination bias. `string ::= char*` is unbounded, so an unbiased
    // sampler wanders forever inside a string value; a real model's EOS/
    // closing-token probability plays this role. Structural closers are
    // ranked first and picked with a cubic bias toward the front, so
    // emissions converge while still exploring the grammar.
    const rank = (ch: string): number => ('"}]'.includes(ch) ? 0 : ch === ',' ? 2 : 1)
    candidates.sort((a, b) => rank(a) - rank(b))
    const r = options.random() ** 6
    const chosen = candidates[Math.min(candidates.length - 1, Math.floor(r * candidates.length))]
    if (chosen === undefined) {
      throw new GbnfParseError('Constrained sampling produced no candidate — unreachable.')
    }
    out += chosen
  }
  throw new GbnfParseError(
    `Constrained sampling exceeded ${maxChars} characters: ${JSON.stringify(out.slice(0, 200))}`,
  )
}

export interface ParsedToolCall {
  thought: string
  tool: string
  args: Record<string, unknown>
}

/** Scan every balanced `{...}` object in model output. */
function extractAllJsonObjects(text: string): string[] {
  const objects: string[] = []
  let scanFrom = 0
  while (scanFrom < text.length) {
    const start = text.indexOf('{', scanFrom)
    if (start === -1) break
    const extracted = extractBalancedJsonObject(text, start)
    if (extracted) {
      objects.push(extracted.json)
      scanFrom = extracted.end
    } else {
      scanFrom = start + 1
    }
  }
  return objects
}

function extractBalancedJsonObject(
  text: string,
  start: number,
): { json: string; end: number } | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return { json: text.slice(start, i + 1), end: i + 1 }
    }
  }
  return null
}

/** Best-effort close of truncated JSON (max-tokens mid-envelope). */
function tryCloseTruncatedJson(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return null

  let inString = false
  let escaped = false
  let depth = 0
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') depth--
  }

  let candidate = trimmed
  if (inString) candidate += '"'
  candidate += '}'.repeat(Math.max(depth, 0))
  try {
    JSON.parse(candidate)
    return candidate
  } catch {
    return null
  }
}

function resolveToolName(obj: Record<string, unknown>): string | undefined {
  const direct = [obj['tool'], obj['action'], obj['name']]
  for (const value of direct) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  if (typeof obj['function'] === 'string' && obj['function'].trim()) {
    return obj['function'].trim()
  }
  const fn = obj['function']
  if (fn && typeof fn === 'object' && !Array.isArray(fn)) {
    const name = (fn as Record<string, unknown>)['name']
    if (typeof name === 'string' && name.trim()) return name.trim()
  }
  const toolCall = obj['tool_call']
  if (toolCall && typeof toolCall === 'object' && !Array.isArray(toolCall)) {
    const nested = toolCall as Record<string, unknown>
    const name = nested['name'] ?? nested['tool']
    if (typeof name === 'string' && name.trim()) return name.trim()
  }
  return undefined
}

function resolveArgs(obj: Record<string, unknown>): Record<string, unknown> | null {
  const nested = obj['args'] ?? obj['arguments'] ?? obj['parameters'] ?? obj['input']
  if (nested !== undefined && nested !== null) {
    if (typeof nested !== 'object' || Array.isArray(nested)) return null
    return nested as Record<string, unknown>
  }

  const reserved = new Set(['thought', 'tool', 'action', 'name', 'function', 'tool_call'])
  const keys = Object.keys(obj).filter((key) => !reserved.has(key))
  if (keys.length === 0) return null
  const args: Record<string, unknown> = {}
  for (const key of keys) args[key] = obj[key]
  return args
}

function inferToolFromArgs(args: Record<string, unknown>): string | undefined {
  if (
    Array.isArray(args.paths) &&
    args.paths.length > 0 &&
    args.paths.every((item) => typeof item === 'string')
  ) {
    return 'read_files'
  }
  if (typeof args.path === 'string') {
    if (typeof args.replace === 'string') {
      if (typeof args.search === 'string') return 'edit_file'
      if (typeof args.startLine === 'number' && typeof args.endLine === 'number') return 'edit_file'
    }
    if (typeof args.content === 'string') return 'write_file'
    return 'read_file'
  }
  if (typeof args.pattern === 'string') return 'grep'
  if (typeof args.query === 'string') return 'search_symbols'
  if (typeof args.command === 'string') return 'run_command'
  if (Array.isArray(args.todo)) return 'update_todos'
  if (typeof args.summary === 'string') return 'step_complete'
  if (typeof args.reason === 'string') return 'step_failed'
  return undefined
}

function parseToolCallObject(
  obj: Record<string, unknown>,
  allowedTools: ReadonlySet<string>,
): ParsedToolCall | { error: string } {
  let tool = resolveToolName(obj)
  const args = resolveArgs(obj)

  if (!tool && args) {
    tool = inferToolFromArgs(args)
  }

  if (!tool) {
    return {
      error:
        'Missing `tool` field. Respond with exactly one JSON object: {"thought": "...", "tool": "<name>", "args": {...}}',
    }
  }

  if (!args) return { error: '`args` must be an object.' }

  if (!allowedTools.has(tool)) {
    return { error: `Unknown tool: ${tool}. Use one of: ${[...allowedTools].join(', ')}` }
  }

  const thought = typeof obj['thought'] === 'string' ? obj['thought'] : ''
  return { thought, tool, args }
}

function scoreToolCallCandidate(
  obj: Record<string, unknown>,
  allowedTools: ReadonlySet<string>,
): number {
  const tool = resolveToolName(obj) ?? inferToolFromArgs(resolveArgs(obj) ?? {})
  if (!tool || !allowedTools.has(tool)) return 0
  const args = resolveArgs(obj)
  if (!args) return 1
  return 2
}

interface ExtractedJson {
  json: string
  /** True when the object was recovered by force-closing truncated output. */
  repairedTruncation: boolean
}

function extractJsonObjectDetailed(
  text: string,
  allowedTools: ReadonlySet<string>,
): ExtractedJson | null {
  const candidates = extractAllJsonObjects(text)
  if (candidates.length === 0) {
    const start = text.indexOf('{')
    if (start === -1) return null
    const closed = tryCloseTruncatedJson(text.slice(start))
    return closed ? { json: closed, repairedTruncation: true } : null
  }

  let best: string | null = null
  let bestScore = -1
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
      const score = scoreToolCallCandidate(parsed as Record<string, unknown>, allowedTools)
      if (score > bestScore) {
        bestScore = score
        best = candidate
      }
    } catch {
      // ignore invalid fragments
    }
  }

  if (best) return { json: best, repairedTruncation: false }

  const start = text.indexOf('{')
  if (start === -1) {
    const fallback = candidates[candidates.length - 1]
    return fallback ? { json: fallback, repairedTruncation: false } : null
  }
  const closed = tryCloseTruncatedJson(text.slice(start))
  if (closed) return { json: closed, repairedTruncation: true }
  const fallback = candidates[candidates.length - 1]
  return fallback ? { json: fallback, repairedTruncation: false } : null
}

/** Extract the best JSON tool envelope from model output (tolerates fences/prose). */
export function extractJsonObject(
  text: string,
  allowedTools: ReadonlySet<string>,
): string | null {
  return extractJsonObjectDetailed(text, allowedTools)?.json ?? null
}

/** A force-closed payload means the mutating args were cut off mid-string — never apply it. */
const TRUNCATION_UNSAFE_TOOLS = new Set(['edit_file', 'write_file'])

export function parseToolCall(
  raw: string,
  allowedTools: ReadonlySet<string>,
): ParsedToolCall | { error: string } {
  const extracted = extractJsonObjectDetailed(raw, allowedTools)
  if (!extracted) return { error: 'No JSON object found in the response.' }
  let parsed: unknown
  try {
    parsed = JSON.parse(extracted.json)
  } catch (error) {
    return { error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'Response is not an object.' }
  }
  const call = parseToolCallObject(parsed as Record<string, unknown>, allowedTools)
  if (!('error' in call) && extracted.repairedTruncation && TRUNCATION_UNSAFE_TOOLS.has(call.tool)) {
    return {
      error:
        `Your ${call.tool} output was cut off before the JSON closed (token limit), so the edit was not applied. Re-issue it with a much shorter \`search\` (the smallest unique block, 3-8 lines) and a shorter \`replace\`.`,
    }
  }
  return call
}

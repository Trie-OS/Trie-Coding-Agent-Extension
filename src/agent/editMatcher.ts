export interface EditCandidate {
  startLine: number
  endLine: number
  text: string
  score?: number
}

export type EditRange =
  | {
      start: number
      end: number
      kind: 'exact' | 'whitespace' | 'lines'
      fileIndent: string
      searchIndent: string
      fileEol: '\n' | '\r\n'
      matchedStartLine?: number
      matchedEndLine?: number
    }
  | {
      error: 'ambiguous' | 'not_found'
      candidates: EditCandidate[]
      ambiguity?: 'exact' | 'whitespace'
    }

interface SourceLine {
  text: string
  start: number
}

function sourceLines(content: string): SourceLine[] {
  const lines = content.split('\n')
  let offset = 0
  return lines.map((line) => {
    const result = { text: line.endsWith('\r') ? line.slice(0, -1) : line, start: offset }
    offset += line.length + 1
    return result
  })
}

function searchLines(search: string): string[] {
  return search.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
}

function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ')
}

function indentation(line: string): string {
  return line.match(/^[ \t]*/)?.[0] ?? ''
}

function candidate(lines: SourceLine[], start: number, count: number, score?: number): EditCandidate {
  const selected = lines.slice(start, start + count)
  return {
    startLine: start + 1,
    endLine: start + count,
    text: selected.map((line) => line.text).join('\n'),
    ...(score === undefined ? {} : { score }),
  }
}

function similarity(a: string, b: string): number {
  const trigrams = (text: string): Map<string, number> => {
    const padded = `  ${normalizeLine(text)} `
    const counts = new Map<string, number>()
    for (let i = 0; i + 3 <= padded.length; i += 1) {
      const key = padded.slice(i, i + 3)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }
  const left = trigrams(a)
  const right = trigrams(b)
  const leftTotal = [...left.values()].reduce((sum, n) => sum + n, 0)
  const rightTotal = [...right.values()].reduce((sum, n) => sum + n, 0)
  if (leftTotal === 0 || rightTotal === 0) return normalizeLine(a) === normalizeLine(b) ? 1 : 0
  let shared = 0
  for (const [key, count] of left) shared += Math.min(count, right.get(key) ?? 0)
  return (2 * shared) / (leftTotal + rightTotal)
}

function nearestCandidates(lines: SourceLine[], wanted: string[], limit = 2): EditCandidate[] {
  if (lines.length === 0 || wanted.every((line) => normalizeLine(line) === '')) return []
  const count = Math.max(1, wanted.length)
  const scored: EditCandidate[] = []
  for (let start = 0; start + count <= lines.length; start += 1) {
    let total = 0
    for (let i = 0; i < count; i += 1) total += similarity(lines[start + i].text, wanted[i] ?? '')
    const score = total / count
    if (score >= 0.35) scored.push(candidate(lines, start, count, score))
  }
  return scored
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.startLine - b.startLine)
    .slice(0, limit)
}

/**
 * Durable edit path: replace an inclusive 1-based line window. The model does
 * not need to retype file bytes — only the new content and the line range
 * from a prior read_file.
 */
export function findLineRange(
  content: string,
  startLine: number,
  endLine: number,
): EditRange {
  const lines = sourceLines(content)
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > lines.length
  ) {
    return {
      error: 'not_found',
      candidates: [],
    }
  }

  const selected = lines.slice(startLine - 1, endLine)
  const firstFileContent =
    selected.find((line) => line.text.trim() !== '')?.text ?? selected[0]?.text ?? ''
  const start = selected[0].start
  const last = selected[selected.length - 1]
  // Include the newline after the last line when there is a following line, so
  // a full-line replacement stays line-aligned.
  let end = last.start + last.text.length
  if (endLine < lines.length) {
    const between = content.slice(end, lines[endLine].start)
    end += between.length
  }

  return {
    start,
    end,
    kind: 'lines',
    fileIndent: indentation(firstFileContent),
    searchIndent: '',
    fileEol: content.slice(start, Math.min(end, start + 4)).includes('\r\n') ? '\r\n' : '\n',
    matchedStartLine: startLine,
    matchedEndLine: endLine,
  }
}

/**
 * Finds a byte range without guessing. Exact text wins. Whitespace-normalized
 * unique matches are accepted. Near-misses are returned as candidates so the
 * harness can steer the model onto the durable line-anchored path.
 */
export function findEditRange(content: string, search: string): EditRange {
  if (search.length === 0) return { error: 'not_found', candidates: [] }
  const exactHits: number[] = []
  for (let offset = content.indexOf(search); offset !== -1; offset = content.indexOf(search, offset + 1)) {
    exactHits.push(offset)
  }
  if (exactHits.length === 1) {
    const exact = exactHits[0]
    return {
      start: exact,
      end: exact + search.length,
      kind: 'exact',
      fileIndent: '',
      searchIndent: '',
      fileEol: '\n',
    }
  }

  const lines = sourceLines(content)
  const wanted = searchLines(search)
  const count = wanted.length
  if (exactHits.length > 1) {
    const candidates = exactHits.slice(0, 3).map((offset) => {
      const startLine = lines.findIndex(
        (line, index) => offset >= line.start && (index + 1 === lines.length || offset < lines[index + 1].start),
      )
      return candidate(lines, Math.max(0, startLine), count)
    })
    return { error: 'ambiguous', candidates, ambiguity: 'exact' }
  }

  const normalizedWanted = wanted.map(normalizeLine)
  const hits: number[] = []
  for (let start = 0; start + count <= lines.length; start += 1) {
    if (normalizedWanted.every((line, index) => normalizeLine(lines[start + index].text) === line)) {
      hits.push(start)
    }
  }

  if (hits.length === 1) {
    const startLine = hits[0]
    const selected = lines.slice(startLine, startLine + count)
    const firstSearchContent = wanted.find((line) => line.trim() !== '') ?? wanted[0] ?? ''
    const firstFileContent =
      selected.find((line) => line.text.trim() !== '')?.text ?? selected[0]?.text ?? ''
    const start = selected[0].start
    const last = selected[selected.length - 1]
    return {
      start,
      end: last.start + last.text.length,
      kind: 'whitespace',
      fileIndent: indentation(firstFileContent),
      searchIndent: indentation(firstSearchContent),
      fileEol: content.slice(start, last.start).includes('\r\n') ? '\r\n' : '\n',
      matchedStartLine: startLine + 1,
      matchedEndLine: startLine + count,
    }
  }

  if (hits.length > 1) {
    return {
      error: 'ambiguous',
      candidates: hits.slice(0, 3).map((start) => candidate(lines, start, count)),
      ambiguity: 'whitespace',
    }
  }

  return { error: 'not_found', candidates: nearestCandidates(lines, wanted) }
}

export function reindentReplacement(
  replacement: string,
  fileIndent: string,
  searchIndent: string,
  fileEol: '\n' | '\r\n',
): string {
  const lines = replacement.replace(/\r\n/g, '\n').split('\n')
  const reindented =
    fileIndent === searchIndent || searchIndent === ''
      ? lines
      : lines.map((line) =>
          line.startsWith(searchIndent) ? fileIndent + line.slice(searchIndent.length) : line,
        )
  return reindented.join(fileEol)
}

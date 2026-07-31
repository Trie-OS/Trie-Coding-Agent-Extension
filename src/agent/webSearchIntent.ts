/**
 * Heuristic detection for when a user turn needs internet research.
 * Local 7–14B models often skip web_search even when it is in the tool list,
 * so the loop auto-prefetches when this returns true.
 */

const EXTERNAL_SIGNALS = [
  /\b(research|paper|papers|academic|scholar|arxiv|pubmed|cite|citation|literature)\b/i,
  /\b(search the (web|internet)|look up online|find online|on the internet)\b/i,
  /\b(latest|current|recent|up[- ]to[- ]date)\b.*\b(docs?|documentation|version|release|api)\b/i,
  /\b(documentation for|docs for)\b/i,
  /\bwhat (are|is) the best\b/i,
  /\b(benchmark|compare|comparison|versus|vs\.?)\b/i,
  /\b(news|announcement|changelog)\b/i,
  /\b(stack overflow|github discussions?)\b/i,
]

/** Obvious repo-local questions — skip auto web search. */
const LOCAL_ONLY = [
  /\b(this (file|function|class|module|repo|codebase))\b/i,
  /\bwhere is .+ (defined|declared|implemented)\b/i,
  /\bexplain (this|the) (code|function|class)\b/i,
  /\bwhat does .+ do in (this|the) (project|codebase|repo)\b/i,
]

export function taskNeedsWebSearch(task: string): boolean {
  const t = task.trim()
  if (t.length < 8) return false
  if (LOCAL_ONLY.some((re) => re.test(t))) return false
  return EXTERNAL_SIGNALS.some((re) => re.test(t))
}

/** Ceramic limits queries to ~50 words; keep the user's wording. */
export function buildWebSearchQuery(task: string): string {
  return task.trim().split(/\s+/).slice(0, 50).join(' ')
}

export function webSearchTaskNote(task: string): string {
  if (!taskNeedsWebSearch(task)) return ''
  return [
    'Note: this question needs information from the internet.',
    'Web search results are already in the transcript — cite their titles and full URLs in step_complete.summary.',
  ].join(' ')
}

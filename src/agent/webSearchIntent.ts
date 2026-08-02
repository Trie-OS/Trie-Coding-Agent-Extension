/**
 * Deterministic policy for whether the active user turn authorizes internet
 * access. This is intentionally narrower than "the model could benefit from
 * docs": ordinary coding work must proceed from repository evidence even when
 * local searches find nothing.
 */

const EXPLICIT_WEB_REQUEST = [
  /\b(?:search|browse)\s+(?:the\s+)?(?:web|internet)\b/i,
  /\b(?:search|find|look\s+up|check)\b[^.!?\n]{0,80}\b(?:online|on\s+the\s+(?:web|internet))\b/i,
  /\b(?:use|do|perform|conduct)\s+(?:an?\s+)?(?:online|web|internet)\s+(?:search|research)\b/i,
  /\b(?:research|investigate)\s+(?:this\s+)?(?:online|on\s+the\s+(?:web|internet))\b/i,
  /^\s*(?:please\s+)?(?:research|investigate)\b/i,
]

const CURRENT_EXTERNAL_FACT = [
  /\b(?:latest|newest|current|recent|today(?:'s)?|right\s+now|up[- ]to[- ]date|as\s+of\s+\w+)\b[^.!?\n]{0,100}\b(?:version|release|changelog|announcement|news|status|availability|price|pricing|weather|law|regulation|advisory|vulnerabilit(?:y|ies)|benchmark|documentation|docs?|api)\b/i,
  /\b(?:version|release|changelog|announcement|news|status|availability|price|pricing|weather|law|regulation|advisory|vulnerabilit(?:y|ies)|benchmark|documentation|docs?|api)\b[^.!?\n]{0,100}\b(?:latest|newest|current|recent|today(?:'s)?|right\s+now|up[- ]to[- ]date)\b/i,
]

const EXTERNAL_DOCUMENTATION = [
  /\b(?:consult|read|check|find|search|look\s+up|show\s+me)\s+(?:the\s+)?(?:official\s+)?(?:docs?|documentation|api\s+reference)\b/i,
  /\baccording\s+to\s+(?:the\s+)?(?:official\s+)?(?:docs?|documentation|api\s+reference)\b/i,
]

const SOURCED_RESEARCH = [
  /\b(?:cite|citation|citations|sources?|references?|bibliography|literature\s+review|arxiv|pubmed|academic\s+(?:paper|research)|research\s+papers?)\b/i,
  /\b(?:stack\s+overflow|github\s+discussions?)\b/i,
]

const LOCAL_CONTEXT = /\b(?:this|the|our|my)\s+(?:file|function|class|module|repo|repository|codebase|project|implementation|extension|app)\b/i
const EXTERNAL_ADVICE = /\b(?:best\s+practices?|compare|comparison|versus|vs\.?|benchmark)\b/i

export type WebSearchIntent =
  | { allowed: true; reason: 'explicit' | 'current' | 'documentation' | 'research' | 'external-advice' }
  | { allowed: false; reason: 'local-default' }

export function classifyWebSearchIntent(task: string): WebSearchIntent {
  const t = task.trim()
  if (t.length < 4) return { allowed: false, reason: 'local-default' }
  if (EXPLICIT_WEB_REQUEST.some((re) => re.test(t))) return { allowed: true, reason: 'explicit' }
  if (CURRENT_EXTERNAL_FACT.some((re) => re.test(t))) return { allowed: true, reason: 'current' }
  if (EXTERNAL_DOCUMENTATION.some((re) => re.test(t))) {
    return { allowed: true, reason: 'documentation' }
  }
  if (SOURCED_RESEARCH.some((re) => re.test(t))) return { allowed: true, reason: 'research' }
  if (!LOCAL_CONTEXT.test(t) && EXTERNAL_ADVICE.test(t)) {
    return { allowed: true, reason: 'external-advice' }
  }
  return { allowed: false, reason: 'local-default' }
}

export function taskNeedsWebSearch(task: string): boolean {
  return classifyWebSearchIntent(task).allowed
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

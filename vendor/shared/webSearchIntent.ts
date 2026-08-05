/**
 * Execution-time internet access policy. A configured provider is capability,
 * not authorization: each active user task must independently justify search.
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

export function taskAllowsWebSearch(task: string): boolean {
  const value = task.trim()
  if (value.length < 4) return false
  if (EXPLICIT_WEB_REQUEST.some((pattern) => pattern.test(value))) return true
  if (CURRENT_EXTERNAL_FACT.some((pattern) => pattern.test(value))) return true
  if (EXTERNAL_DOCUMENTATION.some((pattern) => pattern.test(value))) return true
  if (SOURCED_RESEARCH.some((pattern) => pattern.test(value))) return true
  return !LOCAL_CONTEXT.test(value) && EXTERNAL_ADVICE.test(value)
}

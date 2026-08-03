/** Heuristic: user wants files modified (not just an answer). */
const CODE_CHANGE_SIGNALS = [
  /\b(change|update|fix|add|allow|build|enable|support|remove|implement|refactor|rename|create|delete|modify|edit|rewrite|migrate|replace)\b/i,
  /\b(make|set|turn|switch)\b.+\b(to|into)\b/i,
]

const CODE_CHANGE_EXCLUSIONS = [
  /\b(explain|describe|what (is|does|are)|how (does|do|to)|where is|list|show me)\b/i,
  /^\s*(?:please\s+)?(?:research|investigate)\b/i,
  /\b(?:plan for|implementation plan)\b/i,
]

export function taskExpectsCodeChanges(task: string): boolean {
  const t = task.trim()
  if (t.length < 6) return false
  if (CODE_CHANGE_EXCLUSIONS.some((re) => re.test(t))) return false
  return CODE_CHANGE_SIGNALS.some((re) => re.test(t))
}

const NEW_FEATURE_SIGNALS = [
  /\b(?:add|allow|implement|build|create|introduce|support|enable)\b[^.!?\n]{0,100}\b(?:feature|support|capability|flow|integration|handling|handler|upload|attachment|drag(?:\s+and)?\s+drop)\b/i,
  /\b(?:add|allow|implement|build|create|introduce|support|enable)\b/i,
]

/** A requested capability may legitimately have no matching symbol yet. */
export function taskAddsNewFeature(task: string): boolean {
  const t = task.trim()
  if (!taskExpectsCodeChanges(t)) return false
  return NEW_FEATURE_SIGNALS.some((pattern) => pattern.test(t))
}

const DISCOVERY_STOP_WORDS = new Set([
  'a', 'an', 'and', 'allow', 'add', 'build', 'create', 'enable', 'feature', 'for', 'implement',
  'in', 'new', 'of', 'our', 'please', 'support', 'the', 'to', 'we', 'with',
])
const INTEGRATION_TERMS = new Set([
  'app', 'attachment', 'chat', 'composer', 'controller', 'editor', 'extension', 'handler', 'input',
  'main', 'message', 'panel', 'provider', 'renderer', 'service', 'store', 'view', 'webview',
])

function searchTerms(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .match(/[a-z][a-z0-9_-]*/g)
      ?.filter((term) => term.length > 2 && !DISCOVERY_STOP_WORDS.has(term)) ?? [],
  )
}

function noDirectSearchMatch(result: string): boolean {
  return /\b(?:no declarations found|no symbols|no matches|no files matched)\b/i.test(result)
}

/**
 * Bounds searches for a requested feature's nonexistent implementation while
 * leaving architecture/integration-point searches unrestricted.
 */
export class NewFeatureDiscoveryGuard {
  private readonly featureTerms: Set<string>
  private readonly maxDirectMisses: number
  private emptyDirectSearches = 0

  constructor(task: string, maxDirectMisses = 2) {
    this.featureTerms = taskAddsNewFeature(task) ? searchTerms(task) : new Set()
    this.maxDirectMisses = maxDirectMisses
  }

  private isDirectFeatureSearch(query: string): boolean {
    if (this.featureTerms.size === 0) return false
    const terms = searchTerms(query)
    if ([...terms].some((term) => INTEGRATION_TERMS.has(term))) return false
    return [...terms].some((term) => this.featureTerms.has(term))
  }

  beforeSearch(query: string): string | null {
    if (!this.isDirectFeatureSearch(query) || this.emptyDirectSearches < this.maxDirectMisses) {
      return null
    }
    return [
      'Skipped repeated feature-existence search: targeted local searches already established that this new capability has no direct implementation.',
      'That absence is expected for an add/implement/build request and is not a reason to broaden the query or use web search.',
      'Pivot now: inspect likely integration points (for example composer, webview, provider, message, attachment, or input files), read their architecture, then plan or implement the feature.',
    ].join(' ')
  }

  afterSearch(query: string, result: string): string {
    if (!this.isDirectFeatureSearch(query) || !noDirectSearchMatch(result)) return result
    this.emptyDirectSearches += 1
    const remaining = Math.max(0, this.maxDirectMisses - this.emptyDirectSearches)
    const nudge =
      remaining > 0
        ? `This is a new-feature request, so no existing implementation is expected. At most ${remaining} more targeted feature-existence search is useful; then inspect likely integration files and implement.`
        : 'Feature-existence discovery is complete. Do not broaden or repeat this search and do not escalate to web search. Inspect likely integration files/architecture and proceed to plan or edit.'
    return `${result}\n\nNEXT STEP: ${nudge}`
  }
}

/** Sparse per-turn Hybrid recovery gate: one cloud intervention per stuck episode. */
export class StuckRecoveryGate {
  private issued = false

  reset(): void {
    this.issued = false
  }

  claim(enabled: boolean): boolean {
    if (!enabled || this.issued) return false
    this.issued = true
    return true
  }
}

const TRIVIAL_CONVERSATION = [
  /^(?:hi|hello|hey|hiya|howdy|yo)(?:\s+(?:there|trie|agent))?[!.?]*$/i,
  /^(?:good\s+(?:morning|afternoon|evening))[!.?]*$/i,
  /^(?:how are you|what'?s up|sup)[!.?]*$/i,
  /^(?:thanks|thank you|thx|cool|great|nice|ok|okay|got it)[!.?]*$/i,
  /^(?:test|testing|ping)[!.?]*$/i,
]

/** Turns with no engineering decision or work should never spend a frontier-model call. */
export function isTrivialConversation(task: string): boolean {
  const normalized = task.trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > 80) return false
  return TRIVIAL_CONVERSATION.some((pattern) => pattern.test(normalized))
}

const FILE_EXT = String.raw`(?:swift|tsx?|jsx?|py|rs|go|java|kt|css|scss|html|json|ya?ml|md|m|h)`
const CHANGE_VERB = /\b(updated?|changed?|modified|edited|wrote|created?|fixed|replaced|added|removed|set)\b/i

const CODEBASE_EXPLORATION_SIGNALS = [
  /\brecommend(?:ation)?s?\b/i,
  /\bsuggest(?:ion)?s?\b/i,
  /\b(?:give|make|provide)\b[^.!?\n]{0,40}\b(?:recommendations|suggestions)\b/i,
  /\b(improve|improvement|optimi[sz]e|audit|review)\b[^.!?\n]{0,60}\b(project|codebase|repo(?:sitory)?|app|this)\b/i,
  /\b(project|codebase|repo(?:sitory)?|this app)\b[^.!?\n]{0,60}\b(recommend|suggest|review|audit|improve)/i,
  /\bwhat (?:should|could) (?:we|I) (?:improve|change|fix|do)\b/i,
  /\btell me how\b[^.!?\n]{0,80}\b(?:improve|better|could be improved)\b/i,
  /\bhow\b[^.!?\n]{0,80}\b(?:could|can|should)\b[^.!?\n]{0,40}\b(?:be )?(?:improved|better)\b/i,
  /\b(?:agent|harness|workflow|loop)\b[^.!?\n]{0,60}\b(?:improve|better|improved|improvement)\b/i,
  /\bhow (?:can|could|should) (?:we|I|you) improve\b/i,
  /\bhow (?:can|could|should)\b[^.!?\n]{0,40}\bimprove\b/i,
  /\bimprove\b[^.!?\n]{0,80}\b(?:agent|harness|workflow|loop|this)\b/i,
]

/** Recommendations / project reviews need repo reads before step_complete. */
export function taskNeedsCodebaseExploration(task: string): boolean {
  const t = task.trim()
  if (t.length < 8 || isTrivialConversation(t)) return false
  if (taskExpectsCodeChanges(t)) return false
  return CODEBASE_EXPLORATION_SIGNALS.some((pattern) => pattern.test(t))
}

/** Scope-narrowing clarifiers are inappropriate for broad improvement asks. */
export function isScopeNarrowingQuestion(args: Record<string, unknown>): boolean {
  const raw = args['questions']
  if (!Array.isArray(raw)) return false
  return raw.some((item) => {
    if (typeof item !== 'object' || item === null) return false
    const text = typeof (item as Record<string, unknown>)['question'] === 'string'
      ? ((item as Record<string, unknown>)['question'] as string)
      : ''
    if (!text.trim()) return false
    return (
      /\b(?:which|what specific|narrow|scope|area|aspect|part of)\b/i.test(text) &&
      /\b(?:improve|focus|priorit|recommend|change|harness|agent)\b/i.test(text)
    )
  })
}

export function taskAsksForRecommendations(task: string): boolean {
  return (
    taskNeedsCodebaseExploration(task) &&
    /\brecommend|\bsuggest|\bimprove|\baudit|\breview\b/i.test(task)
  )
}

/**
 * Light intent routing only — no fixed format/count. Quality is judged by an
 * LLM at finish time, not by deterministic checklist rules.
 */
export function recommendationTaskNote(task: string, mode: 'code' | 'plan' | 'ask'): string {
  if (!taskAsksForRecommendations(task)) return ''
  const readOnly =
    mode !== 'code'
      ? 'Read-only mode: put the answer in step_complete.summary; do not edit files.'
      : 'Only edit files if the user also asked you to implement changes.'
  if (taskAsksForHarnessImprovement(task)) {
    return [
      'Note: the user wants a robust harness improvement analysis grounded in this codebase.',
      'Use targeted search, then inspect at most 3 high-signal files unless critical evidence is still missing; synthesize instead of touring the repository.',
      'Prioritize loop.ts, tools.ts, prompts.ts, permissions, ChatViewProvider, or verification policy based on what the search reveals.',
      'Write markdown in step_complete.summary with sections: opening thesis (1–2 sentences), ### Priority gaps (numbered; each names area + current behavior + gap + concrete file-level fix), optional ### Already strong, ### Bottom line (highest-ROI next steps).',
      'Put each numbered list item on its own line. No comma-separated lists. No generic tips like "add more logging" or "consider exposing options".',
      'Do not call ask_user_question to narrow scope.',
      readOnly,
    ].join(' ')
  }
  return [
    'Note: the user wants recommendations / improvement advice grounded in this codebase.',
    'Explore loop.ts, tools.ts, prompts.ts, permissions, and chat UI as needed.',
    'Answer with numbered, file-grounded recommendations — each item names a module/file and a concrete harness change. No generic "optimize performance" or "maintain clean structure" platitudes.',
    'Do not call ask_user_question to narrow scope when the user asked broadly; cover the main harness areas in one answer.',
    'Do not end with step_failed apologies.',
    readOnly,
  ].join(' ')
}

export function taskAsksForHarnessImprovement(task: string): boolean {
  return taskAsksForRecommendations(task) && /\b(?:agent|harness|workflow|tool loop)\b/i.test(task)
}

/** Summaries that punt to docs instead of answering after exploration. */
export function summaryDeflectsToDocs(summary: string): boolean {
  const s = summary.trim()
  if (!/\bread\b[^.!?\n]{0,60}\b(?:docs\/|documentation|\.\/)?\S+\.(?:md|txt|html)\b/i.test(s)) {
    return false
  }
  const hasStructuredAdvice = /(?:^|\n)\s*(?:\d+[.)]|[-*•])\s+\S/m.test(s)
  if (hasStructuredAdvice) return false
  if (/\bfor more (?:information|details|context)\b/i.test(s) && s.length < 500) return true
  return s.length < 320
}

export function summaryMissesRecommendationAsk(task: string, summary: string): boolean {
  if (!taskAsksForRecommendations(task)) return false

  const s = summary.trim()
  if (s.length < 80) return true
  if (summaryDeflectsToDocs(s)) return true
  return false
}

/**
 * Small models often call step_failed with a meta-apology ("I failed to
 * recommend…") instead of answering. That ends the turn in red — refuse it.
 */
export function isAbandonedRecommendationFailure(task: string, reason: string): boolean {
  if (!taskAsksForRecommendations(task)) return false
  const r = reason.trim()
  if (!r) return true
  return /\b(i (?:failed|misunderstood|could not|couldn't|was unable)|failed to provide|unable to provide|will retry|retry with|misread the (?:task|request)|proper action plan)\b/i.test(
    r,
  )
}

/** Placeholder or teaser summaries the model sometimes emits instead of an answer. */
export function isLazyStepCompleteSummary(summary: string): boolean {
  const s = summary.trim()
  if (!s) return true
  if (s === 'Done.' || s === 'Failed.') return false

  const compact = s.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim()

  if (
    /^(?:here (?:are|is)|below (?:are|is)|the following|my (?:recommendations|suggestions)|recommendations:?)\s*[.…]{2,}\s*$/i.test(
      compact,
    )
  ) {
    return true
  }
  if (/^(?:let me|i'll|i will|working on|one moment|stand by)\b/i.test(compact) && compact.length < 80) {
    return true
  }
  if (compact.length < 40 && /[.…]{2}/.test(compact)) return true
  if (/[.…]{3,}\s*$/.test(compact) && compact.length < 120) return true

  return false
}

/** step_complete.summary claims files were edited — must match a real edit_file/write_file. */
export function summaryClaimsFileChanges(summary: string): boolean {
  const s = summary.trim()
  if (s.length < 10) return false
  if (CHANGE_VERB.test(s) && new RegExp(String.raw`\.${FILE_EXT}\b`, 'i').test(s)) return true
  if (/`[^`]+\.[a-z0-9]+`/i.test(s) && CHANGE_VERB.test(s)) return true
  if (/\bNew\s+\w+.*:/i.test(s) && new RegExp(String.raw`\.${FILE_EXT}\b`, 'i').test(s)) return true
  return false
}

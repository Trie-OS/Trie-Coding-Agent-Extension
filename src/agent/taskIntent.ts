/** Heuristic: user wants files modified (not just an answer). */
const CODE_CHANGE_SIGNALS = [
  /\b(change|update|fix|add|remove|implement|refactor|rename|create|delete|modify|edit|rewrite|migrate|replace)\b/i,
  /\b(make|set|turn|switch)\b.+\b(to|into)\b/i,
]

const CODE_CHANGE_EXCLUSIONS = [
  /\b(explain|describe|what (is|does|are)|how (does|do|to)|where is|list|show me)\b/i,
  /\b(research|paper|papers|plan for|implementation plan)\b/i,
]

export function taskExpectsCodeChanges(task: string): boolean {
  const t = task.trim()
  if (t.length < 6) return false
  if (CODE_CHANGE_EXCLUSIONS.some((re) => re.test(t))) return false
  return CODE_CHANGE_SIGNALS.some((re) => re.test(t))
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

/** step_complete.summary claims files were edited — must match a real edit_file/write_file. */
export function summaryClaimsFileChanges(summary: string): boolean {
  const s = summary.trim()
  if (s.length < 10) return false
  if (CHANGE_VERB.test(s) && new RegExp(String.raw`\.${FILE_EXT}\b`, 'i').test(s)) return true
  if (/`[^`]+\.[a-z0-9]+`/i.test(s) && CHANGE_VERB.test(s)) return true
  if (/\bNew\s+\w+.*:/i.test(s) && new RegExp(String.raw`\.${FILE_EXT}\b`, 'i').test(s)) return true
  return false
}

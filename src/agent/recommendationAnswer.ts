/**
 * Recommendation-ask finish path: light intent routing + LLM-as-judge.
 *
 * The harness does not prescribe a fixed shape (e.g. "4–7 bullets"). A judge
 * model call decides whether the draft actually answers the user's ask; if not,
 * one rewrite uses the judge's feedback. No deterministic keyword gates.
 */
import type { ChatTurn, GenerationParams, InferenceClient } from '../inference/types'
import { taskAsksForRecommendations } from './taskIntent.ts'
import { parseToolCall } from './toolParse.ts'

const TOOL_NAMES = new Set(['step_complete', 'step_failed', 'read_file', 'grep', 'search_symbols'])

export interface RecommendationJudgment {
  adequate: boolean
  feedback: string
}

function extractAnswerText(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''

  const parsed = parseToolCall(trimmed, TOOL_NAMES)
  if (!('error' in parsed)) {
    const summary = parsed.args['summary']
    const reason = parsed.args['reason']
    if (typeof summary === 'string' && summary.trim()) return summary.trim()
    if (typeof reason === 'string' && reason.trim()) return reason.trim()
  }

  const fence = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)```$/i)
  if (fence?.[1]) return fence[1].trim()
  return trimmed
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** Obvious non-answers — skip straight to rewrite without spending a judge call. */
export function isObviouslyFailedRecommendationDraft(draft: string): boolean {
  const s = draft.trim()
  if (!s || s.length < 40) return true
  return /\b(i failed|i misunderstood|will retry|failed to provide|unable to provide|proper action plan)\b/i.test(
    s,
  )
}

/**
 * LLM-as-judge: does this draft satisfy the user's recommendation ask?
 * Rubric is semantic — no fixed count/format requirements.
 */
export async function judgeRecommendationAnswer(
  client: InferenceClient,
  task: string,
  draft: string,
  params: GenerationParams,
  signal: AbortSignal,
): Promise<RecommendationJudgment> {
  if (!taskAsksForRecommendations(task)) {
    return { adequate: true, feedback: '' }
  }
  if (isObviouslyFailedRecommendationDraft(draft)) {
    return {
      adequate: false,
      feedback:
        'Draft is empty, an apology, or a promise to retry — write real recommendations grounded in the exploration.',
    }
  }

  try {
    const turns: ChatTurn[] = [
      {
        role: 'system',
        content: [
          'You judge whether an assistant draft answers a recommendations / improvements request.',
          'Reply with exactly one JSON object and nothing else:',
          '{"adequate": true|false, "feedback": "<one or two sentences>"}',
          'adequate=true only if the draft gives concrete, actionable improvement advice grounded in the codebase/context.',
          'adequate=false for architecture inventories, file tours, analysis-complete claims, apologies, or vague non-advice.',
          'Do NOT require a specific number of bullets or a fixed template — judge substance.',
          'feedback must tell the writer what to fix when adequate is false; empty when true.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `User request:\n${task}`,
          '',
          'Assistant draft:\n' + draft.trim().slice(0, 5000),
        ].join('\n'),
      },
    ]
    const result = await client.generate(
      turns,
      { ...params, temperature: 0.1, maxTokens: 160 },
      () => {},
      signal,
    )
    const parsed = extractJsonObject(result.text)
    if (!parsed || typeof parsed.adequate !== 'boolean') {
      // Fail open on judge parse errors — don't block a reasonable draft.
      return { adequate: !isObviouslyFailedRecommendationDraft(draft), feedback: '' }
    }
    return {
      adequate: parsed.adequate,
      feedback:
        typeof parsed.feedback === 'string' ? parsed.feedback.trim().slice(0, 500) : '',
    }
  } catch {
    return { adequate: !isObviouslyFailedRecommendationDraft(draft), feedback: '' }
  }
}

/** One rewrite guided by judge feedback (not a fixed template). */
export async function rewriteRecommendationAnswer(
  client: InferenceClient,
  task: string,
  notes: string,
  draft: string,
  feedback: string,
  params: GenerationParams,
  signal: AbortSignal,
): Promise<string | null> {
  if (!taskAsksForRecommendations(task)) return null
  try {
    const turns: ChatTurn[] = [
      {
        role: 'system',
        content: [
          'You are rewriting an answer to a recommendations request for a coding agent.',
          'Output markdown only — no JSON, no tool calls, no apologies, no "I will retry".',
          'Satisfy the judge feedback. Give concrete, actionable improvement advice grounded in the notes.',
          'Do not invent a mandatory bullet count; write what best answers the user.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `User request:\n${task}`,
          '',
          `Judge feedback:\n${feedback.trim() || 'Draft did not answer with actionable recommendations.'}`,
          '',
          'Exploration notes / prior draft:',
          notes.trim().slice(0, 6500) || '(none)',
          '',
          'Prior draft to replace:',
          draft.trim().slice(0, 2500) || '(none)',
          '',
          'Write the improved answer now.',
        ].join('\n'),
      },
    ]
    const result = await client.generate(
      turns,
      { ...params, temperature: 0.35, maxTokens: Math.max(params.maxTokens, 900) },
      () => {},
      signal,
    )
    const text = extractAnswerText(result.text)
    if (!text || text.length < 40) return null
    return text
  } catch {
    return null
  }
}

/**
 * Finish a recommendation ask: judge the draft; rewrite once if needed.
 * Always returns a user-facing answer string (never an apology-only failure).
 */
export async function finishRecommendationAnswer(
  client: InferenceClient,
  task: string,
  draft: string,
  notes: string,
  params: GenerationParams,
  signal: AbortSignal,
  options: { forceRewrite?: boolean } = {},
): Promise<string> {
  const initial = draft.trim()
  if (!options.forceRewrite) {
    const judgment = await judgeRecommendationAnswer(client, task, initial, params, signal)
    if (judgment.adequate) return initial
    const rewritten = await rewriteRecommendationAnswer(
      client,
      task,
      notes,
      initial,
      judgment.feedback,
      params,
      signal,
    )
    if (rewritten) return rewritten
  } else {
    const judgment = await judgeRecommendationAnswer(
      client,
      task,
      initial || '(empty — model called step_failed)',
      params,
      signal,
    )
    const rewritten = await rewriteRecommendationAnswer(
      client,
      task,
      notes,
      initial,
      judgment.feedback ||
        'Model ended with step_failed / an apology. Write the recommendations the user asked for.',
      params,
      signal,
    )
    if (rewritten) return rewritten
  }

  // Last resort: never ship a pure apology as the turn result.
  if (initial && !isObviouslyFailedRecommendationDraft(initial)) return initial
  return [
    'I explored the codebase for your recommendations ask but could not finalize a strong answer in this pass.',
    'Try asking again, or narrow the area (for example: edit_file reliability, ask-mode finishes, or hybrid review).',
  ].join(' ')
}

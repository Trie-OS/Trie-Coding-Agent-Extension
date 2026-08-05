/**
 * Recommendation-ask finish path: light intent routing + LLM-as-judge.
 *
 * Deterministic checks are limited to obvious non-answers (empty, doc handoff,
 * apologies). Substance — shallow vs robust — is judged semantically; one rewrite
 * uses the judge's feedback.
 */
import type { ChatTurn, GenerationParams, InferenceClient } from '../inference/types'
import {
  summaryDeflectsToDocs,
  taskAsksForHarnessImprovement,
  taskAsksForRecommendations,
} from './taskIntent.ts'
import type { FrontierAssist } from './frontierAssist.ts'
import type { TurnBudget } from './turnBudget.ts'
import { sanitizeReplyText } from './thoughtStream.ts'

const FINAL_SYNTHESIS_MAX_TOKENS = 4096
const FINAL_SYNTHESIS_MAX_CHUNKS = 3
const CONTINUATION_MAX_TOKENS = 2048

export interface RecommendationJudgment {
  adequate: boolean
  factuallyGrounded: boolean
  feedback: string
  rejectedClaims: Array<{
    claim: string
    reason: string
    evidenceIds: string[]
  }>
  tokensIn?: number
  tokensOut?: number
}

export interface RecommendationFinishOptions {
  forceRewrite?: boolean
  frontier?: FrontierAssist
  evidence?: string
  budget?: TurnBudget
  onReplyStart?: () => void
  onReplyChunk?: (chunk: string) => void
  onReplyDiscard?: () => void
  onPhase?: (
    phase: 'judge' | 'synthesis',
    durationMs: number,
    truncationRetries: number,
    tokensIn: number,
    tokensOut: number,
  ) => void
}

function extractAnswerText(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''

  const fence = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)```$/i)
  const answer = sanitizeReplyText(fence?.[1] ?? trimmed)
  if (!answer.startsWith('{')) return answer
  try {
    const parsed = JSON.parse(answer) as unknown
    // Recommendation synthesis is explicitly markdown-only. A bare JSON
    // object here is control/judge output, not a user-facing final answer.
    if (typeof parsed === 'object' && parsed !== null) return ''
  } catch {
    // Keep prose that merely begins with a brace.
  }
  return answer
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

export function stitchSynthesisContinuation(partial: string, continuation: string): string {
  const next = continuation.trimStart()
  if (!next) return partial
  const maxOverlap = Math.min(500, partial.length, next.length)
  for (let size = maxOverlap; size >= 12; size--) {
    if (partial.slice(-size) === next.slice(0, size)) {
      return partial + next.slice(size)
    }
  }
  return partial + next
}

function continuationRequest(originalRequest: string, partial: string): string {
  return [
    originalRequest,
    '',
    'The answer reached the provider output limit. Continue from the exact cutoff below.',
    'Output only the new continuation text. Do not restart, repeat headings, summarize, or wrap it in a code fence.',
    '',
    'PARTIAL ANSWER:',
    partial.slice(-16_000),
  ].join('\n')
}

function createReplyStreamer(
  onReplyStart?: () => void,
  onReplyChunk?: (chunk: string) => void,
  onReplyDiscard?: () => void,
) {
  let started = false
  const push = (chunk: string) => {
    if (!chunk) return
    if (!started) {
      started = true
      onReplyStart?.()
    }
    onReplyChunk?.(chunk)
  }
  const reset = () => {
    if (!started) return
    started = false
    onReplyDiscard?.()
  }
  return { push, reset }
}

/** Obvious non-answers — skip the judge call and go straight to rewrite. */
export function isObviouslyFailedRecommendationDraft(draft: string): boolean {
  const s = draft.trim()
  if (!s || s.length < 40) return true
  if (summaryDeflectsToDocs(s)) return true
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
  frontier?: FrontierAssist,
  evidence = '',
  budget?: TurnBudget,
): Promise<RecommendationJudgment> {
  if (!taskAsksForRecommendations(task)) {
    return { adequate: true, factuallyGrounded: true, feedback: '', rejectedClaims: [] }
  }
  if (isObviouslyFailedRecommendationDraft(draft)) {
    return {
      adequate: false,
      factuallyGrounded: false,
      feedback:
        'Draft is empty, deflects to docs, or is an apology — write substantive recommendations grounded in the exploration.',
      rejectedClaims: [],
    }
  }

  try {
    const turns: ChatTurn[] = [
      {
        role: 'system',
        content: [
          'You judge whether an assistant draft answers a recommendations / improvements request.',
          'Reply with exactly one JSON object and nothing else:',
          '{"adequate": true|false, "factuallyGrounded": true|false, "feedback": "<one or two sentences>", "rejectedClaims": [{"claim": "...", "reason": "...", "evidenceIds": ["E1"]}]}',
          'Judge substance and factual support, not formatting, headings, list length, or rhetorical polish.',
          'factuallyGrounded=true only when current-state claims are supported by the labeled exploration evidence and the draft cites the relevant repository path.',
          'Set factuallyGrounded=false for claims contradicted by evidence, claims that something is absent without evidence, or recommendations based on invented repository behavior.',
          'Absence claims require discovery evidence followed by an exact read marked discovered-before-read=yes; otherwise reject them.',
          'adequate=true only when advice is actionable and specific enough to implement.',
          'A polished template or file-name list is not evidence.',
          'rejectedClaims must be an array (empty when none). Include every contradicted or unsupported current-state claim with relevant evidence IDs.',
          'feedback must tell the writer what to fix when adequate is false; empty when true.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `User request:\n${task}`,
          '',
          `Labeled exploration evidence:\n${evidence.trim() || '(none supplied — current-state claims cannot be verified)'}`,
          '',
          'Assistant draft:\n' + draft.trim().slice(0, 5000),
        ].join('\n'),
      },
    ]
    const useFrontier = frontier?.enabled() === true
    const phaseSignal = budget?.signal(signal, 30_000) ?? signal
    const frontierResult = useFrontier
      ? await frontier.completeResult(turns[0]!.content, turns[1]!.content, {
          maxTokens: 160,
          temperature: 0.1,
          signal: phaseSignal,
          timeoutMs: budget?.remainingMs(),
        })
      : null
    let text = frontierResult?.truncated ? '' : (frontierResult?.text ?? '')
    let tokensIn = frontierResult?.tokensIn ?? 0
    let tokensOut = frontierResult?.tokensOut ?? 0
    if (!text && !useFrontier) {
      if (budget && !budget.claimLocalGeneration()) {
        return {
          adequate: false,
          factuallyGrounded: false,
          feedback: 'Local generation budget exhausted before judging.',
          rejectedClaims: [],
        }
      }
      const localResult = await client.generate(
          turns,
          { ...params, temperature: 0.1, maxTokens: 160 },
          () => {},
          phaseSignal,
        )
      text = localResult.truncated ? '' : localResult.text
      tokensIn += localResult.tokensIn
      tokensOut += localResult.tokensOut
    }
    const parsed = extractJsonObject(text)
    if (
      !parsed ||
      typeof parsed.adequate !== 'boolean' ||
      typeof parsed.factuallyGrounded !== 'boolean' ||
      !Array.isArray(parsed.rejectedClaims)
    ) {
      return {
        adequate: false,
        factuallyGrounded: false,
        feedback: 'Judge output was incomplete; rewrite conservatively from the labeled evidence.',
        rejectedClaims: [],
        tokensIn,
        tokensOut,
      }
    }
    const factuallyGrounded = parsed.factuallyGrounded
    const rejectedClaims = parsed.rejectedClaims
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        claim: typeof item.claim === 'string' ? item.claim.slice(0, 500) : '',
        reason: typeof item.reason === 'string' ? item.reason.slice(0, 500) : '',
        evidenceIds: Array.isArray(item.evidenceIds)
          ? item.evidenceIds.filter((id): id is string => typeof id === 'string').slice(0, 8)
          : [],
      }))
      .filter((item) => item.claim || item.reason)
    return {
      adequate: parsed.adequate && factuallyGrounded,
      factuallyGrounded,
      feedback:
        typeof parsed.feedback === 'string' ? parsed.feedback.trim().slice(0, 500) : '',
      rejectedClaims,
      tokensIn,
      tokensOut,
    }
  } catch {
    return {
      adequate: false,
      factuallyGrounded: false,
      feedback: 'Judge failed; rewrite conservatively from the labeled evidence.',
      rejectedClaims: [],
    }
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
  frontier?: FrontierAssist,
  evidence = '',
  budget?: TurnBudget,
  onTruncationRetry?: () => void,
  onUsage?: (tokensIn: number, tokensOut: number) => void,
  stream?: Pick<RecommendationFinishOptions, 'onReplyStart' | 'onReplyChunk' | 'onReplyDiscard'>,
): Promise<string | null> {
  if (!taskAsksForRecommendations(task)) return null
  const harness = taskAsksForHarnessImprovement(task)
  const replyStream = createReplyStreamer(
    stream?.onReplyStart,
    stream?.onReplyChunk,
    stream?.onReplyDiscard,
  )
  const emitReplyChunk = replyStream.push
  try {
    const turns: ChatTurn[] = [
      {
        role: 'system',
        content: [
          'You are rewriting an answer to a recommendations request for a coding agent.',
          'Output markdown only — no JSON, no tool calls, no apologies, no "I will retry".',
          'Satisfy the judge feedback. Give concrete, actionable improvement advice grounded in the notes.',
          'Treat labeled exploration evidence as the source of truth. Do not claim a feature/file is missing unless the evidence establishes that.',
          'Cite repository paths from the evidence inline for every current-state claim.',
          harness
            ? [
                'Structure:',
                '- Opening thesis (1–2 sentences on the biggest harness gaps).',
                '- ### Priority gaps — numbered list; each item: **Area** — current behavior, gap, concrete fix (file + specific change).',
                '- Optional ### Already strong — brief bullets.',
                '- ### Bottom line — 2–3 highest-ROI next steps.',
                'One numbered item per line. Use ### headers. Optional markdown table for area comparisons.',
                'Be specific (refuse step_complete on X, permanent allow rules in permissions.ts) — never "add more logging" or "consider exposing options".',
              ].join('\n')
            : 'Use ### sections and one item per line for numbered lists. Be specific — name files and concrete changes.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `User request:\n${task}`,
          '',
          `Judge feedback:\n${feedback.trim() || 'Draft did not answer with actionable recommendations.'}`,
          '',
          'Labeled exploration evidence (source of truth):',
          evidence.trim().slice(0, 12_000) || '(none)',
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
    // max_tokens is a ceiling, not a reservation: providers stop naturally
    // when the answer is complete, so a generous ceiling does not force waste.
    const maxTokens = FINAL_SYNTHESIS_MAX_TOKENS
    let raw = ''
    if (frontier?.enabled()) {
      try {
        let result = await frontier.completeResult(turns[0]!.content, turns[1]!.content, {
          maxTokens,
          temperature: 0.35,
          signal: budget?.signal(signal, 30_000) ?? signal,
          timeoutMs: budget?.remainingMs(),
          onToken: emitReplyChunk,
        })
        raw = result?.text ?? ''
        if (result) onUsage?.(result.tokensIn ?? 0, result.tokensOut ?? 0)
        let chunks = 1
        while (result?.truncated && chunks < FINAL_SYNTHESIS_MAX_CHUNKS) {
          onTruncationRetry?.()
          const continuation = await frontier.completeResult(
            turns[0]!.content,
            continuationRequest(turns[1]!.content, raw),
            {
              maxTokens: CONTINUATION_MAX_TOKENS,
              temperature: 0.25,
              signal: budget?.signal(signal, 30_000) ?? signal,
              timeoutMs: budget?.remainingMs(),
              onToken: emitReplyChunk,
            },
          )
          if (!continuation) {
            raw = ''
            break
          }
          onUsage?.(continuation.tokensIn ?? 0, continuation.tokensOut ?? 0)
          result = continuation
          raw = stitchSynthesisContinuation(raw, result.text)
          chunks += 1
        }
        // A truncated frontier answer is never user-facing. Use a fresh local
        // synthesis below rather than exposing its potentially incomplete text.
        if (result?.truncated) {
          raw = ''
          replyStream.reset()
        }
      } catch {
        raw = ''
      }
    }

    if (!raw) {
      // Hybrid is an assist, not a single point of failure. When its provider
      // fails or truncates, the local model still gets the same evidence-grounded
      // synthesis prompt. Never continue after an explicit stop or deadline.
      if (signal.aborted || budget?.expired()) return null
      if (budget && !budget.claimLocalGeneration()) return null
      const localMaxTokens = Math.max(params.maxTokens, FINAL_SYNTHESIS_MAX_TOKENS)
      let result = await client.generate(
        turns,
        {
          ...params,
          temperature: 0.35,
          maxTokens: localMaxTokens,
        },
        emitReplyChunk,
        budget?.signal(signal) ?? signal,
      )
      raw = result.text
      onUsage?.(result.tokensIn, result.tokensOut)
      let chunks = 1
      while (result.truncated && chunks < FINAL_SYNTHESIS_MAX_CHUNKS) {
        onTruncationRetry?.()
        if (budget && !budget.claimLocalGeneration()) return null
        result = await client.generate(
          [
            ...turns,
            { role: 'assistant', content: raw },
            {
              role: 'user',
              content: continuationRequest(turns[1]!.content, raw),
            },
          ],
          {
            ...params,
            temperature: 0.25,
            maxTokens: CONTINUATION_MAX_TOKENS,
          },
          emitReplyChunk,
          budget?.signal(signal) ?? signal,
        )
        onUsage?.(result.tokensIn, result.tokensOut)
        raw = stitchSynthesisContinuation(raw, result.text)
        chunks += 1
      }
      if (result.truncated) return null
    }

    const text = extractAnswerText(raw)
    if (!text || text.length < 40) return null
    return text
  } catch {
    return null
  }
}

async function recommendationFallbackAnswer(
  client: InferenceClient,
  task: string,
  draft: string,
  notes: string,
  params: GenerationParams,
  signal: AbortSignal,
  options: RecommendationFinishOptions,
): Promise<string> {
  const initial = sanitizeReplyText(draft)
  if (signal.aborted) throw new Error('Recommendation synthesis was cancelled.')
  if (options.budget?.expired()) {
    throw new Error('Recommendation synthesis failed: the turn deadline expired before a final answer was produced.')
  }
  const emergency = await rewriteRecommendationAnswer(
    client,
    task,
    notes,
    initial,
    'Write actionable recommendations grounded in the labeled exploration evidence. Use ### Priority gaps with repository paths and concrete file-level changes.',
    params,
    signal,
    undefined,
    options.evidence,
    options.budget,
    undefined,
    undefined,
    {
      onReplyStart: options.onReplyStart,
      onReplyChunk: options.onReplyChunk,
      onReplyDiscard: options.onReplyDiscard,
    },
  )
  if (emergency) return emergency
  const getSkipReason = options.frontier?.getSkipReason
  const hybridReason =
    typeof getSkipReason === 'function' ? getSkipReason.call(options.frontier) : undefined
  const hybridDetail = hybridReason ? ` Hybrid status: ${hybridReason}.` : ''
  if (options.evidence?.trim()) {
    throw new Error(
      `Recommendation synthesis failed after Hybrid and local attempts. Repository evidence was gathered, but no valid final answer was produced.${hybridDetail}`,
    )
  }
  throw new Error(
    `Recommendation synthesis failed: no repository evidence or valid final answer was produced.${hybridDetail}`,
  )
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
  options: RecommendationFinishOptions = {},
): Promise<string> {
  const initial = sanitizeReplyText(draft)
  if (!options.forceRewrite) {
    const judgeStartedAt = Date.now()
    const judgment = await judgeRecommendationAnswer(
      client,
      task,
      initial,
      params,
      signal,
      options.frontier,
      options.evidence,
      options.budget,
    )
    options.onPhase?.(
      'judge',
      Date.now() - judgeStartedAt,
      0,
      judgment.tokensIn ?? 0,
      judgment.tokensOut ?? 0,
    )
    if (judgment.adequate && judgment.factuallyGrounded && initial.length >= 40) {
      createReplyStreamer(options.onReplyStart, options.onReplyChunk).push(initial)
      return initial
    }
    const claimFeedback = judgment.rejectedClaims.length
      ? `\nRejected claims:\n${judgment.rejectedClaims
          .map(
            (item) =>
              `- ${item.claim || '(unspecified claim)'} — ${item.reason}${
                item.evidenceIds.length ? ` [${item.evidenceIds.join(', ')}]` : ''
              }`,
          )
          .join('\n')}`
      : ''
    let truncationRetries = 0
    let synthesisTokensIn = 0
    let synthesisTokensOut = 0
    const synthesisStartedAt = Date.now()
    const rewritten = await rewriteRecommendationAnswer(
      client,
      task,
      notes,
      initial,
      judgment.adequate
        ? 'The draft is factually grounded. Produce the complete final answer using the separate synthesis budget; preserve its supported claims and improve clarity where useful.'
        : `${judgment.feedback}${claimFeedback}`,
      params,
      signal,
      options.frontier,
      options.evidence,
      options.budget,
      () => {
        truncationRetries += 1
      },
      (tokensIn, tokensOut) => {
        synthesisTokensIn += tokensIn
        synthesisTokensOut += tokensOut
      },
      {
        onReplyStart: options.onReplyStart,
        onReplyChunk: options.onReplyChunk,
        onReplyDiscard: options.onReplyDiscard,
      },
    )
    options.onPhase?.(
      'synthesis',
      Date.now() - synthesisStartedAt,
      truncationRetries,
      synthesisTokensIn,
      synthesisTokensOut,
    )
    if (rewritten) return rewritten
  } else {
    const judgeStartedAt = Date.now()
    const judgment = await judgeRecommendationAnswer(
      client,
      task,
      initial || '(empty — model called step_failed)',
      params,
      signal,
      options.frontier,
      options.evidence,
      options.budget,
    )
    options.onPhase?.(
      'judge',
      Date.now() - judgeStartedAt,
      0,
      judgment.tokensIn ?? 0,
      judgment.tokensOut ?? 0,
    )
    const claimFeedback = judgment.rejectedClaims.length
      ? `\nRejected claims:\n${judgment.rejectedClaims
          .map(
            (item) =>
              `- ${item.claim || '(unspecified claim)'} — ${item.reason}${
                item.evidenceIds.length ? ` [${item.evidenceIds.join(', ')}]` : ''
              }`,
          )
          .join('\n')}`
      : ''
    let truncationRetries = 0
    let synthesisTokensIn = 0
    let synthesisTokensOut = 0
    const synthesisStartedAt = Date.now()
    const rewritten = await rewriteRecommendationAnswer(
      client,
      task,
      notes,
      initial,
      `${judgment.feedback ||
        'Model ended with step_failed / an apology. Write the recommendations the user asked for.'}${claimFeedback}`,
      params,
      signal,
      options.frontier,
      options.evidence,
      options.budget,
      () => {
        truncationRetries += 1
      },
      (tokensIn, tokensOut) => {
        synthesisTokensIn += tokensIn
        synthesisTokensOut += tokensOut
      },
      {
        onReplyStart: options.onReplyStart,
        onReplyChunk: options.onReplyChunk,
        onReplyDiscard: options.onReplyDiscard,
      },
    )
    options.onPhase?.(
      'synthesis',
      Date.now() - synthesisStartedAt,
      truncationRetries,
      synthesisTokensIn,
      synthesisTokensOut,
    )
    if (rewritten) return rewritten
  }

  return recommendationFallbackAnswer(
    client,
    task,
    initial,
    notes,
    params,
    signal,
    options,
  )
}

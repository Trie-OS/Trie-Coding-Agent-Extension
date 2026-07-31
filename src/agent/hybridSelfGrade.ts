/**
 * AutoMix-style self-grade: before finishing, the local model scores its own
 * work. Low confidence triggers a frontier consult instead of blindly completing.
 */
import type { ChatTurn, GenerationParams, InferenceClient } from '../inference/types'

export interface SelfGrade {
  confidence: number
  concerns: string
}

const GRADE_PROMPT = [
  'You are grading your own work on the task above.',
  'Reply with exactly one JSON object and nothing else:',
  '{"confidence": <0.0-1.0>, "concerns": "<one sentence, empty if confident>"}',
  'Score confidence by whether the task is actually done and changes are correct.',
].join('\n')

export async function localSelfGrade(
  client: InferenceClient,
  turns: ChatTurn[],
  params: GenerationParams,
  signal: AbortSignal,
): Promise<SelfGrade | null> {
  try {
    const gradeTurns: ChatTurn[] = [
      ...turns.slice(-12),
      { role: 'user', content: GRADE_PROMPT },
    ]
    const result = await client.generate(
      gradeTurns,
      { ...params, temperature: 0.1, maxTokens: 120 },
      () => {},
      signal,
    )
    const start = result.text.indexOf('{')
    const end = result.text.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    const parsed = JSON.parse(result.text.slice(start, end + 1)) as {
      confidence?: number
      concerns?: string
    }
    const confidence =
      typeof parsed.confidence === 'number'
        ? Math.min(1, Math.max(0, parsed.confidence))
        : null
    if (confidence === null) return null
    return {
      confidence,
      concerns: typeof parsed.concerns === 'string' ? parsed.concerns.slice(0, 400) : '',
    }
  } catch {
    return null
  }
}

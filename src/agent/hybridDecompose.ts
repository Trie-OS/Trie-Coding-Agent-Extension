/**
 * MinionS-style decomposition: the frontier model breaks a large task into
 * atomic single-instruction subtasks; the local model executes them.
 * Uses the hybrid completion budget via FrontierAssist.
 */
import type { FrontierAssist } from './frontierAssist'
import { DECOMPOSE_TIMEOUT_MS, shouldDecompose } from './hybridDecomposePolicy'

export interface DecomposePlan {
  subtasks: string[]
  rationale: string
}

export { DECOMPOSE_TIMEOUT_MS, shouldDecompose }

const DECOMPOSE_SYSTEM = [
  'You are a senior engineer planning work for a smaller local coding model.',
  'Break the user task into 3–8 atomic subtasks the local model can do one at a time.',
  'Each subtask must be a single action (read one area, edit one file, run one command).',
  'Reply with exactly one JSON object:',
  '{"subtasks": ["...", "..."], "rationale": "<one short sentence>"}',
].join('\n')

export async function frontierDecompose(
  task: string,
  workspaceHint: string,
  frontier: FrontierAssist,
  signal?: AbortSignal,
): Promise<DecomposePlan | null> {
  if (!frontier.enabled()) return null

  const userContent = `Task:\n${task}\n\nWorkspace:\n${workspaceHint.slice(0, 1500)}`
  try {
    const result = await frontier.completeResult(DECOMPOSE_SYSTEM, userContent, {
      maxTokens: 500,
      temperature: 0.2,
      signal,
      timeoutMs: DECOMPOSE_TIMEOUT_MS,
    })
    const raw = result?.text
    if (!raw) return null
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      subtasks?: unknown
      rationale?: string
    }
    const subtasks = Array.isArray(parsed.subtasks)
      ? parsed.subtasks.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      : []
    if (subtasks.length < 2) return null
    return {
      subtasks: subtasks.slice(0, 8).map((t) => t.trim()),
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 200) : '',
    }
  } catch {
    return null
  }
}

export function formatDecomposeInjection(plan: DecomposePlan): string {
  const lines = plan.subtasks.map((t, i) => `${i + 1}. ${t}`)
  return [
    'Frontier decomposition plan (MinionS-style — execute ONE subtask per tool call, in order):',
    plan.rationale ? `Plan: ${plan.rationale}` : '',
    lines.join('\n'),
    'Start with subtask 1. Call update_todos to mirror this list, then work through it.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

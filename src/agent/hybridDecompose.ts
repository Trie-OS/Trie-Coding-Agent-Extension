/**
 * MinionS-style decomposition: the frontier model breaks a large task into
 * atomic single-instruction subtasks; the local model executes them.
 */
import { defaultFrontierModel, getActiveFrontierConfig, type FrontierAssistConfig } from '../config'
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
  getConfig: () => FrontierAssistConfig,
  signal?: AbortSignal,
): Promise<DecomposePlan | null> {
  const fa = getConfig()
  if (!fa.enabled) return null
  const cfg = getActiveFrontierConfig(fa)
  if (!cfg) return null

  const userContent = `Task:\n${task}\n\nWorkspace:\n${workspaceHint.slice(0, 1500)}`
  const timeout = AbortSignal.timeout(DECOMPOSE_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const raw =
      cfg.provider === 'anthropic'
        ? await callAnthropic(cfg.apiKey, cfg.model, userContent, combined)
        : await callOpenAiCompatible(
            cfg.provider === 'moonshot'
              ? 'https://api.moonshot.ai/v1/chat/completions'
              : 'https://api.openai.com/v1/chat/completions',
            cfg.apiKey,
            cfg.model || defaultFrontierModel(cfg.provider),
            userContent,
            combined,
          )
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

async function callOpenAiCompatible(
  url: string,
  apiKey: string,
  model: string,
  content: string,
  signal: AbortSignal,
): Promise<string | null> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || 'gpt-4o',
      messages: [
        { role: 'system', content: DECOMPOSE_SYSTEM },
        { role: 'user', content },
      ],
      max_tokens: 500,
      temperature: 0.2,
    }),
    signal,
  })
  if (!response.ok) return null
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return data.choices?.[0]?.message?.content ?? null
}

async function callAnthropic(
  apiKey: string,
  model: string,
  content: string,
  signal: AbortSignal,
): Promise<string | null> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-4-20250514',
      system: DECOMPOSE_SYSTEM,
      messages: [{ role: 'user', content }],
      max_tokens: 500,
    }),
    signal,
  })
  if (!response.ok) return null
  const data = (await response.json()) as { content?: Array<{ type: string; text?: string }> }
  return data.content?.find((b) => b.type === 'text')?.text ?? null
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

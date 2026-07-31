/**
 * Prompts follow Trie IDE's approach (app/src/main/agent/prompts.ts):
 * short imperative instructions sized for 7–14B local models, with the tool
 * list generated from the specs, never hand-duplicated.
 *
 * Modes mirror the IDE's plan-first workflow: `code` is the full agent,
 * `plan` and `ask` are read-only (mutating tools are omitted from the prompt
 * and refused by the loop).
 */
import { isWebSearchConfigured, readConfig } from '../config'
import { TOOL_SPECS } from './tools'

export type AgentMode = 'code' | 'plan' | 'ask'

export function isReadOnlyMode(mode: AgentMode): boolean {
  return mode !== 'code'
}

const MODE_RULES: Record<AgentMode, string[]> = {
  code: [
    '- Read a file before editing it. Keep edits minimal; do not refactor beyond the task.',
    '- Use update_todos to track multi-step work.',
    '- When done, call step_complete — its summary is your answer to the user.',
    '- If the request is a question, answer it in step_complete.summary instead of editing files.',
  ],
  plan: [
    '- You are in PLAN mode: explore the workspace but never modify anything.',
    '- Investigate with read_file, grep, glob, and list_dir until you understand the task.',
    '- Then call step_complete with a numbered, step-by-step implementation plan in `summary`.',
    '- Each step names the files to change and what to change. Be specific and concise.',
  ],
  ask: [
    '- You are in ASK mode: answer questions about the code but never modify anything.',
    '- Investigate with read_file, grep, glob, and list_dir as needed.',
    '- Then call step_complete with your answer in `summary`.',
  ],
}

export function agentSystemPrompt(mode: AgentMode = 'code'): string {
  const webSearchOn = isWebSearchConfigured(readConfig())
  const specs = TOOL_SPECS.filter(
    (t) => (!isReadOnlyMode(mode) || !t.mutating) && (t.name !== 'web_search' || webSearchOn),
  )
  const toolLines = specs.map((t) => `- ${t.name} ${t.signature} — ${t.description}`).join('\n')
  return [
    "You are Trie Coding Agent, a coding agent working inside the user's editor workspace.",
    '',
    'Respond with exactly one JSON object and nothing else:',
    '{"thought": "<brief reasoning, under 300 chars>", "tool": "<name>", "args": {...}}',
    '',
    'Tools:',
    toolLines,
    '',
    'Rules:',
    '- One tool call per response. JSON only — no prose, no markdown fences.',
    '- Paths are relative to the workspace root.',
    ...MODE_RULES[mode],
    '- Interpret obvious typos in the task; call step_failed only when truly blocked.',
  ].join('\n')
}

export function agentUserPrompt(task: string, workspaceContext: string): string {
  return [`Task: ${task}`, '', workspaceContext].join('\n')
}

export function toolResultTurn(toolName: string, ok: boolean, result: string): string {
  return `${ok ? 'Result' : 'FAILED result'} of ${toolName}:\n${result}`
}

export function repairTurn(error: string): string {
  return [
    `Your last response was invalid: ${error}`,
    'Respond again with exactly one JSON object: {"thought": "...", "tool": "<name>", "args": {...}}',
  ].join('\n')
}

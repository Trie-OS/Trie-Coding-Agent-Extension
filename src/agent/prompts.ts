/**
 * Prompts follow Trie IDE's approach (app/src/main/agent/prompts.ts):
 * short imperative instructions sized for 7–14B local models, with the tool
 * list generated from the specs, never hand-duplicated.
 */
import { TOOL_SPECS } from './tools'

export function agentSystemPrompt(): string {
  const toolLines = TOOL_SPECS.map((t) => `- ${t.name} ${t.signature} — ${t.description}`).join('\n')
  return [
    "You are Trie IDE, a coding agent working inside the user's editor workspace.",
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
    '- Read a file before editing it. Keep edits minimal; do not refactor beyond the task.',
    '- Use update_todos to track multi-step work.',
    '- When done, call step_complete — its summary is your answer to the user.',
    '- If the request is a question, answer it in step_complete.summary instead of editing files.',
    '- Interpret obvious typos in the task; call step_failed only when truly blocked.',
  ].join('\n')
}

export function agentUserPrompt(task: string, workspaceName: string, rootListing: string): string {
  return [
    `Task: ${task}`,
    '',
    `Workspace: ${workspaceName}`,
    'Top-level entries:',
    rootListing,
  ].join('\n')
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

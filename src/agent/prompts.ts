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
    '- If edit_file fails, do not retry the same guessed/truncated search. Follow its recovery instruction: read_file the exact reported line range, then copy that text exactly; use write_file only when intentionally replacing the whole file.',
    '- Complex ask (3+ distinct steps)? FIRST call update_todos with the full task list, then work through it. After finishing each item, call update_todos again moving it to `done`. Skip the list for trivial one-step tasks.',
    '- When done, call step_complete — its summary is your answer to the user.',
    '- If the request is a question, answer it in step_complete.summary instead of editing files.',
    '- Never claim you changed files in step_complete unless edit_file or write_file succeeded this turn.',
    '- For substantive logic or bug fixes, add/update a focused test when feasible. Batch a coherent set of edits, then verify once — not after every edit.',
    '- Before step_complete, use run_verification for the narrowest relevant test or touched-area typecheck. Broaden to build/full suite only for cross-cutting or high-risk work, or when no narrow check exists.',
    '- Rendered UI/webview behavior (layout, interaction, responsive state, focus/accessibility, truncation, lifecycle rendering): search for an existing visual, browser, e2e, component, or UI harness and use/update it. Verify the actual behavior, not only compilation.',
    '- If a consequential UI behavior has no suitable harness, create or update one narrowly scoped reusable test/harness only when it adds durable value. Prefer assertions against rendered state; capture artifacts when the project supports them. Do not create throwaway previews for every UI edit.',
    '- Run a UI harness after a coherent edit batch, inspect failures and text artifacts with read_file, and use run_verification artifactPaths to confirm generated screenshots/reports when useful.',
    '- Non-UI work and trivial copy/color/icon/asset/purely cosmetic CSS changes should use focused tests/typecheck or may skip visual verification when disproportionate. If verification is impossible or disproportionate, call run_verification with an explicit honest skipReason.',
    '- A passing check becomes stale after any later edit; verify the final mutation batch again.',
  ],
  plan: [
    '- You are in PLAN mode: explore the workspace but never modify anything.',
    '- Investigate with read_file, grep, glob, list_dir, and web_search as needed until you understand the task.',
    '- Then call step_complete with a numbered, step-by-step implementation plan in `summary`.',
    '- Each step names the files to change and what to change. Be specific and concise.',
  ],
  ask: [
    '- You are in ASK mode: answer questions about the code but never modify anything.',
    '- Investigate with read_file, grep, glob, list_dir, and web_search as needed.',
    '- Then call step_complete with your answer in `summary`.',
  ],
}

function webSearchRules(webSearchOn: boolean): string[] {
  if (webSearchOn) {
    return [
      '- Questions about research papers, current docs, APIs, libraries, or anything outside this repo: call web_search (one or more queries) before step_complete.',
      '- In step_complete.summary, list concrete links — each result as "Title — https://…" with the full URL. Do not substitute keyword lists or tell the user to search manually.',
    ]
  }
  return [
    '- Web search is off. If the user asks for internet research, papers, or external docs, say so in step_complete and tell them to enable Web search in Trie Settings (Exa, Tavily, or Ceramic).',
  ]
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
    ...webSearchRules(webSearchOn),
    '- Interpret obvious typos in the task; call step_failed only when truly blocked.',
  ].join('\n')
}

export function agentUserPrompt(task: string, workspaceContext: string, extraNote = ''): string {
  const parts = [`Task: ${task}`]
  if (extraNote) parts.push('', extraNote)
  parts.push('', workspaceContext)
  return parts.join('\n')
}

export function toolResultTurn(toolName: string, ok: boolean, result: string): string {
  const recovery =
    !ok && toolName === 'edit_file'
      ? '\n\nREQUIRED NEXT STEP: read_file the exact reported line range before another edit_file call. Do not retry the previous search.'
      : ''
  return `${ok ? 'Result' : 'FAILED result'} of ${toolName}:\n${result}${recovery}`
}

export function repairTurn(error: string): string {
  return [
    `Your last response was invalid: ${error}`,
    'Respond again with exactly one JSON object: {"thought": "...", "tool": "<name>", "args": {...}}',
  ].join('\n')
}

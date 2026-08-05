/**
 * Tool-call budgets for agent phases.
 *
 * Direct agent mode, plan exploration, and agent-mode subagents share one
 * setting (`agentMaxToolCalls`). Zero means unlimited — the loop ends only
 * when the model calls a control tool (`done_exploring`, `step_complete`, …).
 */

/** PLANNING-MODE.md: one plan step's edit loop (separate from exploration). */
export const STEP_MAX_CALLS = 10

/** @deprecated Plan exploration uses resolveAgentMaxToolCalls — kept for tests/docs. */
export const EXPLORATION_MAX_CALLS = 0

/** Stored value meaning unlimited tool calls per turn. */
export const UNLIMITED_AGENT_MAX_TOOL_CALLS = 0

/** Default when unset in settings.json — unlimited. */
export const DEFAULT_AGENT_MAX_TOOL_CALLS = UNLIMITED_AGENT_MAX_TOOL_CALLS

/** @deprecated Alias for DEFAULT_AGENT_MAX_TOOL_CALLS. */
export const DEFAULT_AGENT_MAX_CALLS = DEFAULT_AGENT_MAX_TOOL_CALLS

/** Minimum when the user sets an explicit cap (1+). Zero remains unlimited. */
export const MIN_AGENT_MAX_TOOL_CALLS = 0

/** Soft upper bound for the settings number input only — not enforced as a runtime cap. */
export const MAX_AGENT_MAX_TOOL_CALLS = 9999

/** Clamp a value before persisting to settings.json (0 = unlimited). */
export function clampStoredAgentMaxToolCalls(raw: number): number {
  if (raw === UNLIMITED_AGENT_MAX_TOOL_CALLS) return UNLIMITED_AGENT_MAX_TOOL_CALLS
  return Math.max(1, Math.min(MAX_AGENT_MAX_TOOL_CALLS, Math.floor(raw)))
}

/** Effective runtime cap for tool loops (0 / unset → unlimited). */
export function normalizeLoopMaxCalls(maxCalls: number | undefined): number {
  if (maxCalls === undefined || maxCalls === UNLIMITED_AGENT_MAX_TOOL_CALLS) return Infinity
  if (!Number.isFinite(maxCalls)) return maxCalls
  return Math.max(1, Math.floor(maxCalls))
}

export function resolveAgentMaxToolCalls(
  settings: { agentMaxToolCalls?: number } | null | undefined,
): number {
  return normalizeLoopMaxCalls(settings?.agentMaxToolCalls)
}

/** Format for prompts and UI (`Infinity` → "unlimited"). */
export function formatAgentMaxToolCalls(maxCalls: number): string {
  return Number.isFinite(maxCalls) ? String(maxCalls) : 'unlimited'
}

/** Serialize for IPC/events (`Infinity` → 0). */
export function serializeAgentMaxToolCalls(maxCalls: number): number {
  return Number.isFinite(maxCalls) ? maxCalls : UNLIMITED_AGENT_MAX_TOOL_CALLS
}

/** Deserialize from IPC/events (0 → unlimited). */
export function deserializeAgentMaxToolCalls(maxCalls: number): number {
  return maxCalls === UNLIMITED_AGENT_MAX_TOOL_CALLS ? Infinity : maxCalls
}

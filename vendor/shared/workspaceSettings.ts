/**
 * Per-workspace settings keys shared between main and renderer.
 *
 * `activeRepoPath` scopes the coding agent (chat, plan, tools, @-mentions,
 * symbol search) to a git repository under the workspace root. `null` means
 * the whole workspace — the default when the opened folder is itself one repo.
 */
export const ACTIVE_REPO_SETTINGS_KEY = 'activeRepoPath'

/** Relative POSIX path from workspace root to the selected repo, or null for all. */
export function readActiveRepoPath(settings: Record<string, unknown>): string | null {
  const raw = settings[ACTIVE_REPO_SETTINGS_KEY]
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw !== 'string') return null
  return raw
}

export function writeActiveRepoPath(
  settings: Record<string, unknown>,
  activeRepoPath: string | null,
): Record<string, unknown> {
  return { ...settings, [ACTIVE_REPO_SETTINGS_KEY]: activeRepoPath }
}

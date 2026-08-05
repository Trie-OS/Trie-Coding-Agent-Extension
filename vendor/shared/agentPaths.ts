/**
 * Map paths between workspace-relative and agent (repo-scoped) coordinates.
 *
 * When `activeRepoPath` is set, the file tree and agent tools operate on
 * paths relative to that repo; the editor still uses workspace-relative paths.
 */
export function toAgentRelativePath(
  workspaceRelPath: string,
  activeRepoPath: string | null,
): string | null {
  if (activeRepoPath === null) return workspaceRelPath
  if (workspaceRelPath === activeRepoPath) return ''
  const prefix = `${activeRepoPath}/`
  if (workspaceRelPath.startsWith(prefix)) return workspaceRelPath.slice(prefix.length)
  return null
}

/** Map an agent-relative path back to workspace-relative for the editor tree. */
export function toWorkspaceRelativePath(
  agentRelPath: string,
  activeRepoPath: string | null,
): string {
  if (activeRepoPath === null || activeRepoPath === '') return agentRelPath
  if (agentRelPath === '') return activeRepoPath
  if (agentRelPath === activeRepoPath || agentRelPath.startsWith(`${activeRepoPath}/`)) {
    return agentRelPath
  }
  return `${activeRepoPath}/${agentRelPath}`
}

/** Normalize any path the UI might pass into a workspace-relative editor path. */
export function resolveEditorRelPath(
  rawPath: string,
  activeRepoPath: string | null,
): string {
  return toWorkspaceRelativePath(rawPath.trim(), activeRepoPath)
}

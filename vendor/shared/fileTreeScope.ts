/**
 * File-tree scoping when the user selects a repo in the multi-repo picker.
 */
export type FsScope = 'workspace' | 'agent'

export interface WorkspaceRepoRef {
  relPath: string
  name: string
}

export function isFileTreeScoped(activeRepoPath: string | null): boolean {
  return activeRepoPath !== null
}

/** IPC fs scope: agent when a repo is selected, otherwise the full workspace. */
export function fsScopeForActiveRepo(activeRepoPath: string | null): FsScope {
  return activeRepoPath === null ? 'workspace' : 'agent'
}

/** True when the workspace contains two or more git repositories. */
export function shouldShowProjectPicker(repos: readonly WorkspaceRepoRef[]): boolean {
  return repos.length >= 2
}

/** Human-readable project label for the sidebar picker and status bar. */
export function resolveProjectLabel(
  repos: readonly WorkspaceRepoRef[],
  activeRepoPath: string | null,
  workspaceName: string,
): string {
  if (activeRepoPath === null) {
    if (repos.length >= 2) return `${workspaceName} — All repos`
    if (repos.length === 1) return repos[0]?.name ?? workspaceName
    return workspaceName
  }
  return repos.find((r) => r.relPath === activeRepoPath)?.name ?? activeRepoPath
}

/** True when a multi-repo workspace has no project selected yet. */
export function needsProjectSelection(
  repos: readonly WorkspaceRepoRef[],
  activeRepoPath: string | null,
): boolean {
  return repos.length >= 2 && activeRepoPath === null
}

/** Label for the tree root header row. */
export function resolveFileTreeRootLabel(
  repos: readonly WorkspaceRepoRef[],
  activeRepoPath: string | null,
  workspaceName: string,
): string {
  if (activeRepoPath === null) return workspaceName
  return repos.find((r) => r.relPath === activeRepoPath)?.name ?? activeRepoPath
}

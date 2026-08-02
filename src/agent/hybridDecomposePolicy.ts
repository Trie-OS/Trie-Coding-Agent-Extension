/** Pure helpers for MinionS-style decomposition (no vscode / network deps). */

/** Same budget as FrontierAssist — decompose must never hang Multitask forever. */
export const DECOMPOSE_TIMEOUT_MS = 30_000

export function shouldDecompose(task: string, todoCount: number): boolean {
  const words = task.trim().split(/\s+/).length
  return todoCount >= 3 || words >= 35 || task.length >= 220
}

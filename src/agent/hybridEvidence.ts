/**
 * Verifiable evidence for hybrid final review: diff summary only.
 * Verification scripts are not auto-run — the model uses run_verification explicitly.
 */
import type { ChangedFileStat } from './checkpoints'

export interface ReviewEvidence {
  diffSummary: string
  changedFiles: ChangedFileStat[]
  verifyResults: { command: string; ok: boolean; output: string }[]
}

export async function gatherReviewEvidence(
  _root: string,
  changedFiles: ChangedFileStat[],
): Promise<ReviewEvidence> {
  const diffSummary =
    changedFiles.length === 0
      ? 'No file changes detected vs the turn checkpoint.'
      : changedFiles
          .map((f) => `${f.path} (+${f.added}/-${f.deleted})`)
          .join('\n')
          .slice(0, 4000)

  return {
    diffSummary,
    changedFiles,
    verifyResults: [
      {
        command: '(skipped)',
        ok: true,
        output:
          'Automatic verification was not run before frontier review. Use run_verification during the turn when checks are needed.',
      },
    ],
  }
}

export function formatEvidenceForFrontier(evidence: ReviewEvidence): string {
  const lines = ['=== Workspace diff (since turn checkpoint) ===', evidence.diffSummary]
  if (evidence.verifyResults.length > 0) {
    lines.push('', '=== Deterministic verification ===')
    for (const v of evidence.verifyResults) {
      lines.push(v.output.slice(0, 800))
    }
  }
  return lines.join('\n')
}

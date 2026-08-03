/**
 * Verifiable evidence for hybrid final review: diff summary only.
 * Verification scripts are not auto-run — the model uses run_verification explicitly.
 */
import type { ChangedFileStat } from './checkpoints'

export interface VerifyResult {
  command: string
  ok: boolean
  output: string
}

export interface ReviewEvidence {
  diffSummary: string
  changedFiles: ChangedFileStat[]
  verifyResults: VerifyResult[]
}

export async function gatherReviewEvidence(
  _root: string,
  changedFiles: ChangedFileStat[],
  verifyResults: VerifyResult[] = [],
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
    verifyResults,
  }
}

export function formatEvidenceForFrontier(evidence: ReviewEvidence): string {
  const lines = ['=== Workspace diff (since turn checkpoint) ===', evidence.diffSummary]
  lines.push('', '=== Deterministic verification ===')
  if (evidence.verifyResults.length > 0) {
    for (const v of evidence.verifyResults) {
      lines.push(`${v.ok ? 'PASS' : 'FAIL'} ${v.command}`)
      lines.push(v.output.slice(0, 800))
    }
  } else {
    lines.push('Verification was not run during this turn.')
  }
  return lines.join('\n')
}

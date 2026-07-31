/**
 * Verifiable evidence for hybrid final review (VPR / VeriGate inspired):
 * run cheap deterministic checks first, then hand diff + output to the frontier
 * reviewer so it judges facts, not vibes.
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { detectProjects } from './context'
import type { ChangedFileStat } from './checkpoints'

export interface ReviewEvidence {
  diffSummary: string
  changedFiles: ChangedFileStat[]
  verifyResults: { command: string; ok: boolean; output: string }[]
}

const VERIFY_TIMEOUT_MS = 45_000
const MAX_OUTPUT_CHARS = 2000

function runCommand(cwd: string, command: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-lc', command],
      { cwd, timeout: VERIFY_TIMEOUT_MS, maxBuffer: 512 * 1024 },
      (error, stdout, stderr) => {
        const output = (stdout + stderr).trim().slice(0, MAX_OUTPUT_CHARS)
        resolve({ ok: !error, output: output || (error ? String(error.message) : '(no output)') })
      },
    )
  })
}

/** Pick the best verification commands for this workspace. */
function verifyCommands(root: string): string[] {
  const commands: string[] = []
  const pkgPath = path.join(root, 'package.json')
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }
      const scripts = pkg.scripts ?? {}
      if (scripts.typecheck) commands.push('npm run typecheck --if-present')
      else if (scripts['type-check']) commands.push('npm run type-check --if-present')
      if (scripts.lint) commands.push('npm run lint --if-present')
      if (scripts.test) commands.push('npm test --if-present -- --passWithNoTests')
      else if (scripts.build) commands.push('npm run build --if-present')
    } catch {
      /* unreadable package.json */
    }
  }
  if (commands.length === 0) {
    for (const project of detectProjects(root)) {
      if (project.verify) commands.push(project.verify.split(';')[0].trim())
    }
  }
  // Cap at two commands — evidence should be fast.
  return [...new Set(commands)].slice(0, 2)
}

export async function gatherReviewEvidence(
  root: string,
  changedFiles: ChangedFileStat[],
): Promise<ReviewEvidence> {
  const diffSummary =
    changedFiles.length === 0
      ? 'No file changes detected vs the turn checkpoint.'
      : changedFiles
          .map((f) => `${f.path} (+${f.added}/-${f.deleted})`)
          .join('\n')
          .slice(0, 4000)

  const verifyResults: ReviewEvidence['verifyResults'] = []
  for (const command of verifyCommands(root)) {
    verifyResults.push({ command, ...(await runCommand(root, command)) })
  }

  return { diffSummary, changedFiles, verifyResults }
}

export function formatEvidenceForFrontier(evidence: ReviewEvidence): string {
  const lines = ['=== Workspace diff (since turn checkpoint) ===', evidence.diffSummary]
  if (evidence.verifyResults.length > 0) {
    lines.push('', '=== Deterministic verification (ran before frontier review) ===')
    for (const v of evidence.verifyResults) {
      lines.push(`$ ${v.command}`)
      lines.push(v.ok ? 'PASS' : 'FAIL')
      lines.push(v.output.slice(0, 800))
      lines.push('')
    }
  } else {
    lines.push('', '(No automatic verify command detected for this project.)')
  }
  return lines.join('\n')
}

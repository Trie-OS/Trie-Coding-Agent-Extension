export type VerificationPolicy = {
  needed: boolean
  encourageTests: boolean
  useVisualHarness: boolean
  reason: string
}

const BEHAVIOR_EXTENSIONS = /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|swift|rb|php|cs|cpp|cc|c|h)$/i
const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|spec)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i
const DOC_OR_ASSET = /\.(?:md|mdx|txt|rst|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|pdf)$/i
const VISUAL_STYLE = /\.(?:css|scss|sass|less)$/i
const UI_SOURCE = /\.(?:[cm]?[jt]sx?|html?|vue|svelte)$/i
const UI_PATH =
  /(?:^|\/)(?:web|frontend|renderer|webview|media\/src|components?|views?|pages?|ui)(?:\/|$)/i
const UI_BEHAVIOR_TASK =
  /\b(?:ui|user interface|webview|render(?:ed|ing)?|layout|responsive|breakpoint|overflow|overlap|collision|truncate|ellipsis|animation|modal|dialog|menu|popover|tooltip|drag|drop|keyboard|focus|accessibility|aria|visual regression|screenshot)\b/i
const TRIVIAL_PRESENTATION =
  /\b(?:copy|wording|typo|color|colour|icon|logo|font|spacing only|cosmetic|asset)\b/i
const CONFIG_FILE =
  /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|tsconfig[^/]*\.json|[^/]*config\.[cm]?[jt]s|\.?[^/]*rc(?:\.[^/]+)?|[^/]*\.ya?ml)$/i
const BUG_OR_LOGIC = /\b(?:bug|fix|regression|logic|behavior|incorrect|broken|crash|error|edge case|refactor)\b/i
const HIGH_RISK = /\b(?:security|auth|permission|migration|database|deploy|build|ci|dependency|configuration|config)\b/i

/**
 * Decide whether edits need executable verification. Pure docs, copy, assets,
 * visual styles, and configuration are skipped by default; risk words opt them
 * back in. Any behavior-bearing source file requires a check.
 */
export function verificationPolicy(task: string, changedPaths: readonly string[]): VerificationPolicy {
  if (changedPaths.length === 0) {
    return {
      needed: false,
      encourageTests: false,
      useVisualHarness: false,
      reason: 'No workspace files changed.',
    }
  }

  const behaviorPaths = changedPaths.filter((file) => BEHAVIOR_EXTENSIONS.test(file))
  const uiSourcePaths = changedPaths.filter(
    (file) => UI_SOURCE.test(file) && (UI_PATH.test(file) || UI_BEHAVIOR_TASK.test(task)),
  )
  const consequentialStyles =
    changedPaths.some((file) => VISUAL_STYLE.test(file)) &&
    UI_BEHAVIOR_TASK.test(task) &&
    !TRIVIAL_PRESENTATION.test(task)
  const useVisualHarness = uiSourcePaths.length > 0 || consequentialStyles
  const onlyTests = behaviorPaths.length > 0 && behaviorPaths.every((file) => TEST_PATH.test(file))
  if (behaviorPaths.length > 0) {
    return {
      needed: true,
      encourageTests: !onlyTests && BUG_OR_LOGIC.test(task),
      useVisualHarness,
      reason: onlyTests
        ? 'Test code changed and should be run.'
        : useVisualHarness
          ? 'Rendered UI or webview behavior changed.'
          : 'Behavior-bearing source code changed.',
    }
  }

  if (consequentialStyles) {
    return {
      needed: true,
      encourageTests: false,
      useVisualHarness: true,
      reason: 'Layout-sensitive visual behavior changed.',
    }
  }

  const lowRiskOnly = changedPaths.every(
    (file) => DOC_OR_ASSET.test(file) || VISUAL_STYLE.test(file) || CONFIG_FILE.test(file),
  )
  if (lowRiskOnly && !HIGH_RISK.test(task)) {
    return {
      needed: false,
      encourageTests: false,
      useVisualHarness: false,
      reason: 'Only docs, assets, visual styles, or low-risk configuration changed.',
    }
  }

  return {
    needed: true,
    encourageTests: BUG_OR_LOGIC.test(task),
    useVisualHarness: false,
    reason: lowRiskOnly
      ? 'The task makes otherwise low-risk files consequential.'
      : 'The changed files may affect runtime behavior.',
  }
}

export function verificationReminder(policy: VerificationPolicy): string {
  const harnessAdvice = policy.useVisualHarness
    ? ' Find and run the existing visual/e2e/UI harness when available. If none exists and the changed interaction cannot be verified otherwise, add or update one narrowly scoped reusable harness, then inspect its output or artifacts.'
    : ''
  const testAdvice = policy.encourageTests
    ? ' Add or update a focused regression test for the changed logic when feasible.'
    : ''
  return (
    `Verification is still stale or missing: ${policy.reason}${harnessAdvice}${testAdvice} ` +
    'Use run_verification once for the narrowest relevant package test, UI/e2e harness, or touched-area typecheck. ' +
    'Use its skipReason only when no test infrastructure exists or verification would be disproportionate, then finish honestly.'
  )
}

/** Turn-local freshness tracking: every later edit invalidates prior evidence. */
export class VerificationTracker {
  private mutationVersion = 0
  private verifiedVersion = -1
  private skippedVersion = -1
  private nudgeUsed = false

  noteMutation(): void {
    this.mutationVersion++
  }

  noteVerification(skipped = false): void {
    if (skipped) this.skippedVersion = this.mutationVersion
    else this.verifiedVersion = this.mutationVersion
  }

  hasCurrentEvidence(): boolean {
    return (
      this.verifiedVersion === this.mutationVersion ||
      this.skippedVersion === this.mutationVersion
    )
  }

  /** Return at most one actionable completion nudge per turn. */
  takeCompletionNudge(policy: VerificationPolicy): string | null {
    if (!policy.needed || this.hasCurrentEvidence() || this.nudgeUsed) return null
    this.nudgeUsed = true
    return verificationReminder(policy)
  }
}

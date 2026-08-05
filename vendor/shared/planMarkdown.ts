/**
 * Plan documents live as markdown files under `.trie-ide/plans/`.
 * The planner agent writes them; users edit in the normal editor.
 */
import type { Plan, PlanArtifact } from './agent'
import { planRootId } from './planHeads'

export const PLAN_MD_DIR = '.trie-ide/plans'

/** Stable path for a plan lineage — one markdown file per root plan. */
export function planMdRelPath(rootPlanId: string): string {
  return `${PLAN_MD_DIR}/${rootPlanId}.md`
}

/** Resolve the markdown path for any revision in a lineage. */
export function planMdRelPathForPlan(plan: Plan, lineage?: readonly Plan[]): string {
  if (!lineage || lineage.length === 0) return planMdRelPath(plan.parentPlanId ?? plan.id)
  const byId = new Map(lineage.map((entry) => [entry.id, entry]))
  return planMdRelPath(planRootId(plan, byId))
}

export function planArtifactToMarkdown(artifact: PlanArtifact, task?: string): string {
  const lines: string[] = [`# ${artifact.title}`, '']

  if (task?.trim()) {
    lines.push('## Task', '', task.trim(), '')
  }

  lines.push('## Summary', '', artifact.summary, '')

  if (artifact.assumptions.length > 0) {
    lines.push('## Assumptions', '')
    for (const item of artifact.assumptions) lines.push(`- ${item}`)
    lines.push('')
  }

  if (artifact.open_questions.length > 0) {
    lines.push('## Open questions', '')
    for (const item of artifact.open_questions) lines.push(`- ${item}`)
    lines.push('')
  }

  lines.push('## Steps', '')
  artifact.steps.forEach((step, index) => {
    lines.push(`### ${index + 1}. ${step.title}`, '', step.intent, '')
    if (step.files.length > 0) {
      lines.push(`**Files:** ${step.files.map((file) => `\`${file}\``).join(', ')}`, '')
    }
    lines.push('**Actions:**')
    for (const action of step.actions) {
      lines.push(`- \`${action.type}\` \`${action.path}\` — ${action.description}`)
    }
    lines.push('')
    const verification = step.verification
    lines.push(
      '**Verify:** ' +
        (verification.type === 'command' ? `\`${verification.command}\`` : verification.manual),
    )
    if (step.note) lines.push('', `> Note: ${step.note}`)
    lines.push('')
  })

  if (artifact.risks.length > 0) {
    lines.push('## Risks', '')
    for (const item of artifact.risks) lines.push(`- ${item}`)
    lines.push('')
  }

  if (artifact.out_of_scope.length > 0) {
    lines.push('## Out of scope', '')
    for (const item of artifact.out_of_scope) lines.push(`- ${item}`)
    lines.push('')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

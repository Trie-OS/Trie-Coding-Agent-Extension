/**
 * Group plan revisions into independent plan lineages (heads).
 *
 * A conversation can hold many plans — each root `insertPlan` starts a new
 * lineage; `revisePlan` appends revisions under that lineage. Callers that only
 * need "which plans exist" should use the latest revision per root, not raw
 * `listPlans` ordered by revision number (which would keep an old plan's r3
 * ahead of a new plan's r1).
 */
import type { Plan } from './agent'

/** Walk parent_plan_id links until the root revision (parent is null). */
export function planRootId(plan: Plan, byId: Map<string, Plan>): string {
  let current: Plan | undefined = plan
  while (current?.parentPlanId) {
    const parent = byId.get(current.parentPlanId)
    if (!parent) break
    current = parent
  }
  return current?.id ?? plan.id
}

/** Latest revision per plan lineage, newest lineage first. */
export function planHeadsFromList(plans: readonly Plan[]): Plan[] {
  if (plans.length === 0) return []
  const byId = new Map(plans.map((plan) => [plan.id, plan]))
  const latestByRoot = new Map<string, Plan>()
  for (const plan of plans) {
    const rootId = planRootId(plan, byId)
    const previous = latestByRoot.get(rootId)
    if (
      !previous ||
      plan.revision > previous.revision ||
      (plan.revision === previous.revision && plan.createdAt > previous.createdAt)
    ) {
      latestByRoot.set(rootId, plan)
    }
  }
  return [...latestByRoot.values()].sort((a, b) => b.createdAt - a.createdAt)
}

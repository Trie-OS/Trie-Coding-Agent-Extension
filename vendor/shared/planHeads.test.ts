import { describe, expect, it } from 'vitest'
import type { Plan, PlanArtifact } from './agent'
import { planHeadsFromList, planRootId } from './planHeads'

const artifact: PlanArtifact = {
  title: 'Plan A',
  summary: 'First plan',
  assumptions: [],
  open_questions: [],
  steps: [
    {
      id: 's1',
      title: 'Step',
      intent: 'Do it',
      files: [],
      actions: [{ type: 'edit', path: 'a.ts', description: 'edit' }],
      verification: { type: 'manual', manual: 'check' },
    },
  ],
  risks: [],
  out_of_scope: [],
}

function makePlan(
  id: string,
  overrides: Partial<Plan> & { parentPlanId?: string | null; revision?: number; createdAt?: number } = {},
): Plan {
  return {
    id,
    conversationId: 'conv-1',
    workspaceId: 'ws-1',
    revision: overrides.revision ?? 1,
    parentPlanId: overrides.parentPlanId ?? null,
    artifact: overrides.artifact ?? { ...artifact, title: `Plan ${id}` },
    status: overrides.status ?? 'draft',
    execMode: overrides.execMode ?? null,
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
    ...overrides,
  }
}

describe('planHeadsFromList', () => {
  it('returns the latest revision per lineage', () => {
    const r1 = makePlan('a-r1', { revision: 1, createdAt: 100 })
    const r2 = makePlan('a-r2', { revision: 2, parentPlanId: 'a-r1', createdAt: 200 })
    const heads = planHeadsFromList([r1, r2])
    expect(heads).toHaveLength(1)
    expect(heads[0]?.id).toBe('a-r2')
  })

  it('keeps multiple independent plans and prefers the newest lineage', () => {
    const planA1 = makePlan('a-r1', { revision: 1, createdAt: 100, artifact: { ...artifact, title: 'A' } })
    const planA2 = makePlan('a-r2', {
      revision: 2,
      parentPlanId: 'a-r1',
      createdAt: 200,
      artifact: { ...artifact, title: 'A v2' },
    })
    const planA3 = makePlan('a-r3', {
      revision: 3,
      parentPlanId: 'a-r2',
      createdAt: 300,
      artifact: { ...artifact, title: 'A v3' },
    })
    const planB1 = makePlan('b-r1', {
      revision: 1,
      createdAt: 400,
      artifact: { ...artifact, title: 'B' },
    })
    const heads = planHeadsFromList([planA1, planA2, planA3, planB1])
    expect(heads.map((plan) => plan.id)).toEqual(['b-r1', 'a-r3'])
  })

  it('finds the root id through a revision chain', () => {
    const r1 = makePlan('root', { revision: 1 })
    const r2 = makePlan('child', { revision: 2, parentPlanId: 'root' })
    const byId = new Map([r1, r2].map((plan) => [plan.id, plan]))
    expect(planRootId(r2, byId)).toBe('root')
  })
})

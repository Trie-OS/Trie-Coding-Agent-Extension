import { describe, expect, it } from 'vitest'
import type { PlanArtifact } from './agent'
import { planArtifactToMarkdown, planMdRelPath } from './planMarkdown'

const artifact: PlanArtifact = {
  title: 'Add dark mode',
  summary: 'Theme context and a toggle.',
  assumptions: ['Tailwind dark mode is configured'],
  open_questions: ['Per-device or per-account?'],
  steps: [
    {
      id: 's1',
      title: 'Create ThemeContext',
      intent: 'One owner for the theme.',
      files: ['src/theme.tsx'],
      actions: [{ type: 'create', path: 'src/theme.tsx', description: 'Context + hook' }],
      verification: { type: 'command', command: 'npm run typecheck' },
    },
  ],
  risks: ['Hardcoded colors'],
  out_of_scope: ['Token refactor'],
}

describe('planMdRelPath', () => {
  it('stores plans under .trie-ide/plans', () => {
    expect(planMdRelPath('plan-abc')).toBe('.trie-ide/plans/plan-abc.md')
  })
})

describe('planArtifactToMarkdown', () => {
  it('renders a readable markdown document', () => {
    const md = planArtifactToMarkdown(artifact, 'Add a toggle to settings')
    expect(md).toContain('# Add dark mode')
    expect(md).toContain('## Task')
    expect(md).toContain('Add a toggle to settings')
    expect(md).toContain('### 1. Create ThemeContext')
    expect(md).toContain('`npm run typecheck`')
    expect(md).toContain('## Risks')
  })
})

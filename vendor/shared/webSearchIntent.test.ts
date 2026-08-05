import { describe, expect, it } from 'vitest'
import { taskAllowsWebSearch } from './webSearchIntent'

describe('taskAllowsWebSearch', () => {
  it('keeps repository-local feature work local even when no implementation exists', () => {
    expect(taskAllowsWebSearch('we should allow drag and drop image support for our extension')).toBe(false)
    expect(taskAllowsWebSearch('Add web search support to this app')).toBe(false)
    expect(taskAllowsWebSearch('Implement a browse files button')).toBe(false)
  })

  it('allows explicit web research and current factual requests', () => {
    expect(taskAllowsWebSearch('Search the web for official VS Code drag and drop docs')).toBe(true)
    expect(taskAllowsWebSearch('Research browser drag and drop security restrictions')).toBe(true)
    expect(taskAllowsWebSearch('What is the latest stable VS Code API version?')).toBe(true)
  })

  it('keeps ambiguous local phrases denied', () => {
    expect(taskAllowsWebSearch('Fix the search component')).toBe(false)
    expect(taskAllowsWebSearch('Update the current implementation')).toBe(false)
    expect(taskAllowsWebSearch('Compare the two providers in this repo')).toBe(false)
  })
})

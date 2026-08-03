import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import type { ToolCall, ToolOutcome } from './tools'

const HOOKS_REL = path.join('.trie-ide', 'hooks.json')

interface HookRule {
  tool?: string
  whenContains?: string
  deny?: string
  rewriteArgs?: Record<string, unknown>
  replaceOutput?: string
}

interface PostAgentHookRule {
  when?: 'step_complete' | 'step_failed' | '*'
  deny?: string
  rewriteSummaryPrefix?: string
  replaceSummary?: string
}

interface HooksFile {
  preTool?: HookRule[]
  postTool?: HookRule[]
  postAgent?: PostAgentHookRule[]
}

export class HookManager {
  private loaded = false
  private hooks: HooksFile = {}
  private readonly workspaceRoot: string

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    const abs = path.join(this.workspaceRoot, HOOKS_REL)
    try {
      if (!fs.existsSync(abs)) return
      const raw = JSON.parse(fs.readFileSync(abs, 'utf8')) as HooksFile
      this.hooks = {
        preTool: Array.isArray(raw.preTool) ? raw.preTool : [],
        postTool: Array.isArray(raw.postTool) ? raw.postTool : [],
        postAgent: Array.isArray(raw.postAgent) ? raw.postAgent : [],
      }
    } catch {
      this.hooks = {}
    }
  }

  preTool(call: ToolCall): { denied?: string; rewritten: ToolCall } {
    this.load()
    const trusted = vscode.workspace.isTrusted
    let rewritten = call
    for (const rule of this.hooks.preTool ?? []) {
      if (!matchesToolRule(rule, rewritten)) continue
      if (rule.deny) return { denied: rule.deny, rewritten }
      if (rule.rewriteArgs && trusted) {
        rewritten = { ...rewritten, args: { ...rewritten.args, ...rule.rewriteArgs } }
      }
    }
    return { rewritten }
  }

  postTool(call: ToolCall, outcome: ToolOutcome): ToolOutcome {
    this.load()
    if (!vscode.workspace.isTrusted) return outcome
    let next = outcome
    for (const rule of this.hooks.postTool ?? []) {
      if (!matchesToolRule(rule, call)) continue
      if (rule.deny) {
        next = { ok: false, uiSummary: 'denied by hook', result: `Error: ${rule.deny}` }
        continue
      }
      if (rule.replaceOutput !== undefined) {
        next = { ...next, result: rule.replaceOutput }
      }
    }
    return next
  }

  postAgent(
    when: 'step_complete' | 'step_failed',
    summary: string,
  ): { denied?: string; summary: string } {
    this.load()
    if (!vscode.workspace.isTrusted) return { summary }
    let next = summary
    for (const rule of this.hooks.postAgent ?? []) {
      if (rule.when && rule.when !== '*' && rule.when !== when) continue
      if (rule.deny) return { denied: rule.deny, summary: next }
      if (rule.replaceSummary !== undefined) {
        next = rule.replaceSummary
        continue
      }
      if (rule.rewriteSummaryPrefix) {
        next = `${rule.rewriteSummaryPrefix}${next}`
      }
    }
    return { summary: next }
  }
}

function matchesToolRule(rule: HookRule, call: ToolCall): boolean {
  if (rule.tool && rule.tool !== '*' && rule.tool !== call.tool) return false
  if (!rule.whenContains?.trim()) return true
  const haystack = JSON.stringify(call.args)
  return haystack.includes(rule.whenContains)
}

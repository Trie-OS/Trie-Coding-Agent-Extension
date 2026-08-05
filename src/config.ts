import * as vscode from 'vscode'
import { normalizeAgentProfile, type AgentProfileName } from './agent/agentProfiles.ts'

export type BackendKind = 'daemon' | 'openai-compatible'
export type FrontierProvider = 'openai' | 'anthropic' | 'moonshot'
export type WebSearchProvider = 'none' | 'exa' | 'tavily' | 'ceramic'

export interface FrontierSlot {
  provider: FrontierProvider
  apiKey: string
  models: [string, string, string]
  activeModel: 0 | 1 | 2
}

export interface FrontierAssistConfig {
  enabled: boolean
  activeSlot: 0 | 1 | 2
  slots: [FrontierSlot, FrontierSlot, FrontierSlot]
}

export interface ActiveFrontierConfig {
  provider: FrontierProvider
  apiKey: string
  model: string
  slot: number
  modelIndex: number
}

export interface HybridModelOption {
  label: string
  slot: number
  modelIndex: number
  active: boolean
}

export interface AgentBudgetSettings {
  modeDeadlineCodeMs: number
  modeDeadlinePlanMs: number
  modeDeadlineAskMs: number
  modeGenerationsPlan: number
  modeGenerationsAsk: number
  maxCompactionGenerations: number
  recommendationDeadlineMs: number
  recommendationGenerationLimit: number
  recommendationExplorationCalls: number
  recommendationExplorationMs: number
  frontierConsultLimit: number
  frontierCompletionLimit: number
  reservedFinishMs: number
}

export interface ExtensionConfig {
  backend: BackendKind
  daemon: {
    url: string
    storePath: string
    contextLength: number
    autoStart: boolean
    keepRunning: boolean
    command: string
  }
  api: { baseUrl: string; modelName: string; apiKey: string }
  agent: {
    maxToolCalls: number
    temperature: number
    maxTokens: number
    profile: AgentProfileName
    budgets: AgentBudgetSettings
  }
  frontierAssist: FrontierAssistConfig
  webSearch: {
    provider: WebSearchProvider
    apiKey: string
    maxResults: number
  }
  index: {
    enabled: boolean
    onStartup: boolean
    maxResults: number
    scoreThreshold: number
  }
}

const DEFAULT_SLOT = (provider: FrontierProvider): FrontierSlot => ({
  provider,
  apiKey: '',
  models: ['', '', ''],
  activeModel: 0,
})

const DEFAULT_SLOTS: [FrontierSlot, FrontierSlot, FrontierSlot] = [
  DEFAULT_SLOT('openai'),
  DEFAULT_SLOT('anthropic'),
  DEFAULT_SLOT('moonshot'),
]

const PROVIDER_LABELS: Record<FrontierProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  moonshot: 'Moonshot',
}

const DEFAULT_MODELS: Record<FrontierProvider, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
  moonshot: 'kimi-k2-0711-preview',
}

export function providerLabel(provider: FrontierProvider): string {
  return PROVIDER_LABELS[provider]
}

export function defaultFrontierModel(provider: FrontierProvider): string {
  return DEFAULT_MODELS[provider]
}

function clampSlot(n: number): 0 | 1 | 2 {
  if (n <= 0) return 0
  if (n >= 2) return 2
  return n as 0 | 1 | 2
}

function normalizeSlot(raw: Partial<FrontierSlot> | undefined, fallback: FrontierSlot): FrontierSlot {
  const provider =
    raw?.provider === 'anthropic' || raw?.provider === 'moonshot' || raw?.provider === 'openai'
      ? raw.provider
      : fallback.provider
  const models = Array.isArray(raw?.models) ? raw!.models.map(String) : []
  return {
    provider,
    apiKey: typeof raw?.apiKey === 'string' ? raw.apiKey : '',
    models: [
      models[0]?.trim() ?? '',
      models[1]?.trim() ?? '',
      models[2]?.trim() ?? '',
    ] as [string, string, string],
    activeModel: clampSlot(typeof raw?.activeModel === 'number' ? raw.activeModel : 0),
  }
}

function normalizeSlots(raw: unknown): [FrontierSlot, FrontierSlot, FrontierSlot] {
  const arr = Array.isArray(raw) ? raw : []
  return [
    normalizeSlot(arr[0] as Partial<FrontierSlot>, DEFAULT_SLOTS[0]),
    normalizeSlot(arr[1] as Partial<FrontierSlot>, DEFAULT_SLOTS[1]),
    normalizeSlot(arr[2] as Partial<FrontierSlot>, DEFAULT_SLOTS[2]),
  ]
}

function readFrontierAssist(cfg: vscode.WorkspaceConfiguration): FrontierAssistConfig {
  const enabled = cfg.get<boolean>('frontierAssist.enabled', false)
  const activeSlot = clampSlot(cfg.get<number>('frontierAssist.activeSlot', 0))
  let slots = normalizeSlots(cfg.get('frontierAssist.slots'))

  const legacyApiKey = cfg.get<string>('frontierAssist.apiKey', '').trim()
  if (legacyApiKey && !slots[0].apiKey.trim()) {
    const legacyProvider = cfg.get<FrontierProvider>('frontierAssist.provider', 'openai')
    const legacyModel = cfg.get<string>('frontierAssist.model', '').trim()
    slots[0] = {
      provider: legacyProvider,
      apiKey: legacyApiKey,
      models: [legacyModel, '', ''],
      activeModel: 0,
    }
  }

  return { enabled, activeSlot, slots }
}

/** Resolved provider + model + key for the active slot selection. */
export function getActiveFrontierConfig(fa: FrontierAssistConfig): ActiveFrontierConfig | null {
  const slot = fa.slots[fa.activeSlot]
  if (!slot?.apiKey.trim()) return null
  const modelIndex = slot.activeModel
  const named = slot.models[modelIndex]?.trim()
  const model = named || defaultFrontierModel(slot.provider)
  return {
    provider: slot.provider,
    apiKey: slot.apiKey,
    model,
    slot: fa.activeSlot,
    modelIndex,
  }
}

export function listHybridModelOptions(fa: FrontierAssistConfig): HybridModelOption[] {
  const options: HybridModelOption[] = []
  for (let slot = 0; slot < 3; slot++) {
    const s = fa.slots[slot]
    if (!s.apiKey.trim()) continue
    for (let modelIndex = 0; modelIndex < 3; modelIndex++) {
      const name = s.models[modelIndex]?.trim()
      if (!name) continue
      options.push({
        label: `${providerLabel(s.provider)} · ${name}`,
        slot,
        modelIndex,
        active: fa.activeSlot === slot && s.activeModel === modelIndex,
      })
    }
  }
  return options
}

export function hybridActiveLabel(fa: FrontierAssistConfig): string {
  const active = getActiveFrontierConfig(fa)
  if (!active) return 'Hybrid'
  const named = fa.slots[active.slot].models[active.modelIndex]?.trim()
  if (named) return `${providerLabel(active.provider)} · ${named}`
  return `${providerLabel(active.provider)} · ${active.model}`
}

export function isHybridConfigured(fa: FrontierAssistConfig): boolean {
  return listHybridModelOptions(fa).length > 0
}

export function isWebSearchConfigured(cfg: ExtensionConfig): boolean {
  return cfg.webSearch.provider !== 'none' && cfg.webSearch.apiKey.trim().length > 0
}

/** First workspace folder — used for resource-scoped `index.*` settings. */
export function getPrimaryWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0]
}

/** Configuration scoped to the primary workspace folder (required for `scope: resource` keys). */
export function getResourceConfiguration(): vscode.WorkspaceConfiguration {
  const folder = getPrimaryWorkspaceFolder()
  return folder
    ? vscode.workspace.getConfiguration('trie-ide', folder.uri)
    : vscode.workspace.getConfiguration('trie-ide')
}

const INDEX_DEFAULTS = {
  enabled: true,
  onStartup: true,
  maxResults: 30,
  scoreThreshold: 0.4,
} as const

/** Pre-0.5.11 package.json default for tool-call cap. */
export const LEGACY_MAX_TOOL_CALLS = 24

export function normalizeMaxToolCalls(value: number): number {
  return value === LEGACY_MAX_TOOL_CALLS ? 0 : value
}

const AGENT_BUDGET_DEFAULTS: AgentBudgetSettings = {
  modeDeadlineCodeMs: 8 * 60_000,
  modeDeadlinePlanMs: 4 * 60_000,
  modeDeadlineAskMs: 2 * 60_000,
  modeGenerationsPlan: 10,
  modeGenerationsAsk: 8,
  maxCompactionGenerations: 2,
  recommendationDeadlineMs: 120_000,
  recommendationGenerationLimit: 6,
  recommendationExplorationCalls: 3,
  recommendationExplorationMs: 90_000,
  frontierConsultLimit: 4,
  frontierCompletionLimit: 4,
  reservedFinishMs: 45_000,
}

function readAgentBudgetSettings(cfg: vscode.WorkspaceConfiguration): AgentBudgetSettings {
  return {
    modeDeadlineCodeMs: cfg.get<number>(
      'agent.budgets.modeDeadlineCodeMs',
      AGENT_BUDGET_DEFAULTS.modeDeadlineCodeMs,
    ),
    modeDeadlinePlanMs: cfg.get<number>(
      'agent.budgets.modeDeadlinePlanMs',
      AGENT_BUDGET_DEFAULTS.modeDeadlinePlanMs,
    ),
    modeDeadlineAskMs: cfg.get<number>(
      'agent.budgets.modeDeadlineAskMs',
      AGENT_BUDGET_DEFAULTS.modeDeadlineAskMs,
    ),
    modeGenerationsPlan: cfg.get<number>(
      'agent.budgets.modeGenerationsPlan',
      AGENT_BUDGET_DEFAULTS.modeGenerationsPlan,
    ),
    modeGenerationsAsk: cfg.get<number>(
      'agent.budgets.modeGenerationsAsk',
      AGENT_BUDGET_DEFAULTS.modeGenerationsAsk,
    ),
    maxCompactionGenerations: cfg.get<number>(
      'agent.budgets.maxCompactionGenerations',
      AGENT_BUDGET_DEFAULTS.maxCompactionGenerations,
    ),
    recommendationDeadlineMs: cfg.get<number>(
      'agent.budgets.recommendationDeadlineMs',
      AGENT_BUDGET_DEFAULTS.recommendationDeadlineMs,
    ),
    recommendationGenerationLimit: cfg.get<number>(
      'agent.budgets.recommendationGenerationLimit',
      AGENT_BUDGET_DEFAULTS.recommendationGenerationLimit,
    ),
    recommendationExplorationCalls: cfg.get<number>(
      'agent.budgets.recommendationExplorationCalls',
      AGENT_BUDGET_DEFAULTS.recommendationExplorationCalls,
    ),
    recommendationExplorationMs: cfg.get<number>(
      'agent.budgets.recommendationExplorationMs',
      AGENT_BUDGET_DEFAULTS.recommendationExplorationMs,
    ),
    frontierConsultLimit: cfg.get<number>(
      'agent.budgets.frontierConsultLimit',
      AGENT_BUDGET_DEFAULTS.frontierConsultLimit,
    ),
    frontierCompletionLimit: cfg.get<number>(
      'agent.budgets.frontierCompletionLimit',
      AGENT_BUDGET_DEFAULTS.frontierCompletionLimit,
    ),
    reservedFinishMs: cfg.get<number>(
      'agent.budgets.reservedFinishMs',
      AGENT_BUDGET_DEFAULTS.reservedFinishMs,
    ),
  }
}

/** Read index.* with folder → workspace file → user precedence (matches VS Code settings UI). */
function readIndexConfig(cfg: vscode.WorkspaceConfiguration): ExtensionConfig['index'] {
  const pick = <T>(key: string, fallback: T): T => {
    const inspected = cfg.inspect<T>(key)
    if (inspected?.workspaceFolderValue !== undefined) return inspected.workspaceFolderValue
    // Older builds wrote resource keys with ConfigurationTarget.Workspace — still honor them.
    if (inspected?.workspaceValue !== undefined) return inspected.workspaceValue
    if (inspected?.globalValue !== undefined) return inspected.globalValue
    return fallback
  }
  return {
    enabled: pick('index.enabled', INDEX_DEFAULTS.enabled),
    onStartup: pick('index.onStartup', INDEX_DEFAULTS.onStartup),
    maxResults: Math.min(100, Math.max(5, pick('index.maxResults', INDEX_DEFAULTS.maxResults))),
    scoreThreshold: Math.min(1, Math.max(0, pick('index.scoreThreshold', INDEX_DEFAULTS.scoreThreshold))),
  }
}

/**
 * Persist a workspace-scoped setting to the primary folder, falling back to user settings
 * when no folder is open or the workspace settings file is not writable.
 */
export async function updateWorkspaceScopedSetting(key: string, value: unknown): Promise<void> {
  const folder = getPrimaryWorkspaceFolder()
  if (folder) {
    const scoped = vscode.workspace.getConfiguration('trie-ide', folder.uri)
    try {
      await scoped.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder)
      return
    } catch {
      void vscode.window.showWarningMessage(
        `Could not save "${key}" to this workspace — saved to your user settings instead.`,
      )
    }
  }
  await vscode.workspace.getConfiguration('trie-ide').update(key, value, vscode.ConfigurationTarget.Global)
}

export function readConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration('trie-ide')
  const indexCfg = getResourceConfiguration()
  return {
    backend: cfg.get<BackendKind>('backend', 'daemon'),
    daemon: {
      url: cfg.get<string>('daemon.url', 'http://127.0.0.1:7841').replace(/\/+$/, ''),
      storePath: cfg.get<string>('daemon.storePath', ''),
      contextLength: cfg.get<number>('daemon.contextLength', 8192),
      autoStart: cfg.get<boolean>('daemon.autoStart', true),
      keepRunning: cfg.get<boolean>('daemon.keepRunning', false),
      command: cfg.get<string>('daemon.command', ''),
    },
    api: {
      baseUrl: cfg.get<string>('api.baseUrl', 'http://127.0.0.1:8080').replace(/\/+$/, ''),
      modelName: cfg.get<string>('api.modelName', ''),
      apiKey: cfg.get<string>('api.apiKey', ''),
    },
    agent: {
      maxToolCalls: normalizeMaxToolCalls(cfg.get<number>('agent.maxToolCalls', 0)),
      temperature: cfg.get<number>('agent.temperature', 0.2),
      maxTokens: cfg.get<number>('agent.maxTokens', 2048),
      profile: normalizeAgentProfile(cfg.get<string>('agent.profile', 'default')),
      budgets: readAgentBudgetSettings(cfg),
    },
    frontierAssist: readFrontierAssist(cfg),
    webSearch: {
      provider: cfg.get<WebSearchProvider>('webSearch.provider', 'none'),
      apiKey: cfg.get<string>('webSearch.apiKey', ''),
      maxResults: cfg.get<number>('webSearch.maxResults', 5),
    },
    index: readIndexConfig(indexCfg),
  }
}

export async function setFrontierSelection(
  slot: number,
  modelIndex: number,
): Promise<void> {
  const settings = vscode.workspace.getConfiguration('trie-ide')
  const fa = readFrontierAssist(settings)
  const s = clampSlot(slot)
  const m = clampSlot(modelIndex)
  const slots = [...fa.slots] as [FrontierSlot, FrontierSlot, FrontierSlot]
  slots[s] = { ...slots[s], activeModel: m }
  await settings.update('frontierAssist.activeSlot', s, vscode.ConfigurationTarget.Global)
  await settings.update('frontierAssist.slots', slots, vscode.ConfigurationTarget.Global)
}

export async function setHybridEnabled(enabled: boolean): Promise<void> {
  const settings = vscode.workspace.getConfiguration('trie-ide')
  await settings.update('frontierAssist.enabled', enabled, vscode.ConfigurationTarget.Global)
}

/** One-time migration for users who still have pre-0.5.11 budget defaults persisted. */
export async function migrateLegacyAgentBudgetDefaults(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('trie-ide')
  const targets: Array<[unknown, vscode.ConfigurationTarget]> = [
    [cfg.inspect<number>('agent.maxToolCalls')?.globalValue, vscode.ConfigurationTarget.Global],
    [cfg.inspect<number>('agent.maxToolCalls')?.workspaceValue, vscode.ConfigurationTarget.Workspace],
    [cfg.inspect<number>('agent.maxToolCalls')?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder],
  ]
  for (const [value, target] of targets) {
    if (value === LEGACY_MAX_TOOL_CALLS) {
      await cfg.update('agent.maxToolCalls', 0, target)
    }
  }
  // Code mode no longer has a generation cap — drop the obsolete setting if present.
  const legacyGenerations = cfg.inspect<number>('agent.budgets.modeGenerationsCode')
  if (legacyGenerations?.globalValue !== undefined) {
    await cfg.update('agent.budgets.modeGenerationsCode', undefined, vscode.ConfigurationTarget.Global)
  }
  if (legacyGenerations?.workspaceValue !== undefined) {
    await cfg.update('agent.budgets.modeGenerationsCode', undefined, vscode.ConfigurationTarget.Workspace)
  }
  if (legacyGenerations?.workspaceFolderValue !== undefined) {
    await cfg.update(
      'agent.budgets.modeGenerationsCode',
      undefined,
      vscode.ConfigurationTarget.WorkspaceFolder,
    )
  }
}

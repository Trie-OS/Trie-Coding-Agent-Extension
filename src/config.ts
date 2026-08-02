import * as vscode from 'vscode'

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
  agent: { maxToolCalls: number; temperature: number; maxTokens: number }
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
      maxToolCalls: cfg.get<number>('agent.maxToolCalls', 24),
      temperature: cfg.get<number>('agent.temperature', 0.2),
      maxTokens: cfg.get<number>('agent.maxTokens', 2048),
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

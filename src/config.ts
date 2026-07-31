import * as vscode from 'vscode'

export type BackendKind = 'daemon' | 'openai-compatible'
export type FrontierProvider = 'openai' | 'anthropic'
export type WebSearchProvider = 'none' | 'exa' | 'tavily' | 'ceramic'

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
  frontierAssist: {
    enabled: boolean
    provider: FrontierProvider
    model: string
    apiKey: string
  }
  webSearch: {
    provider: WebSearchProvider
    apiKey: string
    maxResults: number
  }
}

export function isWebSearchConfigured(cfg: ExtensionConfig): boolean {
  return cfg.webSearch.provider !== 'none' && cfg.webSearch.apiKey.trim().length > 0
}

export function readConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration('trie-ide')
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
    frontierAssist: {
      enabled: cfg.get<boolean>('frontierAssist.enabled', false),
      provider: cfg.get<FrontierProvider>('frontierAssist.provider', 'openai'),
      model: cfg.get<string>('frontierAssist.model', ''),
      apiKey: cfg.get<string>('frontierAssist.apiKey', ''),
    },
    webSearch: {
      provider: cfg.get<WebSearchProvider>('webSearch.provider', 'none'),
      apiKey: cfg.get<string>('webSearch.apiKey', ''),
      maxResults: cfg.get<number>('webSearch.maxResults', 5),
    },
  }
}

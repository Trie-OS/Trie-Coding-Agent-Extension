import * as vscode from 'vscode'
import { readConfig } from '../config'

export async function runHybridSetup(onConfigured: () => void): Promise<void> {
  const cfg = readConfig()

  const enable = await vscode.window.showQuickPick(
    [
      { label: 'Enable hybrid mode', value: true as const, description: 'Local model works; frontier model advises at checkpoints' },
      { label: 'Disable hybrid mode', value: false as const, description: 'Local-only — no cloud calls' },
    ],
    {
      title: 'Hybrid mode',
      placeHolder: cfg.frontierAssist.enabled ? 'Hybrid mode is on' : 'Hybrid mode is off',
    },
  )
  if (!enable) return

  const settings = vscode.workspace.getConfiguration('trie-ide')
  await settings.update('frontierAssist.enabled', enable.value, vscode.ConfigurationTarget.Global)

  if (!enable.value) {
    onConfigured()
    void vscode.window.showInformationMessage('Hybrid mode disabled — local model only.')
    return
  }

  const providerPick = await vscode.window.showQuickPick(
    [
      { label: 'OpenAI', value: 'openai' as const, description: 'gpt-4o default' },
      { label: 'Anthropic', value: 'anthropic' as const, description: 'claude-sonnet default' },
    ],
    { title: 'Hybrid mode — frontier provider', placeHolder: `Current: ${cfg.frontierAssist.provider}` },
  )
  if (!providerPick) return
  await settings.update('frontierAssist.provider', providerPick.value, vscode.ConfigurationTarget.Global)

  const apiKey = await vscode.window.showInputBox({
    title: 'Hybrid mode — API key',
    prompt: `${providerPick.label} API key (stored in VS Code settings)`,
    password: true,
    ignoreFocusOut: true,
    value: cfg.frontierAssist.apiKey || undefined,
  })
  if (apiKey === undefined) return
  if (!apiKey.trim()) {
    void vscode.window.showWarningMessage('API key is required for hybrid mode.')
    return
  }
  await settings.update('frontierAssist.apiKey', apiKey.trim(), vscode.ConfigurationTarget.Global)

  const defaultModel =
    providerPick.value === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o'
  const model = await vscode.window.showInputBox({
    title: 'Hybrid mode — frontier model',
    prompt: 'Leave empty for provider default',
    value: cfg.frontierAssist.model || defaultModel,
    ignoreFocusOut: true,
  })
  if (model === undefined) return
  await settings.update('frontierAssist.model', model.trim(), vscode.ConfigurationTarget.Global)

  onConfigured()
  void vscode.window.showInformationMessage(
    `Hybrid mode enabled (${providerPick.label}). The local model still drives all work — the frontier model only adds purple guide notes when stuck or at the end of a turn.`,
    'Open settings',
  ).then((pick) => {
    if (pick === 'Open settings') void openHybridSettings()
  })
}

export function openHybridSettings(): Thenable<unknown> {
  return vscode.commands.executeCommand(
    'workbench.action.openSettings',
    '@ext:Trie.trie-ide frontierAssist',
  )
}

export function openAllSettings(): Thenable<unknown> {
  return vscode.commands.executeCommand(
    'workbench.action.openSettings',
    '@ext:Trie.trie-ide',
  )
}

export async function runWebSearchSetup(onConfigured: () => void): Promise<void> {
  const cfg = readConfig()
  const providerPick = await vscode.window.showQuickPick(
    [
      { label: 'Exa', value: 'exa' as const, description: 'exa.ai — neural web search' },
      { label: 'Tavily', value: 'tavily' as const, description: 'tavily.com — search built for AI agents' },
      { label: 'Ceramic', value: 'ceramic' as const, description: 'ceramic.ai — low-cost search for LLMs' },
      { label: 'Disable web search', value: 'none' as const, description: 'Remove the web_search tool' },
    ],
    {
      title: 'Web search — provider',
      placeHolder:
        cfg.webSearch.provider === 'none' ? 'Web search is off' : `Current: ${cfg.webSearch.provider}`,
    },
  )
  if (!providerPick) return

  const settings = vscode.workspace.getConfiguration('trie-ide')
  await settings.update('webSearch.provider', providerPick.value, vscode.ConfigurationTarget.Global)

  if (providerPick.value === 'none') {
    onConfigured()
    void vscode.window.showInformationMessage('Web search disabled.')
    return
  }

  const apiKey = await vscode.window.showInputBox({
    title: `Web search — ${providerPick.label} API key`,
    prompt: `${providerPick.label} API key (stored in VS Code settings; used only from this machine)`,
    password: true,
    ignoreFocusOut: true,
    value: cfg.webSearch.apiKey || undefined,
  })
  if (apiKey === undefined) return
  if (!apiKey.trim()) {
    void vscode.window.showWarningMessage('An API key is required for web search.')
    return
  }
  await settings.update('webSearch.apiKey', apiKey.trim(), vscode.ConfigurationTarget.Global)

  onConfigured()
  void vscode.window.showInformationMessage(
    `Web search enabled via ${providerPick.label}. The agent now has a web_search tool; queries go directly from your machine to ${providerPick.label}.`,
  )
}


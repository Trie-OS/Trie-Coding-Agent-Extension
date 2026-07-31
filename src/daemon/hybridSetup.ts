import * as vscode from 'vscode'
import { defaultFrontierModel, providerLabel, readConfig, type FrontierProvider } from '../config'

export async function runHybridSetup(onConfigured: () => void): Promise<void> {
  const cfg = readConfig()

  const enable = await vscode.window.showQuickPick(
    [
      { label: 'Enable hybrid mode', value: true as const, description: 'Local model works; frontier model advises at checkpoints' },
      { label: 'Disable hybrid mode', value: false as const, description: 'Local-only — no cloud calls' },
      { label: 'Open hybrid settings…', value: 'settings' as const, description: 'Configure up to 3 providers and models' },
    ],
    {
      title: 'Hybrid mode',
      placeHolder: cfg.frontierAssist.enabled ? 'Hybrid mode is on' : 'Hybrid mode is off',
    },
  )
  if (!enable) return

  if (enable.value === 'settings') {
    await openHybridSettings()
    return
  }

  const settings = vscode.workspace.getConfiguration('trie-ide')
  await settings.update('frontierAssist.enabled', enable.value, vscode.ConfigurationTarget.Global)

  if (!enable.value) {
    onConfigured()
    void vscode.window.showInformationMessage('Hybrid mode disabled — local model only.')
    return
  }

  const slot0 = cfg.frontierAssist.slots[0]
  if (slot0.apiKey.trim() && slot0.models.some((m) => m.trim())) {
    onConfigured()
    void vscode.window.showInformationMessage(
      'Hybrid mode enabled. Pick the active frontier model from the Hybrid chip in chat.',
      'Open settings',
    ).then((pick) => {
      if (pick === 'Open settings') void openHybridSettings()
    })
    return
  }

  const providerPick = await vscode.window.showQuickPick(
    [
      { label: 'OpenAI', value: 'openai' as const, description: 'gpt-4o default' },
      { label: 'Anthropic', value: 'anthropic' as const, description: 'claude-sonnet default' },
      { label: 'Moonshot AI (Kimi)', value: 'moonshot' as const, description: 'kimi-k2 default' },
    ],
    { title: 'Hybrid mode — provider (slot 1)', placeHolder: `Current: ${providerLabel(slot0.provider)}` },
  )
  if (!providerPick) return

  const apiKey = await vscode.window.showInputBox({
    title: 'Hybrid mode — API key',
    prompt: `${providerPick.label} API key (stored in VS Code settings)`,
    password: true,
    ignoreFocusOut: true,
    value: slot0.apiKey || undefined,
  })
  if (apiKey === undefined) return
  if (!apiKey.trim()) {
    void vscode.window.showWarningMessage('API key is required for hybrid mode.')
    return
  }

  const defaultModel = defaultFrontierModel(providerPick.value)
  const model = await vscode.window.showInputBox({
    title: 'Hybrid mode — frontier model',
    prompt: 'Model name for slot 1 (add more in Settings)',
    value: slot0.models[0]?.trim() || defaultModel,
    ignoreFocusOut: true,
  })
  if (model === undefined) return

  const slots = [...cfg.frontierAssist.slots] as typeof cfg.frontierAssist.slots
  slots[0] = {
    provider: providerPick.value as FrontierProvider,
    apiKey: apiKey.trim(),
    models: [model.trim(), '', ''],
    activeModel: 0,
  }
  await settings.update('frontierAssist.slots', slots, vscode.ConfigurationTarget.Global)
  await settings.update('frontierAssist.activeSlot', 0, vscode.ConfigurationTarget.Global)

  onConfigured()
  void vscode.window.showInformationMessage(
    `Hybrid mode enabled (${providerPick.label}). Add more providers in Settings; switch models from the Hybrid chip.`,
    'Open settings',
  ).then((pick) => {
    if (pick === 'Open settings') void openHybridSettings()
  })
}

export function openHybridSettings(): Thenable<unknown> {
  return vscode.commands.executeCommand('trie-ide.settings')
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

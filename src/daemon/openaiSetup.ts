import * as vscode from 'vscode'
import { readConfig } from '../config'

type HostPreset = 'ollama' | 'lmstudio'

const PRESETS: Record<HostPreset, { baseUrl: string; defaultModel: string; steps: string }> = {
  ollama: {
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen2.5-coder:7b',
    steps:
      '1. Install Ollama from https://ollama.com\n' +
      '2. Run: ollama pull qwen2.5-coder:7b\n' +
      '3. Keep Ollama running, then chat — no Connect step needed.',
  },
  lmstudio: {
    baseUrl: 'http://127.0.0.1:1234/v1',
    defaultModel: '',
    steps:
      '1. Open LM Studio → load a model\n' +
      '2. Start the local server (Developer tab, port 1234)\n' +
      '3. Enter the model name LM Studio shows, then chat — no Connect step needed.',
  },
}

export async function runOpenAiHostSetup(preset: HostPreset, onConfigured: () => void): Promise<void> {
  const info = PRESETS[preset]
  const model = await vscode.window.showInputBox({
    title: preset === 'ollama' ? 'Set up Ollama' : 'Set up LM Studio',
    prompt: 'Model name exposed by your server',
    value: info.defaultModel,
    placeHolder: preset === 'ollama' ? 'qwen2.5-coder:7b' : 'the model id shown in LM Studio',
    ignoreFocusOut: true,
  })
  if (model === undefined) return
  if (!model.trim()) {
    void vscode.window.showWarningMessage('Model name is required.')
    return
  }

  const cfg = vscode.workspace.getConfiguration('trie-ide')
  await cfg.update('backend', 'openai-compatible', vscode.ConfigurationTarget.Global)
  await cfg.update('api.baseUrl', info.baseUrl, vscode.ConfigurationTarget.Global)
  await cfg.update('api.modelName', model.trim(), vscode.ConfigurationTarget.Global)

  onConfigured()
  void vscode.window
    .showInformationMessage(
      `Trie Coding Agent will use ${model.trim()} at ${info.baseUrl}. Describe a task in the chat — Connect is not used for Ollama/LM Studio.`,
      'Show steps',
    )
    .then((pick) => {
      if (pick === 'Show steps') {
        void vscode.window.showInformationMessage(info.steps, { modal: true })
      }
    })
}

export async function promptOpenAiHost(onConfigured: () => void): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: 'Ollama',
        description: 'http://127.0.0.1:11434/v1 — easiest local setup',
        preset: 'ollama' as const,
      },
      {
        label: 'LM Studio',
        description: 'http://127.0.0.1:1234/v1 — load a GGUF in the app, start server',
        preset: 'lmstudio' as const,
      },
    ],
    { placeHolder: 'Pick a local LLM API host (no .gguf Connect step)' },
  )
  if (!picked) return
  await runOpenAiHostSetup(picked.preset, onConfigured)
}

/** Shown when Connect is pressed but backend is already openai-compatible. */
export async function explainOpenAiBackend(onConfigured: () => void): Promise<void> {
  const cfg = readConfig()
  if (cfg.api.modelName) {
    void vscode.window.showInformationMessage(
      `Already using ${cfg.api.modelName} at ${cfg.api.baseUrl}. Just describe a task — Connect is only for the embedded GGUF daemon.`,
      'Change host',
    ).then((pick) => {
      if (pick === 'Change host') void promptOpenAiHost(onConfigured)
    })
    return
  }

  const pick = await vscode.window.showWarningMessage(
    'LLM API backend is on, but trie-ide.api.modelName is empty. Set up Ollama or LM Studio — no Connect step.',
    'Set up Ollama',
    'Set up LM Studio',
    'Open Settings',
  )
  if (pick === 'Set up Ollama') await runOpenAiHostSetup('ollama', onConfigured)
  else if (pick === 'Set up LM Studio') await runOpenAiHostSetup('lmstudio', onConfigured)
  else if (pick === 'Open Settings') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'trie-ide.api')
  }
}

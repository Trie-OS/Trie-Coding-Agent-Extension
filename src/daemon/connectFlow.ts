import { basename } from 'node:path'
import * as vscode from 'vscode'
import { readConfig } from '../config'
import { DaemonClient, type DaemonStoreModel } from '../inference/daemonClient'
import type { DaemonHost } from './daemonHost'
import { explainOpenAiBackend, promptOpenAiHost } from './openaiSetup'

interface GgufPickItem extends vscode.QuickPickItem {
  pickType: 'gguf'
}

interface ModelPickItem extends vscode.QuickPickItem {
  pickType: 'model'
  model: DaemonStoreModel
  volumePath: string
}

interface ExternalHostPickItem extends vscode.QuickPickItem {
  pickType: 'external'
}

type PickItem = GgufPickItem | ModelPickItem | ExternalHostPickItem

export async function runConnectFlow(
  daemonHost: DaemonHost,
  getClient: () => DaemonClient,
  onLoaded: () => void,
): Promise<void> {
  const cfg = readConfig()
  if (cfg.backend !== 'daemon') {
    await explainOpenAiBackend(onLoaded)
    return
  }

  let reachable: boolean
  try {
    reachable = await daemonHost.restartForConnect()
  } catch (error) {
    await showLoadError(error, daemonHost)
    return
  }
  const client = getClient()
  client.clearLoaded()
  if (!reachable) {
    const pick = await vscode.window.showErrorMessage(
      `Could not reach the Trie IDE daemon at ${cfg.daemon.url}. Start an embedded daemon, run trie-daemon yourself, or switch to openai-compatible (Ollama / LM Studio).`,
      'Open Settings',
      'Show Daemon Log',
    )
    if (pick === 'Open Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'trie-ide.backend')
    } else if (pick === 'Show Daemon Log') {
      daemonHost.log('')
      await vscode.commands.executeCommand('workbench.action.output.show')
    }
    return
  }

  let store
  try {
    store = await client.store(cfg.daemon.storePath || undefined)
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Store scan failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }

  const items: PickItem[] = [
    {
      pickType: 'external',
      label: '$(server) Use Ollama or LM Studio instead…',
      description: 'Point at a running local server — no .gguf file or Node.js needed',
    },
    {
      pickType: 'gguf',
      label: '$(file) Pick a .gguf file…',
      description: 'Embedded daemon — load a bare GGUF (requires Node.js)',
    },
  ]

  if (store?.models.length) {
    for (const model of store.models) {
      items.push({
        pickType: 'model',
        label: model.displayName,
        description: `${model.quant} · ${(model.sizeBytes / 1e9).toFixed(1)} GB`,
        model,
        volumePath: store.volumePath,
      })
    }
  }

  const picked = await vscode.window.showQuickPick<PickItem>(items, {
    placeHolder: store?.models.length
      ? 'Pick a local model to load'
      : 'No model store found — pick a .gguf file or set trie-ide.daemon.storePath',
  })
  if (!picked) return

  if (picked.pickType === 'external') {
    await promptOpenAiHost(onLoaded)
    return
  }

  if (picked.pickType === 'gguf') {
    const file = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'GGUF models': ['gguf'] },
      title: 'Select a GGUF model file',
    })
    const modelPath = file?.[0]?.fsPath
    if (!modelPath) return

    const displayName = basename(modelPath, '.gguf')
    try {
      await loadWithProgress(client, displayName, modelPath, cfg.daemon.contextLength)
      onLoaded()
      void vscode.window.showInformationMessage(`Loaded ${displayName}.`)
    } catch (error) {
      await showLoadError(error, daemonHost)
    }
    return
  }

  try {
    await loadWithProgress(
      client,
      picked.model.displayName,
      `${picked.volumePath}/${picked.model.relPath}`.replace(/\/+/g, '/'),
      picked.model.ctxLen && picked.model.ctxLen > 0
        ? Math.min(picked.model.ctxLen, cfg.daemon.contextLength)
        : cfg.daemon.contextLength,
      picked.model.modelId,
    )
    onLoaded()
    void vscode.window.showInformationMessage(`Loaded ${picked.model.displayName}.`)
  } catch (error) {
    await showLoadError(error, daemonHost)
  }
}

async function loadWithProgress(
  client: DaemonClient,
  displayName: string,
  modelPath: string,
  ctxLen: number,
  modelId?: string,
): Promise<void> {
  const sizeHint = displayName.includes('14B') ? ' — large models can take several minutes' : ''
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Loading ${displayName}${sizeHint}`,
      cancellable: false,
    },
    async (progress) => {
      await client.loadModelFromPath(modelPath, displayName, ctxLen, modelId, (pct) => {
        progress.report({ message: `${pct}%` })
      })
      const loaded = await client.syncStatus()
      if (!loaded) {
        throw new Error(
          'The daemon finished loading but reports no model is active. Open Output → Trie Coding Agent Daemon for details.',
        )
      }
    },
  )
}

async function showLoadError(error: unknown, daemonHost: DaemonHost): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  daemonHost.log(`Model load failed: ${message}`)
  const pick = await vscode.window.showErrorMessage(`Model load failed: ${message}`, 'Show Daemon Log')
  if (pick === 'Show Daemon Log') {
    daemonHost.log('')
    await vscode.commands.executeCommand('workbench.action.output.show')
  }
}

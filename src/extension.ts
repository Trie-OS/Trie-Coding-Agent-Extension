import * as vscode from 'vscode'
import { ChatViewProvider } from './chat/ChatViewProvider'
import { readConfig } from './config'
import { DaemonHost } from './daemon/daemonHost'
import { runConnectFlow } from './daemon/connectFlow'
import { runHybridSetup, runWebSearchSetup } from './daemon/hybridSetup'
import { SettingsPanel } from './chat/SettingsPanel'
import { DaemonClient } from './inference/daemonClient'
import { getSymbolIndex } from './agent/symbolIndex'

let daemonHost: DaemonHost | null = null

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90)
  statusBar.command = 'trie-ide.openChat'
  statusBar.text = '$(sparkle) Trie Coding'
  statusBar.tooltip = 'Trie Coding Agent — open chat'
  statusBar.show()

  daemonHost = new DaemonHost(context)

  const provider = new ChatViewProvider(context.extensionUri, context.globalStorageUri, (label) => {
    statusBar.text = `$(sparkle) Trie Coding: ${label}`
  })

  // Codebase indexing: eager build only when opted in — the default stays
  // lazy (first search) so an idle extension costs nothing.
  const warmUpIndexIfConfigured = (): void => {
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!folder) return
    const cfg = readConfig()
    if (cfg.index.enabled && cfg.index.onStartup) {
      void getSymbolIndex(folder.uri.fsPath).warmUp()
    }
  }
  warmUpIndexIfConfigured()
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(warmUpIndexIfConfigured))

  const getDaemonClient = (): DaemonClient => {
    const cfg = readConfig()
    return (provider.daemonClient ??= new DaemonClient(cfg.daemon.url))
  }

  context.subscriptions.push(
    statusBar,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider),

    vscode.commands.registerCommand('trie-ide.openChat', async () => {
      await vscode.commands.executeCommand('trie-ide.chatView.focus')
    }),

    vscode.commands.registerCommand('trie-ide.newSession', () => provider.newSession()),

    vscode.commands.registerCommand('trie-ide.stop', () => provider.stop()),

    vscode.commands.registerCommand('trie-ide.connect', async () => {
      await runConnectFlow(daemonHost!, getDaemonClient, () => provider.refreshState())
    }),

    vscode.commands.registerCommand('trie-ide.configureHybrid', async () => {
      await runHybridSetup(() => provider.refreshState())
    }),

    vscode.commands.registerCommand('trie-ide.configureWebSearch', async () => {
      await runWebSearchSetup(() => provider.refreshState())
    }),

    vscode.commands.registerCommand('trie-ide.settings', () => {
      SettingsPanel.show(context.extensionUri, () => provider.refreshState())
    }),

    vscode.commands.registerCommand('trie-ide.installInference', async () => {
      try {
        await daemonHost!.installInferenceRuntime()
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Failed to install inference runtime: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }),

    vscode.commands.registerCommand('trie-ide.startDaemon', async () => {
      try {
        await daemonHost!.startEmbedded()
        void vscode.window.showInformationMessage('Trie Coding Agent embedded daemon started.')
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Failed to start embedded daemon: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }),

    vscode.commands.registerCommand('trie-ide.stopDaemon', async () => {
      await daemonHost!.stopEmbedded()
      void vscode.window.showInformationMessage('Trie Coding Agent embedded daemon stopped.')
    }),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('trie-ide')) provider.refreshState()
    }),

    { dispose: () => daemonHost?.dispose() },
  )

  const cfg = readConfig()
  if (cfg.backend === 'daemon') {
    void daemonHost.handshake(cfg.daemon.url).then(async (ready) => {
      if (!ready) return
      const client = getDaemonClient()
      try {
        const status = await client.status()
        if (status.loaded && status.modelId) {
          client.noteLoaded(status.modelId)
          provider.refreshState()
        }
      } catch {
        // Daemon may still be starting.
      }
    })
  }
}

export function deactivate(): void {
  daemonHost?.dispose()
  daemonHost = null
}

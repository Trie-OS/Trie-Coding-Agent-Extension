import * as vscode from 'vscode'
import { ChatViewProvider } from './chat/ChatViewProvider'
import { migrateLegacyAgentBudgetDefaults, readConfig } from './config'
import { DaemonHost } from './daemon/daemonHost'
import { runConnectFlow } from './daemon/connectFlow'
import { runHybridSetup, runWebSearchSetup } from './daemon/hybridSetup'
import { SettingsPanel } from './chat/SettingsPanel'
import { DaemonClient } from './inference/daemonClient'
import { warmUpSymbolIndex, disposeSymbolIndex } from './agent/symbolIndex'

let daemonHost: DaemonHost | null = null

export function activate(context: vscode.ExtensionContext): void {
  void migrateLegacyAgentBudgetDefaults()
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90)
  statusBar.command = 'trie-ide.openChat'
  statusBar.text = '$(sparkle) Trie Coding'
  statusBar.tooltip = 'Trie Coding Agent — open chat'
  statusBar.show()

  daemonHost = new DaemonHost(context)

  const provider = new ChatViewProvider(
    context.extensionUri,
    context.globalStorageUri,
    (label) => {
      statusBar.text = `$(sparkle) Trie Coding: ${label}`
    },
    undefined,
  )

  // Codebase indexing: build on activate when enabled + onStartup (default on).
  const warmUpIndexIfConfigured = (): void => {
    const cfg = readConfig()
    warmUpSymbolIndex({ enabled: cfg.index.enabled, onStartup: cfg.index.onStartup })
  }
  warmUpIndexIfConfigured()
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const folder of event.removed) {
        disposeSymbolIndex(folder.uri.fsPath)
      }
      warmUpIndexIfConfigured()
    }),
  )

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
      // Toggling index.onStartup / index.enabled used to do nothing until reload.
      if (
        event.affectsConfiguration('trie-ide.index.onStartup') ||
        event.affectsConfiguration('trie-ide.index.enabled')
      ) {
        warmUpIndexIfConfigured()
      }
    }),

    vscode.window.onDidChangeActiveColorTheme(() => {
      provider.refreshState()
      SettingsPanel.refreshTheme()
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

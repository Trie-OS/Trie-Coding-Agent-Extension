import * as vscode from 'vscode'
import { ChatViewProvider } from './chat/ChatViewProvider'
import { readConfig } from './config'
import { DaemonClient } from './inference/daemonClient'

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90)
  statusBar.command = 'trie-ide.openChat'
  statusBar.text = '$(sparkle) Trie IDE'
  statusBar.tooltip = 'Trie IDE Agent — open chat'
  statusBar.show()

  const provider = new ChatViewProvider(context.extensionUri, (label) => {
    statusBar.text = `$(sparkle) Trie IDE: ${label}`
  })

  context.subscriptions.push(
    statusBar,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider),

    vscode.commands.registerCommand('trie-ide.openChat', async () => {
      await vscode.commands.executeCommand('trie-ide.chatView.focus')
    }),

    vscode.commands.registerCommand('trie-ide.newSession', () => provider.newSession()),

    vscode.commands.registerCommand('trie-ide.stop', () => provider.stop()),

    vscode.commands.registerCommand('trie-ide.connect', async () => {
      const cfg = readConfig()
      if (cfg.backend !== 'daemon') {
        void vscode.window.showInformationMessage(
          'Backend is set to OpenAI-compatible — nothing to load. Switch trie-ide.backend to "daemon" to use local GGUF models.',
        )
        return
      }
      const client = (provider.daemonClient ??= new DaemonClient(cfg.daemon.url))
      try {
        await client.handshake()
      } catch {
        void vscode.window.showErrorMessage(
          `Could not reach the Trie IDE daemon at ${cfg.daemon.url}. Start it with \`npm run daemon:local\` in the Trie IDE app, or run the Trie IDE desktop app.`,
        )
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
      if (!store || store.models.length === 0) {
        void vscode.window.showWarningMessage(
          'No Trie IDE model store found on the daemon host. Set trie-ide.daemon.storePath to a drive initialized by Trie IDE.',
        )
        return
      }

      const picked = await vscode.window.showQuickPick(
        store.models.map((m) => ({
          label: m.displayName,
          description: `${m.quant} · ${(m.sizeBytes / 1e9).toFixed(1)} GB`,
          model: m,
        })),
        { placeHolder: 'Pick a local model to load' },
      )
      if (!picked) return

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Loading ${picked.model.displayName}…` },
        async () => {
          await client.loadModel(picked.model, store.volumePath, cfg.daemon.contextLength)
        },
      )
      provider.refreshState()
      void vscode.window.showInformationMessage(`Loaded ${picked.model.displayName}.`)
    }),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('trie-ide')) provider.refreshState()
    }),
  )

  // If the daemon already has a model loaded (e.g. the Trie IDE app loaded
  // it), reflect that in the status bar without requiring a connect.
  const cfg = readConfig()
  if (cfg.backend === 'daemon') {
    const client = (provider.daemonClient ??= new DaemonClient(cfg.daemon.url))
    void client
      .status()
      .then((status) => {
        if (status.loaded && status.modelId) {
          client.noteLoaded(status.modelId)
          provider.refreshState()
        }
      })
      .catch(() => {})
  }
}

export function deactivate(): void {}

import * as crypto from 'node:crypto'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { readConfig } from '../config'
import { ShadowRepo, type ChangedFileStat } from '../agent/checkpoints'
import { FrontierAssist, type GuideNote } from '../agent/frontierAssist'
import { AgentSession } from '../agent/loop'
import type { AgentMode } from '../agent/prompts'
import type { ToolCall } from '../agent/tools'
import { formatToolRow, toolGroupKey, toolLineDelta } from '../agent/tools'
import { DaemonClient } from '../inference/daemonClient'
import { OpenAiCompatibleClient } from '../inference/openaiClient'
import type { InferenceClient } from '../inference/types'

type ToWebview =
  | { type: 'state'; backend: string; model: string; hybrid: boolean; busy: boolean }
  | { type: 'tool-call'; id: number; tool: string; args: string; rowLabel: string; thought: string; groupKey?: string; linesAdded?: number; linesDeleted?: number }
  | { type: 'tool-result'; id: number; ok: boolean; summary: string; viaTrie?: boolean }
  | { type: 'todos'; todo: string[]; done: string[] }
  | { type: 'hybrid-check'; active: boolean; checkpoint?: string }
  | { type: 'guide'; checkpoint: string; verdict: string; text: string }
  | { type: 'final'; ok: boolean; text: string; checkpoint?: string }
  | { type: 'review'; checkpoint: string; files: ChangedFileStat[] }
  | { type: 'error'; text: string }
  | { type: 'notice'; text: string }
  | { type: 'restored'; sha: string; files: number }
  | { type: 'reset' }

const CHECKPOINT_SCHEME = 'trie-checkpoint'

type FromWebview =
  | { type: 'init' }
  | { type: 'send'; text: string; mode?: AgentMode }
  | { type: 'stop' }
  | { type: 'new' }
  | { type: 'connect' }
  | { type: 'settings' }
  | { type: 'restore'; sha: string }
  | { type: 'open-diff'; sha: string; path: string }

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'trie-ide.chatView'

  private view: vscode.WebviewView | null = null
  private session: AgentSession | null = null
  private abort: AbortController | null = null
  private busy = false
  private shadowRepo: ShadowRepo | null = null
  private readonly output = vscode.window.createOutputChannel('Trie Coding Agent')

  private log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`)
  }

  /** Set by the connect command so the status line can show the model. */
  daemonClient: DaemonClient | null = null

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onStatusChanged: (label: string) => void,
  ) {
    // Read-only "file as it was at the checkpoint" documents, the left side
    // of the review card's diff view.
    vscode.workspace.registerTextDocumentContentProvider(CHECKPOINT_SCHEME, {
      provideTextDocumentContent: async (uri: vscode.Uri): Promise<string> => {
        const { ref, root } = JSON.parse(uri.query) as { ref: string; root: string }
        const relPath = uri.path.replace(/^\//, '')
        try {
          return (await new ShadowRepo(root).readFileAtRef(ref, relPath)) ?? ''
        } catch {
          return ''
        }
      },
    })
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    }
    view.webview.html = this.html(view.webview)
    view.webview.onDidReceiveMessage((message: FromWebview) => void this.onMessage(message))
    this.pushState()
  }

  private post(message: ToWebview): void {
    void this.view?.webview.postMessage(message)
  }

  private pushState(): void {
    const cfg = readConfig()
    const client = this.currentClient()
    const model = client ? client.describe() : 'not configured'
    // Only show the model chip when something is actually ready to serve:
    // a loaded .gguf on the daemon path, or a configured model name otherwise.
    const ready =
      cfg.backend === 'daemon'
        ? (this.daemonClient?.hasModel() ?? false)
        : cfg.api.modelName.trim().length > 0
    this.post({
      type: 'state',
      backend: cfg.backend === 'daemon' ? 'Trie IDE daemon' : 'OpenAI-compatible',
      model: ready ? model : '',
      hybrid: cfg.frontierAssist.enabled && cfg.frontierAssist.apiKey.trim().length > 0,
      busy: this.busy,
    })
    this.onStatusChanged(model)
  }

  private currentClient(): InferenceClient | null {
    const cfg = readConfig()
    if (cfg.backend === 'daemon') {
      this.daemonClient ??= new DaemonClient(cfg.daemon.url)
      return this.daemonClient
    }
    if (!cfg.api.modelName && !cfg.api.baseUrl) return null
    return new OpenAiCompatibleClient(cfg.api.baseUrl, cfg.api.modelName, cfg.api.apiKey)
  }

  refreshState(): void {
    this.pushState()
  }

  newSession(): void {
    this.stop()
    this.session?.reset()
    this.session = null
    this.post({ type: 'reset' })
    this.pushState()
  }

  stop(): void {
    this.abort?.abort()
    if (readConfig().backend === 'daemon') void this.daemonClient?.cancel()
  }

  async runTask(text: string, mode: AgentMode = 'code'): Promise<void> {
    if (this.busy) {
      void vscode.window.showInformationMessage('Trie Coding Agent is already running — stop it first.')
      return
    }
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!folder) {
      this.post({ type: 'error', text: 'Open a folder first — the agent works on a workspace.' })
      return
    }
    const client = this.currentClient()
    if (!client) {
      this.post({ type: 'error', text: 'No backend configured. Check the Trie Coding Agent settings.' })
      return
    }

    const cfg = readConfig()
    const frontier = new FrontierAssist(() => readConfig().frontierAssist)
    this.session ??= new AgentSession(folder.uri.fsPath, folder.name, frontier)

    this.busy = true
    this.pushState()
    this.abort = new AbortController()

    // Checkpoint before any turn that can mutate the workspace (fail-soft:
    // no git or a snapshot failure just means no review card this turn —
    // but always say why, in the output channel and the chat).
    let checkpointSha: string | undefined
    if (mode === 'code') {
      try {
        this.shadowRepo ??= new ShadowRepo(folder.uri.fsPath)
        if (await this.shadowRepo.isGitAvailable()) {
          checkpointSha = await this.shadowRepo.snapshot(`before: ${text.slice(0, 72)}`)
          this.log(`checkpoint ${checkpointSha.slice(0, 8)} taken for: ${text.slice(0, 60)}`)
        } else {
          this.log('git not available — no checkpoint, no review card this turn')
          this.post({ type: 'notice', text: 'git not found — changes this turn cannot be reviewed or undone.' })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.log(`checkpoint snapshot FAILED: ${message}`)
        this.post({ type: 'notice', text: `Checkpoint failed (${message.slice(0, 120)}) — changes this turn cannot be undone.` })
      }
    }

    try {
      const result = await this.session.runTurn(
        text,
        mode,
        client,
        { temperature: cfg.agent.temperature, topP: 0.95, maxTokens: cfg.agent.maxTokens },
        cfg.agent.maxToolCalls,
        {
          onGenerating: () => {},
          onToolCall: (id: number, call: ToolCall, argsSummary: string) => {
            const delta = toolLineDelta(call)
            this.post({
              type: 'tool-call',
              id,
              tool: call.tool,
              args: argsSummary,
              rowLabel: formatToolRow(call),
              thought: call.thought,
              groupKey: toolGroupKey(call),
              linesAdded: delta.added,
              linesDeleted: delta.deleted,
            })
          },
          onToolResult: (id: number, ok: boolean, summary: string, viaTrie?: boolean) =>
            this.post({ type: 'tool-result', id, ok, summary, viaTrie }),
          onTodos: (todo: string[], done: string[]) => this.post({ type: 'todos', todo, done }),
          onHybridChecking: (active, checkpoint) =>
            this.post({ type: 'hybrid-check', active, checkpoint }),
          onGuideNote: (note: GuideNote) =>
            this.post({ type: 'guide', checkpoint: note.checkpoint, verdict: note.verdict, text: note.text }),
        },
        this.abort.signal,
      )
      // Cursor-style review card: per-file stats vs the checkpoint, with
      // Keep/Undo. Falls back to the plain restore button if stats fail.
      let reviewFiles: ChangedFileStat[] | null = null
      if (checkpointSha && this.shadowRepo) {
        try {
          reviewFiles = await this.shadowRepo.changedFileStats(checkpointSha)
          this.log(`diff vs ${checkpointSha.slice(0, 8)}: ${reviewFiles.length} changed file(s)`)
        } catch (error) {
          this.log(`diff stats FAILED: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      this.post({
        type: 'final',
        ok: result.ok,
        text: result.summary,
        // Card replaces the old restore row; keep it only when stats failed.
        checkpoint: reviewFiles === null ? checkpointSha : undefined,
      })
      if (checkpointSha && reviewFiles && reviewFiles.length > 0) {
        this.post({ type: 'review', checkpoint: checkpointSha, files: reviewFiles })
      }
    } catch (error) {
      if (this.abort.signal.aborted) {
        this.post({ type: 'final', ok: false, text: 'Stopped.', checkpoint: checkpointSha })
      } else {
        this.post({ type: 'error', text: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      this.busy = false
      this.abort = null
      this.pushState()
    }
  }

  private async restoreCheckpoint(sha: string): Promise<void> {
    if (this.busy) {
      void vscode.window.showInformationMessage('Stop the agent before restoring a checkpoint.')
      return
    }
    if (!this.shadowRepo) return
    const choice = await vscode.window.showWarningMessage(
      `Restore the workspace to the checkpoint taken before this turn? Files changed since (checkpoint ${sha.slice(0, 8)}) will be reverted.`,
      { modal: true },
      'Restore',
    )
    if (choice !== 'Restore') return
    try {
      const changed = await this.shadowRepo.changedPaths(sha)
      await this.shadowRepo.restore(sha)
      this.post({ type: 'restored', sha, files: changed.length })
      void vscode.window.showInformationMessage(
        `Restored checkpoint ${sha.slice(0, 8)} (${changed.length} file${changed.length === 1 ? '' : 's'} reverted).`,
      )
    } catch (error) {
      this.post({
        type: 'error',
        text: `Restore failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  private async onMessage(message: FromWebview): Promise<void> {
    switch (message.type) {
      case 'init':
        // The webview script just loaded — (re)send state that may have been
        // posted before its message listener existed.
        this.pushState()
        break
      case 'send':
        await this.runTask(message.text, message.mode ?? 'code')
        break
      case 'stop':
        this.stop()
        break
      case 'new':
        this.newSession()
        break
      case 'connect':
        await vscode.commands.executeCommand('trie-ide.connect')
        break
      case 'settings':
        await vscode.commands.executeCommand('trie-ide.settings')
        break
      case 'restore':
        await this.restoreCheckpoint(message.sha)
        break
      case 'open-diff':
        await this.openCheckpointDiff(message.sha, message.path)
        break
    }
  }

  /** Diff view: the file at the pre-turn checkpoint vs what's on disk now. */
  private async openCheckpointDiff(sha: string, relPath: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!folder) return
    const original = vscode.Uri.from({
      scheme: CHECKPOINT_SCHEME,
      path: `/${relPath}`,
      query: JSON.stringify({ ref: sha, root: folder.uri.fsPath }),
    })
    const current = vscode.Uri.joinPath(folder.uri, relPath)
    const name = path.basename(relPath)
    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        original,
        current,
        `${name} (before ↔ after)`,
      )
    } catch (error) {
      this.post({
        type: 'error',
        text: `Could not open diff for ${relPath}: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex')
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'))
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.css'))
    const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png'))
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <style nonce="${nonce}">
    html, body { background: #ffffff !important; color: #171717 !important; color-scheme: light only; }
    #header, #messages, #composer, #todos { background: #ffffff !important; }
  </style>
  <link href="${styleUri}" rel="stylesheet" />
</head>
<body>
  <header id="header">
    <div id="status">
      <span id="backend-chip" class="chip" hidden></span>
      <span id="hybrid-chip" class="chip hybrid" hidden>
        <svg class="hybrid-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/>
          <path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/>
          <path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>
        </svg>
        <span class="hybrid-label">Hybrid</span>
      </span>
    </div>
    <div id="header-actions">
      <button id="connect-btn" class="ghost" title="Connect & load a local model">Connect</button>
      <button id="settings-btn" class="ghost" title="Hybrid mode &amp; extension settings">Settings</button>
      <button id="new-btn" class="ghost" title="New session">New</button>
    </div>
  </header>
  <main id="messages">
    <div id="welcome">
      <img class="logo" src="${logoUri}" width="48" height="48" alt="Trie" />
      <h2>Trie is a local-first coding agent in your editor</h2>
      <ul>
        <li>
          <svg class="li-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 20h8"/></svg>
          <div><strong>Runs on your machine:</strong> <span class="desc">open GGUF models via the embedded daemon, Ollama, or LM Studio — no cloud required.</span></div>
        </li>
        <li>
          <svg class="li-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 7l-5 5 5 5"/><path d="M20 4v16"/></svg>
          <div><strong>A real agent loop:</strong> <span class="desc">reads, searches, edits, and runs commands (always with your approval), then reports back.</span></div>
        </li>
        <li>
          <svg class="li-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/></svg>
          <div><strong>Hybrid mode:</strong> <span class="desc">your local model runs the loop; a frontier model weighs in only when you're stuck or at the finish line — advisor, never driver. Frontier judgment without paying cloud rates for every file read. Click <strong>Settings</strong> to enable.</span></div>
        </li>
      </ul>
      <div class="hint">
        <strong>Get started — pick one:</strong><br />
        <span class="desc">• <strong>Ollama / LM Studio</strong> — click <strong>Connect</strong> → <em>Use Ollama or LM Studio instead</em>, then chat (no .gguf load).<br />
        • <strong>Embedded daemon</strong> — click <strong>Connect</strong> → <em>Pick a .gguf file</em> (requires Node.js).</span>
      </div>
    </div>
  </main>
  <section id="todos" hidden></section>
  <footer id="composer">
    <textarea id="input" rows="3" placeholder="Describe a task or ask a question…"></textarea>
    <div id="composer-bottom">
      <div id="mode-picker" role="radiogroup" aria-label="Agent mode" title="Code: full agent. Plan: read-only, produces a plan. Ask: read-only Q&amp;A.">
        <button class="mode active" data-mode="code" aria-pressed="true">Code</button>
        <button class="mode" data-mode="plan" aria-pressed="false">Plan</button>
        <button class="mode" data-mode="ask" aria-pressed="false">Ask</button>
      </div>
      <div id="composer-actions">
        <button id="stop-btn" hidden>Stop</button>
        <button id="send-btn">Send</button>
      </div>
    </div>
  </footer>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}

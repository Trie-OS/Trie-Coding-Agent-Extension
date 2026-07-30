import * as crypto from 'node:crypto'
import * as vscode from 'vscode'
import { readConfig } from '../config'
import { FrontierAssist, type GuideNote } from '../agent/frontierAssist'
import { AgentSession } from '../agent/loop'
import type { ToolCall } from '../agent/tools'
import { DaemonClient } from '../inference/daemonClient'
import { OpenAiCompatibleClient } from '../inference/openaiClient'
import type { InferenceClient } from '../inference/types'

type ToWebview =
  | { type: 'state'; backend: string; model: string; hybrid: boolean; busy: boolean }
  | { type: 'tool-call'; id: number; tool: string; args: string; thought: string }
  | { type: 'tool-result'; id: number; ok: boolean; summary: string }
  | { type: 'todos'; todo: string[]; done: string[] }
  | { type: 'guide'; checkpoint: string; verdict: string; text: string }
  | { type: 'final'; ok: boolean; text: string }
  | { type: 'error'; text: string }
  | { type: 'reset' }

type FromWebview =
  | { type: 'send'; text: string }
  | { type: 'stop' }
  | { type: 'new' }
  | { type: 'connect' }

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'trie-ide.chatView'

  private view: vscode.WebviewView | null = null
  private session: AgentSession | null = null
  private abort: AbortController | null = null
  private busy = false

  /** Set by the connect command so the status line can show the model. */
  daemonClient: DaemonClient | null = null

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onStatusChanged: (label: string) => void,
  ) {}

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
    this.post({
      type: 'state',
      backend: cfg.backend === 'daemon' ? 'Trie IDE daemon' : 'OpenAI-compatible',
      model,
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

  async runTask(text: string): Promise<void> {
    if (this.busy) {
      void vscode.window.showInformationMessage('Trie IDE agent is already running — stop it first.')
      return
    }
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!folder) {
      this.post({ type: 'error', text: 'Open a folder first — the agent works on a workspace.' })
      return
    }
    const client = this.currentClient()
    if (!client) {
      this.post({ type: 'error', text: 'No backend configured. Check the Trie IDE settings.' })
      return
    }

    const cfg = readConfig()
    const frontier = new FrontierAssist(() => readConfig().frontierAssist)
    this.session ??= new AgentSession(folder.uri.fsPath, folder.name, frontier)

    this.busy = true
    this.pushState()
    this.abort = new AbortController()

    try {
      const result = await this.session.runTurn(
        text,
        client,
        { temperature: cfg.agent.temperature, topP: 0.95, maxTokens: cfg.agent.maxTokens },
        cfg.agent.maxToolCalls,
        {
          onGenerating: () => {},
          onToolCall: (id: number, call: ToolCall, argsSummary: string) =>
            this.post({ type: 'tool-call', id, tool: call.tool, args: argsSummary, thought: call.thought }),
          onToolResult: (id: number, ok: boolean, summary: string) =>
            this.post({ type: 'tool-result', id, ok, summary }),
          onTodos: (todo: string[], done: string[]) => this.post({ type: 'todos', todo, done }),
          onGuideNote: (note: GuideNote) =>
            this.post({ type: 'guide', checkpoint: note.checkpoint, verdict: note.verdict, text: note.text }),
        },
        this.abort.signal,
      )
      this.post({ type: 'final', ok: result.ok, text: result.summary })
    } catch (error) {
      if (this.abort.signal.aborted) {
        this.post({ type: 'final', ok: false, text: 'Stopped.' })
      } else {
        this.post({ type: 'error', text: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      this.busy = false
      this.abort = null
      this.pushState()
    }
  }

  private async onMessage(message: FromWebview): Promise<void> {
    switch (message.type) {
      case 'send':
        await this.runTask(message.text)
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
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex')
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'))
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.css'))
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <link href="${styleUri}" rel="stylesheet" />
</head>
<body>
  <header id="header">
    <div id="status">
      <span id="backend-chip" class="chip"></span>
      <span id="hybrid-chip" class="chip hybrid" hidden>hybrid</span>
    </div>
    <div id="header-actions">
      <button id="connect-btn" class="ghost" title="Connect & load a local model">Connect</button>
      <button id="new-btn" class="ghost" title="New session">New</button>
    </div>
  </header>
  <main id="messages"></main>
  <section id="todos" hidden></section>
  <footer id="composer">
    <textarea id="input" rows="3" placeholder="Describe a task or ask a question…"></textarea>
    <div id="composer-actions">
      <button id="stop-btn" hidden>Stop</button>
      <button id="send-btn">Send</button>
    </div>
  </footer>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}

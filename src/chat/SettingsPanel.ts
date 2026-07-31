/**
 * Settings page — a webview panel with a form UI over the trie-ide.* settings,
 * styled to match the chat webview (media/main.css design tokens). Changes are
 * saved to global VS Code settings immediately on edit.
 */
import * as crypto from 'node:crypto'
import * as vscode from 'vscode'
import { readConfig } from '../config'

type FromWebview =
  | { type: 'init' }
  | { type: 'update'; key: string; value: unknown }
  | { type: 'openNative' }
  | { type: 'connect' }

/** Only these keys can be written from the webview. */
const EDITABLE_KEYS = new Set([
  'backend',
  'daemon.url',
  'daemon.autoStart',
  'daemon.keepRunning',
  'daemon.command',
  'daemon.storePath',
  'daemon.contextLength',
  'api.baseUrl',
  'api.modelName',
  'api.apiKey',
  'agent.maxToolCalls',
  'agent.temperature',
  'agent.maxTokens',
  'frontierAssist.enabled',
  'frontierAssist.provider',
  'frontierAssist.model',
  'frontierAssist.apiKey',
  'webSearch.provider',
  'webSearch.apiKey',
  'webSearch.maxResults',
])

export class SettingsPanel {
  private static current: SettingsPanel | null = null
  private readonly panel: vscode.WebviewPanel

  static show(extensionUri: vscode.Uri, onConfigured: () => void): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal()
      return
    }
    SettingsPanel.current = new SettingsPanel(extensionUri, onConfigured)
  }

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onConfigured: () => void,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'trie-ide.settingsPanel',
      'Trie Coding Agent Settings',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
        retainContextWhenHidden: true,
      },
    )
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png')
    this.panel.webview.html = this.html(this.panel.webview)
    this.panel.webview.onDidReceiveMessage((message: FromWebview) => void this.onMessage(message))
    this.panel.onDidDispose(() => {
      SettingsPanel.current = null
    })
  }

  private postConfig(): void {
    const cfg = readConfig()
    void this.panel.webview.postMessage({
      type: 'config',
      values: {
        backend: cfg.backend,
        'daemon.url': cfg.daemon.url,
        'daemon.autoStart': cfg.daemon.autoStart,
        'daemon.keepRunning': cfg.daemon.keepRunning,
        'daemon.command': cfg.daemon.command,
        'daemon.storePath': cfg.daemon.storePath,
        'daemon.contextLength': cfg.daemon.contextLength,
        'api.baseUrl': cfg.api.baseUrl,
        'api.modelName': cfg.api.modelName,
        'api.apiKey': cfg.api.apiKey,
        'agent.maxToolCalls': cfg.agent.maxToolCalls,
        'agent.temperature': cfg.agent.temperature,
        'agent.maxTokens': cfg.agent.maxTokens,
        'frontierAssist.enabled': cfg.frontierAssist.enabled,
        'frontierAssist.provider': cfg.frontierAssist.provider,
        'frontierAssist.model': cfg.frontierAssist.model,
        'frontierAssist.apiKey': cfg.frontierAssist.apiKey,
        'webSearch.provider': cfg.webSearch.provider,
        'webSearch.apiKey': cfg.webSearch.apiKey,
        'webSearch.maxResults': cfg.webSearch.maxResults,
      },
    })
  }

  private async onMessage(message: FromWebview): Promise<void> {
    switch (message.type) {
      case 'init':
        this.postConfig()
        break
      case 'update': {
        if (!EDITABLE_KEYS.has(message.key)) return
        const settings = vscode.workspace.getConfiguration('trie-ide')
        await settings.update(message.key, message.value, vscode.ConfigurationTarget.Global)
        this.onConfigured()
        void this.panel.webview.postMessage({ type: 'saved', key: message.key })
        break
      }
      case 'openNative':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:Trie.trie-ide')
        break
      case 'connect':
        await vscode.commands.executeCommand('trie-ide.connect')
        break
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex')
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
  </style>
  <link href="${styleUri}" rel="stylesheet" />
</head>
<body class="settings-body">
  <main class="settings-page">
    <header class="settings-header">
      <img src="${logoUri}" width="36" height="36" alt="Trie" />
      <div>
        <h1>Trie Coding Agent</h1>
        <p>Settings are saved as you edit. <a href="#" id="open-native">Open in the VS Code settings UI</a></p>
      </div>
      <span id="save-toast" class="save-toast" hidden>Saved ✓</span>
    </header>

    <section class="settings-card">
      <h2>Model backend</h2>
      <p class="section-desc">What serves tokens to the agent loop.</p>
      <div class="seg" role="radiogroup" aria-label="Backend">
        <button class="seg-btn" data-backend="daemon">Embedded daemon <span class="seg-sub">local .gguf</span></button>
        <button class="seg-btn" data-backend="openai-compatible">OpenAI-compatible API <span class="seg-sub">Ollama · LM Studio · cloud</span></button>
      </div>

      <div id="daemon-fields" class="field-group" hidden>
        <div class="row">
          <label for="f-daemon-url">Daemon URL</label>
          <input id="f-daemon-url" data-key="daemon.url" data-type="string" type="text" spellcheck="false" />
        </div>
        <div class="row">
          <label for="f-ctx">Context length</label>
          <input id="f-ctx" data-key="daemon.contextLength" data-type="number" type="number" min="1024" step="1024" />
        </div>
        <div class="row check">
          <input id="f-autostart" data-key="daemon.autoStart" data-type="boolean" type="checkbox" />
          <label for="f-autostart">Auto-start the embedded daemon when none is reachable</label>
        </div>
        <div class="row check">
          <input id="f-keeprunning" data-key="daemon.keepRunning" data-type="boolean" type="checkbox" />
          <label for="f-keeprunning">Keep the daemon running after VS Code closes</label>
        </div>
        <div class="row">
          <label for="f-daemon-cmd">External daemon command <span class="opt">optional</span></label>
          <input id="f-daemon-cmd" data-key="daemon.command" data-type="string" type="text" spellcheck="false" placeholder="empty = embedded daemon" />
        </div>
        <div class="row">
          <label for="f-store">Model store path <span class="opt">optional</span></label>
          <input id="f-store" data-key="daemon.storePath" data-type="string" type="text" spellcheck="false" placeholder="empty = daemon home" />
        </div>
        <div class="row">
          <button id="connect-btn" class="ghost">Connect &amp; load a .gguf model…</button>
        </div>
      </div>

      <div id="api-fields" class="field-group" hidden>
        <div class="preset-row">
          <span class="opt">Presets:</span>
          <button class="ghost preset" data-url="http://127.0.0.1:11434/v1" data-model="qwen2.5-coder:7b">Ollama</button>
          <button class="ghost preset" data-url="http://127.0.0.1:1234/v1" data-model="">LM Studio</button>
          <button class="ghost preset" data-url="https://api.openai.com/v1" data-model="gpt-4o-mini">OpenAI</button>
          <button class="ghost preset" data-url="https://api.moonshot.ai/v1" data-model="kimi-k2-0711-preview">Kimi</button>
        </div>
        <div class="row">
          <label for="f-baseurl">Base URL</label>
          <input id="f-baseurl" data-key="api.baseUrl" data-type="string" type="text" spellcheck="false" />
        </div>
        <div class="row">
          <label for="f-model">Model name</label>
          <input id="f-model" data-key="api.modelName" data-type="string" type="text" spellcheck="false" placeholder="e.g. qwen2.5-coder:7b" />
        </div>
        <div class="row">
          <label for="f-apikey">API key <span class="opt">optional for local servers</span></label>
          <input id="f-apikey" data-key="api.apiKey" data-type="string" type="password" spellcheck="false" />
        </div>
      </div>
    </section>

    <section class="settings-card">
      <h2>Agent</h2>
      <p class="section-desc">Budget and sampling for the tool loop.</p>
      <div class="grid3">
        <div class="row">
          <label for="f-maxcalls">Max tool calls / turn</label>
          <input id="f-maxcalls" data-key="agent.maxToolCalls" data-type="number" type="number" min="4" max="200" />
        </div>
        <div class="row">
          <label for="f-temp">Temperature</label>
          <input id="f-temp" data-key="agent.temperature" data-type="number" type="number" min="0" max="2" step="0.05" />
        </div>
        <div class="row">
          <label for="f-maxtok">Max tokens / response</label>
          <input id="f-maxtok" data-key="agent.maxTokens" data-type="number" type="number" min="256" step="256" />
        </div>
      </div>
    </section>

    <section class="settings-card">
      <h2>Hybrid mode <span class="badge purple">advisor</span></h2>
      <p class="section-desc">Your local model runs the loop. A frontier model adds purple guide notes only when you're stuck or at the finish line — capped to a few API calls per turn, so you get frontier judgment without frontier token bills.</p>
      <div class="row check">
        <input id="f-hybrid" data-key="frontierAssist.enabled" data-type="boolean" type="checkbox" />
        <label for="f-hybrid">Enable hybrid mode</label>
      </div>
      <div id="hybrid-fields" class="field-group">
        <div class="row">
          <label for="f-hprov">Provider</label>
          <select id="f-hprov" data-key="frontierAssist.provider" data-type="string">
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </div>
        <div class="row">
          <label for="f-hkey">API key</label>
          <input id="f-hkey" data-key="frontierAssist.apiKey" data-type="string" type="password" spellcheck="false" />
        </div>
        <div class="row">
          <label for="f-hmodel">Model <span class="opt">empty = provider default</span></label>
          <input id="f-hmodel" data-key="frontierAssist.model" data-type="string" type="text" spellcheck="false" placeholder="gpt-4o / claude-sonnet-4-20250514" />
        </div>
      </div>
    </section>

    <section class="settings-card">
      <h2>Web search</h2>
      <p class="section-desc">Gives the agent a <code>web_search</code> tool. Queries go directly from this machine to the provider with your API key — nothing is proxied.</p>
      <div class="row">
        <label for="f-wsprov">Provider</label>
        <select id="f-wsprov" data-key="webSearch.provider" data-type="string">
          <option value="none">Disabled</option>
          <option value="exa">Exa (exa.ai)</option>
          <option value="tavily">Tavily (tavily.com)</option>
          <option value="ceramic">Ceramic (ceramic.ai)</option>
        </select>
      </div>
      <div id="ws-fields" class="field-group" hidden>
        <div class="row">
          <label for="f-wskey">API key</label>
          <input id="f-wskey" data-key="webSearch.apiKey" data-type="string" type="password" spellcheck="false" />
        </div>
        <div class="row">
          <label for="f-wsmax">Max results / query</label>
          <input id="f-wsmax" data-key="webSearch.maxResults" data-type="number" type="number" min="1" max="10" />
        </div>
      </div>
    </section>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi()
    const $ = (sel) => document.querySelector(sel)
    const controls = [...document.querySelectorAll('[data-key]')]
    let currentBackend = 'daemon'

    function send(key, value) {
      vscode.postMessage({ type: 'update', key, value })
    }

    function readControl(el) {
      if (el.dataset.type === 'boolean') return el.checked
      if (el.dataset.type === 'number') {
        const n = Number(el.value)
        return Number.isFinite(n) ? n : 0
      }
      return el.value
    }

    function writeControl(el, value) {
      if (el.dataset.type === 'boolean') el.checked = Boolean(value)
      else el.value = value == null ? '' : String(value)
    }

    function applyVisibility() {
      $('#daemon-fields').hidden = currentBackend !== 'daemon'
      $('#api-fields').hidden = currentBackend !== 'openai-compatible'
      document.querySelectorAll('.seg-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.backend === currentBackend)
      })
      $('#hybrid-fields').classList.toggle('dimmed', !$('#f-hybrid').checked)
      $('#hybrid-fields').querySelectorAll('input, select').forEach((el) => {
        el.disabled = !$('#f-hybrid').checked
      })
      $('#ws-fields').hidden = $('#f-wsprov').value === 'none'
    }

    let toastTimer = null
    function flashSaved() {
      const toast = $('#save-toast')
      toast.hidden = false
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => { toast.hidden = true }, 1400)
    }

    controls.forEach((el) => {
      el.addEventListener('change', () => {
        send(el.dataset.key, readControl(el))
        applyVisibility()
      })
    })

    document.querySelectorAll('.seg-btn').forEach((b) => {
      b.addEventListener('click', () => {
        currentBackend = b.dataset.backend
        send('backend', currentBackend)
        applyVisibility()
      })
    })

    document.querySelectorAll('.preset').forEach((b) => {
      b.addEventListener('click', () => {
        $('#f-baseurl').value = b.dataset.url
        send('api.baseUrl', b.dataset.url)
        if (b.dataset.model) {
          $('#f-model').value = b.dataset.model
          send('api.modelName', b.dataset.model)
        }
      })
    })

    $('#open-native').addEventListener('click', (e) => {
      e.preventDefault()
      vscode.postMessage({ type: 'openNative' })
    })
    $('#connect-btn').addEventListener('click', () => vscode.postMessage({ type: 'connect' }))

    window.addEventListener('message', (event) => {
      const msg = event.data
      if (msg.type === 'config') {
        for (const [key, value] of Object.entries(msg.values)) {
          const el = controls.find((c) => c.dataset.key === key)
          if (el) writeControl(el, value)
          if (key === 'backend') currentBackend = value
        }
        applyVisibility()
      } else if (msg.type === 'saved') {
        flashSaved()
      }
    })

    vscode.postMessage({ type: 'init' })
  </script>
</body>
</html>`
  }
}

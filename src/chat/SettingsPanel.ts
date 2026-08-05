/**
 * Settings page — a webview panel with a form UI over the trie-ide.* settings,
 * styled to match the chat webview (media/main.css design tokens). Changes are
 * saved to VS Code settings immediately on edit (index.* per workspace folder).
 */
import * as crypto from 'node:crypto'
import * as vscode from 'vscode'
import { readConfig, updateWorkspaceScopedSetting } from '../config'
import { getSymbolIndex, onIndexStatusChange, warmUpSymbolIndex } from '../agent/symbolIndex'
import { webviewTheme } from '../theme'

type FromWebview =
  | { type: 'init' }
  | { type: 'update'; key: string; value: unknown }
  | { type: 'openNative' }
  | { type: 'connect' }
  | { type: 'indexStatus' }
  | { type: 'rebuildIndex' }
  | { type: 'update-slots'; slots: unknown; activeSlot?: number }

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
  'frontierAssist.activeSlot',
  'frontierAssist.slots',
  'webSearch.provider',
  'webSearch.apiKey',
  'webSearch.maxResults',
  'index.enabled',
  'index.onStartup',
  'index.maxResults',
  'index.scoreThreshold',
])

/** Saved per workspace folder when one is open; otherwise global. */
const WORKSPACE_SCOPED_KEYS = new Set([
  'index.enabled',
  'index.onStartup',
  'index.maxResults',
  'index.scoreThreshold',
])

export class SettingsPanel {
  private static current: SettingsPanel | null = null
  private readonly panel: vscode.WebviewPanel
  private readonly statusDisposable: vscode.Disposable

  static show(extensionUri: vscode.Uri, onConfigured: () => void): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal()
      return
    }
    SettingsPanel.current = new SettingsPanel(extensionUri, onConfigured)
  }

  static refreshTheme(): void {
    SettingsPanel.current?.postTheme()
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
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    this.statusDisposable = onIndexStatusChange((root) => {
      if (root === workspaceRoot) this.postIndexStatus()
    })
    this.panel.onDidDispose(() => {
      this.statusDisposable.dispose()
      SettingsPanel.current = null
    })
  }

  private postConfig(): void {
    const cfg = readConfig()
    this.postTheme()
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
        'frontierAssist.activeSlot': cfg.frontierAssist.activeSlot,
        'frontierAssist.slots': cfg.frontierAssist.slots,
        'webSearch.provider': cfg.webSearch.provider,
        'webSearch.apiKey': cfg.webSearch.apiKey,
        'webSearch.maxResults': cfg.webSearch.maxResults,
        'index.enabled': cfg.index.enabled,
        'index.onStartup': cfg.index.onStartup,
        'index.maxResults': cfg.index.maxResults,
        'index.scoreThreshold': cfg.index.scoreThreshold,
      },
    })
  }

  private postTheme(): void {
    void this.panel.webview.postMessage({ type: 'theme', theme: webviewTheme() })
  }

  private postIndexStatus(): void {
    const folder = vscode.workspace.workspaceFolders?.[0]
    const root = folder?.uri.fsPath
    const status = root
      ? getSymbolIndex(root).status()
      : { state: 'standby' as const, files: 0, symbols: 0, buildMs: 0, totalFiles: null }
    void this.panel.webview.postMessage({
      type: 'indexStatus',
      ...status,
      hasWorkspace: !!root,
      workspaceName: folder?.name ?? '',
    })
  }

  private async onMessage(message: FromWebview): Promise<void> {
    switch (message.type) {
      case 'init':
        this.postConfig()
        break
      case 'update': {
        if (!EDITABLE_KEYS.has(message.key)) return
        if (WORKSPACE_SCOPED_KEYS.has(message.key)) {
          await updateWorkspaceScopedSetting(message.key, message.value)
        } else {
          await vscode.workspace
            .getConfiguration('trie-ide')
            .update(message.key, message.value, vscode.ConfigurationTarget.Global)
        }
        this.onConfigured()
        void this.panel.webview.postMessage({ type: 'saved', key: message.key })
        // Enabling indexing / on-startup should start building immediately —
        // not wait for a window reload or the agent's first search_symbols.
        if (message.key === 'index.enabled' || message.key === 'index.onStartup') {
          const cfg = readConfig()
          warmUpSymbolIndex({
            enabled: cfg.index.enabled,
            onStartup: cfg.index.onStartup,
            force: message.key === 'index.enabled' && cfg.index.enabled,
          })
          this.postIndexStatus()
        }
        break
      }
      case 'openNative':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:Trie.trie-ide')
        break
      case 'connect':
        await vscode.commands.executeCommand('trie-ide.connect')
        break
      case 'indexStatus':
        this.postIndexStatus()
        break
      case 'update-slots': {
        const settings = vscode.workspace.getConfiguration('trie-ide')
        await settings.update('frontierAssist.slots', message.slots, vscode.ConfigurationTarget.Global)
        if (typeof message.activeSlot === 'number') {
          await settings.update('frontierAssist.activeSlot', message.activeSlot, vscode.ConfigurationTarget.Global)
        }
        this.onConfigured()
        void this.panel.webview.postMessage({ type: 'saved', key: 'frontierAssist.slots' })
        break
      }
      case 'rebuildIndex': {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        if (!root) break
        const rebuild = getSymbolIndex(root).rebuild()
        this.postIndexStatus() // show "Indexing…" immediately
        await rebuild
        this.postIndexStatus()
        break
      }
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex')
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.css'))
    const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png'))
    const theme = webviewTheme()
    return /* html */ `<!DOCTYPE html>
<html lang="en" data-theme="${theme}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <style nonce="${nonce}">
    html[data-theme="light"], html[data-theme="light"] body { background: #ffffff; color: #171717; }
    html[data-theme="dark"], html[data-theme="dark"] body { background: #0a0a0a; color: #fafafa; }
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
        <button class="seg-btn" data-backend="openai-compatible">LLM API <span class="seg-sub">Ollama · LM Studio · cloud</span></button>
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
          <label for="f-maxcalls">Max tool calls / turn (0 = unlimited)</label>
          <input id="f-maxcalls" data-key="agent.maxToolCalls" data-type="number" type="number" min="0" max="9999" />
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
      <p class="section-desc">Local model runs the loop; frontier model advises on stuck loops and turn-end review.</p>
      <div class="row check">
        <input id="f-hybrid" data-key="frontierAssist.enabled" data-type="boolean" type="checkbox" />
        <label for="f-hybrid">Enable hybrid mode</label>
      </div>
      <div id="hybrid-fields" class="field-group">
        <div id="hybrid-slots"></div>
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

    <section class="settings-card">
      <h2>Codebase indexing</h2>
      <p class="section-desc">Each workspace gets its own symbol index on your machine — settings below apply to this project only. Powers <code>search_symbols</code> and the <code>grep</code> fast path so the agent finds declarations in milliseconds instead of scanning every file.</p>
      <div class="row check">
        <input id="f-idx" data-key="index.enabled" data-type="boolean" type="checkbox" />
        <label for="f-idx">Enable codebase indexing</label>
      </div>
      <div id="idx-fields" class="field-group">
        <div class="row">
          <label>Status</label>
          <div class="idx-status">
            <span id="idx-dot" class="status-dot grey"></span>
            <div class="idx-status-text">
              <span id="idx-state">Not indexed yet</span>
              <span id="idx-detail" class="idx-detail"></span>
            </div>
          </div>
        </div>
        <div class="row check">
          <input id="f-idx-startup" data-key="index.onStartup" data-type="boolean" type="checkbox" />
          <label for="f-idx-startup">Index when the workspace opens <span class="opt">default: on</span></label>
        </div>
        <div class="row">
          <label for="f-idx-thresh">Search score threshold <span class="opt">1.0 = exact only · lower = fuzzier (typos, initials, substrings)</span></label>
          <div class="slider-row">
            <input id="f-idx-thresh" data-key="index.scoreThreshold" data-type="number" type="range" min="0" max="1" step="0.05" />
            <span id="idx-thresh-value" class="slider-value">0.40</span>
            <button id="idx-thresh-reset" class="slider-reset" title="Reset to 0.40">↺</button>
          </div>
        </div>
        <div class="row">
          <label for="f-idx-max">Max symbol results / search</label>
          <input id="f-idx-max" data-key="index.maxResults" data-type="number" type="number" min="5" max="100" />
        </div>
        <div class="row">
          <button id="rebuild-btn" class="ghost">Rebuild index</button>
        </div>
      </div>
    </section>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi()
    const $ = (sel) => document.querySelector(sel)
    const controls = [...document.querySelectorAll('[data-key]')]
    let currentBackend = 'daemon'
    let hybridSlots = []
    let hybridActiveSlot = 0
    let hybridSaveTimer = null

    const PROVIDER_LABELS = { openai: 'OpenAI', anthropic: 'Anthropic', moonshot: 'Moonshot' }
    const DEFAULT_SLOTS = [
      { provider: 'openai', apiKey: '', models: ['', '', ''], activeModel: 0 },
      { provider: 'anthropic', apiKey: '', models: ['', '', ''], activeModel: 0 },
      { provider: 'moonshot', apiKey: '', models: ['', '', ''], activeModel: 0 },
    ]

    function normalizeSlots(raw) {
      const arr = Array.isArray(raw) ? raw : []
      return DEFAULT_SLOTS.map((fallback, i) => {
        const s = arr[i] || {}
        const models = Array.isArray(s.models) ? s.models.map(String) : []
        return {
          provider: s.provider === 'anthropic' || s.provider === 'moonshot' ? s.provider : (s.provider === 'openai' ? 'openai' : fallback.provider),
          apiKey: typeof s.apiKey === 'string' ? s.apiKey : '',
          models: [models[0] || '', models[1] || '', models[2] || ''],
          activeModel: typeof s.activeModel === 'number' ? Math.max(0, Math.min(2, s.activeModel)) : 0,
        }
      })
    }

    function scheduleSlotSave() {
      clearTimeout(hybridSaveTimer)
      hybridSaveTimer = setTimeout(() => {
        vscode.postMessage({ type: 'update-slots', slots: hybridSlots, activeSlot: hybridActiveSlot })
      }, 300)
    }

    function renderHybridSlots() {
      const root = $('#hybrid-slots')
      root.innerHTML = ''
      hybridSlots.forEach((slot, slotIdx) => {
        const details = document.createElement('details')
        details.className = 'hybrid-slot'
        details.open = slotIdx === 0
        const summary = document.createElement('summary')
        const provLabel = PROVIDER_LABELS[slot.provider] || slot.provider
        summary.textContent = 'Provider ' + (slotIdx + 1) + ' — ' + provLabel
        details.appendChild(summary)

        const body = document.createElement('div')
        body.className = 'hybrid-slot-body'

        const provRow = document.createElement('div')
        provRow.className = 'row'
        provRow.innerHTML = '<label>Provider</label>'
        const provSel = document.createElement('select')
        ;['openai', 'anthropic', 'moonshot'].forEach((p) => {
          const opt = document.createElement('option')
          opt.value = p
          opt.textContent = PROVIDER_LABELS[p]
          if (slot.provider === p) opt.selected = true
          provSel.appendChild(opt)
        })
        provSel.addEventListener('change', () => {
          hybridSlots[slotIdx].provider = provSel.value
          summary.textContent = 'Provider ' + (slotIdx + 1) + ' — ' + PROVIDER_LABELS[provSel.value]
          scheduleSlotSave()
        })
        provRow.appendChild(provSel)
        body.appendChild(provRow)

        const keyRow = document.createElement('div')
        keyRow.className = 'row'
        keyRow.innerHTML = '<label>API key</label>'
        const keyInput = document.createElement('input')
        keyInput.type = 'password'
        keyInput.spellcheck = false
        keyInput.value = slot.apiKey
        keyInput.addEventListener('input', () => {
          hybridSlots[slotIdx].apiKey = keyInput.value
          scheduleSlotSave()
        })
        keyRow.appendChild(keyInput)
        body.appendChild(keyRow)

        for (let mi = 0; mi < 3; mi++) {
          const modelRow = document.createElement('div')
          modelRow.className = 'row hybrid-model-row'
          const radioId = 'slot-' + slotIdx + '-model-' + mi
          modelRow.innerHTML =
            '<input type="radio" name="slot-' + slotIdx + '-default" id="' + radioId + '" />' +
            '<label for="' + radioId + '">Model ' + (mi + 1) + '</label>'
          const radio = modelRow.querySelector('input')
          radio.checked = slot.activeModel === mi
          radio.addEventListener('change', () => {
            if (radio.checked) {
              hybridSlots[slotIdx].activeModel = mi
              scheduleSlotSave()
            }
          })
          const modelInput = document.createElement('input')
          modelInput.type = 'text'
          modelInput.spellcheck = false
          modelInput.placeholder = mi === 0 ? 'e.g. gpt-4o' : ''
          modelInput.value = slot.models[mi] || ''
          modelInput.addEventListener('input', () => {
            hybridSlots[slotIdx].models[mi] = modelInput.value
            scheduleSlotSave()
          })
          modelRow.appendChild(modelInput)
          body.appendChild(modelRow)
        }

        details.appendChild(body)
        root.appendChild(details)
      })
      applyVisibility()
    }

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
      $('#hybrid-fields').classList.remove('dimmed')
      $('#ws-fields').hidden = $('#f-wsprov').value === 'none'
      $('#idx-fields').classList.toggle('dimmed', !$('#f-idx').checked)
      $('#idx-fields').querySelectorAll('input, button').forEach((el) => {
        el.disabled = !$('#f-idx').checked
      })
    }

    let idxPoll = null
    let idxLastState = null
    let idxJustReadyTimer = null

    function stopIdxPoll() {
      clearInterval(idxPoll)
      idxPoll = null
    }

    function startIdxPoll() {
      if (!idxPoll) idxPoll = setInterval(() => vscode.postMessage({ type: 'indexStatus' }), 1000)
    }

    function formatBuildTime(ms) {
      return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'
    }

    function formatCount(n) {
      return n >= 1000 ? (n / 1000).toFixed(1).replace(/\\.0$/, '') + 'k' : String(n)
    }

    function renderIndexStatus(msg) {
      const dot = $('#idx-dot')
      const state = $('#idx-state')
      const detail = $('#idx-detail')

      if (!msg.hasWorkspace) {
        dot.className = 'status-dot grey'
        state.textContent = 'No workspace open'
        detail.textContent = ''
        idxLastState = null
        stopIdxPoll()
        return
      }

      if (msg.state === 'indexing') {
        dot.className = 'status-dot amber'
        state.textContent = 'Indexing…'
        if (msg.totalFiles != null && msg.totalFiles > 0) {
          detail.textContent = formatCount(msg.files) + ' / ' + formatCount(msg.totalFiles) + ' files'
        } else if (msg.files > 0) {
          detail.textContent = formatCount(msg.files) + ' files scanned'
        } else {
          detail.textContent = 'Discovering files…'
        }
        idxLastState = 'indexing'
        startIdxPoll()
        return
      }

      stopIdxPoll()

      if (msg.state === 'ready') {
        const justFinished = idxLastState === 'indexing'
        idxLastState = 'ready'
        dot.className = 'status-dot green' + (justFinished ? ' just-ready' : '')
        state.textContent = justFinished ? 'Indexed ✓' : 'Indexed'
        detail.textContent =
          formatCount(msg.files) + ' files · ' +
          formatCount(msg.symbols) + ' symbols · built in ' +
          formatBuildTime(msg.buildMs)
        if (justFinished) {
          clearTimeout(idxJustReadyTimer)
          idxJustReadyTimer = setTimeout(() => {
            state.textContent = 'Indexed'
            dot.classList.remove('just-ready')
          }, 4000)
        }
        return
      }

      idxLastState = 'standby'
      dot.className = 'status-dot grey'
      state.textContent = 'Not indexed yet'
      detail.textContent = $('#f-idx-startup').checked
        ? 'Starting automatically…'
        : 'Builds when the agent first searches symbols'
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
    $('#rebuild-btn').addEventListener('click', () => {
      vscode.postMessage({ type: 'rebuildIndex' })
      vscode.postMessage({ type: 'indexStatus' })
    })

    function syncThreshDisplay() {
      $('#idx-thresh-value').textContent = Number($('#f-idx-thresh').value).toFixed(2)
    }
    $('#f-idx-thresh').addEventListener('input', syncThreshDisplay)
    $('#idx-thresh-reset').addEventListener('click', () => {
      $('#f-idx-thresh').value = '0.4'
      syncThreshDisplay()
      send('index.scoreThreshold', 0.4)
    })

    window.addEventListener('message', (event) => {
      const msg = event.data
      if (msg.type === 'theme') {
        document.documentElement.dataset.theme = msg.theme === 'dark' ? 'dark' : 'light'
      } else if (msg.type === 'config') {
        for (const [key, value] of Object.entries(msg.values)) {
          const el = controls.find((c) => c.dataset.key === key)
          if (el) writeControl(el, value)
          if (key === 'backend') currentBackend = value
          if (key === 'frontierAssist.slots') hybridSlots = normalizeSlots(value)
          if (key === 'frontierAssist.activeSlot') hybridActiveSlot = Number(value) || 0
        }
        renderHybridSlots()
        applyVisibility()
        syncThreshDisplay()
      } else if (msg.type === 'saved') {
        flashSaved()
      } else if (msg.type === 'indexStatus') {
        renderIndexStatus(msg)
      }
    })

    vscode.postMessage({ type: 'init' })
    vscode.postMessage({ type: 'indexStatus' })
  </script>
</body>
</html>`
  }
}

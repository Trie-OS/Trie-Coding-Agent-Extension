import { ArrowRight, Bot, Brain, createElement, ListChecks, MessageCircleQuestion } from 'lucide'
import { normalizeReplyMarkdownStructure } from '../../src/chat/replyMarkdown.ts'
import { ThoughtStreamParser, isToolCallEnvelope, sanitizeReplyText, sanitizeThoughtDisplay } from '../../src/agent/thoughtStream.ts'

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void }

const MODE_ICONS = {
  code: Bot,
  plan: ListChecks,
  ask: MessageCircleQuestion,
} as const

;(function () {
  const vscode = acquireVsCodeApi()

  const messagesEl = document.getElementById('messages') as HTMLElement
  const inputEl = document.getElementById('input') as HTMLTextAreaElement
  const sendBtn = document.getElementById('send-btn') as HTMLButtonElement
  const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement
  const newBtn = document.getElementById('new-btn') as HTMLButtonElement
  const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement
  const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement
  const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement
  const ctxGauge = document.getElementById('ctx-gauge') as HTMLButtonElement
  const composerPlusBtn = document.getElementById('composer-plus') as HTMLButtonElement
  const composerPlusMenu = document.getElementById('composer-plus-menu') as HTMLElement
  const composerChips = document.getElementById('composer-chips') as HTMLElement
  const backendChip = document.getElementById('backend-chip') as HTMLElement
  const versionLabel = document.getElementById('version-label') as HTMLElement
  const hybridChip = document.getElementById('hybrid-chip') as HTMLButtonElement | null
  const hybridMenu = document.getElementById('hybrid-menu') as HTMLElement | null
  const hybridMenuEnabled = document.getElementById('hybrid-menu-enabled') as HTMLInputElement | null
  const hybridModelList = document.getElementById('hybrid-model-list') as HTMLElement | null
  const hybridModelLabel = hybridChip?.querySelector('.hybrid-model-label') as HTMLElement | null
  const historyBtn = document.getElementById('history-btn') as HTMLButtonElement
  const historyView = document.getElementById('history-view') as HTMLElement

  // Wire header controls first — a later init throw must not leave these dead (see 0.4.51).
  newBtn.addEventListener('click', () => vscode.postMessage({ type: 'new' }))
  connectBtn.addEventListener('click', () => vscode.postMessage({ type: 'connect' }))
  settingsBtn.addEventListener('click', () => vscode.postMessage({ type: 'settings' }))
  historyBtn.addEventListener('click', () => {
    document.body.classList.add('history-open')
    historyView.hidden = false
    vscode.postMessage({ type: 'history' })
  })

  const toolCards = new Map<number, HTMLElement>()
  let spinnerEl: HTMLElement | null = null
  let planningEl: HTMLElement | null = null
  interface HybridGroup {
    el: HTMLDetailsElement
    titleEl: HTMLElement
    metaEl: HTMLElement
    body: HTMLElement
    checkpoint: string
  }
  let pendingHybridGroup: HybridGroup | null = null
  let activeHybridLabel = 'Hybrid'
  let currentMode: keyof typeof MODE_ICONS = 'code'

  /** Read-only exploration tools — nested in an "Explored" accordion. */
  const EXPLORE_TOOLS = new Set([
    'read_file',
    'read_files',
    'list_dir',
    'glob',
    'grep',
    'search_symbols',
    'web_search',
  ])

  function isExploreTool(tool: string): boolean {
    return EXPLORE_TOOLS.has(tool)
  }

  function basename(relPath: string): string {
    const parts = relPath.split('/')
    return parts[parts.length - 1] || relPath
  }

  function formatElapsed(ms: number): string {
    const seconds = Math.max(1, Math.round(ms / 1000))
    if (seconds < 60) return seconds + 's'
    return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's'
  }

  let hybridMenuOpen = false

  function closeHybridMenu(): void {
    hybridMenuOpen = false
    if (hybridMenu) hybridMenu.hidden = true
    hybridChip?.setAttribute('aria-expanded', 'false')
  }

  function openHybridMenu(): void {
    hybridMenuOpen = true
    if (hybridMenu) hybridMenu.hidden = false
    hybridChip?.setAttribute('aria-expanded', 'true')
  }

  function renderHybridMenu(
    models: { label: string; slot: number; modelIndex: number; active: boolean }[],
    enabled: boolean,
  ): void {
    if (!hybridMenuEnabled || !hybridModelList) return
    hybridMenuEnabled.checked = enabled
    hybridModelList.innerHTML = ''
    if (models.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'hybrid-menu-empty'
      empty.textContent = 'Configure providers in Settings'
      hybridModelList.appendChild(empty)
      return
    }
    for (const m of models) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'hybrid-menu-item' + (m.active ? ' active' : '')
      btn.textContent = m.label
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        vscode.postMessage({ type: 'set-frontier', slot: m.slot, modelIndex: m.modelIndex })
        closeHybridMenu()
      })
      hybridModelList.appendChild(btn)
    }
  }

  if (hybridChip && hybridMenu) {
    hybridChip.addEventListener('click', (e) => {
      e.stopPropagation()
      if (hybridMenuOpen) closeHybridMenu()
      else openHybridMenu()
    })

    hybridMenuEnabled?.addEventListener('change', () => {
      vscode.postMessage({ type: 'toggle-hybrid', enabled: hybridMenuEnabled!.checked })
    })

    hybridMenu.addEventListener('click', (e) => e.stopPropagation())

    document.addEventListener('click', () => {
      if (hybridMenuOpen) closeHybridMenu()
    })
  }

  /* ── Turn activity accordion (Cursor-style nested groups) ─────────────── */

  interface AccordionGroup {
    el: HTMLDetailsElement
    body: HTMLElement
    metaEl: HTMLElement
    kind: 'explore' | 'edit' | 'command'
    key: string
    count: number
  }

  interface TurnSession {
    el: HTMLDetailsElement
    body: HTMLElement
    labelEl: HTMLElement
    statsEl: HTMLElement | null
    startTime: number
    lastEventAt: number
    activeGroup: AccordionGroup | null
    editedPaths: Set<string>
    exploredFiles: Set<string>
    exploredActions: number
    added: number
    deleted: number
    commandCount: number
  }

  let turnSession: TurnSession | null = null
  let liveReasoningEl: HTMLElement | null = null
  let liveReasoningBodyEl: HTMLElement | null = null
  let hadLiveReasoningThisStep = false
  let lastThoughtFingerprint = ''
  let reasoningStream = new ThoughtStreamParser()
  let liveReplyEl: HTMLElement | null = null
  let liveReplyBodyEl: HTMLElement | null = null

  function thoughtPreview(text: string, max = 92): string {
    const oneLine = text.replace(/\s+/g, ' ').trim()
    if (!oneLine) return ''
    return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…'
  }

  function setThoughtSummary(summary: HTMLElement, text: string, sinceMs: number, live: boolean): void {
    const preview = thoughtPreview(text)
    const lead = live ? 'Thinking' : sinceMs >= 800 ? `Thought for ${formatElapsed(sinceMs)}` : 'Thought'
    summary.replaceChildren()
    summary.appendChild(
      createElement(Brain, {
        class: 'acc-thought-icon',
        width: 12,
        height: 12,
        'stroke-width': 1.8,
        'aria-hidden': 'true',
      }),
    )
    const label = document.createElement('span')
    label.className = 'acc-thought-label'
    label.textContent = preview ? `${lead}: ${preview}` : live ? 'Thinking…' : lead
    summary.appendChild(label)
  }

  function resetReasoningStream(): void {
    reasoningStream.reset()
  }

  function ensureLiveReasoning(): HTMLElement {
    if (liveReasoningEl && liveReasoningBodyEl) return liveReasoningBodyEl
    const details = document.createElement('details')
    details.className = 'acc-thought-block live'
    details.open = true
    const summary = document.createElement('summary')
    summary.className = 'acc-thought-summary'
    setThoughtSummary(summary, '', 0, true)
    const body = document.createElement('div')
    body.className = 'acc-thought live-reasoning'
    details.append(summary, body)
    const session = ensureTurnSession()
    session.body.appendChild(details)
    liveReasoningEl = details
    liveReasoningBodyEl = body
    return body
  }

  function appendLiveReasoning(chunk: string): void {
    if (!chunk) return
    let delta = reasoningStream.push(chunk)
    if (!delta) {
      if (reasoningStream.inToolEnvelope()) return
      const trimmed = chunk.trimStart()
      // Reasoning-model traces (reasoning_content) are plain text, not JSON envelopes.
      if (trimmed && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        delta = chunk
      } else {
        return
      }
    }
    hadLiveReasoningThisStep = true
    const body = ensureLiveReasoning()
    const nextText = (body.textContent ?? '') + delta
    body.textContent = nextText
    const summary = liveReasoningEl?.querySelector('.acc-thought-summary') as HTMLElement | null
    if (summary) setThoughtSummary(summary, nextText, 0, true)
    scrollDown()
  }

  function settleLiveReasoning(finalText?: string): void {
    if (!liveReasoningEl) {
      resetReasoningStream()
      return
    }
    const text = sanitizeThoughtDisplay(finalText ?? liveReasoningBodyEl?.textContent ?? '').trim()
    if (!text) {
      liveReasoningEl.remove()
      liveReasoningEl = null
      liveReasoningBodyEl = null
      resetReasoningStream()
      return
    }
    if (liveReasoningBodyEl) liveReasoningBodyEl.textContent = text
    liveReasoningEl.classList.remove('live')
    liveReasoningEl.open = false
    const summary = liveReasoningEl.querySelector('.acc-thought-summary') as HTMLElement | null
    if (summary) setThoughtSummary(summary, text, 0, false)
    lastThoughtFingerprint = text.replace(/\s+/g, ' ').trim()
    liveReasoningEl = null
    liveReasoningBodyEl = null
    resetReasoningStream()
  }

  function discardLiveReasoning(): void {
    liveReasoningEl?.remove()
    liveReasoningEl = null
    liveReasoningBodyEl = null
    hadLiveReasoningThisStep = false
    resetReasoningStream()
  }

  function renderPersistedThought(text: string): void {
    const cleaned = sanitizeThoughtDisplay(text)
    if (!cleaned.trim()) return
    const session = ensureTurnSession()
    const group =
      session.activeGroup ?? ensureAccordionGroup('explore', 'Explored')
    addThoughtRow(group, cleaned, 0)
  }

  function ensureLiveReply(): HTMLElement {
    if (liveReplyEl && liveReplyBodyEl) return liveReplyBodyEl
    const el = document.createElement('div')
    el.className = 'reply live'
    const body = document.createElement('div')
    body.className = 'reply-live-body'
    el.appendChild(body)
    messagesEl.appendChild(el)
    liveReplyEl = el
    liveReplyBodyEl = body
    scrollDown()
    return body
  }

  function appendLiveReply(chunk: string): void {
    if (!chunk) return
    const body = ensureLiveReply()
    body.textContent = (body.textContent ?? '') + chunk
    scrollDown()
  }

  function settleLiveReply(text: string, failed = false): HTMLElement {
    const display = cleanReplyText(text).trim()
    const emptyReplyError = 'Error: the extension host returned an empty or invalid reply.'
    const replyFailed = failed || !display
    const el = liveReplyEl ?? document.createElement('div')
    if (!liveReplyEl) {
      el.className = 'reply' + (replyFailed ? ' failed' : '')
      messagesEl.appendChild(el)
    } else {
      el.classList.remove('live')
      if (replyFailed) el.classList.add('failed')
    }
    el.replaceChildren()
    el.appendChild(formatReplyMarkdown(display || emptyReplyError))
    liveReplyEl = null
    liveReplyBodyEl = null
    scrollDown()
    return el
  }

  function discardLiveReply(): void {
    liveReplyEl?.remove()
    liveReplyEl = null
    liveReplyBodyEl = null
  }

  /**
   * Top-level label. Exploration is deliberately not repeated here — the
   * nested "Explored N files" group already says it (Cursor does the same:
   * "Worked for 45s" on top, exploration only inside).
   */
  function turnSummaryText(session: TurnSession, finished: boolean): string {
    const parts: string[] = []
    if (session.editedPaths.size > 0) {
      const n = session.editedPaths.size
      parts.push('Editing ' + n + ' file' + (n === 1 ? '' : 's'))
    }
    if (session.commandCount > 0) {
      parts.push('ran ' + session.commandCount + ' command' + (session.commandCount === 1 ? '' : 's'))
    }
    if (parts.length === 0) {
      return finished ? 'Worked for ' + formatElapsed(Date.now() - session.startTime) : 'Working…'
    }
    return parts.join(', ')
  }

  function refreshTurnSummary(): void {
    if (!turnSession) return
    turnSession.labelEl.textContent = turnSummaryText(turnSession, false)
    if (turnSession.statsEl) {
      const showStats = turnSession.added > 0 || turnSession.deleted > 0
      turnSession.statsEl.hidden = !showStats
      if (showStats) {
        const add = turnSession.statsEl.querySelector('.stat-add') as HTMLElement
        const del = turnSession.statsEl.querySelector('.stat-del') as HTMLElement
        add.textContent = '+' + turnSession.added
        del.textContent = '−' + turnSession.deleted
      }
    }
  }

  function ensureTurnSession(): TurnSession {
    if (turnSession) return turnSession
    const el = document.createElement('details')
    el.className = 'turn-session'

    const summary = document.createElement('summary')
    summary.className = 'turn-summary'
    summary.innerHTML =
      '<span class="acc-chevron"></span>' +
      '<span class="turn-label">Working…</span>' +
      '<span class="turn-stats" hidden>' +
      '<span class="stat-add"></span> <span class="stat-del"></span></span>'
    el.appendChild(summary)

    const body = document.createElement('div')
    body.className = 'turn-body'
    el.appendChild(body)

    messagesEl.appendChild(el)
    turnSession = {
      el,
      body,
      labelEl: summary.querySelector('.turn-label') as HTMLElement,
      statsEl: summary.querySelector('.turn-stats') as HTMLElement,
      startTime: Date.now(),
      lastEventAt: Date.now(),
      activeGroup: null,
      editedPaths: new Set(),
      exploredFiles: new Set(),
      exploredActions: 0,
      added: 0,
      deleted: 0,
      commandCount: 0,
    }
    scrollDown()
    return turnSession
  }

  function closeActiveGroup(): void {
    if (turnSession) turnSession.activeGroup = null
  }

  function groupTitle(kind: AccordionGroup['kind'], key: string, count: number): string {
    if (kind === 'explore') {
      if (key === 'web-search') return 'Web search'
      const n = turnSession?.exploredFiles.size ?? 0
      if (n > 0) return 'Explored ' + n + ' file' + (n === 1 ? '' : 's')
      const actions = turnSession?.exploredActions ?? count
      return 'Explored · ' + actions
    }
    if (kind === 'edit') {
      return 'Edited ' + basename(key)
    }
    return 'Ran ' + count + ' command' + (count === 1 ? '' : 's')
  }

  function ensureAccordionGroup(kind: AccordionGroup['kind'], key: string): AccordionGroup {
    const session = ensureTurnSession()
    const active = session.activeGroup
    if (active && active.kind === kind && active.key === key) return active

    const el = document.createElement('details')
    el.className = 'acc-group acc-' + kind

    const summary = document.createElement('summary')
    summary.className = 'acc-summary'
    summary.innerHTML =
      '<span class="acc-chevron"></span>' +
      '<span class="acc-title"></span>' +
      '<span class="acc-meta"></span>'
    el.appendChild(summary)

    const body = document.createElement('div')
    body.className = 'acc-body'
    el.appendChild(body)

    session.body.appendChild(el)
    const group: AccordionGroup = {
      el,
      body,
      metaEl: summary.querySelector('.acc-meta') as HTMLElement,
      kind,
      key,
      count: 0,
    }
    ;(summary.querySelector('.acc-title') as HTMLElement).textContent = groupTitle(kind, key, 0)
    session.activeGroup = group
    scrollDown()
    return group
  }

  function bumpGroupMeta(group: AccordionGroup): void {
    group.count += 1
    ;(group.el.querySelector('.acc-title') as HTMLElement).textContent = groupTitle(
      group.kind,
      group.key,
      group.count,
    )
    if (group.kind === 'explore') {
      const n = turnSession?.exploredFiles.size ?? 0
      group.metaEl.textContent = n > 0 ? String(n) : String(turnSession?.exploredActions ?? group.count)
    } else {
      group.metaEl.textContent = String(group.count)
    }
  }

  function addThoughtRow(group: AccordionGroup, thought: string | undefined, sinceMs: number): void {
    if (!thought || !thought.trim()) return
    const fingerprint = thought.replace(/\s+/g, ' ').trim()
    if (!fingerprint || fingerprint === lastThoughtFingerprint) return
    lastThoughtFingerprint = fingerprint
    const details = document.createElement('details')
    details.className = 'acc-thought-block'
    const summary = document.createElement('summary')
    summary.className = 'acc-thought-summary'
    setThoughtSummary(summary, thought, sinceMs, false)
    const body = document.createElement('div')
    body.className = 'acc-thought'
    body.textContent = thought
    details.append(summary, body)
    group.body.appendChild(details)
  }

  function addToolRow(
    group: AccordionGroup,
    id: number,
    rowLabel: string,
    thought: string,
    sinceMs: number,
    argsPreview?: string,
    toolName?: string,
    showThought = true,
  ): HTMLElement {
    if (showThought) addThoughtRow(group, thought, sinceMs)
    const row = document.createElement('div')
    row.className = 'acc-row tool running'
    row.dataset.id = String(id)
    if (argsPreview) row.dataset.args = argsPreview
    if (toolName) row.dataset.tool = toolName
    row.innerHTML =
      '<button type="button" class="acc-expand" hidden aria-label="Show details">⏵</button>' +
      '<span class="acc-status">·</span><span class="acc-label"></span>'
    ;(row.querySelector('.acc-label') as HTMLElement).textContent = rowLabel
    group.body.appendChild(row)
    bumpGroupMeta(group)
    if (argsPreview) {
      const expand = row.querySelector('.acc-expand') as HTMLButtonElement
      expand.hidden = false
    }
    return row
  }

  function renderDiffDetailPanel(text: string): HTMLElement {
    const panel = document.createElement('div')
    panel.className = 'acc-tool-detail acc-tool-diff'
    for (const line of text.split('\n')) {
      const row = document.createElement('div')
      if (line.startsWith('\u2212')) {
        row.className = 'diff-del'
        row.textContent = line
      } else if (line.startsWith('+')) {
        row.className = 'diff-add'
        row.textContent = line
      } else {
        row.className = 'diff-context'
        row.textContent = line
      }
      panel.appendChild(row)
    }
    return panel
  }

  function attachToolDetail(row: HTMLElement, argsPreview?: string, detail?: string): void {
    if (!argsPreview && !detail) return
    const expand = row.querySelector('.acc-expand') as HTMLButtonElement | null
    if (expand) expand.hidden = false
    let panel: HTMLElement | null = null
    const toggle = (): void => {
      if (panel) {
        panel.remove()
        panel = null
        if (expand) expand.textContent = '⏵'
        row.classList.remove('expanded')
        return
      }
      const parts: string[] = []
      if (argsPreview) parts.push(argsPreview)
      if (detail) parts.push(detail)
      const combined = parts.join('\n\n')
      const isDiff =
        detail !== undefined &&
        detail.split('\n').some((line) => line.startsWith('\u2212') || line.startsWith('+'))
      if (isDiff && !argsPreview) {
        panel = renderDiffDetailPanel(detail!)
      } else if (isDiff) {
        panel = document.createElement('div')
        panel.className = 'acc-tool-detail'
        if (argsPreview) {
          const argsEl = document.createElement('pre')
          argsEl.className = 'acc-tool-args'
          argsEl.textContent = argsPreview
          panel.appendChild(argsEl)
        }
        panel.appendChild(renderDiffDetailPanel(detail!))
      } else {
        panel = document.createElement('pre')
        panel.className = 'acc-tool-detail'
        panel.textContent = combined
      }
      row.after(panel)
      row.classList.add('expanded')
      if (expand) expand.textContent = '⏷'
      scrollDown()
    }
    expand?.addEventListener('click', (event) => {
      event.stopPropagation()
      toggle()
    })
    if (detail) row.dataset.detail = detail
  }

  function trackToolCall(msg: {
    id: number
    tool: string
    args: string
    rowLabel: string
    thought: string
    groupKey?: string
    linesAdded?: number
    linesDeleted?: number
    suppressThought?: boolean
  }): HTMLElement {
    const session = ensureTurnSession()
    const sinceMs = Date.now() - session.lastEventAt
    session.lastEventAt = Date.now()
    hidePlanning()

    if (msg.linesAdded) session.added += msg.linesAdded
    if (msg.linesDeleted) session.deleted += msg.linesDeleted

    let group: AccordionGroup
    if (msg.tool === 'web_search') {
      group = ensureAccordionGroup('explore', 'web-search')
    } else if (isExploreTool(msg.tool)) {
      session.exploredActions += 1
      if (msg.tool === 'read_file' && msg.args) session.exploredFiles.add(msg.args)
      if (msg.tool === 'read_files' && msg.args) {
        for (const file of msg.args.split(',').map((item) => item.trim()).filter(Boolean)) {
          session.exploredFiles.add(file)
        }
      }
      group = ensureAccordionGroup('explore', 'explore')
    } else if (msg.tool === 'run_command') {
      session.commandCount += 1
      group = ensureAccordionGroup('command', 'command')
    } else if (msg.tool === 'edit_file' || msg.tool === 'write_file') {
      const key = msg.groupKey || msg.args || msg.tool
      if (msg.groupKey) session.editedPaths.add(msg.groupKey)
      group = ensureAccordionGroup('edit', key)
    } else {
      closeActiveGroup()
      group = ensureAccordionGroup('edit', msg.tool)
    }

    refreshTurnSummary()
    const showThought = !msg.suppressThought && !hadLiveReasoningThisStep
    hadLiveReasoningThisStep = false
    return addToolRow(group, msg.id, msg.rowLabel, msg.thought, sinceMs, msg.args, msg.tool, showThought)
  }

  /** Inline task list — one card per turn, updated in place (Cursor-style). */
  let todoCard: HTMLElement | null = null
  let todoCardSeen = false

  function renderInlineTodos(todo: string[], done: string[]): void {
    if (todo.length === 0 && done.length === 0) return
    const session = ensureTurnSession()
    closeActiveGroup()
    const total = todo.length + done.length
    if (!todoCard) {
      const el = document.createElement('details')
      el.className = 'acc-group acc-todos'
      el.innerHTML =
        '<summary class="acc-summary">' +
        '<span class="acc-chevron"></span>' +
        '<span class="acc-title">Todos</span>' +
        '<span class="acc-meta"></span>' +
        '</summary>' +
        '<div class="acc-body todo-card-body"></div>'
      session.body.appendChild(el)
      todoCard = el
    }
    const body = todoCard.querySelector('.todo-card-body') as HTMLElement
    const titleEl = todoCard.querySelector('.acc-title') as HTMLElement
    const metaEl = todoCard.querySelector('.acc-meta') as HTMLElement
    titleEl.textContent = todoCardSeen ? 'Updated todos' : 'Todos'
    metaEl.textContent = String(total)
    todoCardSeen = true
    body.innerHTML = ''
    for (const item of done) {
      const row = document.createElement('div')
      row.className = 'todo-card-item done'
      row.innerHTML = '<span class="todo-mark">✓</span><span class="todo-text"></span>'
      ;(row.querySelector('.todo-text') as HTMLElement).textContent = item
      body.appendChild(row)
    }
    for (const item of todo) {
      const row = document.createElement('div')
      row.className = 'todo-card-item'
      row.innerHTML = '<span class="todo-mark"></span><span class="todo-text"></span>'
      ;(row.querySelector('.todo-text') as HTMLElement).textContent = item
      body.appendChild(row)
    }
    scrollDown()
  }

  function turnSessionHasVisibleActivity(session: TurnSession): boolean {
    if (session.editedPaths.size > 0 || session.commandCount > 0 || session.exploredActions > 0) {
      return true
    }
    return (
      session.body.querySelector('.acc-group, .acc-row:not(.planning), .todo-card') !== null
    )
  }

  function finishTurnSession(): void {
    if (!turnSession) return
    for (const row of Array.from(
      turnSession.body.querySelectorAll<HTMLElement>('.acc-row.tool.muted:not([data-skipped])'),
    )) {
      row.classList.remove('muted')
      row.classList.add('failed')
      const status = row.querySelector('.acc-status')
      if (status) status.textContent = '✗'
    }
    refreshTurnSummary() // final +/− stats
    const session = turnSession
    session.labelEl.textContent = turnSummaryText(session, true)
    session.el.open = false
    if (!turnSessionHasVisibleActivity(session)) session.el.remove()
    turnSession = null
    lastThoughtFingerprint = ''
    todoCard = null
    todoCardSeen = false
    closeActiveGroup()
  }

  function resetTurnSession(): void {
    turnSession = null
    lastThoughtFingerprint = ''
    todoCard = null
    todoCardSeen = false
    closeActiveGroup()
  }

  function showPlanning(): void {
    hidePlanning()
    const session = ensureTurnSession()
    planningEl = document.createElement('div')
    planningEl.className = 'acc-row planning'
    planningEl.textContent = 'Planning next moves…'
    session.body.appendChild(planningEl)
    scrollDown()
  }

  function hidePlanning(): void {
    planningEl?.remove()
    planningEl = null
  }

  /** Review cards keyed by checkpoint sha, so `restored` can mark them undone. */
  const reviewCards = new Map<string, HTMLElement>()
  const questionSnapshots = new Map<
    string,
    { question: string; options: string[]; multiSelect?: boolean }[]
  >()
  const planHandoffSnapshots = new Map<string, { path: string; content: string }>()

  function fileBadge(name: string): { text: string; cls: string } {
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    if (ext === 'ts' || ext === 'tsx') return { text: 'TS', cls: 'ts' }
    if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return { text: 'JS', cls: 'js' }
    if (ext === 'css' || ext === 'scss' || ext === 'less') return { text: '#', cls: 'css' }
    if (ext === 'json') return { text: '{}', cls: 'json' }
    if (ext === 'md' || ext === 'mdx') return { text: 'M↓', cls: 'md' }
    if (ext === 'html' || ext === 'svg' || ext === 'xml') return { text: '<>', cls: 'html' }
    if (ext === 'py') return { text: 'PY', cls: 'py' }
    if (ext === 'swift') return { text: 'SW', cls: 'swift' }
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'icns'].includes(ext)) {
      return { text: '▨', cls: 'img' }
    }
    return { text: (ext.slice(0, 2) || '·').toUpperCase(), cls: 'other' }
  }

  /** Last turn checkpoint — composer Undo and review card share this. */
  let pendingUndoSha: string | null = null

  function setComposerUndo(sha: string | null, fileCount?: number): void {
    pendingUndoSha = sha
    undoBtn.hidden = !sha
    if (sha) {
      const hint =
        fileCount && fileCount > 0
          ? `Revert ${fileCount} changed file${fileCount === 1 ? '' : 's'} from the last turn`
          : "Revert the last turn's file changes"
      undoBtn.title = hint
    }
  }

  function resolveReviewCard(card: HTMLElement, state: 'kept' | 'undone'): void {
    card.classList.add('resolved', state)
    if (state === 'kept' || state === 'undone') setComposerUndo(null)
    const actions = card.querySelector('.review-actions')
    if (actions) {
      actions.innerHTML = ''
      const note = document.createElement('span')
      note.className = 'review-resolved-note'
      note.textContent = state === 'kept' ? '✓ Changes kept' : '↺ Changes undone'
      actions.appendChild(note)
    }
  }

  function fmtMs(ms: number): string {
    if (ms < 1) return '<1ms'
    if (ms < 1000) return Math.round(ms) + 'ms'
    return (ms / 1000).toFixed(1) + 's'
  }

  function attachTrieBadge(row: HTMLElement, trieMs: number, scanMs?: number): void {
    row.classList.add('trie-fast')
    const badge = document.createElement('span')
    badge.className = 'trie-badge'
    if (typeof scanMs === 'number' && scanMs > trieMs) {
      const saved = Math.max(0, scanMs - trieMs)
      badge.textContent = 'Trie saved ' + fmtMs(saved)
      badge.title = `Symbol index ${fmtMs(trieMs)} vs full scan ${fmtMs(scanMs)} on this search`
    } else {
      badge.textContent = 'Trie · ' + fmtMs(trieMs)
      badge.title = 'Answered from the prefix-trie symbol index'
    }
    row.appendChild(badge)
  }

  /* ── Context gauge + memory compaction (bottom-right of composer) ───── */

  let ctxUsed = 0
  let ctxLimit = 0
  let ctxFlashTimer: ReturnType<typeof setTimeout> | null = null

  function fmtTokens(n: number): string {
    if (n < 1000) return String(n)
    return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  }

  function applyTheme(theme: unknown): void {
    document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light'
  }

  function renderCtxGauge(): void {
    if (ctxLimit <= 0) {
      ctxGauge.hidden = true
      return
    }
    const pct = Math.min(999, Math.round((ctxUsed / ctxLimit) * 100))
    ctxGauge.hidden = false
    ctxGauge.classList.remove('compacting')
    ctxGauge.classList.toggle('warn', pct >= 75 && pct < 90)
    ctxGauge.classList.toggle('hot', pct >= 90)
    ctxGauge.textContent = fmtTokens(ctxUsed) + ' · ' + pct + '%'
    ctxGauge.title =
      'Context: ' + ctxUsed.toLocaleString() + ' / ' + ctxLimit.toLocaleString() +
      ' tokens (' + pct + '%) — click to compact memory now'
  }

  ctxGauge.addEventListener('click', () => {
    if (isBusy || ctxGauge.classList.contains('compacting')) return
    vscode.postMessage({ type: 'compact' })
  })

  function renderReviewCard(sha: string, files: { path: string; added: number; deleted: number }[]): void {
    const card = document.createElement('div')
    card.className = 'review-card'
    reviewCards.set(sha, card)

    const totalAdded = files.reduce((sum, f) => sum + f.added, 0)
    const totalDeleted = files.reduce((sum, f) => sum + f.deleted, 0)

    const head = document.createElement('div')
    head.className = 'review-head'
    const title = document.createElement('span')
    title.className = 'review-title'
    title.textContent = files.length + ' File' + (files.length === 1 ? '' : 's') + ' Changed'
    const reviewBtn = document.createElement('button')
    reviewBtn.className = 'review-open'
    reviewBtn.textContent = 'Review'
    reviewBtn.title =
      'Open a before ↔ after diff for each changed file (+' + totalAdded + ' −' + totalDeleted + ')'
    reviewBtn.addEventListener('click', () => {
      for (const file of files) {
        vscode.postMessage({ type: 'open-diff', sha, path: file.path })
      }
    })
    head.appendChild(title)
    head.appendChild(reviewBtn)
    card.appendChild(head)

    const list = document.createElement('div')
    list.className = 'review-files'
    const VISIBLE_FILES = 4
    for (const [index, file] of files.entries()) {
      const parts = file.path.split('/')
      const name = parts[parts.length - 1]
      const badge = fileBadge(name)

      const row = document.createElement('button')
      row.className = 'review-file'
      if (index >= VISIBLE_FILES) row.classList.add('overflow')
      row.title = 'Open diff: ' + file.path
      const badgeEl = document.createElement('span')
      badgeEl.className = 'file-badge ' + badge.cls
      badgeEl.textContent = badge.text
      const nameEl = document.createElement('span')
      nameEl.className = 'file-name'
      nameEl.textContent = name
      const statsEl = document.createElement('span')
      statsEl.className = 'file-stats'
      if (file.added > 0) {
        const add = document.createElement('span')
        add.className = 'stat-add'
        add.textContent = '+' + file.added
        statsEl.appendChild(add)
      }
      if (file.deleted > 0) {
        const del = document.createElement('span')
        del.className = 'stat-del'
        del.textContent = '−' + file.deleted
        statsEl.appendChild(del)
      }
      row.appendChild(badgeEl)
      row.appendChild(nameEl)
      row.appendChild(statsEl)
      row.addEventListener('click', () => {
        vscode.postMessage({ type: 'open-diff', sha, path: file.path })
      })
      list.appendChild(row)
    }
    if (files.length > VISIBLE_FILES) {
      const more = document.createElement('button')
      more.className = 'review-more'
      const hiddenCount = files.length - VISIBLE_FILES
      more.innerHTML = '<span class="review-more-dots">⋯</span><span class="review-more-label"></span>'
      ;(more.querySelector('.review-more-label') as HTMLElement).textContent =
        'Show ' + hiddenCount + ' more'
      more.addEventListener('click', () => {
        const expanded = card.classList.toggle('expanded')
        ;(more.querySelector('.review-more-label') as HTMLElement).textContent = expanded
          ? 'Show fewer'
          : 'Show ' + hiddenCount + ' more'
        scrollDown()
      })
      list.appendChild(more)
    }
    card.appendChild(list)

    const actions = document.createElement('div')
    actions.className = 'review-actions'
    const undoBtn = document.createElement('button')
    undoBtn.className = 'review-btn undo'
    undoBtn.textContent = '↺ Undo'
    undoBtn.title = 'Revert files and rewind the conversation to before this turn'
    undoBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'restore', sha })
    })
    const keepBtn = document.createElement('button')
    keepBtn.className = 'review-btn keep'
    keepBtn.textContent = '✓ Keep'
    keepBtn.title = 'Accept these changes'
    keepBtn.addEventListener('click', () => {
      resolveReviewCard(card, 'kept')
    })
    actions.appendChild(undoBtn)
    actions.appendChild(keepBtn)
    card.appendChild(actions)

    messagesEl.appendChild(card)
    scrollDown()
  }

  function hybridModelName(): string {
    return activeHybridLabel === 'Hybrid' ? 'Hybrid' : 'Hybrid · ' + activeHybridLabel
  }

  function hybridCheckpointLabel(checkpoint: string, phase: 'checking' | 'guide'): string {
    if (phase === 'checking') return 'Checking with ' + hybridModelName()
    const action: Record<string, string> = {
      decompose: 'Planned with',
      stuck_hint: 'Guidance from',
      final_review: 'Reviewed with',
      uncertainty: 'Guidance from',
      self_grade: 'Reviewed with',
    }
    return (action[checkpoint] ?? 'Checked with') + ' ' + hybridModelName()
  }

  function renderHybridSubtasks(body: HTMLElement, subtasks: string[], rationale?: string): void {
    body.innerHTML = ''
    const ol = document.createElement('ol')
    ol.className = 'hybrid-subtasks'
    for (const task of subtasks) {
      const li = document.createElement('li')
      li.textContent = task
      ol.appendChild(li)
    }
    body.appendChild(ol)
    if (rationale?.trim()) {
      const note = document.createElement('div')
      note.className = 'hybrid-plan-note'
      note.textContent = rationale.trim()
      body.appendChild(note)
    }
  }

  function createHybridGroup(checkpoint: string): HybridGroup {
    const session = ensureTurnSession()
    closeActiveGroup()
    const el = document.createElement('details')
    el.className = 'acc-group acc-hybrid checking'
    el.dataset.checkpoint = checkpoint

    const summary = document.createElement('summary')
    summary.className = 'acc-summary'
    summary.innerHTML =
      '<span class="acc-chevron"></span>' +
      '<span class="acc-title"></span>' +
      '<span class="acc-meta"></span>'
    el.appendChild(summary)

    const body = document.createElement('div')
    body.className = 'acc-body'
    el.appendChild(body)

    session.body.appendChild(el)
    scrollDown()

    return {
      el,
      titleEl: summary.querySelector('.acc-title') as HTMLElement,
      metaEl: summary.querySelector('.acc-meta') as HTMLElement,
      body,
      checkpoint,
    }
  }

  function showHybridCheck(checkpoint: string): void {
    hideSpinner()
    pendingHybridGroup = createHybridGroup(checkpoint)
    pendingHybridGroup.titleEl.textContent = hybridCheckpointLabel(checkpoint, 'checking')
    pendingHybridGroup.metaEl.textContent = ''
    pendingHybridGroup.body.innerHTML = ''
    if (checkpoint === 'decompose') {
      const row = document.createElement('div')
      row.className = 'acc-hybrid-note'
      row.textContent = 'Breaking the task into steps…'
      pendingHybridGroup.body.appendChild(row)
    }
  }

  function showHybridPlan(subtasks: string[], rationale?: string): void {
    hideSpinner()
    let group = pendingHybridGroup
    if (!group || group.checkpoint !== 'decompose') {
      group = createHybridGroup('decompose')
      pendingHybridGroup = group
    }
    group.el.classList.remove('checking')
    group.el.classList.add('plan')
    group.titleEl.textContent = hybridCheckpointLabel('decompose', 'guide')
    group.metaEl.textContent = String(subtasks.length)
    renderHybridSubtasks(group.body, subtasks, rationale)
    pendingHybridGroup = null
    scrollDown()
  }

  /** Stop the checking animation; drop empty rows when no guide follows. */
  function settleHybridCheck(checkpoint: string): void {
    const group = pendingHybridGroup
    if (!group) return
    group.el.classList.remove('checking')
    if (group.el.classList.contains('plan')) {
      pendingHybridGroup = null
      return
    }
    const el = group.el
    pendingHybridGroup = null
    setTimeout(() => {
      if (el.classList.contains('guide') || el.classList.contains('plan')) return
      if (el.querySelector('.acc-hybrid-note, .hybrid-subtasks')) return
      el.remove()
    }, 0)
  }

  function showHybridGuide(checkpoint: string, verdict: string, text: string): void {
    hideSpinner()
    let group = pendingHybridGroup
    if (!group || group.checkpoint !== checkpoint) {
      const waiting = turnSession?.body.querySelectorAll<HTMLDetailsElement>(
        '.acc-hybrid:not(.guide)',
      )
      const last = waiting?.[waiting.length - 1]
      if (last) {
        group = {
          el: last,
          titleEl: last.querySelector('.acc-title') as HTMLElement,
          metaEl: last.querySelector('.acc-meta') as HTMLElement,
          body: last.querySelector('.acc-body') as HTMLElement,
          checkpoint,
        }
      }
    }
    if (!group) group = createHybridGroup(checkpoint)
    group.el.classList.remove('checking')
    group.el.classList.add('guide')
    group.titleEl.textContent = hybridCheckpointLabel(checkpoint, 'guide')
    group.metaEl.textContent = verdict === 'looks_good' ? '✓' : '!'
    group.body.innerHTML = ''
    const note = document.createElement('div')
    note.className = 'acc-hybrid-note'
    // Always show what came back — this text is exactly what gets fed to the
    // local model. An approval with no note still deserves a readable body.
    note.textContent = text.trim()
      ? text
      : verdict === 'looks_good'
        ? 'Looks good — no changes requested.'
        : 'The reviewer flagged a concern but returned no details.'
    group.body.appendChild(note)
    pendingHybridGroup = null
    scrollDown()
  }

  function clearHybridGroups(): void {
    pendingHybridGroup = null
    for (const el of Array.from(document.querySelectorAll('.acc-hybrid'))) {
      el.remove()
    }
  }

  function renderCompactionNote(saved: number, keptTurns?: number): void {
    const session = ensureTurnSession()
    const row = document.createElement('div')
    row.className = 'acc-row compaction-note'
    const kept = typeof keptTurns === 'number' ? ` · kept last ${keptTurns} turns` : ''
    row.textContent = `Compacted conversation history · freed ~${fmtTokens(saved)}${kept}`
    session.body.appendChild(row)
    scrollDown()
  }

  function renderPermissionCard(
    requestId: string,
    request: {
      kind: 'shell' | 'write' | 'scope'
      title: string
      preview: string
      path?: string
      command?: string
      cwd?: string
      scope?: 'outside-workspace' | 'url-pattern'
      toolName?: string
      action?: 'edit' | 'write'
      diff?: { before?: string; after?: string }
    },
  ): void {
    hideSpinner()
    const card = document.createElement('div')
    card.className = 'permission-card'
    card.dataset.requestId = requestId
    const head = document.createElement('div')
    head.className = 'permission-head'
    head.textContent = request.title
    const hint = document.createElement('div')
    hint.className = 'permission-hint'
    hint.textContent =
      request.kind === 'shell'
        ? 'Shell commands can modify your system. Review before allowing.'
        : request.kind === 'scope'
          ? 'This action expands tool scope beyond the workspace.'
          : 'This path may contain secrets or credentials.'
    card.append(head, hint)

    if (request.kind === 'shell' && request.command) {
      const shellBox = document.createElement('div')
      shellBox.className = 'permission-shell'
      const command = document.createElement('pre')
      command.className = 'permission-shell-command'
      command.textContent = request.command
      shellBox.appendChild(command)
      if (request.cwd) {
        const cwd = document.createElement('div')
        cwd.className = 'permission-shell-cwd'
        cwd.textContent = 'cwd: ' + request.cwd
        shellBox.appendChild(cwd)
      }
      card.appendChild(shellBox)
    }

    if (request.diff?.before !== undefined || request.diff?.after !== undefined) {
      const diffWrap = document.createElement('div')
      diffWrap.className = 'permission-diff'
      if (request.diff.before !== undefined) {
        const beforeBlock = document.createElement('pre')
        beforeBlock.className = 'permission-diff-before'
        beforeBlock.textContent = request.diff.before
        diffWrap.appendChild(beforeBlock)
      }
      if (request.diff.after !== undefined) {
        const afterBlock = document.createElement('pre')
        afterBlock.className = 'permission-diff-after'
        afterBlock.textContent = request.diff.after
        diffWrap.appendChild(afterBlock)
      }
      card.appendChild(diffWrap)
    } else if (!(request.kind === 'shell' && request.command)) {
      const preview = document.createElement('pre')
      preview.className = 'permission-preview'
      preview.textContent = request.preview
      card.appendChild(preview)
    }

    const actions = document.createElement('div')
    actions.className = 'permission-actions'
    const buttons: HTMLButtonElement[] = []
    const once = document.createElement('button')
    once.className = 'permission-btn'
    once.textContent = 'Allow once'
    once.disabled = true
    buttons.push(once)
    const sessionBtn = document.createElement('button')
    sessionBtn.className = 'permission-btn'
    sessionBtn.textContent = 'Allow for session'
    sessionBtn.disabled = true
    buttons.push(sessionBtn)
    const alwaysBtn = document.createElement('button')
    alwaysBtn.className = 'permission-btn'
    alwaysBtn.textContent = 'Always allow'
    alwaysBtn.disabled = true
    buttons.push(alwaysBtn)
    const deny = document.createElement('button')
    deny.className = 'permission-btn ghost'
    deny.textContent = 'Deny'
    deny.disabled = true
    buttons.push(deny)

    const resolve = (choice: 'once' | 'session' | 'always' | 'deny'): void => {
      card.classList.add('resolved')
      for (const btn of buttons) btn.disabled = true
      vscode.postMessage({ type: 'permission-answer', requestId, choice })
    }
    once.addEventListener('click', () => resolve('once'))
    sessionBtn.addEventListener('click', () => resolve('session'))
    alwaysBtn.addEventListener('click', () => resolve('always'))
    deny.addEventListener('click', () => resolve('deny'))
    actions.append(once, sessionBtn, alwaysBtn, deny)
    card.appendChild(actions)
    messagesEl.appendChild(card)
    scrollDown()
    setTimeout(() => {
      for (const btn of buttons) btn.disabled = false
    }, 400)
  }

  function showQuestionAnswers(
    card: HTMLElement,
    answers: { question: string; answer: string; isOther?: boolean }[],
  ): void {
    card.querySelectorAll(
      '.question-options, .question-other, .question-actions, .question-error, .question-answers, .question-block',
    ).forEach((el) => el.remove())

    if (answers.length === 1) {
      const only = answers[0]!
      const title = document.createElement('div')
      title.className = 'question-title'
      title.textContent = only.question
      const ans = document.createElement('div')
      ans.className = 'question-answer-a single'
      ans.textContent = only.answer
      card.append(title, ans)
    } else {
      const summary = document.createElement('div')
      summary.className = 'question-answers'
      for (const answer of answers) {
        const row = document.createElement('div')
        row.className = 'question-answer-row'
        const q = document.createElement('div')
        q.className = 'question-answer-q'
        q.textContent = answer.question
        const a = document.createElement('div')
        a.className = 'question-answer-a'
        a.textContent = answer.answer
        row.append(q, a)
        summary.appendChild(row)
      }
      card.appendChild(summary)
    }
    card.classList.add('resolved')
  }

  function renderQuestionCard(
    requestId: string,
    questions: { question: string; options: string[]; multiSelect?: boolean }[],
    resolvedAnswers?: { question: string; answer: string; isOther?: boolean }[],
  ): void {
    if (resolvedAnswers?.length) {
      const card = document.createElement('div')
      card.className = 'question-card'
      card.dataset.requestId = requestId
      showQuestionAnswers(card, resolvedAnswers)
      messagesEl.appendChild(card)
      scrollDown()
      return
    }
    hideSpinner()
    const card = document.createElement('div')
    card.className = 'question-card'
    card.dataset.requestId = requestId
    const selections = new Map<number, Set<string>>()
    const otherTexts = new Map<number, string>()

    for (const [qIndex, q] of questions.entries()) {
      const block = document.createElement('div')
      block.className = 'question-block'
      const title = document.createElement('div')
      title.className = 'question-title'
      title.textContent = q.question
      block.appendChild(title)

      const opts = document.createElement('div')
      opts.className = 'question-options'
      selections.set(qIndex, new Set())

      for (const option of q.options) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'question-option'
        btn.textContent = option
        btn.addEventListener('click', () => {
          const set = selections.get(qIndex)!
          if (q.multiSelect) {
            if (set.has(option)) set.delete(option)
            else set.add(option)
            btn.classList.toggle('selected', set.has(option))
          } else {
            set.clear()
            set.add(option)
            for (const sibling of opts.querySelectorAll('.question-option')) {
              sibling.classList.remove('selected')
            }
            btn.classList.add('selected')
          }
        })
        opts.appendChild(btn)
      }

      const otherRow = document.createElement('div')
      otherRow.className = 'question-other'
      const otherInput = document.createElement('input')
      otherInput.type = 'text'
      otherInput.placeholder = 'Other…'
      otherInput.addEventListener('input', () => {
        otherTexts.set(qIndex, otherInput.value.trim())
      })
      otherRow.appendChild(otherInput)
      block.appendChild(opts)
      block.appendChild(otherRow)
      card.appendChild(block)
    }

    const actions = document.createElement('div')
    actions.className = 'question-actions'
    const submit = document.createElement('button')
    submit.className = 'question-submit'
    submit.textContent = 'Submit'
    submit.addEventListener('click', () => {
      const answers: { question: string; answer: string; isOther?: boolean }[] = []
      for (const [i, q] of questions.entries()) {
        const other = otherTexts.get(i) ?? ''
        if (other) {
          answers.push({ question: q.question, answer: other, isOther: true })
          continue
        }
        const selected = [...(selections.get(i) ?? [])]
        if (selected.length === 0) {
          let err = card.querySelector('.question-error') as HTMLElement | null
          if (!err) {
            err = document.createElement('div')
            err.className = 'question-error'
            actions.before(err)
          }
          err.textContent = 'Answer every question before submitting.'
          return
        }
        answers.push({ question: q.question, answer: selected.join(', ') })
      }
      showQuestionAnswers(card, answers)
      vscode.postMessage({ type: 'question-answer', requestId, answers })
    })
    const cancel = document.createElement('button')
    cancel.className = 'question-cancel ghost'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', () => {
      card.remove()
      vscode.postMessage({ type: 'question-cancel', requestId })
    })
    actions.appendChild(submit)
    actions.appendChild(cancel)
    card.appendChild(actions)
    messagesEl.appendChild(card)
    scrollDown()
  }

  function renderPlanHandoffCard(
    id: string,
    path: string,
    content: string,
    resolvedAction?: 'execute' | 'stay' | 'open',
  ): void {
    hideSpinner()
    const card = document.createElement('div')
    card.className = 'plan-handoff-card' + (resolvedAction ? ' resolved' : '')
    card.dataset.handoffId = id
    const head = document.createElement('div')
    head.className = 'plan-handoff-head'
    head.textContent = 'Plan ready for review'
    const meta = document.createElement('div')
    meta.className = 'plan-handoff-path'
    meta.textContent = path
    const preview = document.createElement('div')
    preview.className = 'plan-handoff-preview reply-markdown'
    preview.appendChild(formatReplyMarkdown(content.length > 8000 ? content.slice(0, 8000) + '…' : content))
    if (resolvedAction) {
      const note = document.createElement('div')
      note.className = 'plan-handoff-resolved-note'
      note.textContent =
        resolvedAction === 'execute'
          ? 'Approved — implementing in Code mode.'
          : resolvedAction === 'stay'
            ? 'Staying in Plan mode.'
            : 'Opened in editor.'
      card.append(head, meta, preview, note)
      messagesEl.appendChild(card)
      scrollDown()
      return
    }
    const actions = document.createElement('div')
    actions.className = 'plan-handoff-actions'
    const execute = document.createElement('button')
    execute.className = 'plan-handoff-btn primary'
    execute.textContent = 'Execute'
    execute.addEventListener('click', () => {
      card.classList.add('resolved')
      vscode.postMessage({ type: 'plan-handoff-action', id, action: 'execute' })
    })
    const stay = document.createElement('button')
    stay.className = 'plan-handoff-btn ghost'
    stay.textContent = 'Stay in Plan'
    stay.addEventListener('click', () => {
      card.classList.add('resolved')
      vscode.postMessage({ type: 'plan-handoff-action', id, action: 'stay' })
    })
    const open = document.createElement('button')
    open.className = 'plan-handoff-btn ghost'
    open.textContent = 'Open plan'
    open.addEventListener('click', () => {
      vscode.postMessage({ type: 'plan-handoff-action', id, action: 'open' })
    })
    actions.append(execute, stay, open)
    card.append(head, meta, preview, actions)
    messagesEl.appendChild(card)
    scrollDown()
  }

  function hideWelcome(): void {
    document.getElementById('welcome')?.classList.add('hidden')
  }

  function showWelcome(): void {
    document.getElementById('welcome')?.classList.remove('hidden')
  }

  function scrollDown(): void {
    messagesEl.scrollTop = messagesEl.scrollHeight
  }

  function addBubble(className: string, text: string, images?: ComposerImageAttachment[]): HTMLElement {
    const el = document.createElement('div')
    el.className = 'bubble ' + className
    el.textContent = text
    if (images && images.length > 0) {
      const row = document.createElement('div')
      row.className = 'user-image-row'
      for (const image of images) {
        const img = document.createElement('img')
        img.src = image.previewUrl
        img.alt = image.name
        row.appendChild(img)
      }
      el.appendChild(row)
    }
    messagesEl.appendChild(el)
    scrollDown()
    return el
  }

  /** Final assistant prose — inline markdown (bold, code, links). */
  function isInlineMarkdownSpecial(text: string, index: number): boolean {
    const ch = text[index]
    if (ch === '`' || ch === '*') return true
    if (ch === '_' && (text[index + 1] === '_' || isItalicUnderscoreStart(text, index))) return true
    return /^https?:\/\//.test(text.slice(index))
  }

  function isItalicUnderscoreStart(text: string, index: number): boolean {
    if (text[index] !== '_' || text[index + 1] === '_') return false
    const before = index > 0 ? text[index - 1]! : ' '
    if (/[\w/]/.test(before)) return false
    const close = text.indexOf('_', index + 1)
    if (close === -1 || text[close + 1] === '_') return false
    const after = close + 1 < text.length ? text[close + 1]! : ' '
    return !/[\w/]/.test(after) && close > index + 1
  }

  function formatInlineMarkdownInto(parent: Node, text: string): void {
    let i = 0
    while (i < text.length) {
      if (text[i] === '`') {
        let j = i + 1
        while (j < text.length) {
          if (text[j] === '\\' && j + 1 < text.length) {
            j += 2
            continue
          }
          if (text[j] === '`') break
          j++
        }
        if (j < text.length && text[j] === '`') {
          const code = document.createElement('code')
          code.className = 'reply-inline-code'
          code.textContent = text.slice(i + 1, j).replace(/\\`/g, '`')
          parent.appendChild(code)
          i = j + 1
          continue
        }
      }

      if (text[i] === '*' && text[i + 1] === '*') {
        const close = text.indexOf('**', i + 2)
        if (close !== -1 && close > i + 2) {
          const strong = document.createElement('strong')
          formatInlineMarkdownInto(strong, text.slice(i + 2, close))
          parent.appendChild(strong)
          i = close + 2
          continue
        }
      }

      if (text[i] === '_' && text[i + 1] === '_') {
        const close = text.indexOf('__', i + 2)
        if (close !== -1 && close > i + 2) {
          const strong = document.createElement('strong')
          formatInlineMarkdownInto(strong, text.slice(i + 2, close))
          parent.appendChild(strong)
          i = close + 2
          continue
        }
      }

      if (text[i] === '*' && text[i + 1] !== '*') {
        const close = text.indexOf('*', i + 1)
        if (close !== -1 && text[close + 1] !== '*' && close > i + 1) {
          const em = document.createElement('em')
          formatInlineMarkdownInto(em, text.slice(i + 1, close))
          parent.appendChild(em)
          i = close + 1
          continue
        }
      }

      if (isItalicUnderscoreStart(text, i)) {
        const close = text.indexOf('_', i + 1)
        if (close !== -1) {
          const em = document.createElement('em')
          formatInlineMarkdownInto(em, text.slice(i + 1, close))
          parent.appendChild(em)
          i = close + 1
          continue
        }
      }

      const urlMatch = text.slice(i).match(/^https?:\/\/[^\s<>"')\]]+/)
      if (urlMatch) {
        const a = document.createElement('a')
        a.href = urlMatch[0]
        a.textContent = urlMatch[0]
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        parent.appendChild(a)
        i += urlMatch[0].length
        continue
      }

      let next = i + 1
      while (next < text.length && !isInlineMarkdownSpecial(text, next)) next++
      parent.appendChild(document.createTextNode(text.slice(i, next)))
      i = next
    }
  }

  function formatReplyMarkdown(text: string): DocumentFragment {
    const fragment = document.createDocumentFragment()
    const lines = normalizeReplyMarkdownStructure(text).split('\n')
    let i = 0

    function isTableRow(line: string): boolean {
      const t = line.trim()
      return t.startsWith('|') && t.endsWith('|') && t.includes('|', 1)
    }

    function isTableSeparator(line: string): boolean {
      return /^\|[\s:|-]+\|$/.test(line.trim())
    }

    function parseTableCells(line: string): string[] {
      return line
        .trim()
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim())
    }

    const appendNestedBullets = (li: HTMLLIElement, start: number): number => {
      let j = start
      if (j >= lines.length || !/^\s+[-*]\s/.test(lines[j]!)) return j
      const ul = document.createElement('ul')
      ul.className = 'reply-ul'
      while (j < lines.length && /^\s+[-*]\s/.test(lines[j]!)) {
        const match = lines[j]!.match(/^\s+[-*]\s+(.*)$/)
        const subLi = document.createElement('li')
        formatInlineMarkdownInto(subLi, match?.[1] ?? '')
        ul.appendChild(subLi)
        j++
      }
      li.appendChild(ul)
      return j
    }

    while (i < lines.length) {
      const line = lines[i]!
      if (!line.trim()) {
        i++
        continue
      }

      if (isTableRow(line)) {
        const table = document.createElement('table')
        table.className = 'reply-table'
        const tbody = document.createElement('tbody')
        let headerRow: HTMLTableRowElement | null = null
        while (i < lines.length && isTableRow(lines[i]!)) {
          if (isTableSeparator(lines[i]!)) {
            i++
            continue
          }
          const cells = parseTableCells(lines[i]!)
          const tr = document.createElement('tr')
          for (const cell of cells) {
            const el = document.createElement(headerRow ? 'td' : 'th')
            formatInlineMarkdownInto(el, cell)
            tr.appendChild(el)
          }
          if (!headerRow) {
            headerRow = tr
            const thead = document.createElement('thead')
            thead.appendChild(tr)
            table.appendChild(thead)
          } else {
            tbody.appendChild(tr)
          }
          i++
        }
        if (tbody.childNodes.length > 0) table.appendChild(tbody)
        fragment.appendChild(table)
        continue
      }

      const headerMatch = line.match(/^(#{1,6})\s+(.+)$/)
      if (headerMatch) {
        const level = Math.min(headerMatch[1]!.length, 6)
        const h = document.createElement('h' + level)
        h.className = 'reply-h' + level
        formatInlineMarkdownInto(h, headerMatch[2]!)
        fragment.appendChild(h)
        i++
        continue
      }

      if (/^\d+\.\s/.test(line)) {
        const ol = document.createElement('ol')
        ol.className = 'reply-ol'
        while (i < lines.length && /^\d+\.\s/.test(lines[i]!)) {
          const itemMatch = lines[i]!.match(/^\d+\.\s+(.*)$/)
          const li = document.createElement('li')
          formatInlineMarkdownInto(li, itemMatch?.[1] ?? '')
          i++
          i = appendNestedBullets(li, i)
          ol.appendChild(li)
        }
        fragment.appendChild(ol)
        continue
      }

      if (/^[-*]\s/.test(line)) {
        const ul = document.createElement('ul')
        ul.className = 'reply-ul'
        while (i < lines.length && /^[-*]\s/.test(lines[i]!)) {
          const itemMatch = lines[i]!.match(/^[-*]\s+(.*)$/)
          const li = document.createElement('li')
          formatInlineMarkdownInto(li, itemMatch?.[1] ?? '')
          i++
          ul.appendChild(li)
        }
        fragment.appendChild(ul)
        continue
      }

      const paraLines: string[] = []
      while (i < lines.length) {
        const l = lines[i]!
        if (!l.trim()) break
        if (/^#{1,6}\s/.test(l)) break
        if (isTableRow(l)) break
        if (/^\d+\.\s/.test(l)) break
        if (/^[-*]\s/.test(l)) break
        paraLines.push(l)
        i++
      }
      if (paraLines.length > 0) {
        const p = document.createElement('p')
        p.className = 'reply-p'
        formatInlineMarkdownInto(p, paraLines.join(' '))
        fragment.appendChild(p)
      }
    }

    return fragment
  }

  function cleanReplyText(text: string): string {
    return sanitizeReplyText(text)
  }

  function addReply(text: string, failed = false): HTMLElement {
    const display = cleanReplyText(text).trim()
    const emptyReplyError = 'Error: the extension host returned an empty or invalid reply.'
    const replyFailed = failed || !display
    const el = document.createElement('div')
    el.className = 'reply' + (replyFailed ? ' failed' : '')
    el.appendChild(formatReplyMarkdown(display || emptyReplyError))
    messagesEl.appendChild(el)
    scrollDown()
    return el
  }

  function showSpinner(): void {
    hideSpinner()
    showPlanning()
  }

  function hideSpinner(): void {
    hidePlanning()
    spinnerEl?.remove()
    spinnerEl = null
  }

  /* ── Follow-up queue + Multitask mode (Cursor-style) ─────────────────── */

  let isBusy = false
  let workElsewhere = 0
  let backgroundWorkEl: HTMLElement | null = null
  let multitaskMode = false
  let queueCollapsed = true
  let queueStartingId: string | null = null
  interface QueuedItem {
    id: string
    text: string
    mode: keyof typeof MODE_ICONS
  }
  type MultitaskStatus = 'waiting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  interface MultitaskTask {
    id: string
    parentId: string
    name: string
    text: string
    mode: keyof typeof MODE_ICONS
    status: MultitaskStatus
    currentAction?: string
    kind: 'child' | 'coordinator' | 'integrator'
    createdAt: number
    startedAt?: number
    finishedAt?: number
    result?: string
    chatId: string
    worktreeBranch?: string
  }
  const queue: QueuedItem[] = []
  let multitaskTasks: MultitaskTask[] = []
  let queueCard: HTMLElement | null = null
  let activeModeChipEl: HTMLElement | null = null
  let multitaskChipEl: HTMLElement | null = null
  let multitaskActivityEl: HTMLElement | null = null
  let finishedSubagentsEl: HTMLDetailsElement | null = null
  const multitaskRunRows = new Map<string, HTMLElement>()
  const composerEl = document.getElementById('composer') as HTMLElement
  const imageAttachmentChipsEl = document.getElementById('image-attachment-chips') as HTMLElement
  const imageDropOverlayEl = document.getElementById('image-drop-overlay') as HTMLElement
  const imageFileInputEl = document.getElementById('image-file-input') as HTMLInputElement
  let plusMenuOpen = false
  let imageSupport: 'supported' | 'non-vision-model' | 'inference-not-supported' = 'non-vision-model'
  let imageDragDepth = 0

  interface ComposerImageAttachment {
    id: string
    name: string
    mimeType: string
    previewUrl: string
    dataBase64: string
  }

  const MAX_IMAGE_ATTACHMENTS = 4
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024
  const ACCEPTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
  const ACCEPTED_IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
  let imageAttachments: ComposerImageAttachment[] = []

  function isAcceptedImageFile(file: File): boolean {
    if (ACCEPTED_IMAGE_TYPES.has(file.type)) return true
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    return ACCEPTED_IMAGE_EXT.has(ext)
  }

  function readFileAsAttachment(file: File): Promise<ComposerImageAttachment | null> {
    if (!isAcceptedImageFile(file)) return Promise.resolve(null)
    if (file.size > MAX_IMAGE_BYTES) return Promise.resolve(null)
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : ''
        const match = /^data:([^;]+);base64,(.+)$/.exec(result)
        if (!match) {
          resolve(null)
          return
        }
        resolve({
          id: crypto.randomUUID(),
          name: file.name,
          mimeType: match[1] ?? file.type,
          previewUrl: result,
          dataBase64: match[2] ?? '',
        })
      }
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(file)
    })
  }

  async function addImageFiles(files: FileList | File[]): Promise<void> {
    const remaining = MAX_IMAGE_ATTACHMENTS - imageAttachments.length
    if (remaining <= 0) return
    const parsed = (
      await Promise.all(Array.from(files).slice(0, remaining).map((file) => readFileAsAttachment(file)))
    ).filter((item): item is ComposerImageAttachment => item !== null)
    if (parsed.length === 0) return
    imageAttachments = [...imageAttachments, ...parsed]
    renderImageAttachmentChips()
  }

  function removeImageAttachment(id: string): void {
    imageAttachments = imageAttachments.filter((item) => item.id !== id)
    renderImageAttachmentChips()
  }

  function clearImageAttachments(): void {
    imageAttachments = []
    renderImageAttachmentChips()
  }

  function renderImageAttachmentChips(): void {
    imageAttachmentChipsEl.innerHTML = ''
    if (imageAttachments.length === 0) {
      imageAttachmentChipsEl.hidden = true
      return
    }
    imageAttachmentChipsEl.hidden = false
    for (const attachment of imageAttachments) {
      const chip = document.createElement('span')
      chip.className = 'image-attachment-chip'
      chip.title = attachment.name
      const img = document.createElement('img')
      img.src = attachment.previewUrl
      img.alt = attachment.name
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.setAttribute('aria-label', `Remove ${attachment.name}`)
      remove.textContent = '×'
      remove.addEventListener('click', () => removeImageAttachment(attachment.id))
      chip.appendChild(img)
      chip.appendChild(remove)
      imageAttachmentChipsEl.appendChild(chip)
    }
  }

  function setImageDragOver(active: boolean): void {
    imageDropOverlayEl.hidden = !active
    imageDropOverlayEl.setAttribute('aria-hidden', active ? 'false' : 'true')
  }

  function hasDraggedImage(dataTransfer: DataTransfer | null): boolean {
    if (!dataTransfer) return false
    if (
      Array.from(dataTransfer.items).some(
        (item) => item.kind === 'file' && item.type.startsWith('image/'),
      )
    ) {
      return true
    }
    return Array.from(dataTransfer.files).some((file) => isAcceptedImageFile(file))
  }

  const MULTITASK_ICON =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="6.25" cy="9" r="3.75"/><circle cx="9.75" cy="7" r="3.75"/></svg>'

  function renderBackgroundWork(): void {
    backgroundWorkEl?.remove()
    backgroundWorkEl = null
    if (workElsewhere <= 0) return
    backgroundWorkEl = document.createElement('div')
    backgroundWorkEl.className = 'notice-row background-work'
    backgroundWorkEl.textContent =
      workElsewhere === 1
        ? 'Work continues in another chat.'
        : `Work continues in ${workElsewhere} other chats.`
    messagesEl.insertBefore(backgroundWorkEl, messagesEl.firstChild)
  }

  function closePlusMenu(): void {
    plusMenuOpen = false
    composerPlusMenu.hidden = true
    composerPlusBtn.setAttribute('aria-expanded', 'false')
  }

  function openPlusMenu(): void {
    plusMenuOpen = true
    composerPlusMenu.hidden = false
    composerPlusBtn.setAttribute('aria-expanded', 'true')
    renderPlusMenu()
  }

  function renderPlusMenu(): void {
    for (const item of composerPlusMenu.querySelectorAll<HTMLButtonElement>('.plus-menu-item')) {
      const pick = item.dataset.pick
      const check = item.querySelector('.plus-menu-check') as HTMLElement | null
      if (!check) continue
      const active = pick === 'multitask' ? multitaskMode : pick === currentMode
      check.hidden = !active
    }
  }

  function setMode(mode: keyof typeof MODE_ICONS): void {
    if (mode !== 'code' && multitaskMode) disableMultitask()
    currentMode = mode
    renderActiveModeChip()
    renderPlusMenu()
    updateComposerPlaceholder()
  }

  function renderActiveModeChip(): void {
    activeModeChipEl?.remove()
    activeModeChipEl = null
    if (currentMode === 'code') return

    const label = currentMode === 'plan' ? 'Plan' : 'Ask'
    const chip = document.createElement('span')
    chip.className = `composer-mode-chip ${currentMode}`
    chip.title =
      currentMode === 'plan'
        ? 'Read-only exploration that returns a plan'
        : 'Ask a read-only question about the codebase'
    const icon = createElement(MODE_ICONS[currentMode], {
      width: 11,
      height: 11,
      'stroke-width': 2,
    })
    const text = document.createElement('span')
    text.className = 'composer-mode-chip-label'
    text.textContent = label
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.className = 'composer-mode-chip-dismiss'
    dismiss.setAttribute('aria-label', `Turn off ${label}`)
    dismiss.textContent = '×'
    dismiss.addEventListener('click', () => setMode('code'))
    chip.appendChild(icon)
    chip.appendChild(text)
    chip.appendChild(dismiss)
    composerChips.insertBefore(chip, multitaskChipEl)
    activeModeChipEl = chip
  }

  function updateComposerChrome(): void {
    // Prompt submission remains available while this or another chat is
    // working; the extension owns the cross-chat FIFO.
    stopBtn.hidden = !isBusy || multitaskMode
    sendBtn.hidden = false
    undoBtn.disabled = isBusy || !pendingUndoSha
  }

  function truncatePreview(text: string, max = 72): string {
    const oneLine = text.replace(/\s+/g, ' ').trim()
    return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…'
  }

  function updateComposerPlaceholder(): void {
    if (multitaskMode) {
      inputEl.placeholder = 'Coordinate parallel work…'
      return
    }
    inputEl.placeholder =
      currentMode === 'plan'
        ? 'Describe what you want — the agent explores read-only and returns a plan…'
        : currentMode === 'ask'
          ? 'Ask a question about this codebase (read-only)…'
          : 'Describe a task or ask a question…'
  }

  function enableMultitask(): void {
    if (multitaskMode) return
    if (currentMode !== 'code') setMode('code')
    multitaskMode = true
    queueCollapsed = true
    renderMultitaskChip()
    renderMultitaskActivity()
    renderQueue()
    renderPlusMenu()
    updateComposerPlaceholder()
    updateComposerChrome()
    if (!isBusy && queue.length > 0) drainQueue()
  }

  function disableMultitask(): void {
    multitaskMode = false
    queueStartingId = null
    renderMultitaskChip()
    renderMultitaskActivity()
    renderQueue()
    renderPlusMenu()
    updateComposerPlaceholder()
    updateComposerChrome()
  }

  function renderMultitaskChip(): void {
    if (!multitaskMode) {
      multitaskChipEl?.remove()
      multitaskChipEl = null
      composerEl.classList.remove('multitask-active')
      return
    }
    composerEl.classList.add('multitask-active')
    if (!multitaskChipEl) {
      multitaskChipEl = document.createElement('span')
      multitaskChipEl.className = 'composer-mode-chip multitask'
      multitaskChipEl.title =
        'Run parallel Multitask agents in isolated git worktrees with sibling messaging'
      multitaskChipEl.innerHTML =
        MULTITASK_ICON +
        '<span class="composer-mode-chip-label">Multitask</span>' +
        '<button type="button" class="composer-mode-chip-dismiss" aria-label="Turn off Multitask">×</button>'
      multitaskChipEl.querySelector('.composer-mode-chip-dismiss')?.addEventListener('click', () => {
        disableMultitask()
      })
      composerChips.appendChild(multitaskChipEl)
    }
  }

  function multitaskActivityStatus(): string {
    const running = multitaskTasks.filter((task) => task.status === 'running').length
    const waiting = multitaskTasks.filter((task) => task.status === 'waiting').length
    const done = multitaskTasks.filter((task) =>
      task.status === 'completed' ||
      task.status === 'failed' ||
      task.status === 'cancelled' ||
      task.status === 'interrupted',
    ).length
    const parts: string[] = []
    if (running) parts.push(`${running} working`)
    if (waiting) parts.push(`${waiting} waiting`)
    if (done && (running || waiting)) parts.push(`${done} done`)
    if (parts.length) return parts.join(' · ')
    return 'Planning next moves…'
  }

  function renderMultitaskActivity(): void {
    const active = multitaskTasks.some((task) => task.status === 'waiting' || task.status === 'running')
    const show = multitaskMode && active
    if (!show) {
      multitaskActivityEl?.remove()
      multitaskActivityEl = null
      return
    }
    if (!multitaskActivityEl) {
      multitaskActivityEl = document.createElement('div')
      multitaskActivityEl.id = 'multitask-activity'
      multitaskActivityEl.className = 'multitask-activity'
      multitaskActivityEl.innerHTML =
        '<span class="multitask-badge">Multitask</span>' +
        '<span class="multitask-activity-status"></span>'
      messagesEl.insertBefore(multitaskActivityEl, messagesEl.firstChild)
    }
    const status = multitaskActivityEl.querySelector('.multitask-activity-status') as HTMLElement
    status.textContent = multitaskActivityStatus()
    scrollDown()
  }

  function queueCardStatus(): string {
    if (multitaskTasks.some((task) => task.status === 'running')) return 'Working…'
    if (multitaskTasks.some((task) => task.status === 'waiting')) return 'Starting up'
    return 'Multitask'
  }

  function multitaskStatusLabel(status: MultitaskStatus): string {
    if (status === 'running') return 'Working'
    if (status === 'completed') return 'Done'
    if (status === 'failed') return 'Failed'
    if (status === 'cancelled') return 'Cancelled'
    if (status === 'interrupted') return 'Interrupted'
    return 'Starting up'
  }

  function multitaskRunStatus(task: MultitaskTask): string {
    if (task.status !== 'waiting') return multitaskStatusLabel(task.status)
    const runningCount = multitaskTasks.filter((candidate) => candidate.status === 'running').length
    if (runningCount === 0) return 'Starting up'
    return 'Queued for a free model slot'
  }

  function isFinishedMultitaskStatus(status: MultitaskStatus): boolean {
    return status === 'completed' ||
      status === 'failed' ||
      status === 'cancelled' ||
      status === 'interrupted'
  }

  function multitaskElapsed(task: MultitaskTask): string {
    if (task.startedAt === undefined || task.finishedAt === undefined) return ''
    return formatElapsed(Math.max(0, task.finishedAt - task.startedAt))
  }

  function renderFinishedSubagents(): void {
    const finished = multitaskTasks.filter((task) => isFinishedMultitaskStatus(task.status))
    if (finished.length === 0) {
      finishedSubagentsEl?.remove()
      finishedSubagentsEl = null
      return
    }

    if (!finishedSubagentsEl) {
      finishedSubagentsEl = document.createElement('details')
      finishedSubagentsEl.className = 'finished-subagents'
      finishedSubagentsEl.innerHTML =
        '<summary class="finished-subagents-summary">' +
        '<span class="acc-chevron"></span>' +
        '<span class="finished-subagents-title"></span>' +
        '</summary>' +
        '<div class="finished-subagents-body"></div>'
      messagesEl.appendChild(finishedSubagentsEl)
    }

    const title = finishedSubagentsEl.querySelector('.finished-subagents-title') as HTMLElement
    title.textContent = `Finished ${finished.length} subagent${finished.length === 1 ? '' : 's'}`

    const body = finishedSubagentsEl.querySelector('.finished-subagents-body') as HTMLElement
    const expandedIds = new Set(
      Array.from(body.querySelectorAll<HTMLDetailsElement>('.finished-subagent-row[open]'))
        .map((row) => row.dataset.id)
        .filter((id): id is string => !!id),
    )
    body.innerHTML = ''

    for (const task of finished) {
      const row = document.createElement('details')
      row.className = `finished-subagent-row ${task.status}`
      row.dataset.id = task.id
      row.open = expandedIds.has(task.id)

      const summary = document.createElement('summary')
      summary.innerHTML =
        '<span class="finished-subagent-indicator" aria-hidden="true"></span>' +
        '<span class="finished-subagent-copy">' +
        '<span class="finished-subagent-title"></span>' +
        '<span class="finished-subagent-result-preview"></span>' +
        '</span>' +
        '<span class="finished-subagent-meta"></span>' +
        '<span class="acc-chevron"></span>'
      ;(summary.querySelector('.finished-subagent-indicator') as HTMLElement).textContent =
        task.status === 'completed' ? '✓' : task.status === 'failed' ? '×' : '·'
      ;(summary.querySelector('.finished-subagent-title') as HTMLElement).textContent =
        truncatePreview(task.text, 72) || 'Subagent'
      const result = task.result?.trim() ?? ''
      const preview = summary.querySelector('.finished-subagent-result-preview') as HTMLElement
      preview.textContent = truncatePreview(result, 110)
      preview.hidden = !result
      const elapsed = multitaskElapsed(task)
      ;(summary.querySelector('.finished-subagent-meta') as HTMLElement).textContent =
        multitaskStatusLabel(task.status) + (elapsed ? ` · ${elapsed}` : '')
      row.appendChild(summary)

      const detail = document.createElement('div')
      detail.className = 'finished-subagent-detail'
      const promptLabel = document.createElement('div')
      promptLabel.className = 'finished-subagent-detail-label'
      promptLabel.textContent = 'Prompt'
      const prompt = document.createElement('div')
      prompt.className = 'finished-subagent-detail-text'
      prompt.textContent = task.text
      detail.appendChild(promptLabel)
      detail.appendChild(prompt)
      if (result) {
        const resultLabel = document.createElement('div')
        resultLabel.className = 'finished-subagent-detail-label'
        resultLabel.textContent = task.status === 'failed' ? 'Error' : 'Result'
        const resultText = document.createElement('div')
        resultText.className = 'finished-subagent-detail-text result'
        resultText.textContent = result
        detail.appendChild(resultLabel)
        detail.appendChild(resultText)
      }
      row.appendChild(detail)
      body.appendChild(row)
    }
  }

  function syncMultitaskRunRows(): void {
    const liveTasks = multitaskTasks.filter(
      (task) => task.status === 'waiting' || task.status === 'running',
    )
    const liveIds = new Set(liveTasks.map((task) => task.id))
    for (const [id, row] of multitaskRunRows) {
      if (liveIds.has(id)) continue
      row.remove()
      multitaskRunRows.delete(id)
    }

    for (const task of liveTasks) {
      let row = multitaskRunRows.get(task.id)
      if (!row) {
        row = document.createElement('details')
        row.className = 'multitask-run-row'
        row.innerHTML =
          '<summary><span class="multitask-run-indicator" aria-hidden="true">' +
          '<span class="multitask-run-dots">' +
          '<i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>' +
          '</span><span class="multitask-run-result"></span></span>' +
          '<span class="multitask-run-copy">' +
          '<span class="multitask-run-title"></span>' +
          '<span class="multitask-run-status"></span></span></summary>' +
          '<div class="multitask-run-prompt"></div>'
        const steer = document.createElement('button')
        steer.type = 'button'
        steer.className = 'multitask-steer'
        steer.title = 'Continue this task in the active subagent'
        steer.setAttribute('aria-label', 'Continue this waiting task in the active subagent')
        steer.appendChild(
          createElement(ArrowRight, {
            width: 14,
            height: 14,
            'stroke-width': 2,
            'aria-hidden': 'true',
          }),
        )
        steer.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          vscode.postMessage({ type: 'multitask-steer', id: task.id })
        })
        row.querySelector('summary')?.appendChild(steer)
        messagesEl.appendChild(row)
        multitaskRunRows.set(task.id, row)
      }
      row.className = 'multitask-run-row ' + task.status
      ;(row.querySelector('.multitask-run-title') as HTMLElement).textContent =
        task.name || 'New subagent'
      ;(row.querySelector('.multitask-run-status') as HTMLElement).textContent =
        task.currentAction ||
        (task.worktreeBranch && task.status === 'waiting'
          ? `${multitaskRunStatus(task)} · ${task.worktreeBranch}`
          : multitaskRunStatus(task))
      ;(row.querySelector('.multitask-run-prompt') as HTMLElement).textContent = task.text
      const steer = row.querySelector('.multitask-steer') as HTMLButtonElement
      steer.hidden =
        task.status !== 'waiting' ||
        !multitaskTasks.some((candidate) => candidate.status === 'running')
      ;(row.querySelector('.multitask-run-result') as HTMLElement).textContent =
        ''
    }
    renderFinishedSubagents()
    scrollDown()
  }

  function dispatch(text: string, mode: keyof typeof MODE_ICONS): void {
    isBusy = true // optimistic, so a second drain can't fire before state arrives
    hideWelcome()
    const images = [...imageAttachments]
    addBubble('user', text, images)
    clearImageAttachments()
    showSpinner()
    renderMultitaskActivity()
    vscode.postMessage({
      type: 'send',
      text,
      mode,
      images: images.map(({ mimeType, dataBase64 }) => ({ mimeType, dataBase64 })),
    })
  }

  function drainQueue(): void {
    if (isBusy || queue.length === 0) return
    const next = queue[0]
    if (!next) return

    const launch = (): void => {
      if (queue[0]?.id !== next.id) {
        queueStartingId = null
        renderQueue()
        renderMultitaskActivity()
        return
      }
      queue.shift()
      queueStartingId = null
      renderQueue()
      renderMultitaskActivity()
      dispatch(next.text, next.mode)
    }

    if (multitaskMode) {
      queueStartingId = next.id
      renderQueue()
      renderMultitaskActivity()
      setTimeout(launch, 450)
    } else {
      launch()
    }
  }

  function sendQueuedNow(): void {
    if (queue.length === 0) return
    vscode.postMessage({ type: 'stop' })
  }

  function closeQueueMenu(): void {
    queueCard?.querySelector('.queue-menu')?.remove()
  }

  function renderQueue(): void {
    const providerTasks = multitaskTasks
      .filter((task) => task.status === 'waiting' || task.status === 'running')
      .slice(-8)
      .reverse()
    const showCard = multitaskMode ? providerTasks.length > 0 : queue.length > 0
    if (!showCard) {
      queueCard?.remove()
      queueCard = null
      closeQueueMenu()
      renderMultitaskActivity()
      return
    }

    if (!queueCard) {
      queueCard = document.createElement('div')
      queueCard.id = 'queue-card'
      queueCard.className = 'multitask-card'
      composerEl.parentElement?.insertBefore(queueCard, composerEl)
    }

    queueCard.classList.toggle('collapsed', queueCollapsed)
    queueCard.classList.toggle('multitask-mode', multitaskMode)
    queueCard.classList.toggle('draining', isBusy || queueStartingId !== null)
    queueCard.innerHTML = ''

    const head = document.createElement('div')
    head.className = 'multitask-card-head'
    const activeCount = multitaskTasks.filter(
      (task) => task.status === 'waiting' || task.status === 'running',
    ).length

    const left = document.createElement('div')
    left.className = 'multitask-card-left'
    if (multitaskMode && queueCollapsed) {
      const dots = document.createElement('span')
      dots.className = 'multitask-pill-dots'
      dots.setAttribute('aria-hidden', 'true')
      dots.innerHTML = '<i></i><i></i><i></i><i></i><i></i><i></i>'
      left.appendChild(dots)
    }
    const count = document.createElement('span')
    count.className = 'multitask-count'
    if (multitaskMode) {
      count.textContent = queueCollapsed
        ? activeCount > 0
          ? `${activeCount} Working`
          : 'Recent agents'
        : activeCount > 0
          ? `${activeCount} Working`
          : 'Recent agents'
    } else {
      count.textContent = queue.length === 1 ? '1 Queued' : `${queue.length} Queued`
    }
    const hint = document.createElement('span')
    hint.className = 'multitask-send-hint'
    hint.textContent = '⏎ to send next'
    hint.title = 'Press Enter on an empty composer to send the next queued task now'
    left.appendChild(count)
    if (!multitaskMode) left.appendChild(hint)

    const right = document.createElement('div')
    right.className = 'multitask-card-right'
    if (multitaskMode && !queueCollapsed && activeCount > 0) {
      const stopAll = document.createElement('button')
      stopAll.type = 'button'
      stopAll.className = 'multitask-stop-all'
      stopAll.title = 'Stop all background agents'
      stopAll.setAttribute('aria-label', 'Stop all background agents')
      stopAll.textContent = 'Stop All'
      stopAll.addEventListener('click', (event) => {
        event.stopPropagation()
        vscode.postMessage({ type: 'multitask-cancel-all' })
      })
      right.appendChild(stopAll)
    }
    const collapse = document.createElement('button')
    collapse.type = 'button'
    collapse.className = 'multitask-collapse'
    collapse.setAttribute('aria-expanded', String(!queueCollapsed))
    collapse.title = queueCollapsed ? 'Show background agents' : 'Collapse background agents'
    collapse.setAttribute(
      'aria-label',
      queueCollapsed ? 'Show background agents' : 'Collapse background agents',
    )
    if (multitaskMode && !queueCollapsed) {
      collapse.classList.add('multitask-panel-close')
      collapse.textContent = '×'
    } else {
      collapse.innerHTML = '<span class="multitask-collapse-chevron"></span>'
    }
    collapse.addEventListener('click', (event) => {
      event.stopPropagation()
      queueCollapsed = !queueCollapsed
      renderQueue()
    })
    if (!multitaskMode || !queueCollapsed) right.appendChild(collapse)

    head.appendChild(left)
    head.appendChild(right)
    if (multitaskMode && queueCollapsed) {
      head.tabIndex = 0
      head.setAttribute('role', 'button')
      head.setAttribute('aria-expanded', 'false')
      head.setAttribute('aria-label', `Show background agents, ${count.textContent}`)
      const expand = (): void => {
        queueCollapsed = false
        renderQueue()
      }
      head.addEventListener('click', expand)
      head.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        expand()
      })
    }
    queueCard.appendChild(head)

    const body = document.createElement('div')
    body.className = 'multitask-card-body'

    const rows = multitaskMode ? providerTasks : queue
    rows.forEach((item) => {
      const row = document.createElement('div')
      row.className = 'multitask-item'
      const providerTask = 'status' in item ? item : null
      const status = providerTask ? providerTask.status : 'queued'
      row.classList.add(status)

      const iconWrap = document.createElement('span')
      iconWrap.className = 'multitask-item-icon'
      iconWrap.setAttribute('aria-hidden', 'true')
      iconWrap.innerHTML =
        '<span class="multitask-item-dots"><i></i><i></i><i></i><i></i><i></i><i></i></span>'

      const copy = document.createElement('span')
      copy.className = 'multitask-item-copy'
      const text = document.createElement('span')
      text.className = 'multitask-item-text'
      text.textContent = providerTask?.name || truncatePreview(item.text)
      text.title = providerTask ? `${providerTask.name}: ${providerTask.text}` : item.text
      const action = document.createElement('span')
      action.className = 'multitask-item-action'
      action.textContent =
        providerTask?.currentAction || (providerTask ? multitaskRunStatus(providerTask) : 'Queued')
      copy.appendChild(text)
      copy.appendChild(action)

      const statusEl = document.createElement('span')
      statusEl.className = 'multitask-item-status'
      statusEl.textContent = providerTask ? multitaskRunStatus(providerTask) : 'Queued'
      statusEl.hidden = multitaskMode

      const steer = document.createElement('button')
      steer.type = 'button'
      steer.className = 'multitask-steer'
      steer.title = 'Continue this task in the active subagent'
      steer.setAttribute('aria-label', 'Continue this waiting task in the active subagent')
      steer.appendChild(
        createElement(ArrowRight, {
          width: 14,
          height: 14,
          'stroke-width': 2,
          'aria-hidden': 'true',
        }),
      )
      steer.hidden =
        multitaskMode ||
        !providerTask ||
        providerTask.status !== 'waiting' ||
        !multitaskTasks.some((candidate) => candidate.status === 'running')
      steer.addEventListener('click', (event) => {
        event.stopPropagation()
        if (providerTask) vscode.postMessage({ type: 'multitask-steer', id: providerTask.id })
      })

      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'multitask-item-remove'
      remove.title = providerTask
        ? status === 'running'
          ? 'Cancel active subagent'
          : 'Cancel waiting subagent'
        : 'Remove from queue'
      remove.setAttribute('aria-label', remove.title)
      remove.textContent = multitaskMode ? 'Stop' : '×'
      remove.hidden = status !== 'queued' && status !== 'waiting' && status !== 'running'
      remove.addEventListener('click', (event) => {
        event.stopPropagation()
        if ('status' in item) {
          vscode.postMessage({ type: 'multitask-cancel', id: item.id })
        } else {
          const index = queue.findIndex((candidate) => candidate.id === item.id)
          if (index >= 0) queue.splice(index, 1)
          renderQueue()
          renderMultitaskActivity()
        }
      })

      row.appendChild(iconWrap)
      row.appendChild(copy)
      row.appendChild(statusEl)
      row.appendChild(steer)
      row.appendChild(remove)
      body.appendChild(row)
    })

    queueCard.appendChild(body)
    renderMultitaskActivity()
  }

  document.addEventListener('click', () => closeQueueMenu())

  composerPlusBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    if (plusMenuOpen) closePlusMenu()
    else openPlusMenu()
  })

  for (const item of composerPlusMenu.querySelectorAll<HTMLButtonElement>('.plus-menu-item')) {
    item.addEventListener('click', (event) => {
      event.stopPropagation()
      const pick = item.dataset.pick
      if (pick === 'multitask') {
        if (multitaskMode) disableMultitask()
        else enableMultitask()
      } else if (pick === 'attach-image') {
        imageFileInputEl.click()
        closePlusMenu()
        return
      } else if (pick && pick in MODE_ICONS) {
        const mode = pick as keyof typeof MODE_ICONS
        setMode(currentMode === mode ? 'code' : mode)
      }
      // Keep the menu open for mode toggles so checkmarks update immediately.
    })
  }

  document.addEventListener('click', () => closePlusMenu())

  updateComposerPlaceholder()
  updateComposerChrome()
  renderPlusMenu()

  function send(): void {
    const text = inputEl.value.trim()
    const hasImages = imageAttachments.length > 0
    if (!text && !hasImages) {
      // Empty composer + queued follow-up: "⏎ to Send" sends it now.
      if (isBusy && queue.length > 0) sendQueuedNow()
      return
    }
    inputEl.value = ''
    if (multitaskMode) {
      if (hasImages) {
        const row = document.createElement('div')
        row.className = 'notice-row'
        row.textContent = 'Image attachments are not supported in Multitask mode yet.'
        messagesEl.appendChild(row)
        scrollDown()
        return
      }
      hideWelcome()
      vscode.postMessage({ type: 'multitask-enqueue', text, mode: currentMode })
      return
    }
    dispatch(text || 'Describe this image.', currentMode)
  }

  sendBtn.addEventListener('click', send)
  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  })
  inputEl.addEventListener('paste', (event) => {
    const items = event.clipboardData?.items
    if (!items) return
    const files: File[] = []
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length === 0) return
    event.preventDefault()
    void addImageFiles(files)
  })
  imageFileInputEl.addEventListener('change', () => {
    if (imageFileInputEl.files?.length) void addImageFiles(imageFileInputEl.files)
    imageFileInputEl.value = ''
  })
  composerEl.addEventListener('dragenter', (event) => {
    if (!hasDraggedImage(event.dataTransfer)) return
    event.preventDefault()
    imageDragDepth += 1
    if (imageDragDepth === 1) setImageDragOver(true)
  })
  composerEl.addEventListener('dragover', (event) => {
    if (!hasDraggedImage(event.dataTransfer)) return
    event.preventDefault()
  })
  composerEl.addEventListener('dragleave', (event) => {
    if (imageDragDepth === 0) return
    event.preventDefault()
    imageDragDepth = Math.max(0, imageDragDepth - 1)
    if (imageDragDepth === 0) setImageDragOver(false)
  })
  composerEl.addEventListener('drop', (event) => {
    imageDragDepth = 0
    setImageDragOver(false)
    const files: File[] = []
    if (event.dataTransfer?.files.length) {
      files.push(...Array.from(event.dataTransfer.files))
    } else if (event.dataTransfer?.items) {
      for (const item of event.dataTransfer.items) {
        if (item.kind !== 'file') continue
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    const imageFiles = files.filter((file) => isAcceptedImageFile(file))
    if (imageFiles.length === 0) return
    event.preventDefault()
    void addImageFiles(imageFiles)
  })
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }))
  undoBtn.addEventListener('click', () => {
    if (pendingUndoSha) vscode.postMessage({ type: 'restore', sha: pendingUndoSha })
  })
  /* ── Chat history ─────────────────────────────────────────────────────── */

  const histBack = document.getElementById('hist-back') as HTMLButtonElement
  const histSearch = document.getElementById('hist-search') as HTMLInputElement
  const histScope = document.getElementById('hist-scope') as HTMLSelectElement
  const histSort = document.getElementById('hist-sort') as HTMLSelectElement
  const histList = document.getElementById('hist-list') as HTMLElement

  interface HistChat {
    id: string
    title: string
    workspace: string
    updatedAt: number
    current: boolean
  }
  let histChats: HistChat[] = []

  function closeHistory(): void {
    document.body.classList.remove('history-open')
    historyView.hidden = true
  }

  function relTime(ts: number): string {
    const mins = Math.max(0, Math.round((Date.now() - ts) / 60000))
    if (mins < 1) return 'just now'
    if (mins < 60) return mins + 'm ago'
    const hours = Math.round(mins / 60)
    if (hours < 24) return hours + 'h ago'
    const days = Math.round(hours / 24)
    return days === 1 ? 'yesterday' : days + 'd ago'
  }

  /** Substring beats subsequence beats nothing — enough fuzz for titles. */
  function fuzzyScore(query: string, text: string): number {
    const q = query.toLowerCase().trim()
    const t = text.toLowerCase()
    if (!q) return 1
    if (t.includes(q)) return 2 + q.length / t.length
    let qi = 0
    for (let i = 0; i < t.length && qi < q.length; i++) {
      if (t[i] === q[qi]) qi++
    }
    return qi === q.length ? 1 : 0
  }

  function renderHistory(): void {
    histList.innerHTML = ''
    const query = histSearch.value
    let rows = histChats.filter((c) => (histScope.value === 'current' ? c.current : true))
    const scored = rows
      .map((chat) => ({ chat, score: fuzzyScore(query, chat.title) }))
      .filter((r) => r.score > 0)
    if (query.trim()) {
      scored.sort((a, b) => b.score - a.score || b.chat.updatedAt - a.chat.updatedAt)
    } else {
      scored.sort((a, b) =>
        histSort.value === 'oldest'
          ? a.chat.updatedAt - b.chat.updatedAt
          : b.chat.updatedAt - a.chat.updatedAt,
      )
    }
    if (scored.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'hist-empty'
      empty.textContent = histChats.length === 0 ? 'No chats yet.' : 'No chats match.'
      histList.appendChild(empty)
      return
    }
    for (const { chat } of scored) {
      const row = document.createElement('div')
      row.className = 'hist-row'
      const main = document.createElement('div')
      main.className = 'hist-row-main'
      const title = document.createElement('div')
      title.className = 'hist-title'
      title.textContent = chat.title
      const meta = document.createElement('div')
      meta.className = 'hist-meta'
      const ws = chat.workspace.split('/').pop() || chat.workspace
      meta.textContent =
        relTime(chat.updatedAt) + (histScope.value === 'all' ? ' · ' + ws : '')
      main.appendChild(title)
      main.appendChild(meta)
      const del = document.createElement('button')
      del.className = 'hist-delete'
      del.title = 'Delete chat'
      del.textContent = '✕'
      del.addEventListener('click', (event) => {
        event.stopPropagation()
        vscode.postMessage({ type: 'delete-chat', id: chat.id })
      })
      row.appendChild(main)
      row.appendChild(del)
      row.addEventListener('click', () => vscode.postMessage({ type: 'open-chat', id: chat.id }))
      histList.appendChild(row)
    }
  }

  histBack.addEventListener('click', closeHistory)
  histSearch.addEventListener('input', renderHistory)
  histScope.addEventListener('change', renderHistory)
  histSort.addEventListener('change', renderHistory)

  /** Clear the chat area (shared by New session and opening a stored chat). */
  function resetChatUI(): void {
    for (const child of Array.from(messagesEl.children)) {
      if (child.id !== 'welcome') child.remove()
    }
    ctxUsed = 0
    ctxLimit = 0
    if (ctxFlashTimer) {
      clearTimeout(ctxFlashTimer)
      ctxFlashTimer = null
    }
    ctxGauge.hidden = true
    toolCards.clear()
    reviewCards.clear()
    resetTurnSession()
    setComposerUndo(null)
    queue.length = 0
    multitaskTasks = []
    multitaskRunRows.clear()
    finishedSubagentsEl = null
    queueStartingId = null
    multitaskMode = false
    queueCollapsed = false
    renderMultitaskChip()
    renderQueue()
    renderMultitaskActivity()
    updateComposerPlaceholder()
    updateComposerChrome()
    closePlusMenu()
    clearHybridGroups()
    liveReasoningEl = null
    liveReasoningBodyEl = null
    hadLiveReasoningThisStep = false
    resetReasoningStream()
    discardLiveReply()
    hideSpinner()
    backgroundWorkEl = null
  }

  window.addEventListener('message', (event) => {
    const msg = event.data
    switch (msg.type) {
      case 'state': {
        applyTheme(msg.theme)
        versionLabel.textContent = `v${msg.extensionVersion ?? '?'}`
        versionLabel.title = `Running Trie IDE extension ${msg.extensionVersion ?? 'unknown'}`
        backendChip.hidden = !msg.model
        backendChip.textContent = msg.model
        backendChip.title = msg.backend
        const hasModels = Array.isArray(msg.hybridModels) && msg.hybridModels.length > 0
        activeHybridLabel =
          typeof msg.hybridActiveLabel === 'string' && msg.hybridActiveLabel.trim()
            ? msg.hybridActiveLabel.trim()
            : 'Hybrid'
        if (hybridChip) {
          hybridChip.hidden = !hasModels && !msg.hybridEnabled
          hybridChip.classList.toggle('muted', !msg.hybridEnabled)
        }
        if (hybridModelLabel) {
          hybridModelLabel.textContent =
            msg.hybridActiveLabel && msg.hybridActiveLabel !== 'Hybrid'
              ? ' · ' + msg.hybridActiveLabel
              : ''
        }
        renderHybridMenu(msg.hybridModels ?? [], !!msg.hybridEnabled)
        imageSupport = msg.imageSupport ?? 'non-vision-model'
        isBusy = msg.busy
        workElsewhere = Number(msg.workElsewhere ?? 0)
        sendBtn.disabled = false
        updateComposerChrome()
        renderQueue()
        renderMultitaskActivity()
        renderBackgroundWork()
        if (!msg.busy) {
          hideSpinner()
          setTimeout(drainQueue, 0)
        } else if (!turnSession) {
          hideWelcome()
          showSpinner()
        }
        break
      }
      case 'multitask-list': {
        multitaskTasks = Array.isArray(msg.tasks) ? msg.tasks : []
        if (
          multitaskTasks.some((task) => task.status === 'waiting' || task.status === 'running') &&
          !multitaskMode
        ) {
          enableMultitask()
        }
        syncMultitaskRunRows()
        renderQueue()
        renderMultitaskActivity()
        break
      }
      case 'tool-call': {
        settleLiveReasoning()
        hideSpinner()
        const row = trackToolCall(msg)
        toolCards.set(msg.id, row)
        if (msg.linesAdded || msg.linesDeleted) {
          row.dataset.added = String(msg.linesAdded ?? 0)
          row.dataset.deleted = String(msg.linesDeleted ?? 0)
        }
        showSpinner()
        scrollDown()
        break
      }
      case 'tool-result': {
        const row = toolCards.get(msg.id)
        if (!row) break
        row.classList.remove('running')
        const status = row.querySelector('.acc-status')
        if (msg.userSkipped) {
          row.classList.add('muted')
          row.dataset.skipped = '1'
          if (status) status.textContent = '□'
        } else if (msg.ok) {
          row.classList.add('ok')
          if (status) status.textContent = '✓'
        } else {
          row.classList.add('muted')
          if (status) status.textContent = '□'
        }
        attachToolDetail(row, row.dataset.args, msg.detail ?? row.dataset.detail)
        if (msg.viaTrie && typeof msg.trieMs === 'number') {
          attachTrieBadge(row, msg.trieMs, msg.scanMs)
        }
        if (!msg.ok && !msg.userSkipped) {
          if (msg.summary) {
            const err = document.createElement('div')
            err.className = 'acc-error muted-error'
            err.textContent = msg.summary
            row.after(err)
          }
          const added = Number(row.dataset.added ?? 0)
          const deleted = Number(row.dataset.deleted ?? 0)
          if (turnSession && (added || deleted)) {
            turnSession.added = Math.max(0, turnSession.added - added)
            turnSession.deleted = Math.max(0, turnSession.deleted - deleted)
            refreshTurnSummary()
          }
        }
        break
      }
      case 'reasoning': {
        if (msg.discard) {
          discardLiveReasoning()
          break
        }
        if (typeof msg.chunk === 'string' && msg.chunk) appendLiveReasoning(msg.chunk)
        if (msg.done) {
          if (typeof msg.text === 'string' && msg.text.trim()) {
            if (liveReasoningEl) settleLiveReasoning(msg.text)
            else renderPersistedThought(msg.text)
          } else {
            settleLiveReasoning()
          }
        }
        break
      }
      case 'reply': {
        if (msg.discard) {
          discardLiveReply()
          break
        }
        if (msg.start) ensureLiveReply()
        if (typeof msg.chunk === 'string' && msg.chunk) appendLiveReply(msg.chunk)
        break
      }
      case 'todos': {
        renderInlineTodos(msg.todo, msg.done)
        break
      }
      case 'context': {
        ctxUsed = msg.used
        ctxLimit = msg.limit
        // A "freed Xk" flash is showing — its timer re-renders with these values.
        if (!ctxFlashTimer) renderCtxGauge()
        break
      }
      case 'compaction': {
        if (msg.active) {
          if (ctxFlashTimer) {
            clearTimeout(ctxFlashTimer)
            ctxFlashTimer = null
          }
          ctxGauge.hidden = false
          ctxGauge.classList.add('compacting')
          ctxGauge.classList.remove('warn', 'hot')
          ctxGauge.textContent = 'Compacting…'
          ctxGauge.title = 'Summarizing older turns to free context'
        } else if (typeof msg.saved === 'number' && msg.saved > 0) {
          ctxGauge.classList.remove('compacting')
          ctxGauge.textContent = 'freed ' + fmtTokens(msg.saved)
          renderCompactionNote(msg.saved, msg.keptTurns)
          ctxFlashTimer = setTimeout(() => {
            ctxFlashTimer = null
            renderCtxGauge()
          }, 2500)
        } else {
          renderCtxGauge()
        }
        break
      }
      case 'hybrid-check': {
        if (msg.active) showHybridCheck(msg.checkpoint ?? 'final_review')
        else settleHybridCheck(msg.checkpoint ?? 'final_review')
        break
      }
      case 'hybrid-plan': {
        showHybridPlan(msg.subtasks, msg.rationale)
        break
      }
      case 'guide': {
        showHybridGuide(msg.checkpoint ?? 'final_review', msg.verdict, msg.text)
        break
      }
      case 'question': {
        questionSnapshots.set(msg.requestId, msg.questions ?? [])
        renderQuestionCard(msg.requestId, msg.questions ?? [])
        break
      }
      case 'question-resolved': {
        const existing = messagesEl.querySelector(
          `.question-card[data-request-id="${msg.requestId}"]`,
        ) as HTMLElement | null
        if (existing?.classList.contains('resolved')) break
        if (existing) {
          showQuestionAnswers(existing, msg.answers ?? [])
        } else {
          renderQuestionCard(
            msg.requestId,
            questionSnapshots.get(msg.requestId) ?? [],
            msg.answers ?? [],
          )
        }
        break
      }
      case 'plan-handoff': {
        planHandoffSnapshots.set(msg.id, { path: msg.path ?? '', content: msg.content ?? '' })
        renderPlanHandoffCard(msg.id, msg.path ?? '', msg.content ?? '')
        break
      }
      case 'plan-handoff-resolved': {
        const existing = messagesEl.querySelector(
          `.plan-handoff-card[data-handoff-id="${msg.id}"]`,
        ) as HTMLElement | null
        const snap = planHandoffSnapshots.get(msg.id)
        if (existing && snap) {
          existing.classList.add('resolved')
          existing.querySelector('.plan-handoff-actions')?.remove()
          let note = existing.querySelector('.plan-handoff-resolved-note') as HTMLElement | null
          if (!note) {
            note = document.createElement('div')
            note.className = 'plan-handoff-resolved-note'
            existing.appendChild(note)
          }
          note.textContent =
            msg.action === 'execute'
              ? 'Approved — implementing in Code mode.'
              : msg.action === 'stay'
                ? 'Staying in Plan mode.'
                : 'Opened in editor.'
        } else if (snap) {
          renderPlanHandoffCard(msg.id, snap.path, snap.content, msg.action)
        }
        break
      }
      case 'permission': {
        renderPermissionCard(msg.requestId, msg.request)
        break
      }
      case 'final': {
        settleLiveReasoning()
        hideSpinner()
        finishTurnSession()
        if (liveReplyEl) {
          settleLiveReply(msg.text, !msg.ok)
        } else {
          addReply(msg.text, !msg.ok)
        }
        if (msg.checkpoint) setComposerUndo(msg.checkpoint)
        if (msg.checkpoint) {
          const row = document.createElement('div')
          row.className = 'checkpoint-row'
          const btn = document.createElement('button')
          btn.className = 'ghost checkpoint-btn'
          btn.textContent = '↺ Restore checkpoint'
          btn.title = 'Revert the workspace to how it was before this turn'
          btn.addEventListener('click', () => {
            vscode.postMessage({ type: 'restore', sha: msg.checkpoint })
          })
          row.appendChild(btn)
          messagesEl.appendChild(row)
          scrollDown()
        }
        break
      }
      case 'review': {
        hideSpinner()
        setComposerUndo(msg.checkpoint, msg.files.length)
        renderReviewCard(msg.checkpoint, msg.files)
        break
      }
      case 'restored': {
        setComposerUndo(null)
        const card = reviewCards.get(msg.sha)
        if (card) {
          resolveReviewCard(card, 'undone')
        } else if (!msg.conversationRewound) {
          // When conversationRewound, chat-loaded already rebuilt the transcript.
          addReply(
            'Undid turn ' + msg.sha.slice(0, 8) + ' (' + msg.files + ' files reverted).',
          )
        }
        break
      }
      case 'error': {
        settleLiveReasoning()
        discardLiveReply()
        hideSpinner()
        finishTurnSession()
        addBubble('error', msg.text)
        // Early failures (e.g. no workspace) never cycle the busy state, so
        // clear the optimistic flag and let queued follow-ups proceed.
        isBusy = false
        setTimeout(drainQueue, 0)
        break
      }
      case 'notice': {
        const el = document.createElement('div')
        el.className = 'notice-row'
        el.textContent = msg.text
        messagesEl.appendChild(el)
        scrollDown()
        break
      }
      case 'reset': {
        resetChatUI()
        showWelcome()
        break
      }
      case 'history': {
        histChats = msg.chats
        renderHistory()
        break
      }
      case 'chat-loaded': {
        closeHistory()
        resetChatUI()
        hideWelcome()
        for (const entry of msg.transcript) {
          if (entry.role === 'activity' && entry.message) {
            let activity = entry.message as { type?: string; [key: string]: unknown }
            if (activity.type === 'reasoning' && activity.done && activity.text) {
              window.dispatchEvent(new MessageEvent('message', { data: activity }))
              continue
            }
            if (activity.type === 'tool-call' && activity.thought) {
              const prev = msg.transcript[msg.transcript.indexOf(entry) - 1]
              if (
                prev?.role === 'activity' &&
                prev.message?.type === 'reasoning' &&
                prev.message?.text === activity.thought
              ) {
                activity = { ...activity, suppressThought: true }
              }
            }
            window.dispatchEvent(new MessageEvent('message', { data: activity }))
          } else if (entry.role === 'user') {
            finishTurnSession()
            hideSpinner()
            addBubble('user', entry.text)
          } else if (entry.role === 'error') {
            finishTurnSession()
            hideSpinner()
            addBubble('error', entry.text)
          } else if (entry.role === 'reply') {
            finishTurnSession()
            hideSpinner()
            addReply(entry.text, entry.failed === true)
          }
        }
        finishTurnSession()
        hideSpinner()
        scrollDown()
        break
      }
    }
  })

  // Ask for current state — the extension's first push can land before this
  // script's listener exists (e.g. on first reveal of the view).
  vscode.postMessage({ type: 'init' })
})()

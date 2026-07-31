import { ArrowRight, Bot, createElement, FileText, ListChecks, MessageCircleQuestion } from 'lucide'

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
  const hybridChip = document.getElementById('hybrid-chip') as HTMLButtonElement | null
  const hybridMenu = document.getElementById('hybrid-menu') as HTMLElement | null
  const hybridMenuEnabled = document.getElementById('hybrid-menu-enabled') as HTMLInputElement | null
  const hybridModelList = document.getElementById('hybrid-model-list') as HTMLElement | null
  const hybridModelLabel = hybridChip?.querySelector('.hybrid-model-label') as HTMLElement | null

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
    /** Cumulative measured ms the trie index saved vs full scans this turn. */
    trieSavedMs: number
  }

  let turnSession: TurnSession | null = null

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
    const trieEl = turnSession.el.querySelector('.turn-trie') as HTMLElement | null
    if (trieEl) {
      trieEl.hidden = turnSession.trieSavedMs < 1
      if (turnSession.trieSavedMs >= 1) {
        trieEl.textContent = 'trie saved ' + fmtMs(turnSession.trieSavedMs)
        trieEl.title =
          'Measured time the prefix-trie symbol index saved vs full content scans this turn'
      }
    }
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
    el.open = true

    const summary = document.createElement('summary')
    summary.className = 'turn-summary'
    summary.innerHTML =
      '<span class="acc-chevron"></span>' +
      '<span class="turn-label">Working…</span>' +
      '<span class="turn-trie" hidden></span>' +
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
      trieSavedMs: 0,
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
    el.open = true

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
    const row = document.createElement('div')
    row.className = 'acc-row thought'
    const prefix = sinceMs >= 800 ? 'Thought for ' + formatElapsed(sinceMs) : 'Thought'
    row.textContent = prefix
    const detail = document.createElement('div')
    detail.className = 'acc-thought'
    detail.textContent = thought
    group.body.appendChild(row)
    group.body.appendChild(detail)
  }

  function addToolRow(
    group: AccordionGroup,
    id: number,
    rowLabel: string,
    thought: string,
    sinceMs: number,
  ): HTMLElement {
    addThoughtRow(group, thought, sinceMs)
    const row = document.createElement('div')
    row.className = 'acc-row tool running'
    row.dataset.id = String(id)
    row.innerHTML =
      '<span class="acc-status">·</span><span class="acc-label"></span>'
    ;(row.querySelector('.acc-label') as HTMLElement).textContent = rowLabel
    group.body.appendChild(row)
    bumpGroupMeta(group)
    return row
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
    return addToolRow(group, msg.id, msg.rowLabel, msg.thought, sinceMs)
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
      el.open = true
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

  function finishTurnSession(): void {
    if (!turnSession) return
    refreshTurnSummary() // final +/− stats
    turnSession.labelEl.textContent = turnSummaryText(turnSession, true)
    turnSession = null
    todoCard = null
    todoCardSeen = false
    closeActiveGroup()
  }

  function resetTurnSession(): void {
    turnSession = null
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

  /* ── Context gauge + memory compaction (bottom-right of composer) ───── */

  let ctxUsed = 0
  let ctxLimit = 0
  let ctxFlashTimer: ReturnType<typeof setTimeout> | null = null

  function fmtTokens(n: number): string {
    if (n < 1000) return String(n)
    return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
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
    undoBtn.title = 'Revert the workspace to how it was before this turn'
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
    el.open = true
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

  function mountModeIcons(): void {
    for (const btn of document.querySelectorAll<HTMLButtonElement>('#mode-picker .mode')) {
      const mode = btn.dataset.mode as keyof typeof MODE_ICONS | undefined
      if (!mode || !(mode in MODE_ICONS)) continue
      btn.querySelector('.mode-icon')?.remove()
      const svg = createElement(MODE_ICONS[mode], {
        width: 13,
        height: 13,
        'stroke-width': 2,
        class: 'mode-icon',
      })
      btn.prepend(svg)
    }
  }

  mountModeIcons()

  const modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#mode-picker .mode'))
  for (const btn of modeButtons) {
    btn.addEventListener('click', () => {
      setMode((btn.dataset.mode as keyof typeof MODE_ICONS) || 'code')
    })
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

  function addBubble(className: string, text: string): HTMLElement {
    const el = document.createElement('div')
    el.className = 'bubble ' + className
    el.textContent = text
    messagesEl.appendChild(el)
    scrollDown()
    return el
  }

  /** Final assistant prose — plain text, no chat bubble (Cursor-style). URLs become links. */
  function linkifyText(text: string): DocumentFragment {
    const fragment = document.createDocumentFragment()
    const urlRe = /https?:\/\/[^\s<>"')\]]+/g
    let last = 0
    let match: RegExpExecArray | null
    while ((match = urlRe.exec(text)) !== null) {
      if (match.index > last) fragment.appendChild(document.createTextNode(text.slice(last, match.index)))
      const a = document.createElement('a')
      a.href = match[0]
      a.textContent = match[0]
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      fragment.appendChild(a)
      last = match.index + match[0].length
    }
    if (last < text.length) fragment.appendChild(document.createTextNode(text.slice(last)))
    return fragment
  }

  function addReply(text: string, failed = false): HTMLElement {
    const el = document.createElement('div')
    el.className = 'reply' + (failed ? ' failed' : '')
    el.appendChild(linkifyText(text))
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
    text: string
    mode: keyof typeof MODE_ICONS
    status: MultitaskStatus
    createdAt: number
    startedAt?: number
    finishedAt?: number
  }
  const queue: QueuedItem[] = []
  let multitaskTasks: MultitaskTask[] = []
  let queueCard: HTMLElement | null = null
  let activeModeChipEl: HTMLElement | null = null
  let multitaskChipEl: HTMLElement | null = null
  let multitaskActivityEl: HTMLElement | null = null
  const multitaskRunRows = new Map<string, HTMLElement>()
  const composerEl = document.getElementById('composer') as HTMLElement
  let plusMenuOpen = false

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
      const check = item.querySelector('.plus-menu-check') as HTMLElement
      const active = pick === 'multitask' ? multitaskMode : pick === currentMode
      check.hidden = !active
    }
  }

  function setMode(mode: keyof typeof MODE_ICONS): void {
    if (mode !== 'code' && multitaskMode) disableMultitask()
    currentMode = mode
    for (const btn of modeButtons) {
      const active = btn.dataset.mode === mode
      btn.classList.toggle('active', active)
      btn.setAttribute('aria-pressed', String(active))
    }
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
    chip.className = 'composer-mode-chip'
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
      multitaskChipEl.title = 'Run isolated background coding agents safely, one at a time'
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
    if (running && waiting) return `${running} working · ${waiting} waiting`
    if (running) return `${running} working`
    if (waiting) return `${waiting} starting up`
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
    const hasRunningTask = multitaskTasks.some((candidate) => candidate.status === 'running')
    const firstWaitingTask = multitaskTasks.find((candidate) => candidate.status === 'waiting')
    return !hasRunningTask && firstWaitingTask?.id === task.id
      ? 'Starting up'
      : 'Waiting for model/subagent'
  }

  function syncMultitaskRunRows(): void {
    for (const task of multitaskTasks) {
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
        truncatePreview(task.text, 64) || 'New subagent'
      ;(row.querySelector('.multitask-run-status') as HTMLElement).textContent =
        multitaskRunStatus(task)
      ;(row.querySelector('.multitask-run-prompt') as HTMLElement).textContent = task.text
      const steer = row.querySelector('.multitask-steer') as HTMLButtonElement
      steer.hidden =
        task.status !== 'waiting' ||
        !multitaskTasks.some((candidate) => candidate.status === 'running')
      ;(row.querySelector('.multitask-run-result') as HTMLElement).textContent =
        task.status === 'completed'
          ? '✓'
          : task.status === 'failed' || task.status === 'cancelled' || task.status === 'interrupted'
            ? '×'
            : ''
    }
    scrollDown()
  }

  function dispatch(text: string, mode: keyof typeof MODE_ICONS): void {
    isBusy = true // optimistic, so a second drain can't fire before state arrives
    hideWelcome()
    addBubble('user', text)
    showSpinner()
    renderMultitaskActivity()
    vscode.postMessage({ type: 'send', text, mode })
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
    const providerTasks = multitaskTasks.slice(-8).reverse()
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
      dots.innerHTML = '<i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>'
      const separator = document.createElement('span')
      separator.className = 'multitask-pill-separator'
      separator.textContent = '·'
      left.appendChild(dots)
      left.appendChild(separator)
    }
    const count = document.createElement('span')
    count.className = 'multitask-count'
    if (multitaskMode) {
      count.textContent = queueCollapsed
        ? activeCount > 0
          ? `${activeCount} Working`
          : 'Recent agents'
        : activeCount > 0
          ? `${activeCount} Active`
          : 'Recent agents'
    } else {
      count.textContent = queue.length === 1 ? '1 Queued' : `${queue.length} Queued`
    }
    const hint = document.createElement('span')
    hint.className = 'multitask-send-hint'
    hint.textContent = multitaskMode ? 'Background agents' : '⏎ to send next'
    hint.title = multitaskMode
      ? 'Tasks run one at a time to protect the local model and workspace'
      : 'Press Enter on an empty composer to send the next queued task now'
    left.appendChild(count)
    if (!multitaskMode || !queueCollapsed) left.appendChild(hint)

    const right = document.createElement('div')
    right.className = 'multitask-card-right'
    if (
      multitaskMode &&
      !queueCollapsed &&
      multitaskTasks.some((task) => task.status === 'waiting' || task.status === 'running')
    ) {
      const spinner = document.createElement('span')
      spinner.className = 'multitask-spinner'
      spinner.setAttribute('aria-hidden', 'true')
      const status = document.createElement('span')
      status.className = 'multitask-card-status'
      status.textContent = queueCardStatus()
      right.appendChild(spinner)
      right.appendChild(status)
    }
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
      iconWrap.appendChild(
        createElement(FileText, {
          width: 13,
          height: 13,
          'stroke-width': 2,
        }),
      )

      const text = document.createElement('span')
      text.className = 'multitask-item-text'
      text.textContent = truncatePreview(item.text)
      text.title = item.text

      const statusEl = document.createElement('span')
      statusEl.className = 'multitask-item-status'
      statusEl.textContent = providerTask ? multitaskRunStatus(providerTask) : 'Queued'

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
      remove.textContent = '×'
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
      row.appendChild(text)
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
      } else if (pick && pick in MODE_ICONS) {
        setMode(pick as keyof typeof MODE_ICONS)
      }
      closePlusMenu()
    })
  }

  document.addEventListener('click', () => closePlusMenu())

  updateComposerPlaceholder()
  updateComposerChrome()
  renderPlusMenu()

  function send(): void {
    const text = inputEl.value.trim()
    if (!text) {
      // Empty composer + queued follow-up: "⏎ to Send" sends it now.
      if (isBusy && queue.length > 0) sendQueuedNow()
      return
    }
    inputEl.value = ''
    if (multitaskMode) {
      hideWelcome()
      vscode.postMessage({ type: 'multitask-enqueue', text, mode: currentMode })
      return
    }
    dispatch(text, currentMode)
  }

  sendBtn.addEventListener('click', send)
  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  })
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }))
  undoBtn.addEventListener('click', () => {
    if (pendingUndoSha) vscode.postMessage({ type: 'restore', sha: pendingUndoSha })
  })
  newBtn.addEventListener('click', () => vscode.postMessage({ type: 'new' }))
  connectBtn.addEventListener('click', () => vscode.postMessage({ type: 'connect' }))
  settingsBtn.addEventListener('click', () => vscode.postMessage({ type: 'settings' }))

  /* ── Chat history ─────────────────────────────────────────────────────── */

  const historyBtn = document.getElementById('history-btn') as HTMLButtonElement
  const historyView = document.getElementById('history-view') as HTMLElement
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

  function openHistory(): void {
    document.body.classList.add('history-open')
    historyView.hidden = false
    vscode.postMessage({ type: 'history' })
  }

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

  historyBtn.addEventListener('click', openHistory)
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
    hideSpinner()
    backgroundWorkEl = null
  }

  window.addEventListener('message', (event) => {
    const msg = event.data
    switch (msg.type) {
      case 'state': {
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
        row.classList.add(msg.ok ? 'ok' : 'failed')
        const status = row.querySelector('.acc-status')
        if (status) status.textContent = msg.ok ? '✓' : '✗'
        if (msg.viaTrie && turnSession && typeof msg.trieMs === 'number' && typeof msg.scanMs === 'number') {
          turnSession.trieSavedMs += Math.max(0, msg.scanMs - msg.trieMs)
          refreshTurnSummary()
        }
        if (!msg.ok) {
          row.classList.add('failed')
          if (msg.summary) {
            const err = document.createElement('div')
            err.className = 'acc-error'
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
      case 'final': {
        hideSpinner()
        finishTurnSession()
        addReply(msg.text, !msg.ok)
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
        } else {
          addReply(
            'Workspace restored to checkpoint ' + msg.sha.slice(0, 8) + ' (' + msg.files + ' files reverted).',
          )
        }
        break
      }
      case 'error': {
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
          if (entry.role === 'user') addBubble('user', entry.text)
          else if (entry.role === 'error') addBubble('error', entry.text)
          else addReply(entry.text, entry.failed === true)
        }
        scrollDown()
        break
      }
    }
  })

  // Ask for current state — the extension's first push can land before this
  // script's listener exists (e.g. on first reveal of the view).
  vscode.postMessage({ type: 'init' })
})()

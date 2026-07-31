import * as crypto from 'node:crypto'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { readConfig, setFrontierSelection, setHybridEnabled, hybridActiveLabel, isHybridConfigured, listHybridModelOptions } from '../config'
import { ShadowRepo, type ChangedFileStat } from '../agent/checkpoints'
import { FrontierAssist, type GuideNote } from '../agent/frontierAssist'
import { AgentSession } from '../agent/loop'
import type { AgentMode } from '../agent/prompts'
import type { ToolCall } from '../agent/tools'
import { formatToolRow, toolGroupKey, toolLineDelta } from '../agent/tools'
import { summaryClaimsFileChanges } from '../agent/taskIntent'
import { DaemonClient } from '../inference/daemonClient'
import { OpenAiCompatibleClient } from '../inference/openaiClient'
import type { InferenceClient } from '../inference/types'
import { ChatStore, type ChatSummary, type TranscriptEntry } from './chatStore'

type ToWebview =
  | {
      type: 'state'
      backend: string
      model: string
      hybridEnabled: boolean
      hybridActiveLabel: string
      hybridModels: { label: string; slot: number; modelIndex: number; active: boolean }[]
      busy: boolean
      workElsewhere: number
    }
  | { type: 'tool-call'; id: number; tool: string; args: string; rowLabel: string; thought: string; groupKey?: string; linesAdded?: number; linesDeleted?: number }
  | { type: 'tool-result'; id: number; ok: boolean; summary: string; viaTrie?: boolean; trieMs?: number; scanMs?: number }
  | { type: 'todos'; todo: string[]; done: string[] }
  | { type: 'hybrid-check'; active: boolean; checkpoint?: string }
  | { type: 'hybrid-plan'; subtasks: string[]; rationale?: string }
  | { type: 'guide'; checkpoint: string; verdict: string; text: string }
  | { type: 'context'; used: number; limit: number }
  | { type: 'compaction'; active: boolean; saved?: number }
  | { type: 'final'; ok: boolean; text: string; checkpoint?: string }
  | { type: 'review'; checkpoint: string; files: ChangedFileStat[] }
  | { type: 'error'; text: string }
  | { type: 'notice'; text: string }
  | { type: 'restored'; sha: string; files: number }
  | { type: 'reset' }
  | { type: 'history'; chats: (ChatSummary & { current: boolean })[] }
  | { type: 'chat-loaded'; transcript: TranscriptEntry[] }
  | { type: 'multitask-list'; tasks: MultitaskTaskView[] }

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
  | { type: 'history' }
  | { type: 'open-chat'; id: string }
  | { type: 'delete-chat'; id: string }
  | { type: 'compact' }
  | { type: 'set-frontier'; slot: number; modelIndex: number }
  | { type: 'toggle-hybrid'; enabled: boolean }
  | { type: 'multitask-enqueue'; text: string; mode?: AgentMode }
  | { type: 'multitask-cancel'; id: string }
  | { type: 'multitask-cancel-all' }
  | { type: 'multitask-steer'; id: string }

type MultitaskStatus = 'waiting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

interface MultitaskTask {
  id: string
  parentId: string
  name: string
  text: string
  mode: AgentMode
  status: MultitaskStatus
  currentAction?: string
  kind: 'child' | 'coordinator'
  createdAt: number
  startedAt?: number
  finishedAt?: number
  result?: string
  session?: AgentSession
  chatId: string
}

type MultitaskTaskView = Omit<MultitaskTask, 'session'>

interface MultitaskParent {
  id: string
  text: string
  mode: AgentMode
  chatId: string
  children: MultitaskTask[]
  cancelled: boolean
}

interface ChatRuntime {
  id: string
  createdAt: number
  workspace: string
  transcript: TranscriptEntry[]
  session: AgentSession
  pendingRuns: number
}

interface RunRequest {
  runtime: ChatRuntime
  text: string
  mode: AgentMode
  session: AgentSession
  multitask?: MultitaskTask
  multitaskParent?: MultitaskParent
  internal?: boolean
  abort: AbortController
}

interface RunOutcome {
  ok: boolean
  result: string
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'trie-ide.chatView'

  private view: vscode.WebviewView | null = null
  private shadowRepo: ShadowRepo | null = null
  private readonly output = vscode.window.createOutputChannel('Trie Coding Agent')
  private readonly store: ChatStore
  private readonly runtimes = new Map<string, ChatRuntime>()
  private selectedChatId: string | null = null
  private readonly runQueue: RunRequest[] = []
  private activeRun: RunRequest | null = null
  private readonly multitaskTasks: MultitaskTask[] = []
  private readonly multitaskParents = new Map<string, MultitaskParent>()
  private activeMultitaskId: string | null = null

  private log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`)
  }

  /** Set by the connect command so the status line can show the model. */
  daemonClient: DaemonClient | null = null

  constructor(
    private readonly extensionUri: vscode.Uri,
    storageUri: vscode.Uri,
    private readonly onStatusChanged: (label: string) => void,
  ) {
    this.store = new ChatStore(storageUri)
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

  private createRuntime(
    folder: vscode.WorkspaceFolder,
    id: string = crypto.randomUUID(),
    createdAt = Date.now(),
    transcript: TranscriptEntry[] = [],
  ): ChatRuntime {
    const runtime: ChatRuntime = {
      id,
      createdAt,
      workspace: folder.uri.fsPath,
      transcript: [...transcript],
      session: new AgentSession(
        folder.uri.fsPath,
        folder.name,
        new FrontierAssist(() => readConfig().frontierAssist),
      ),
      pendingRuns: 0,
    }
    this.runtimes.set(id, runtime)
    return runtime
  }

  private selectedRuntime(): ChatRuntime | null {
    return this.selectedChatId ? this.runtimes.get(this.selectedChatId) ?? null : null
  }

  private ensureSelectedRuntime(folder: vscode.WorkspaceFolder): ChatRuntime {
    const selected = this.selectedRuntime()
    if (selected) return selected
    const runtime = this.createRuntime(folder)
    this.selectedChatId = runtime.id
    return runtime
  }

  private isRuntimeBusy(runtime: ChatRuntime | null): boolean {
    return !!runtime && (runtime.pendingRuns > 0 || this.activeRun?.runtime.id === runtime.id)
  }

  private postFor(runtime: ChatRuntime, message: ToWebview): void {
    if (this.isPersistedActivity(message)) {
      runtime.transcript.push({
        role: 'activity',
        message: message as { type: string; [key: string]: unknown },
      })
    }
    if (this.selectedChatId === runtime.id) this.post(message)
  }

  private isPersistedActivity(message: ToWebview): boolean {
    switch (message.type) {
      case 'tool-call':
      case 'tool-result':
      case 'todos':
      case 'hybrid-check':
      case 'hybrid-plan':
      case 'guide':
      case 'context':
      case 'compaction':
      case 'review':
      case 'notice':
      case 'multitask-list':
        return true
      default:
        return false
    }
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
    const fa = cfg.frontierAssist
    const hybridModels = listHybridModelOptions(fa)
    const selected = this.selectedRuntime()
    const workElsewhere = [...this.runtimes.values()].filter(
      (runtime) => runtime.id !== this.selectedChatId && this.isRuntimeBusy(runtime),
    ).length
    this.post({
      type: 'state',
      backend: cfg.backend === 'daemon' ? 'Trie IDE daemon' : 'LLM API',
      model: ready ? model : '',
      hybridEnabled: fa.enabled && isHybridConfigured(fa),
      hybridActiveLabel: hybridActiveLabel(fa),
      hybridModels,
      busy: this.isRuntimeBusy(selected),
      workElsewhere,
    })
    this.onStatusChanged(model)
  }

  private pushMultitaskTasks(): void {
    const selectedChatId = this.selectedChatId
    const message: ToWebview = {
      type: 'multitask-list',
      tasks: this.multitaskTasks
        .filter((task) => task.chatId === selectedChatId)
        .slice(-20)
        .map(({ session: _session, ...task }) => task),
    }
    const runtime = this.selectedRuntime()
    if (runtime) {
      this.postFor(runtime, message)
      void this.saveChat(runtime)
    } else {
      this.post(message)
    }
  }

  private restoreMultitaskSnapshot(runtime: ChatRuntime): void {
    const latest = [...runtime.transcript].reverse().find(
      (entry) => entry.role === 'activity' && entry.message.type === 'multitask-list',
    )
    if (!latest || latest.role !== 'activity' || !Array.isArray(latest.message['tasks'])) return
    const known = new Set(this.multitaskTasks.map((task) => task.id))
    for (const raw of latest.message['tasks'] as MultitaskTaskView[]) {
      if (!raw?.id || known.has(raw.id)) continue
      const task: MultitaskTask = { ...raw }
      if (task.status === 'waiting' || task.status === 'running') {
        task.status = 'interrupted'
        task.currentAction = 'Interrupted when the extension session ended'
        task.finishedAt = Date.now()
        task.result = 'Interrupted when the extension session ended; this child was not resumed.'
      }
      this.multitaskTasks.push(task)
    }
  }

  private requestedAgentCount(text: string): number {
    const explicit = text.match(/\b([2-6]|two|three|four|five|six)\s+(?:separate\s+|independent\s+)?(?:sub)?agents?\b/i)
    if (explicit) {
      const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6 }
      return Number(explicit[1]) || words[explicit[1].toLowerCase()] || 1
    }
    if (
      /\b(?:a\s+few|few|several|multiple)\s+(?:separate\s+|independent\s+)?(?:sub)?agents?\b/i.test(text)
    ) return 3
    if (/\b(?:a\s+couple(?:\s+of)?|couple(?:\s+of)?)\s+(?:sub)?agents?\b/i.test(text)) return 2
    // In Multitask mode an unqualified plural "agents" is still an explicit
    // orchestration request. Default to a small, useful team rather than
    // silently collapsing the request to one generic parent turn.
    return /\b(?:sub)?agents\b/i.test(text) ? 3 : 1
  }

  private childAssignments(count: number): { name: string; focus: string }[] {
    if (count === 1) return [{ name: 'Primary agent', focus: 'Own the requested task end to end.' }]
    const focuses = [
      'Map the relevant architecture, entry points, state ownership, and cross-file data flow.',
      'Inspect the core implementation for correctness, races, lifecycle bugs, and unsafe assumptions.',
      'Audit edge cases, cancellation/error paths, persistence, accessibility, and test coverage.',
      'Trace integration boundaries and look for regressions or compatibility risks.',
      'Independently challenge earlier findings and verify the highest-risk claims with concrete evidence.',
      'Review validation, build, and release concerns; identify gaps that could escape normal testing.',
    ]
    return Array.from({ length: count }, (_, index) => ({
      name: `Agent ${index + 1} · ${['Architecture', 'Implementation', 'Verification', 'Integration', 'Adversarial review', 'Release'][index]}`,
      focus: `${focuses[index]} Coordinate by reporting concise structured findings for the next sibling and final coordinator.`,
    }))
  }

  private childPrompt(parent: MultitaskParent, child: MultitaskTask): string {
    const completed = parent.children
      .filter((candidate) => candidate.kind === 'child' && candidate.result)
      .map((candidate) => `${candidate.name}:\n${candidate.result}`)
    return [
      `You are ${child.name}, one isolated child in a coordinated Multitask run.`,
      `Parent request: ${parent.text}`,
      `Your assigned focus: ${child.text}`,
      completed.length
        ? `Structured findings from completed siblings (verify and build on them; do not merely repeat):\n${completed.join('\n\n')}`
        : 'No sibling has completed yet. Establish concrete findings for the agents that follow.',
      'Finish with a concise structured report: scope examined, evidence (paths/symbols), findings or changes, verification, and handoff notes.',
    ].join('\n\n')
  }

  private enqueueNextChild(parent: MultitaskParent): void {
    if (parent.cancelled) return
    const next = parent.children.find((child) => child.kind === 'child' && child.status === 'waiting')
    if (next) {
      if (
        this.activeRun?.multitask?.id === next.id ||
        this.runQueue.some((request) => request.multitask?.id === next.id)
      ) return
      this.enqueueRun(
        this.runtimes.get(parent.chatId)!,
        this.childPrompt(parent, next),
        next.mode,
        next.session!,
        next,
        parent,
        true,
      )
      return
    }
    const children = parent.children.filter((child) => child.kind === 'child')
    if (children.some((child) => child.status === 'running')) return
    const findings = children
      .map((child) => `${child.name} [${child.status}]:\n${child.result ?? 'No result.'}`)
      .join('\n\n')
    const folder = vscode.workspace.workspaceFolders?.[0]
    const runtime = this.runtimes.get(parent.chatId)
    if (!folder || !runtime || parent.children.some((child) => child.kind === 'coordinator')) return
    const coordinator: MultitaskTask = {
      id: crypto.randomUUID(),
      parentId: parent.id,
      name: 'Coordinator',
      text: 'Synthesize child findings and hand the result back to the user.',
      mode: 'ask',
      status: 'waiting',
      currentAction: 'Waiting for child findings',
      kind: 'coordinator',
      createdAt: Date.now(),
      chatId: parent.chatId,
      session: new AgentSession(folder.uri.fsPath, folder.name, new FrontierAssist(() => readConfig().frontierAssist)),
    }
    parent.children.push(coordinator)
    this.multitaskTasks.push(coordinator)
    this.pushMultitaskTasks()
    this.enqueueRun(
      runtime,
      [
        'You are the coordinator for a completed Multitask run.',
        `Original request: ${parent.text}`,
        `Child reports:\n${findings}`,
        'Synthesize one evidence-based final response. Reconcile conflicts, distinguish completed changes from recommendations, list verification, and state any remaining limitations. Do not modify files.',
      ].join('\n\n'),
      'ask',
      coordinator.session!,
      coordinator,
      parent,
      false,
    )
  }

  private enqueueMultitask(text: string, mode: AgentMode): void {
    const trimmed = text.trim()
    if (!trimmed) return
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!folder) {
      this.post({ type: 'error', text: 'Open a folder first — the agent works on a workspace.' })
      return
    }
    const runtime = this.ensureSelectedRuntime(folder)
    const parent: MultitaskParent = {
      id: crypto.randomUUID(),
      text: trimmed,
      mode,
      chatId: runtime.id,
      children: [],
      cancelled: false,
    }
    const assignments = this.childAssignments(this.requestedAgentCount(trimmed))
    parent.children = assignments.map((assignment): MultitaskTask => ({
      id: crypto.randomUUID(),
      parentId: parent.id,
      name: assignment.name,
      text: assignment.focus,
      mode,
      status: 'waiting',
      currentAction: 'Waiting to start',
      kind: 'child',
      createdAt: Date.now(),
      chatId: runtime.id,
      session: new AgentSession(
        folder.uri.fsPath,
        folder.name,
        new FrontierAssist(() => readConfig().frontierAssist),
      ),
    }))
    this.multitaskParents.set(parent.id, parent)
    this.multitaskTasks.push(...parent.children)
    runtime.transcript.push({ role: 'user', text: trimmed })
    void this.saveChat(runtime)
    this.pushMultitaskTasks()
    this.enqueueNextChild(parent)
  }

  private cancelMultitask(id: string): void {
    const task = this.multitaskTasks.find((candidate) => candidate.id === id)
    if (!task || (task.status !== 'waiting' && task.status !== 'running')) return
    const parent = this.multitaskParents.get(task.parentId)
    const queued = this.runQueue.find((request) => request.multitask?.id === id)
    task.status = 'cancelled'
    task.currentAction = 'Stopped'
    task.finishedAt = Date.now()
    if (queued) {
      task.result = 'Cancelled before starting.'
      this.removeQueuedRun(queued)
    }
    if (this.activeRun?.multitask?.id === id) {
      this.activeRun.abort.abort()
      if (readConfig().backend === 'daemon') void this.daemonClient?.cancel()
    }
    if (parent && !parent.cancelled && task.kind === 'child') {
      queueMicrotask(() => this.enqueueNextChild(parent))
    }
    this.pushMultitaskTasks()
  }

  private cancelAllMultitask(): void {
    const selectedChatId = this.selectedChatId
    if (!selectedChatId) return
    const cancellable = this.multitaskTasks.filter(
      (task) =>
        task.chatId === selectedChatId &&
        (task.status === 'waiting' || task.status === 'running'),
    )
    if (cancellable.length === 0) return

    const ids = new Set(cancellable.map((task) => task.id))
    const queuedIds = new Set(
      this.runQueue
        .filter((request) => request.multitask && ids.has(request.multitask.id))
        .map((request) => request.multitask!.id),
    )
    const finishedAt = Date.now()
    for (const task of cancellable) {
      this.multitaskParents.get(task.parentId)!.cancelled = true
      task.status = 'cancelled'
      task.currentAction = 'Stopped'
      task.finishedAt = finishedAt
      if (queuedIds.has(task.id)) task.result = 'Cancelled before starting.'
    }
    for (const request of [...this.runQueue]) {
      if (request.multitask && ids.has(request.multitask.id)) this.removeQueuedRun(request)
    }
    if (this.activeRun?.multitask && ids.has(this.activeRun.multitask.id)) {
      this.activeRun.abort.abort()
      if (readConfig().backend === 'daemon') void this.daemonClient?.cancel()
    }
    this.pushMultitaskTasks()
    this.pushState()
  }

  private steerMultitask(id: string): void {
    const selected = this.multitaskTasks.find((candidate) => candidate.id === id)
    const active = this.activeMultitaskId
      ? this.multitaskTasks.find((candidate) => candidate.id === this.activeMultitaskId)
      : undefined
    if (
      !selected ||
      selected.status !== 'waiting' ||
      !active ||
      active.status !== 'running' ||
      selected.chatId !== active.chatId
    ) return

    const selectedRequestIndex = this.runQueue.findIndex(
      (request) => request.multitask?.id === selected.id,
    )
    if (selectedRequestIndex < 0 || !active.session) return

    // The selected task continues as the same subagent: it inherits all model
    // turns and tool results accumulated by the active task before cancellation.
    selected.session = active.session
    const [selectedRequest] = this.runQueue.splice(selectedRequestIndex, 1)
    selectedRequest.session = active.session
    this.runQueue.unshift(selectedRequest)
    active.status = 'interrupted'
    active.finishedAt = Date.now()
    this.pushMultitaskTasks()

    // Cancellation is asynchronous. The pump remains locked by activeMultitaskId
    // until runTask unwinds, so the one-slot daemon never receives two generations.
    this.activeRun?.abort.abort()
    if (readConfig().backend === 'daemon') void this.daemonClient?.cancel()
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

  /** Manual memory compaction from the composer gauge. No-op while busy. */
  private async compactMemory(): Promise<void> {
    const runtime = this.selectedRuntime()
    if (this.activeRun || this.runQueue.length > 0 || !runtime) return
    const client = this.currentClient()
    if (!client) return
    const cfg = readConfig()
    try {
      await runtime.session.compactNow(
        client,
        { temperature: cfg.agent.temperature, topP: 0.95, maxTokens: cfg.agent.maxTokens },
        {
          onContext: (used, limit) => this.postFor(runtime, { type: 'context', used, limit }),
          onCompaction: (active, saved) => this.postFor(runtime, { type: 'compaction', active, saved }),
        },
        new AbortController().signal,
      )
    } catch (error) {
      this.log(`manual compaction FAILED: ${error instanceof Error ? error.message : String(error)}`)
      this.post({ type: 'compaction', active: false })
    }
  }

  refreshState(): void {
    this.pushState()
  }

  newSession(): void {
    this.selectedChatId = null
    this.post({ type: 'reset' })
    this.pushState()
    this.pushMultitaskTasks()
  }

  stop(): void {
    const selectedId = this.selectedChatId
    if (!selectedId) return
    for (const request of [...this.runQueue]) {
      if (request.runtime.id !== selectedId) continue
      this.removeQueuedRun(request, true)
    }
    if (this.activeRun?.runtime.id === selectedId) {
      this.activeRun.abort.abort()
      if (readConfig().backend === 'daemon') void this.daemonClient?.cancel()
    }
    this.pushState()
  }

  async runTask(
    text: string,
    mode: AgentMode = 'code',
    sessionOverride?: AgentSession,
  ): Promise<boolean> {
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!folder) {
      this.post({ type: 'error', text: 'Open a folder first — the agent works on a workspace.' })
      return false
    }
    if (!this.currentClient()) {
      this.post({ type: 'error', text: 'No backend configured. Check the Trie Coding Agent settings.' })
      return false
    }

    const runtime = this.ensureSelectedRuntime(folder)
    this.enqueueRun(runtime, text, mode, sessionOverride ?? runtime.session)
    return true
  }

  private enqueueRun(
    runtime: ChatRuntime,
    text: string,
    mode: AgentMode,
    session = runtime.session,
    multitask?: MultitaskTask,
    multitaskParent?: MultitaskParent,
    internal = false,
  ): void {
    if (!internal && !multitaskParent) runtime.transcript.push({ role: 'user', text })
    runtime.pendingRuns++
    this.runQueue.push({
      runtime,
      text,
      mode,
      session,
      multitask,
      multitaskParent,
      internal,
      abort: new AbortController(),
    })
    void this.saveChat(runtime)
    this.pushState()
    queueMicrotask(() => this.pumpRuns())
  }

  private removeQueuedRun(request: RunRequest, addStoppedReply = false): void {
    const index = this.runQueue.indexOf(request)
    if (index < 0) return
    this.runQueue.splice(index, 1)
    request.runtime.pendingRuns = Math.max(0, request.runtime.pendingRuns - 1)
    if (addStoppedReply) {
      request.runtime.transcript.push({ role: 'reply', text: 'Stopped.', failed: true })
      this.postFor(request.runtime, { type: 'final', ok: false, text: 'Stopped.' })
    }
    if (request.multitask && request.multitask.status === 'waiting') {
      request.multitask.status = 'cancelled'
      request.multitask.finishedAt = Date.now()
      request.multitask.result = 'Cancelled before starting.'
    }
    void this.saveChat(request.runtime)
  }

  private pumpRuns(): void {
    if (this.activeRun) return
    const request = this.runQueue.shift()
    if (!request) {
      this.pushState()
      return
    }
    this.activeRun = request
    request.runtime.pendingRuns = Math.max(0, request.runtime.pendingRuns - 1)
    if (request.multitask) {
      this.activeMultitaskId = request.multitask.id
      request.multitask.status = 'running'
      request.multitask.currentAction =
        request.multitask.kind === 'coordinator' ? 'Synthesizing child findings' : 'Starting isolated session'
      request.multitask.startedAt = Date.now()
      this.pushMultitaskTasks()
    }
    this.pushState()
    void this.executeRun(request).then(
      (outcome) => this.finishRun(request, outcome),
      (error) =>
        this.finishRun(request, {
          ok: false,
          result: error instanceof Error ? error.message : String(error),
        }),
    )
  }

  private finishRun(request: RunRequest, outcome: RunOutcome): void {
    if (request.multitask) {
      if (request.multitask.status === 'running') {
        request.multitask.status = outcome.ok ? 'completed' : 'failed'
      }
      request.multitask.result = outcome.result
      request.multitask.currentAction =
        request.multitask.status === 'completed' ? 'Completed' :
          request.multitask.status === 'cancelled' ? 'Stopped' : outcome.result
      request.multitask.finishedAt = Date.now()
      this.activeMultitaskId = null
      if (request.multitask.kind === 'coordinator') {
        request.runtime.session = request.session
      }
      this.pushMultitaskTasks()
      if (request.multitaskParent && request.multitask.kind === 'child') {
        queueMicrotask(() => this.enqueueNextChild(request.multitaskParent!))
      }
    }
    if (this.activeRun === request) this.activeRun = null
    this.pushState()
    queueMicrotask(() => this.pumpRuns())
  }

  private async executeRun(request: RunRequest): Promise<RunOutcome> {
    const { runtime, text, mode, session } = request
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!folder) return { ok: false, result: 'No workspace folder is open.' }
    const client = this.currentClient()
    if (!client) return { ok: false, result: 'No model backend is configured.' }
    const cfg = readConfig()

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
          this.postFor(runtime, { type: 'notice', text: 'git not found — changes this turn cannot be reviewed or undone.' })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.log(`checkpoint snapshot FAILED: ${message}`)
        this.postFor(runtime, { type: 'notice', text: `Checkpoint failed (${message.slice(0, 120)}) — changes this turn cannot be undone.` })
      }
    }

    try {
      const result = await session.runTurn(
        text,
        mode,
        client,
        { temperature: cfg.agent.temperature, topP: 0.95, maxTokens: cfg.agent.maxTokens },
        cfg.agent.maxToolCalls,
        {
          onGenerating: (active) => {
            if (!request.multitask || !active) return
            request.multitask.currentAction =
              request.multitask.kind === 'coordinator' ? 'Synthesizing child findings' : 'Thinking'
            this.pushMultitaskTasks()
          },
          onToolCall: (id: number, call: ToolCall, argsSummary: string) => {
            const delta = toolLineDelta(call)
            if (request.multitask) {
              request.multitask.currentAction = formatToolRow(call)
              this.pushMultitaskTasks()
            }
            if (request.internal) return
            this.postFor(runtime, {
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
          onToolResult: (id: number, ok: boolean, summary: string, viaTrie?: boolean, trieMs?: number, scanMs?: number) =>
            request.internal
              ? undefined
              : this.postFor(runtime, { type: 'tool-result', id, ok, summary, viaTrie, trieMs, scanMs }),
          onTodos: (todo: string[], done: string[]) => {
            if (!request.internal) this.postFor(runtime, { type: 'todos', todo, done })
          },
          onHybridChecking: (active, checkpoint) =>
            this.postFor(runtime, { type: 'hybrid-check', active, checkpoint }),
          onHybridPlan: (subtasks, rationale) =>
            this.postFor(runtime, { type: 'hybrid-plan', subtasks, rationale }),
          onContext: (used, limit) => this.postFor(runtime, { type: 'context', used, limit }),
          onCompaction: (active, saved) => this.postFor(runtime, { type: 'compaction', active, saved }),
          onGuideNote: (note: GuideNote) =>
            this.postFor(runtime, { type: 'guide', checkpoint: note.checkpoint, verdict: note.verdict, text: note.text }),
        },
        request.abort.signal,
        checkpointSha && this.shadowRepo
          ? {
              changedFileStats: () => this.shadowRepo!.changedFileStats(checkpointSha),
            }
          : undefined,
      )
      if (result.hybridStats) {
        const h = result.hybridStats
        this.log(
          `hybrid: ${h.frontierCalls} frontier call(s), decomposed=${h.decomposed}, uncertainty=${h.uncertaintyEscalations}, selfGrade=${h.selfGradeConfidence ?? 'n/a'}, evidenceFiles=${h.evidenceChecks}`,
        )
      }
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
      if ((!reviewFiles || reviewFiles.length === 0) && result.mutatedFiles?.length) {
        reviewFiles = result.mutatedFiles
        this.log(`using tool-tracked files (${reviewFiles.length}) — shadow diff was empty`)
      }
      const hasReview = !!(reviewFiles && reviewFiles.length > 0)
      const activeTask = request.multitask
      let finalText =
        activeTask?.status === 'interrupted' && result.summary === 'Stopped.'
          ? 'Interrupted — context handed off to another subagent.'
          : result.summary
      let finalOk = result.ok
      if (result.ok && !hasReview && summaryClaimsFileChanges(result.summary)) {
        finalOk = false
        this.log('summary claims file changes but no diff — flagging reply')
        this.postFor(runtime, {
          type: 'notice',
          text: 'No files were changed this turn. The summary below describes changes that did not happen — check the activity stream for failed or missing edits.',
        })
      }
      if (checkpointSha && hasReview) {
        this.postFor(runtime, { type: 'review', checkpoint: checkpointSha, files: reviewFiles! })
      }
      if (!request.internal) {
        this.postFor(runtime, {
          type: 'final',
          ok: finalOk,
          text: finalText,
          // Card replaces the old restore row; keep it only when stats failed.
          checkpoint: reviewFiles === null ? checkpointSha : undefined,
        })
        runtime.transcript.push({ role: 'reply', text: finalText, failed: !finalOk })
      }
      return { ok: finalOk, result: finalText }
    } catch (error) {
      if (request.abort.signal.aborted) {
        const activeTask = request.multitask
        const stoppedText =
          activeTask?.status === 'interrupted'
            ? 'Interrupted — context handed off to another subagent.'
            : 'Stopped.'
        if (!request.internal) {
          this.postFor(runtime, { type: 'final', ok: false, text: stoppedText, checkpoint: checkpointSha })
          runtime.transcript.push({ role: 'reply', text: stoppedText, failed: true })
        }
        return { ok: false, result: stoppedText }
      } else {
        const message = error instanceof Error ? error.message : String(error)
        this.log(`turn FAILED: ${message}`)
        const friendly = /fetch failed|ECONNREFUSED|ECONNRESET/i.test(message)
          ? `Could not reach the model backend (${message}). The local server may have stopped — check it, then use Connect and retry.`
          : message
        if (!request.internal) {
          this.postFor(runtime, { type: 'error', text: friendly })
          runtime.transcript.push({ role: 'error', text: friendly })
        }
        return { ok: false, result: friendly }
      }
    } finally {
      void this.saveChat(runtime)
    }
  }

  private async saveChat(runtime: ChatRuntime): Promise<void> {
    if (runtime.transcript.length === 0) return
    const firstUser = runtime.transcript.find(
      (entry): entry is { role: 'user'; text: string; failed?: boolean } => entry.role === 'user',
    )
    try {
      await this.store.upsert({
        id: runtime.id,
        title: (firstUser?.text ?? 'Untitled chat').slice(0, 80),
        workspace: runtime.workspace,
        createdAt: runtime.createdAt,
        updatedAt: Date.now(),
        transcript: [...runtime.transcript],
        turns: runtime.session.exportTurns(),
      })
    } catch (error) {
      this.log(`chat save FAILED: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async postHistory(): Promise<void> {
    const current = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''
    const chats = await this.store.list()
    this.post({
      type: 'history',
      chats: chats.map((c) => ({ ...c, current: c.workspace === current })),
    })
  }

  private async openChat(id: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!folder) return
    let runtime = this.runtimes.get(id)
    if (!runtime) {
      const chat = await this.store.get(id)
      if (!chat) return
      runtime = this.createRuntime(folder, chat.id, chat.createdAt, chat.transcript)
      runtime.session.restoreTurns(chat.turns)
      this.restoreMultitaskSnapshot(runtime)
    }
    this.selectedChatId = runtime.id
    this.post({ type: 'chat-loaded', transcript: runtime.transcript })
    this.pushState()
    this.pushMultitaskTasks()
  }

  private async restoreCheckpoint(sha: string): Promise<void> {
    if (this.activeRun) {
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
        {
          const runtime = this.selectedRuntime()
          if (runtime) this.post({ type: 'chat-loaded', transcript: runtime.transcript })
        }
        this.pushState()
        this.pushMultitaskTasks()
        break
      case 'send':
        await this.runTask(message.text, message.mode ?? 'code')
        break
      case 'stop':
        this.stop()
        break
      case 'history':
        await this.postHistory()
        break
      case 'open-chat':
        await this.openChat(message.id)
        break
      case 'delete-chat': {
        const runtime = this.runtimes.get(message.id)
        if (runtime && this.isRuntimeBusy(runtime)) {
          void vscode.window.showInformationMessage('This chat still has queued or running work.')
          break
        }
        await this.store.delete(message.id)
        this.runtimes.delete(message.id)
        if (message.id === this.selectedChatId) {
          // The open chat was deleted — the next turn starts a fresh one.
          this.selectedChatId = null
          this.post({ type: 'reset' })
          this.pushState()
        }
        await this.postHistory()
        break
      }
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
      case 'compact':
        await this.compactMemory()
        break
      case 'set-frontier':
        await setFrontierSelection(message.slot, message.modelIndex)
        this.pushState()
        break
      case 'toggle-hybrid':
        await setHybridEnabled(message.enabled)
        this.pushState()
        break
      case 'multitask-enqueue':
        this.enqueueMultitask(message.text, message.mode ?? 'code')
        break
      case 'multitask-cancel':
        this.cancelMultitask(message.id)
        break
      case 'multitask-cancel-all':
        this.cancelAllMultitask()
        break
      case 'multitask-steer':
        this.steerMultitask(message.id)
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
      <div class="hybrid-anchor">
        <button id="hybrid-chip" class="chip hybrid" type="button" hidden aria-haspopup="true" aria-expanded="false">
          <svg class="hybrid-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/>
            <path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/>
            <path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>
          </svg>
          <span class="hybrid-label">Hybrid</span>
          <span class="hybrid-model-label"></span>
          <span class="hybrid-caret" aria-hidden="true"></span>
        </button>
        <div id="hybrid-menu" class="hybrid-menu" hidden role="menu">
          <label class="hybrid-menu-toggle">
            <input id="hybrid-menu-enabled" type="checkbox" />
            <span>Hybrid mode</span>
          </label>
          <div class="hybrid-menu-divider"></div>
          <div id="hybrid-model-list" class="hybrid-model-list"></div>
        </div>
      </div>
    </div>
    <div id="header-actions">
      <button id="connect-btn" class="ghost header-icon-btn" type="button" title="Connect &amp; load a local model" aria-label="Connect">
        <svg class="header-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 22v-5"/>
          <path d="M9 8V2"/>
          <path d="M15 8V2"/>
          <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>
        </svg>
      </button>
      <button id="settings-btn" class="ghost header-icon-btn" type="button" title="Settings" aria-label="Settings">
        <svg class="header-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </button>
      <button id="history-btn" class="ghost header-icon-btn" type="button" title="Chat history" aria-label="History">
        <svg class="header-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
          <path d="M3 3v5h5"/>
          <path d="M12 7v5l4 2"/>
        </svg>
      </button>
      <button id="new-btn" class="new-chat-btn header-icon-btn" type="button" title="New chat" aria-label="New chat">
        <svg class="header-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 5v14"/>
          <path d="M5 12h14"/>
        </svg>
      </button>
    </div>
  </header>
  <section id="history-view" hidden>
    <div class="hist-head">
      <button id="hist-back" class="ghost" title="Back to chat">←</button>
      <h3>History</h3>
    </div>
    <input id="hist-search" type="text" placeholder="Fuzzy search history…" spellcheck="false" />
    <div class="hist-filters">
      <select id="hist-scope">
        <option value="current">Workspace: Current</option>
        <option value="all">Workspace: All</option>
      </select>
      <select id="hist-sort">
        <option value="newest">Sort: Newest</option>
        <option value="oldest">Sort: Oldest</option>
      </select>
    </div>
    <div id="hist-list"></div>
  </section>
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
          <div><strong>Hybrid mode:</strong> <span class="desc">your local model runs the loop; a frontier model weighs in only when you're stuck or at the finish line. Frontier judgment without paying cloud rates for every file read. Enable in <strong>Settings</strong>.</span></div>
        </li>
      </ul>
    </div>
  </main>
  <footer id="composer">
    <textarea id="input" rows="3" placeholder="Describe a task or ask a question…"></textarea>
    <div id="composer-bottom">
      <div id="composer-left">
        <button id="composer-plus" class="composer-plus" type="button" title="Add modes" aria-label="Add modes" aria-haspopup="true" aria-expanded="false">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
        </button>
        <div id="composer-chips" class="composer-chips"></div>
      </div>
      <div id="composer-actions">
        <button id="ctx-gauge" class="ctx-gauge" hidden></button>
        <button id="undo-btn" class="ghost composer-undo" hidden title="Revert the last turn's file changes">↺ Undo</button>
        <button id="stop-btn" hidden>Stop</button>
        <button id="send-btn">Send</button>
      </div>
    </div>
    <div id="composer-plus-menu" class="composer-plus-menu" hidden role="menu">
      <div class="plus-menu-label">Mode</div>
      <button class="plus-menu-item" type="button" data-pick="plan" role="menuitem">
        <svg class="plus-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 5H3"/><path d="M16 12H3"/><path d="M16 19H3"/><path d="M21 5h.01"/><path d="M21 12h.01"/><path d="M21 19h.01"/></svg>
        <span class="plus-menu-text">Plan</span>
        <span class="plus-menu-check" hidden aria-hidden="true">✓</span>
      </button>
      <button class="plus-menu-item" type="button" data-pick="ask" role="menuitem">
        <svg class="plus-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>
        <span class="plus-menu-text">Ask</span>
        <span class="plus-menu-check" hidden aria-hidden="true">✓</span>
      </button>
      <button class="plus-menu-item" type="button" data-pick="multitask" role="menuitem">
        <svg class="plus-menu-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="6.25" cy="9" r="3.75"/><circle cx="9.75" cy="7" r="3.75"/></svg>
        <span class="plus-menu-text">Multitask</span>
        <span class="plus-menu-check" hidden aria-hidden="true">✓</span>
      </button>
    </div>
  </footer>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}

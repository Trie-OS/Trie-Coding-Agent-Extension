import * as crypto from 'node:crypto'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { readConfig, setFrontierSelection, setHybridEnabled, hybridActiveLabel, isHybridConfigured, listHybridModelOptions } from '../config'
import { ShadowRepo, type ChangedFileStat } from '../agent/checkpoints'
import { FrontierAssist, type GuideNote } from '../agent/frontierAssist'
import { AgentSession, type TurnTelemetry } from '../agent/loop'
import type { PermissionChoice, PermissionRequest } from '../agent/permissionBroker'
import type { QuestionAnswer, UserQuestionPayload } from '../agent/questionBroker'
import { MultitaskBus } from '../agent/multitaskBus'
import type { AgentMode } from '../agent/prompts'
import type { ToolCall } from '../agent/tools'
import { formatToolRow, toolGroupKey, toolLineDelta } from '../agent/tools'
import { summaryClaimsFileChanges } from '../agent/taskIntent'
import { clearScratchpad } from '../agent/scratchpad'
import { WorktreeManager } from '../agent/worktrees'
import { DaemonClient } from '../inference/daemonClient'
import {
  extensionImageAttachmentSupport,
  imageAttachmentsBlockedMessage,
  type ImageAttachmentSupport,
} from '../inference/modelVision'
import { OpenAiCompatibleClient } from '../inference/openaiClient'
import type { ChatTurnImage, InferenceClient } from '../inference/types'
import { ChatStore, type ChatSummary, type TranscriptEntry } from './chatStore'
import { webviewTheme, type WebviewTheme } from '../theme'

const MULTITASK_MAX_CONCURRENCY = 6

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
      imageSupport: ImageAttachmentSupport
      theme: WebviewTheme
      extensionVersion: string
    }
  | { type: 'tool-call'; id: number; tool: string; args: string; rowLabel: string; thought: string; groupKey?: string; linesAdded?: number; linesDeleted?: number }
  | { type: 'reasoning'; chunk?: string; done?: boolean; text?: string; discard?: boolean }
  | { type: 'tool-result'; id: number; ok: boolean; summary: string; viaTrie?: boolean; trieMs?: number; scanMs?: number; detail?: string; userSkipped?: boolean }
  | { type: 'todos'; todo: string[]; done: string[] }
  | { type: 'hybrid-check'; active: boolean; checkpoint?: string }
  | { type: 'hybrid-plan'; subtasks: string[]; rationale?: string }
  | { type: 'guide'; checkpoint: string; verdict: string; text: string }
  | { type: 'context'; used: number; limit: number }
  | { type: 'telemetry'; telemetry: TurnTelemetry }
  | { type: 'compaction'; active: boolean; saved?: number; keptTurns?: number }
  | { type: 'final'; ok: boolean; text: string; checkpoint?: string }
  | { type: 'review'; checkpoint: string; files: ChangedFileStat[] }
  | { type: 'error'; text: string }
  | { type: 'notice'; text: string }
  | { type: 'restored'; sha: string; files: number; conversationRewound?: boolean }
  | { type: 'reset' }
  | { type: 'history'; chats: (ChatSummary & { current: boolean })[] }
  | { type: 'chat-loaded'; transcript: TranscriptEntry[] }
  | { type: 'multitask-list'; tasks: MultitaskTaskView[] }
  | { type: 'question'; requestId: string; questions: UserQuestionPayload[] }
  | { type: 'question-resolved'; requestId: string; answers: QuestionAnswer[] }
  | { type: 'plan-handoff'; id: string; path: string; content: string }
  | { type: 'plan-handoff-resolved'; id: string; action: 'execute' | 'stay' | 'open' }
  | { type: 'permission'; requestId: string; request: PermissionRequest }

const CHECKPOINT_SCHEME = 'trie-checkpoint'

type FromWebview =
  | { type: 'init' }
  | { type: 'send'; text: string; mode?: AgentMode; images?: ChatTurnImage[] }
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
  | { type: 'question-answer'; requestId: string; answers: QuestionAnswer[] }
  | { type: 'question-cancel'; requestId: string }
  | { type: 'plan-handoff-action'; id: string; action: 'execute' | 'stay' | 'open' }
  | { type: 'permission-answer'; requestId: string; choice: PermissionChoice }

type MultitaskStatus = 'waiting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

interface MultitaskTask {
  id: string
  parentId: string
  name: string
  text: string
  mode: AgentMode
  status: MultitaskStatus
  currentAction?: string
  kind: 'child' | 'coordinator' | 'integrator'
  createdAt: number
  startedAt?: number
  finishedAt?: number
  result?: string
  session?: AgentSession
  chatId: string
  worktreePath?: string
  worktreeBranch?: string
}

type MultitaskTaskView = Omit<MultitaskTask, 'session'>

interface MultitaskParent {
  id: string
  text: string
  mode: AgentMode
  chatId: string
  children: MultitaskTask[]
  cancelled: boolean
  bus?: MultitaskBus
  worktrees?: WorktreeManager
  integrateSummary?: string
  concurrencyNote?: string
  finalizing?: boolean
}

/** File + conversation rewind point captured with each turn checkpoint. */
interface CheckpointBookmark {
  turnsLen: number
  transcriptLen: number
  chatId: string
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
  images?: ChatTurnImage[]
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
  private readonly activeRuns = new Map<string, RunRequest>()
  private readonly multitaskTasks: MultitaskTask[] = []
  private readonly multitaskParents = new Map<string, MultitaskParent>()
  /** checkpoint sha → rewind boundary for files + conversation */
  private readonly checkpointBookmarks = new Map<string, CheckpointBookmark>()
  private readonly pendingQuestions = new Map<
    string,
    { resolve: (answers: QuestionAnswer[] | null) => void }
  >()
  private readonly pendingPlanHandoffs = new Map<
    string,
    { resolve: (decision: 'execute' | 'stay') => void; path: string }
  >()
  private readonly pendingPermissions = new Map<
    string,
    { resolve: (choice: PermissionChoice | null) => void }
  >()

  private log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`)
  }

  /** Set by the connect command so the status line can show the model. */
  daemonClient: DaemonClient | null = null

  constructor(
    private readonly extensionUri: vscode.Uri,
    storageUri: vscode.Uri,
    private readonly onStatusChanged: (label: string) => void,
    private readonly getDaemonClient?: () => DaemonClient,
    private readonly extensionVersion = 'unknown',
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
    const session = new AgentSession(
      folder.uri.fsPath,
      folder.name,
      new FrontierAssist(() => readConfig().frontierAssist),
    )
    session.setSessionId(id)
    const runtime: ChatRuntime = {
      id,
      createdAt,
      workspace: folder.uri.fsPath,
      transcript: [...transcript],
      session,
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
    if (!runtime) return false
    if (runtime.pendingRuns > 0) return true
    for (const request of this.activeRuns.values()) {
      if (request.runtime.id === runtime.id) return true
    }
    return false
  }

  private maxRunConcurrency(): number {
    return readConfig().backend === 'daemon' ? 1 : MULTITASK_MAX_CONCURRENCY
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
      case 'reasoning':
      case 'todos':
      case 'hybrid-check':
      case 'hybrid-plan':
      case 'guide':
      case 'context':
      case 'compaction':
      case 'review':
      case 'notice':
      case 'multitask-list':
      case 'question':
      case 'question-resolved':
      case 'plan-handoff':
      case 'plan-handoff-resolved':
        return true
      default:
        return false
    }
  }

  private post(message: ToWebview): void {
    void this.view?.webview.postMessage(message)
  }

  private requestQuestion(
    runtime: ChatRuntime,
    requestId: string,
    questions: UserQuestionPayload[],
  ): Promise<QuestionAnswer[] | null> {
    return new Promise((resolve) => {
      this.pendingQuestions.set(requestId, { resolve })
      this.postFor(runtime, { type: 'question', requestId, questions })
    })
  }

  private requestPlanHandoff(
    runtime: ChatRuntime,
    payload: { path: string; content: string },
  ): Promise<'execute' | 'stay'> {
    const id = crypto.randomUUID()
    return new Promise((resolve) => {
      this.pendingPlanHandoffs.set(id, { resolve, path: payload.path })
      this.postFor(runtime, { type: 'plan-handoff', id, path: payload.path, content: payload.content })
    })
  }

  private requestPermission(
    runtime: ChatRuntime,
    requestId: string,
    request: PermissionRequest,
  ): Promise<PermissionChoice | null> {
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, { resolve })
      this.postFor(runtime, { type: 'permission', requestId, request })
    })
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
    const imageSupport = extensionImageAttachmentSupport(
      cfg.backend,
      cfg.backend === 'daemon' ? this.daemonClient?.loadedModel() ?? null : null,
    )
    this.post({
      type: 'state',
      backend: cfg.backend === 'daemon' ? 'Trie IDE daemon' : 'LLM API',
      model: ready ? model : '',
      hybridEnabled: fa.enabled && isHybridConfigured(fa),
      hybridActiveLabel: hybridActiveLabel(fa),
      hybridModels,
      busy: this.isRuntimeBusy(selected),
      workElsewhere,
      imageSupport,
      theme: webviewTheme(),
      extensionVersion: this.extensionVersion,
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
      'Map architecture, entry points, and ownership. Prefer read/analysis; claim interface files before light edits. Post findings on the sibling bus immediately.',
      'Implement or fix core logic. Claim paths before editing; read sibling findings via read_sibling_updates; do not wait for Architecture to finish.',
      'Audit edge cases and verification. Prefer claiming/editing tests; challenge sibling claims with concrete evidence from the bus.',
      'Trace integration boundaries for regressions. Coordinate via the bus; claim only paths you will change.',
      'Adversarially challenge the highest-risk sibling findings with independent evidence. Prefer read-only unless a small proof edit is needed.',
      'Review validation/build/release gaps. Claim CI/config paths only when necessary; post release risks on the bus.',
    ]
    return Array.from({ length: count }, (_, index) => ({
      name: `Agent ${index + 1} · ${['Architecture', 'Implementation', 'Verification', 'Integration', 'Adversarial review', 'Release'][index]}`,
      focus: `${focuses[index]} Work in parallel with siblings; communicate via post_finding / claim_paths / read_sibling_updates.`,
    }))
  }

  private childPrompt(parent: MultitaskParent, child: MultitaskTask): string {
    const siblings = parent.children
      .filter((candidate) => candidate.kind === 'child' && candidate.id !== child.id)
      .map((candidate) => candidate.name)
    const busDigest = parent.bus?.digest() ?? 'No sibling bus.'
    return [
      `You are ${child.name}, one parallel child in a coordinated Multitask run.`,
      `Parent request: ${parent.text}`,
      `Your assigned focus: ${child.text}`,
      child.worktreeBranch
        ? `Your isolated git worktree branch: ${child.worktreeBranch}. Edits stay local until integration merges sibling branches.`
        : 'You share the primary workspace in read-oriented mode — avoid conflicting edits; use the sibling bus.',
      siblings.length ? `Sibling agents running in parallel: ${siblings.join(', ')}` : 'You are the sole child agent.',
      parent.concurrencyNote ? `Runtime note: ${parent.concurrencyNote}` : '',
      `Sibling bus digest:\n${busDigest}`,
      'Do not wait for siblings to finish. Claim paths before mutating them. Finish with a concise structured report: scope, evidence (paths/symbols), findings or changes, verification, and handoff notes.',
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  private enqueueMultitask(text: string, mode: AgentMode): void {
    void this.startMultitask(text, mode)
  }

  private async startMultitask(text: string, mode: AgentMode): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!folder) {
      this.post({ type: 'error', text: 'Open a folder first — the agent works on a workspace.' })
      return
    }
    if (!this.currentClient()) {
      this.post({ type: 'error', text: 'No backend configured. Check the Trie Coding Agent settings.' })
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
      bus: new MultitaskBus(),
    }

    const daemonSerial = readConfig().backend === 'daemon'
    parent.concurrencyNote = daemonSerial
      ? 'Embedded daemon is single-flight — agents are isolated in worktrees but model turns run one at a time.'
      : 'API/hybrid backend — sibling agents run concurrently.'

    const assignments = this.childAssignments(this.requestedAgentCount(trimmed))
    // A single child can edit the primary tree; isolation is for parallel siblings.
    const needsWorktrees = mode === 'code' && assignments.length > 1
    let worktrees: WorktreeManager | undefined

    if (needsWorktrees) {
      const repoRoot = await WorktreeManager.resolveRepoRoot(folder.uri.fsPath)
      if (!repoRoot) {
        this.post({
          type: 'error',
          text: 'Parallel Multitask with edits requires a git repository. Open a git workspace or use Ask/Plan mode.',
        })
        return
      }
      worktrees = new WorktreeManager(repoRoot, parent.id)
      try {
        await worktrees.prepare()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.post({ type: 'error', text: `Could not start parallel Multitask: ${message}` })
        return
      }
      parent.worktrees = worktrees
    }

    try {
      parent.children = []
      for (const assignment of assignments) {
        const id = crypto.randomUUID()
        let root = folder.uri.fsPath
        let branch: string | undefined
        if (worktrees) {
          const childWt = await worktrees.createChild(id, assignment.name)
          root = childWt.path
          branch = childWt.branch
        }
        const session = new AgentSession(
          root,
          folder.name,
          new FrontierAssist(() => readConfig().frontierAssist),
        )
        const child: MultitaskTask = {
          id,
          parentId: parent.id,
          name: assignment.name,
          text: assignment.focus,
          mode,
          status: 'waiting',
          currentAction: branch ? `Ready on ${branch}` : 'Waiting to start',
          kind: 'child',
          createdAt: Date.now(),
          chatId: runtime.id,
          session,
          worktreePath: worktrees ? root : undefined,
          worktreeBranch: branch,
        }
        session.configureMultitask({
          agentId: child.id,
          agentName: child.name,
          bus: parent.bus!,
          skipDecompose: true,
          onBusActivity: (summary) => {
            if (child.status !== 'running') return
            child.currentAction = summary
            this.pushMultitaskTasks()
          },
        })
        parent.children.push(child)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await worktrees?.cleanup(true).catch(() => undefined)
      this.post({ type: 'error', text: `Failed to provision Multitask worktrees: ${message}` })
      return
    }

    this.multitaskParents.set(parent.id, parent)
    this.multitaskTasks.push(...parent.children)
    runtime.transcript.push({ role: 'user', text: trimmed })
    if (parent.concurrencyNote && daemonSerial) {
      this.postFor(runtime, { type: 'notice', text: parent.concurrencyNote })
    }
    void this.saveChat(runtime)
    this.pushMultitaskTasks()

    // Enqueue every child up front — pumpRuns starts them up to max concurrency.
    for (const child of parent.children) {
      this.enqueueRun(
        runtime,
        this.childPrompt(parent, child),
        child.mode,
        child.session!,
        child,
        parent,
        true,
      )
    }
  }

  private async onMultitaskChildFinished(parent: MultitaskParent): Promise<void> {
    if (parent.cancelled || parent.finalizing) return
    const children = parent.children.filter((child) => child.kind === 'child')
    if (children.some((child) => child.status === 'waiting' || child.status === 'running')) return
    if (parent.children.some((child) => child.kind === 'coordinator' || child.kind === 'integrator')) {
      return
    }

    parent.finalizing = true
    const runtime = this.runtimes.get(parent.chatId)
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!runtime || !folder) {
      parent.finalizing = false
      return
    }

    if (parent.worktrees) {
      for (const child of children) {
        try {
          await parent.worktrees.commitChild(child.id, `Multitask: ${child.name}`)
          const diff = await parent.worktrees.collectDiff(child.id)
          if (diff) {
            child.result = [child.result?.trim(), `Diff vs base:\n${diff}`].filter(Boolean).join('\n\n')
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.log(`multitask commit ${child.name} FAILED: ${message}`)
        }
      }

      const integrate = await parent.worktrees.integrate(children.map((child) => child.id))
      parent.integrateSummary = integrate.summary
      const integrator: MultitaskTask = {
        id: crypto.randomUUID(),
        parentId: parent.id,
        name: 'Integrator',
        text: 'Merge sibling worktree branches into the primary workspace.',
        mode: 'ask',
        status: integrate.ok ? 'completed' : 'failed',
        currentAction: integrate.ok ? 'Merged' : 'Merge conflicts',
        kind: 'integrator',
        createdAt: Date.now(),
        startedAt: Date.now(),
        finishedAt: Date.now(),
        result: integrate.summary,
        chatId: parent.chatId,
      }
      parent.children.push(integrator)
      this.multitaskTasks.push(integrator)
      this.pushMultitaskTasks()
      this.postFor(runtime, {
        type: 'notice',
        text: integrate.summary,
      })
      await parent.worktrees.cleanup(integrate.ok).catch((error) => {
        this.log(`multitask worktree cleanup FAILED: ${error instanceof Error ? error.message : String(error)}`)
      })
      parent.worktrees = undefined
    }

    const findings = children
      .map((child) => `${child.name} [${child.status}]:\n${child.result ?? 'No result.'}`)
      .join('\n\n')
    const busDigest = parent.bus?.digest(40) ?? ''
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
      session: new AgentSession(
        folder.uri.fsPath,
        folder.name,
        new FrontierAssist(() => readConfig().frontierAssist),
      ),
    }
    parent.children.push(coordinator)
    this.multitaskTasks.push(coordinator)
    this.pushMultitaskTasks()
    this.enqueueRun(
      runtime,
      [
        'You are the coordinator for a completed Multitask run.',
        `Original request: ${parent.text}`,
        parent.integrateSummary ? `Integration result:\n${parent.integrateSummary}` : '',
        busDigest ? `Sibling bus digest:\n${busDigest}` : '',
        `Child reports:\n${findings}`,
        'Synthesize one evidence-based final response. Reconcile conflicts, distinguish completed changes from recommendations, list verification, and state any remaining limitations. Do not modify files.',
      ]
        .filter(Boolean)
        .join('\n\n'),
      'ask',
      coordinator.session!,
      coordinator,
      parent,
      false,
    )
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
    const active = this.activeRuns.get(id)
    if (active) {
      active.abort.abort()
      if (readConfig().backend === 'daemon') void this.daemonClient?.cancel()
    }
    if (parent && !parent.cancelled && task.kind === 'child') {
      queueMicrotask(() => void this.onMultitaskChildFinished(parent))
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
    const parents = new Set<MultitaskParent>()
    for (const task of cancellable) {
      const parent = this.multitaskParents.get(task.parentId)
      if (parent) {
        parent.cancelled = true
        parents.add(parent)
      }
      task.status = 'cancelled'
      task.currentAction = 'Stopped'
      task.finishedAt = finishedAt
      if (queuedIds.has(task.id)) task.result = 'Cancelled before starting.'
    }
    for (const request of [...this.runQueue]) {
      if (request.multitask && ids.has(request.multitask.id)) this.removeQueuedRun(request)
    }
    let abortedDaemon = false
    for (const request of [...this.activeRuns.values()]) {
      if (!request.multitask || !ids.has(request.multitask.id)) continue
      request.abort.abort()
      if (!abortedDaemon && readConfig().backend === 'daemon') {
        abortedDaemon = true
        void this.daemonClient?.cancel()
      }
    }
    for (const parent of parents) {
      void parent.worktrees?.cleanup(false).catch(() => undefined)
      parent.worktrees = undefined
    }
    this.pushMultitaskTasks()
    this.pushState()
  }

  private steerMultitask(id: string): void {
    const selected = this.multitaskTasks.find((candidate) => candidate.id === id)
    if (!selected || selected.status !== 'waiting') return

    const activeRequest = [...this.activeRuns.values()].find(
      (request) =>
        request.multitask &&
        request.multitask.status === 'running' &&
        request.multitask.chatId === selected.chatId,
    )
    const active = activeRequest?.multitask
    if (!active || !active.session) return

    const selectedRequestIndex = this.runQueue.findIndex(
      (request) => request.multitask?.id === selected.id,
    )
    if (selectedRequestIndex < 0) return

    // The selected task continues as the same subagent: it inherits all model
    // turns and tool results accumulated by the active task before cancellation.
    selected.session = active.session
    selected.worktreePath = active.worktreePath
    selected.worktreeBranch = active.worktreeBranch
    const [selectedRequest] = this.runQueue.splice(selectedRequestIndex, 1)
    selectedRequest.session = active.session
    this.runQueue.unshift(selectedRequest)
    active.status = 'interrupted'
    active.finishedAt = Date.now()
    this.pushMultitaskTasks()

    activeRequest.abort.abort()
    if (readConfig().backend === 'daemon') void this.daemonClient?.cancel()
  }

  private currentClient(): InferenceClient | null {
    const cfg = readConfig()
    if (cfg.backend === 'daemon') {
      this.daemonClient ??= this.getDaemonClient?.() ?? new DaemonClient(cfg.daemon.url)
      return this.daemonClient
    }
    if (!cfg.api.modelName && !cfg.api.baseUrl) return null
    return new OpenAiCompatibleClient(cfg.api.baseUrl, cfg.api.modelName, cfg.api.apiKey)
  }

  /** Manual memory compaction from the composer gauge. No-op while busy. */
  private async compactMemory(): Promise<void> {
    const runtime = this.selectedRuntime()
    if (this.activeRuns.size > 0 || this.runQueue.length > 0 || !runtime) return
    const client = this.currentClient()
    if (!client) return
    const cfg = readConfig()
    try {
      await runtime.session.compactNow(
        client,
        { temperature: cfg.agent.temperature, topP: 0.95, maxTokens: cfg.agent.maxTokens },
        {
          onContext: (used, limit) => this.postFor(runtime, { type: 'context', used, limit }),
          onCompaction: (active, saved, keptTurns) =>
            this.postFor(runtime, { type: 'compaction', active, saved, keptTurns }),
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
    let abortedDaemon = false
    for (const request of [...this.activeRuns.values()]) {
      if (request.runtime.id !== selectedId) continue
      request.abort.abort()
      if (!abortedDaemon && readConfig().backend === 'daemon') {
        abortedDaemon = true
        void this.daemonClient?.cancel()
      }
    }
    this.pushState()
  }

  async runTask(
    text: string,
    mode: AgentMode = 'code',
    sessionOverride?: AgentSession,
    images?: ChatTurnImage[],
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

    const cfg = readConfig()
    const blocked = imageAttachmentsBlockedMessage(
      cfg.backend,
      cfg.backend === 'daemon' ? this.daemonClient?.loadedModel() ?? null : null,
      images?.length ?? 0,
    )
    if (blocked) {
      this.post({ type: 'error', text: blocked })
      return false
    }

    const runtime = this.ensureSelectedRuntime(folder)
    this.enqueueRun(runtime, text, mode, sessionOverride ?? runtime.session, undefined, undefined, false, images)
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
    images?: ChatTurnImage[],
  ): void {
    if (!internal && !multitaskParent) {
      runtime.transcript.push({
        role: 'user',
        text,
        ...(images?.length ? { imageNames: images.map((_, index) => `image-${index + 1}`) } : {}),
      })
    }
    runtime.pendingRuns++
    this.runQueue.push({
      runtime,
      text,
      mode,
      session,
      images,
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
    const limit = this.maxRunConcurrency()
    while (this.activeRuns.size < limit && this.runQueue.length > 0) {
      const request = this.runQueue.shift()
      if (!request) break
      const key = request.multitask?.id ?? crypto.randomUUID()
      this.activeRuns.set(key, request)
      request.runtime.pendingRuns = Math.max(0, request.runtime.pendingRuns - 1)
      if (request.multitask) {
        request.multitask.status = 'running'
        request.multitask.currentAction =
          request.multitask.kind === 'coordinator'
            ? 'Synthesizing child findings'
            : request.multitask.worktreeBranch
              ? `Starting on ${request.multitask.worktreeBranch}`
              : 'Starting isolated session'
        request.multitask.startedAt = Date.now()
        this.pushMultitaskTasks()
      }
      void this.executeRun(request).then(
        (outcome) => this.finishRun(key, request, outcome),
        (error) =>
          this.finishRun(key, request, {
            ok: false,
            result: error instanceof Error ? error.message : String(error),
          }),
      )
    }
    this.pushState()
  }

  private finishRun(key: string, request: RunRequest, outcome: RunOutcome): void {
    if (request.multitask) {
      if (request.multitask.status === 'running') {
        request.multitask.status = outcome.ok ? 'completed' : 'failed'
      }
      request.multitask.result = outcome.result
      request.multitask.currentAction =
        request.multitask.status === 'completed' ? 'Completed' :
          request.multitask.status === 'cancelled' ? 'Stopped' :
            request.multitask.status === 'interrupted' ? 'Interrupted' : outcome.result
      request.multitask.finishedAt = Date.now()
      if (request.multitask.kind === 'coordinator') {
        request.runtime.session = request.session
      }
      this.pushMultitaskTasks()
      if (request.multitaskParent && request.multitask.kind === 'child') {
        queueMicrotask(() => void this.onMultitaskChildFinished(request.multitaskParent!))
      }
    }
    if (this.activeRuns.get(key) === request) this.activeRuns.delete(key)
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
    // Multitask children checkpoint their isolated worktree, not the primary root.
    let checkpointSha: string | undefined
    let turnShadow: ShadowRepo | null = null
    if (mode === 'code') {
      try {
        const checkpointRoot = session.workspaceRoot
        turnShadow =
          checkpointRoot === folder.uri.fsPath
            ? (this.shadowRepo ??= new ShadowRepo(folder.uri.fsPath))
            : new ShadowRepo(checkpointRoot)
        if (await turnShadow.isGitAvailable()) {
          checkpointSha = await turnShadow.snapshot(`before: ${text.slice(0, 72)}`)
          this.log(`checkpoint ${checkpointSha.slice(0, 8)} taken for: ${text.slice(0, 60)}`)
          // Capture rewind boundary before runTurn mutates model history.
          // Transcript already includes this turn's user bubble (enqueueRun).
          if (!request.internal && !request.multitask) {
            this.checkpointBookmarks.set(checkpointSha, {
              turnsLen: session.exportTurns().length,
              transcriptLen: Math.max(0, runtime.transcript.length - 1),
              chatId: runtime.id,
            })
          }
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

    let pendingReasoning: string | undefined
    try {
      session.questionBroker.setHandler((requestId, questions) =>
        this.requestQuestion(runtime, requestId, questions),
      )
      session.permissionBroker.setHandler((requestId, request) =>
        this.requestPermission(runtime, requestId, request),
      )
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
          onReasoningChunk: (text) => {
            if (request.internal) return
            this.post({ type: 'reasoning', chunk: text })
          },
          onReasoningDone: (text) => {
            if (request.internal) return
            pendingReasoning = text?.trim() || undefined
          },
          onReasoningOutcome: (accepted) => {
            if (request.internal) return
            if (accepted && pendingReasoning) {
              this.postFor(runtime, {
                type: 'reasoning',
                done: true,
                text: pendingReasoning,
              })
            } else {
              this.post({ type: 'reasoning', done: true, discard: true })
            }
            pendingReasoning = undefined
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
          onToolResult: (
            id: number,
            ok: boolean,
            summary: string,
            viaTrie?: boolean,
            trieMs?: number,
            scanMs?: number,
            detail?: string,
            userSkipped?: boolean,
          ) =>
            request.internal
              ? undefined
              : this.postFor(runtime, {
                  type: 'tool-result',
                  id,
                  ok,
                  summary,
                  viaTrie,
                  trieMs,
                  scanMs,
                  detail,
                  userSkipped,
                }),
          onTodos: (todo: string[], done: string[]) => {
            if (!request.internal) this.postFor(runtime, { type: 'todos', todo, done })
          },
          onHybridChecking: (active, checkpoint) =>
            this.postFor(runtime, { type: 'hybrid-check', active, checkpoint }),
          onHybridPlan: (subtasks, rationale) =>
            this.postFor(runtime, { type: 'hybrid-plan', subtasks, rationale }),
          onContext: (used, limit) => this.postFor(runtime, { type: 'context', used, limit }),
          onTelemetry: (telemetry) =>
            this.post({ type: 'telemetry', telemetry }),
          onCompaction: (active, saved, keptTurns) =>
            this.postFor(runtime, { type: 'compaction', active, saved, keptTurns }),
          onGuideNote: (note: GuideNote) =>
            this.postFor(runtime, { type: 'guide', checkpoint: note.checkpoint, verdict: note.verdict, text: note.text }),
          onPlanHandoff: (payload) => this.requestPlanHandoff(runtime, payload),
        },
        request.abort.signal,
        checkpointSha && turnShadow
          ? {
              changedFileStats: () => turnShadow!.changedFileStats(checkpointSha),
            }
          : undefined,
        request.images,
      )
      if (result.hybridStats) {
        const h = result.hybridStats
        this.log(
          `hybrid: ${h.frontierCalls} frontier call(s), decomposed=${h.decomposed}, uncertainty=${h.uncertaintyEscalations}, selfGrade=${h.selfGradeConfidence ?? 'n/a'}, evidenceFiles=${h.evidenceChecks}`,
        )
      }
      if (result.planExecute && !request.internal) {
        const { path: planPath, content: planContent } = result.planExecute
        this.postFor(runtime, {
          type: 'final',
          ok: true,
          text: result.summary,
        })
        runtime.transcript.push({ role: 'reply', text: result.summary, failed: false })
        const implText = `Implement the approved plan at ${planPath}:\n\n${planContent}`
        this.enqueueRun(runtime, implText, 'code', runtime.session, undefined, undefined, false)
        return { ok: true, result: result.summary }
      }
      // Cursor-style review card: per-file stats vs the checkpoint, with
      // Keep/Undo. Falls back to the plain restore button if stats fail.
      let reviewFiles: ChangedFileStat[] | null = null
      if (checkpointSha && turnShadow) {
        try {
          reviewFiles = await turnShadow.changedFileStats(checkpointSha)
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
      session.questionBroker.setHandler(null)
      session.permissionBroker.setHandler(null)
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
    if (this.activeRuns.size > 0) {
      void vscode.window.showInformationMessage('Stop the agent before restoring a checkpoint.')
      return
    }
    if (!this.shadowRepo) return
    const bookmark = this.checkpointBookmarks.get(sha)
    const choice = await vscode.window.showWarningMessage(
      bookmark
        ? `Undo this turn? Files will revert to checkpoint ${sha.slice(0, 8)} and the conversation will rewind to before the turn.`
        : `Restore the workspace to the checkpoint taken before this turn? Files changed since (checkpoint ${sha.slice(0, 8)}) will be reverted.`,
      { modal: true },
      'Undo turn',
    )
    if (choice !== 'Undo turn') return
    try {
      const changed = await this.shadowRepo.changedPaths(sha)
      await this.shadowRepo.restore(sha)
      let conversationRewound = false
      if (bookmark) {
        const runtime = this.runtimes.get(bookmark.chatId) ?? this.selectedRuntime()
        if (runtime) {
          runtime.session.rewindTurns(bookmark.turnsLen)
          runtime.transcript = runtime.transcript.slice(0, bookmark.transcriptLen)
          conversationRewound = true
          void this.saveChat(runtime)
          if (runtime.id === this.selectedChatId) {
            this.post({ type: 'chat-loaded', transcript: runtime.transcript })
          }
        }
        this.checkpointBookmarks.delete(sha)
      }
      this.post({ type: 'restored', sha, files: changed.length, conversationRewound })
      void vscode.window.showInformationMessage(
        conversationRewound
          ? `Undid turn ${sha.slice(0, 8)} (${changed.length} file${changed.length === 1 ? '' : 's'} reverted; conversation rewound).`
          : `Restored checkpoint ${sha.slice(0, 8)} (${changed.length} file${changed.length === 1 ? '' : 's'} reverted).`,
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
        await this.runTask(message.text, message.mode ?? 'code', undefined, message.images)
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
        const folder = vscode.workspace.workspaceFolders?.[0]
        if (folder) clearScratchpad(folder.uri.fsPath, message.id)
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
      case 'question-answer': {
        const pending = this.pendingQuestions.get(message.requestId)
        if (pending) {
          this.pendingQuestions.delete(message.requestId)
          pending.resolve(message.answers)
          const runtime = this.selectedRuntime()
          if (runtime) {
            this.postFor(runtime, {
              type: 'question-resolved',
              requestId: message.requestId,
              answers: message.answers,
            })
          }
        }
        break
      }
      case 'question-cancel': {
        const pending = this.pendingQuestions.get(message.requestId)
        if (pending) {
          this.pendingQuestions.delete(message.requestId)
          pending.resolve(null)
        }
        break
      }
      case 'plan-handoff-action': {
        const handoff = this.pendingPlanHandoffs.get(message.id)
        if (!handoff) break
        if (message.action === 'open') {
          const folder = vscode.workspace.workspaceFolders?.[0]
          if (folder) {
            const uri = vscode.Uri.joinPath(folder.uri, handoff.path)
            void vscode.window.showTextDocument(uri)
          }
          break
        }
        this.pendingPlanHandoffs.delete(message.id)
        handoff.resolve(message.action === 'execute' ? 'execute' : 'stay')
        const runtime = this.selectedRuntime()
        if (runtime) {
          this.postFor(runtime, {
            type: 'plan-handoff-resolved',
            id: message.id,
            action: message.action,
          })
        }
        break
      }
      case 'permission-answer': {
        const pending = this.pendingPermissions.get(message.requestId)
        if (pending) {
          this.pendingPermissions.delete(message.requestId)
          pending.resolve(message.choice)
        }
        break
      }
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
    #header, #messages, #composer, #todos { background: inherit; }
  </style>
  <link href="${styleUri}" rel="stylesheet" />
</head>
<body>
  <header id="header">
    <div id="status">
      <span id="version-label" class="version-label"></span>
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
  <div id="turn-telemetry" class="turn-telemetry" hidden></div>
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
    <div id="image-attachment-chips" class="image-attachment-chips" hidden></div>
    <div id="image-drop-overlay" class="image-drop-overlay" hidden aria-hidden="true">
      <span>Drop images to attach</span>
    </div>
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
      <div class="plus-menu-label">Attach</div>
      <button class="plus-menu-item" type="button" data-pick="attach-image" role="menuitem">
        <svg class="plus-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
        <span>Image…</span>
      </button>
      <div class="plus-menu-divider"></div>
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
    <input id="image-file-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden />
  </footer>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}

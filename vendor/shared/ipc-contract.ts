/**
 * The single source of truth for all IPC channels between renderer and main.
 *
 * Every channel is declared here with zod schemas for its request and response
 * payloads. Preload and main both import this module, so a schema change is a
 * compile error on both sides (ARCHITECTURE.md — IPC contract).
 *
 * Validation policy (fail loudly, never fall back):
 * - preload validates the request before sending and the response after receiving
 * - main validates the request on arrival and the response before returning
 * Any mismatch throws an `IpcValidationError` — there is no coercion and no
 * best-effort pass-through.
 */
import { z } from 'zod'
import { conversationSchema, messageSchema, chatSearchHitSchema } from './chat'
import { subagentRunSchema } from './subagent'
import { contextRefInputSchema, imageAttachmentInputSchema, symbolHitSchema, truncationReportSchema } from './context'
import {
  apiProviderSettingsSchema,
  appSettingsSchema,
  frontierAssistSettingsSchema,
  mlxProviderSettingsSchema,
  webSearchSettingsSchema,
} from './appSettings'
import { guideNoteSchema } from './guideNote'
import { remoteHostAuthKindSchema, remoteHostSchema } from './remote'
import { generationParamsSchema, inferenceStatusSchema } from './inference'
import {
  checkCommandSchema,
  execModes,
  planArtifactSchema,
  planSchema,
  planStepRowSchema,
  toolCallRecordSchema,
} from './agent'

// zod v4 compiles schemas with `new Function` by default. The renderer's CSP
// (script-src 'self', no 'unsafe-eval') forbids code generation from strings,
// which would make every parse in the preload world throw
// "Code generation from strings disallowed for this context". jitless mode
// keeps validation CSP-safe everywhere this module runs (preload and main).
z.config({ jitless: true })

/** A `workspaces` row over the wire (DATA-MODEL.md). */
export const workspaceSchema = z.object({
  id: z.uuid(),
  rootPath: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.number().int().positive(),
  lastOpenedAt: z.number().int().positive(),
  /** Opaque JSON settings blob; the renderer owns the shape of each key. */
  settings: z.record(z.string(), z.unknown()),
})

export type Workspace = z.infer<typeof workspaceSchema>

/**
 * Workspace-relative path. Always POSIX separators over the wire; '' means
 * the workspace root itself (only valid where documented). Main re-validates
 * confinement on every call — this schema is just shape.
 */
const relPathSchema = z.string()

/**
 * When `agent`, fs paths are relative to the active repo root (see
 * workspaceSettings.activeRepoPath). Omitted or `workspace` keeps
 * workspace-relative paths.
 */
const fsScopeSchema = z.enum(['workspace', 'agent']).optional()

/** A single directory entry (fs:list). */
export const fsEntrySchema = z.object({
  name: z.string().min(1),
  relPath: z.string().min(1),
  kind: z.enum(['file', 'dir']),
})

export type FsEntry = z.infer<typeof fsEntrySchema>

/** A `model_stores` row over the wire, plus a derived `mounted` flag. */
export const modelStoreSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(['external_drive', 'internal_folder', 'remote_host', 'scanned_folder', 'api', 'mlx']),
  volumeHint: z.string().nullable(),
  remoteHostId: z.string().nullable().optional(),
  remotePath: z.string().nullable().optional(),
  remoteHostName: z.string().nullable().optional(),
  readMbps: z.number().nullable(),
  lastSeenAt: z.number().nullable(),
  mounted: z.boolean(),
})
export type ModelStore = z.infer<typeof modelStoreSchema>

/** A `models` row over the wire (DATA-MODEL.md / MODELS.md). */
export const modelSchema = z.object({
  id: z.string().min(1),
  storeId: z.string().min(1),
  displayName: z.string().min(1),
  hfRepoId: z.string().nullable(),
  hfFile: z.string().nullable(),
  quant: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string(),
  arch: z.string().nullable(),
  paramsB: z.number().nullable(),
  ctxLen: z.number().int().positive().nullable(),
  chatTemplate: z.string().nullable(),
  /** Heuristic from arch + repo/file/display names (see modelVision.ts). */
  supportsVision: z.boolean(),
  status: z.enum(['available', 'offline', 'downloading', 'failed']),
  addedAt: z.number().int().positive(),
  lastUsedAt: z.number().nullable(),
})
export type Model = z.infer<typeof modelSchema>

export const downloadSchema = z.object({
  id: z.string().min(1),
  modelId: z.string().min(1),
  partIndex: z.number().int().nonnegative(),
  totalBytes: z.number().nonnegative(),
  doneBytes: z.number().nonnegative(),
  status: z.enum(['queued', 'active', 'paused', 'verifying', 'done', 'failed_corrupt', 'failed']),
  error: z.string().nullable(),
})
export type Download = z.infer<typeof downloadSchema>

export const volumeSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  isStore: z.boolean(),
})
export type Volume = z.infer<typeof volumeSchema>

/** One skipped file/dir during a folder scan, with why (fail-loudly — never a silent omission). */
export const scanWarningSchema = z.object({
  path: z.string().min(1),
  reason: z.string().min(1),
})
export type ScanWarning = z.infer<typeof scanWarningSchema>

/** Result of scanning (or re-scanning) an arbitrary folder for `.gguf` files. */
export const scanFolderResultSchema = z.object({
  store: modelStoreSchema,
  modelsFound: z.number().int().nonnegative(),
  warnings: z.array(scanWarningSchema),
})
export type ScanFolderResult = z.infer<typeof scanFolderResultSchema>

export const ipcContract = {
  /** Liveness round-trip: renderer → main → renderer. */
  'app:ping': {
    request: z.object({
      /** Echoed back verbatim so callers can correlate. */
      nonce: z.string().min(1),
    }),
    response: z.object({
      nonce: z.string().min(1),
      /** PID of the main process that answered. */
      mainPid: z.number().int().positive(),
      /** Epoch ms at which main handled the call. */
      receivedAt: z.number().int().positive(),
    }),
  },
  /** App-wide settings (userData/settings.json — onboarding, theme, defaults). */
  'app:get-settings': {
    request: z.object({}),
    response: z.object({ settings: appSettingsSchema }),
  },
  'app:update-settings': {
    request: z.object({
      settings: appSettingsSchema
        .omit({ apiProvider: true, mlxProvider: true, frontierAssist: true, webSearch: true })
        .partial()
        .extend({
          apiProvider: apiProviderSettingsSchema.partial().optional(),
          mlxProvider: mlxProviderSettingsSchema.partial().optional(),
          frontierAssist: frontierAssistSettingsSchema.partial().optional(),
          webSearch: webSearchSettingsSchema.partial().optional(),
        }),
    }),
    response: z.object({ settings: appSettingsSchema }),
  },
  /** Machine facts for onboarding fit advisor and recommendations shelf. */
  'app:system-info': {
    request: z.object({}),
    response: z.object({
      physicalRamBytes: z.number().int().positive(),
      platform: z.string(),
    }),
  },
  /** Live RAM + CPU snapshot for the status overlay. */
  'app:system-metrics': {
    request: z.object({}),
    response: z.object({
      ramUsedBytes: z.number().int().nonnegative(),
      ramTotalBytes: z.number().int().positive(),
      cpuPercent: z.number().int().min(0).max(100),
    }),
  },

  // ── Workspace (PLAN.md Phase 1 — open/recent) ─────────────────────────
  /** Native folder picker. `path: null` when the user cancels. */
  'workspace:pick-folder': {
    request: z.object({}),
    response: z.object({ path: z.string().min(1).nullable() }),
  },
  /** Open (and upsert) a workspace by absolute folder path. */
  'workspace:open': {
    request: z.object({ path: z.string().min(1) }),
    response: z.object({ workspace: workspaceSchema }),
  },
  /** Recent workspaces, most recently opened first. */
  'workspace:recent': {
    request: z.object({}),
    response: z.object({ workspaces: z.array(workspaceSchema) }),
  },
  /** Replace a workspace's settings JSON (panel sizes, defaults, …). */
  'workspace:update-settings': {
    request: z.object({
      workspaceId: z.uuid(),
      settings: z.record(z.string(), z.unknown()),
    }),
    response: z.object({ ok: z.literal(true) }),
  },
  /** Git repositories detected under a workspace (root + immediate children). */
  'workspace:list-repos': {
    request: z.object({ workspaceId: z.uuid() }),
    response: z.object({
      repos: z.array(
        z.object({
          relPath: z.string(),
          name: z.string().min(1),
        }),
      ),
    }),
  },

  // ── Git (user worktree — composer Changes / Commit & Push) ────────────
  'git:status': {
    request: z.object({
      workspaceId: z.uuid(),
      /** Relative repo under the workspace; null = workspace root / active scope. */
      activeRepoPath: z.string().nullable(),
    }),
    response: z.object({
      isRepo: z.boolean(),
      repoRoot: z.string().nullable(),
      branch: z.string().nullable(),
      insertions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
      changedFiles: z.number().int().nonnegative(),
      ahead: z.number().int().nonnegative(),
      behind: z.number().int().nonnegative(),
      hasUpstream: z.boolean(),
      dirty: z.boolean(),
    }),
  },
  'git:commit': {
    request: z.object({
      workspaceId: z.uuid(),
      activeRepoPath: z.string().nullable(),
      message: z.string().min(1),
    }),
    response: z.object({ commitSha: z.string().min(1) }),
  },
  'git:push': {
    request: z.object({
      workspaceId: z.uuid(),
      activeRepoPath: z.string().nullable(),
    }),
    response: z.object({ ok: z.literal(true) }),
  },

  // ── Filesystem (workspace-confined; main owns fs — ARCHITECTURE.md) ───
  /** List one directory ('' = root), .gitignore-filtered, dirs first. */
  'fs:list': {
    request: z.object({
      workspaceId: z.uuid(),
      relPath: relPathSchema,
      scope: fsScopeSchema,
      /** When `scope` is `agent`, overrides persisted settings for snappy repo switches. */
      activeRepoPath: z.string().nullable().optional(),
    }),
    response: z.object({ entries: z.array(fsEntrySchema) }),
  },
  /**
   * Every non-ignored file in the workspace (⌘P quick-open index).
   * `scope: 'agent'` lists from the active repo root with agent-relative paths.
   */
  'fs:list-all': {
    request: z.object({
      workspaceId: z.uuid(),
      scope: z.enum(['workspace', 'agent']).optional(),
    }),
    response: z.object({ files: z.array(z.string().min(1)) }),
  },
  /** Read a UTF-8 text file. Binary content is a typed BINARY_FILE error. */
  'fs:read': {
    request: z.object({
      workspaceId: z.uuid(),
      relPath: z.string().min(1),
      scope: fsScopeSchema,
    }),
    response: z.object({ content: z.string(), mtimeMs: z.number() }),
  },
  /**
   * Write a text file. When `expectedMtimeMs` is set and the file changed on
   * disk since that time, the write fails with FILE_CHANGED_ON_DISK unless
   * `force` — the fs-race guard for editor saves.
   */
  'fs:write': {
    request: z.object({
      workspaceId: z.uuid(),
      relPath: z.string().min(1),
      content: z.string(),
      expectedMtimeMs: z.number().nullable(),
      force: z.boolean(),
      scope: fsScopeSchema,
    }),
    response: z.object({ mtimeMs: z.number() }),
  },
  /** Create an empty file or directory. Existing target → FILE_EXISTS. */
  'fs:create': {
    request: z.object({
      workspaceId: z.uuid(),
      relPath: z.string().min(1),
      kind: z.enum(['file', 'dir']),
      scope: fsScopeSchema,
    }),
    response: z.object({ ok: z.literal(true) }),
  },
  /** Rename/move within the workspace. Existing target → FILE_EXISTS. */
  'fs:rename': {
    request: z.object({
      workspaceId: z.uuid(),
      fromRelPath: z.string().min(1),
      toRelPath: z.string().min(1),
      scope: fsScopeSchema,
    }),
    response: z.object({ ok: z.literal(true) }),
  },
  /** Delete a file or directory tree (permanent — confirm in the UI). */
  'fs:delete': {
    request: z.object({
      workspaceId: z.uuid(),
      relPath: z.string().min(1),
      scope: fsScopeSchema,
    }),
    response: z.object({ ok: z.literal(true) }),
  },
  // ── Terminal (node-pty in main, xterm.js in renderer — ARCHITECTURE.md) ─
  /** Spawn a new shell session rooted at the workspace's root path. */
  'terminal:create': {
    request: z.object({ workspaceId: z.uuid() }),
    response: z.object({ terminalId: z.uuid() }),
  },
  /** Write keystrokes/input to a session's stdin. */
  'terminal:write': {
    request: z.object({ terminalId: z.uuid(), data: z.string() }),
    response: z.object({ ok: z.literal(true) }),
  },
  /** Resize a session's pty (rows/cols) — panel resize or tab activation. */
  'terminal:resize': {
    request: z.object({
      terminalId: z.uuid(),
      cols: z.number().int().positive(),
      rows: z.number().int().positive(),
    }),
    response: z.object({ ok: z.literal(true) }),
  },
  /** Kill a session (tab close). */
  'terminal:kill': {
    request: z.object({ terminalId: z.uuid() }),
    response: z.object({ ok: z.literal(true) }),
  },

  // ── Model manager (PLAN.md Phase 2 — MODELS.md) ────────────────────────
  /** External volumes under /Volumes (system boot volume excluded), with store flag. */
  'volumes:list': {
    request: z.object({}),
    response: z.object({ volumes: z.array(volumeSchema) }),
  },
  /** Create TrieModels/ + store.json on a fresh external volume. */
  'volumes:init-store': {
    request: z.object({ path: z.string().min(1), label: z.string().min(1) }),
    response: z.object({ store: modelStoreSchema }),
  },
  /** Default store in the app folder (`userData/TrieModels/`). Created on first use. */
  'models:ensure-internal-store': {
    request: z.object({}),
    response: z.object({ store: modelStoreSchema, modelsPath: z.string().min(1) }),
  },
  /** Every model in the registry (across mounted and offline stores) + their stores. */
  'models:list': {
    request: z.object({}),
    response: z.object({ models: z.array(modelSchema), stores: z.array(modelStoreSchema) }),
  },
  /** Delete a model's weights + manifest from its store and the registry row. */
  'models:delete': {
    request: z.object({ modelId: z.string().min(1) }),
    response: z.object({ ok: z.literal(true) }),
  },
  /** Every download row (any status) — the persisted queue, for the progress drawer. */
  'downloads:list': {
    request: z.object({}),
    response: z.object({ downloads: z.array(downloadSchema) }),
  },

  // ── Scanned-folder stores (PLAN.md Phase 2.5 — "point Trie IDE at any folder") ─
  /** Native folder picker, reused for the "Scan a folder for models" flow. `path: null` on cancel. */
  'models:pick-scan-folder': {
    request: z.object({}),
    response: z.object({ path: z.string().min(1).nullable() }),
  },
  /**
   * Register a brand-new `scanned_folder` store at `path` (or, if `storeId`
   * is passed, re-scan an existing one under the same id) and reconcile
   * whatever `.gguf` files are found into the registry.
   */
  'models:scan-folder': {
    request: z.object({ path: z.string().min(1), label: z.string().min(1) }),
    response: scanFolderResultSchema,
  },
  /** Re-scan an already-registered scanned-folder store on demand. */
  'models:rescan-folder-store': {
    request: z.object({ storeId: z.string().min(1) }),
    response: scanFolderResultSchema,
  },
  /** Remove a scanned-folder store from the registry without deleting files on disk. */
  'models:unmount-store': {
    request: z.object({ storeId: z.string().min(1) }),
    response: z.object({ ok: z.literal(true) }),
  },
  /** Remove one scanned model from the registry without deleting its file on disk. */
  'models:unmount-model': {
    request: z.object({ modelId: z.string().min(1) }),
    response: z.object({ ok: z.literal(true) }),
  },

  // ── Chat (PLAN.md Phase 3 — DATA-MODEL.md chat history) ────────────────
  /** Conversations for a workspace, newest-updated first, unarchived by default. */
  'chat:conversations:list': {
    request: z.object({ workspaceId: z.uuid(), includeArchived: z.boolean().optional() }),
    response: z.object({ conversations: z.array(conversationSchema) }),
  },
  /** Create a new conversation. Title starts empty; it's derived from the first user message. */
  'chat:conversations:create': {
    request: z.object({
      workspaceId: z.uuid(),
      mode: z.enum(['ask', 'agent', 'plan']),
      modelId: z.string().min(1).nullable(),
    }),
    response: z.object({ conversation: conversationSchema }),
  },
  /** Archive/unarchive (soft delete — conversations are never hard-deleted). */
  'chat:conversations:archive': {
    request: z.object({ conversationId: z.string().min(1), archived: z.boolean() }),
    response: z.object({ conversation: conversationSchema }),
  },
  /** All messages in a conversation, in seq order. */
  'chat:messages:list': {
    request: z.object({ conversationId: z.string().min(1) }),
    response: z.object({ messages: z.array(messageSchema) }),
  },
  /**
   * Send a user turn: persists the user message immediately, persists an
   * `interrupted` placeholder assistant message, loads the model if needed,
   * and starts streaming. Resolves once generation has *started* — the
   * reply itself arrives over the renderer stream port plus
   * `chat:message-updated` events; this call does not wait for it to finish.
   */
  'chat:send': {
    request: z.object({
      conversationId: z.string().min(1),
      modelId: z.string().min(1),
      text: z.string(),
      params: generationParamsSchema,
      contextRefs: z.array(contextRefInputSchema).optional(),
      imageAttachments: z.array(imageAttachmentInputSchema).optional(),
      /** Selected repo from the project picker; main falls back to workspace settings when omitted. */
      activeRepoPath: z.string().nullable().optional(),
    }),
    response: z.object({
      requestId: z.string().min(1),
      userMessage: messageSchema,
      assistantMessage: messageSchema,
      truncation: truncationReportSchema.nullable(),
    }),
  },
  /** Hard-abort the in-flight generation for this request (<200ms, MODELS.md). */
  'chat:cancel': {
    request: z.object({ requestId: z.string().min(1) }),
    response: z.object({ ok: z.literal(true) }),
  },
  /** Full-text search across all workspaces' chat history. */
  'chat:search': {
    request: z.object({ query: z.string().min(1) }),
    response: z.object({ hits: z.array(chatSearchHitSchema) }),
  },

  // ── Subagents (background runs over the serial inference host) ─────────
  /**
   * Spawn a background run: persists a child conversation + user message +
   * a `queued` run row and returns immediately. With `agentMode: true` the
   * run uses the Agent tool loop (can edit files); otherwise it is a single
   * chat generation. Executes when the single generation slot is free
   * (strictly serial); progress arrives on `subagent:changed`.
   */
  'subagent:spawn': {
    request: z.object({
      conversationId: z.string().min(1),
      modelId: z.string().min(1),
      prompt: z.string().min(1),
      title: z.string().min(1).optional(),
      /**
       * When true, the background run uses the Agent-mode tool loop (can edit
       * files) instead of a single chat generation.
       */
      agentMode: z.boolean().optional(),
    }),
    response: z.object({ run: subagentRunSchema }),
  },
  /** Every run in a workspace, newest first (the Working-pill popover). */
  'subagent:list': {
    request: z.object({ workspaceId: z.uuid() }),
    response: z.object({ runs: z.array(subagentRunSchema) }),
  },
  /** The run plus its stored transcript (final assistant message included). */
  'subagent:result': {
    request: z.object({ runId: z.string().min(1) }),
    response: z.object({ run: subagentRunSchema, messages: z.array(messageSchema) }),
  },
  /** Cancel a queued run (dequeue) or a running one (abort the generation). */
  'subagent:cancel': {
    request: z.object({ runId: z.string().min(1) }),
    response: z.object({ run: subagentRunSchema }),
  },

  // ── Context engine (PLAN.md Phase 5) ───────────────────────────────────
  /** Fuzzy search workspace symbols for @-mention autocomplete. */
  'context:search-symbols': {
    request: z.object({ workspaceId: z.uuid(), query: z.string() }),
    response: z.object({ symbols: z.array(symbolHitSchema) }),
  },

  // ── Inline completions (editor ghost text, FIM over the loaded model) ──
  /**
   * One inline (tab) completion at the cursor. A new request supersedes any
   * in-flight one; `text: ''` means "no completion" (no model loaded, model
   * busy with chat, or nothing useful generated) — never an error.
   */
  'completion:inline': {
    request: z.object({
      workspaceId: z.uuid(),
      relPath: z.string().min(1),
      /** Monaco language id ('typescript', 'python', …). */
      language: z.string(),
      /** File text immediately before the cursor (renderer-clamped). */
      prefix: z.string(),
      /** File text immediately after the cursor (renderer-clamped). */
      suffix: z.string(),
      /** Snippets from recently viewed files, for repo-level FIM context. */
      recentFiles: z
        .array(z.object({ path: z.string().min(1), snippet: z.string() }))
        .optional(),
    }),
    response: z.object({ text: z.string() }),
  },
  /** Abort the in-flight inline completion, if any (ghost text went stale). */
  'completion:cancel': {
    request: z.object({}),
    response: z.object({ ok: z.literal(true) }),
  },

  // ── Inference (PLAN.md Phase 3 — MODELS.md §"Inference host") ──────────
  /** Current lifecycle snapshot of the local inference process. */
  'inference:status': {
    request: z.object({}),
    response: inferenceStatusSchema,
  },
  /** Load a model into the inference host without starting a chat turn. */
  'inference:load': {
    request: z.object({ modelId: z.string().min(1) }),
    response: inferenceStatusSchema,
  },
  /** Unload the currently loaded model. Idempotent when already idle. */
  'inference:unload': {
    request: z.object({}),
    response: inferenceStatusSchema,
  },

  // ── Remote hosts (PLAN.md Phase 7 — REMOTE.md) ───────────────────────────
  'remote:list': {
    request: z.object({}),
    response: z.object({ hosts: z.array(remoteHostSchema) }),
  },
  'remote:add': {
    request: z.object({
      name: z.string().min(1),
      host: z.string().min(1),
      port: z.number().int().positive().optional(),
      username: z.string().min(1),
      authKind: remoteHostAuthKindSchema,
      keyPath: z.string().nullable().optional(),
    }),
    response: z.object({ host: remoteHostSchema }),
  },
  'remote:remove': {
    request: z.object({ hostId: z.string().min(1) }),
    response: z.object({ ok: z.literal(true) }),
  },
  'remote:connect': {
    request: z.object({ hostId: z.string().min(1) }),
    response: z.object({ host: remoteHostSchema }),
  },
  'remote:bootstrap': {
    request: z.object({
      hostId: z.string().min(1),
      storePath: z.string().min(1).optional(),
    }),
    response: z.object({
      host: remoteHostSchema,
      steps: z.array(
        z.object({
          step: z.string().min(1),
          ok: z.boolean(),
          detail: z.string().optional(),
        }),
      ),
      storeId: z.string().nullable(),
    }),
  },
  'remote:reconcile-store': {
    request: z.object({ hostId: z.string().min(1), storePath: z.string().min(1) }),
    response: z.object({ storeId: z.string().min(1), modelsFound: z.number().int().nonnegative() }),
  },

  /**
   * Run one direct agent turn: grammar-constrained tool loop with read/write
   * tools. Resolves when the turn finishes; tool activity arrives as
   * `plan:tool-call` / `plan:exploration-progress` events.
   */
  'agent:run': {
    request: z.object({
      conversationId: z.string().min(1),
      modelId: z.string().min(1),
      task: z.string().min(1),
      params: generationParamsSchema.optional(),
      contextRefs: z.array(contextRefInputSchema).optional(),
      imageAttachments: z.array(imageAttachmentInputSchema).optional(),
      activeRepoPath: z.string().nullable().optional(),
    }),
    response: z.object({
      userMessage: messageSchema,
      assistantMessage: messageSchema,
    }),
  },
  /** Accept / reject file changes after an agent turn (mirrors plan:review-step). */
  'agent:review-turn': {
    request: z.object({
      conversationId: z.string().min(1),
      decision: z.enum(['accept', 'accept-with-edits', 'reject']),
    }),
    response: z.object({ ok: z.literal(true) }),
  },
  /** Before/after file contents for an agent turn awaiting review. */
  'agent:review-files': {
    request: z.object({ checkpointId: z.string().min(1) }),
    response: z.object({
      files: z.array(
        z.object({
          path: z.string().min(1),
          original: z.string(),
          modified: z.string(),
        }),
      ),
    }),
  },
  /**
   * Cancel an in-flight agent turn or plan generation. Idempotent when idle.
   * Clears stuck foreground work so the next send works.
   */
  'agent:cancel': {
    request: z.object({ conversationId: z.string().min(1) }),
    response: z.object({ cancelled: z.boolean() }),
  },
  /**
   * Whether main still holds foreground agent or planning work for this
   * conversation — used to rehydrate the renderer after a remount.
   */
  'agent:status': {
    request: z.object({ conversationId: z.string().min(1) }),
    response: z.object({
      running: z.boolean(),
      planning: z.boolean(),
      review: z
        .object({
          conversationId: z.string().min(1),
          messageId: z.string().min(1),
          checkpointId: z.string().min(1),
          diff: z.string(),
          changedFiles: z.number().int().nonnegative(),
        })
        .nullable(),
    }),
  },

  // ── Planning mode (PLAN.md Phase 4 — PLANNING-MODE.md) ─────────────────
  /**
   * Run the Plan phase: bounded read-only exploration, then one
   * grammar-constrained plan emission at temperature 0. Resolves with the
   * persisted draft plan. Tool activity arrives meanwhile as
   * `plan:tool-call` / `plan:exploration-progress` events.
   */
  'plan:create': {
    request: z.object({
      conversationId: z.string().min(1),
      modelId: z.string().min(1),
      task: z.string().min(1),
      params: generationParamsSchema.optional(),
    }),
    response: z.object({ plan: planSchema }),
  },
  /** Every revision of every plan in a conversation, newest revision first. */
  'plan:list': {
    request: z.object({ conversationId: z.string().min(1) }),
    response: z.object({ plans: z.array(planSchema) }),
  },
  /** One plan with its step rows (status/checkpoint/diff/error). */
  'plan:get': {
    request: z.object({ planId: z.string().min(1) }),
    response: z.object({ plan: planSchema, steps: z.array(planStepRowSchema) }),
  },
  /**
   * Save an edited artifact as a **new revision**. The previous revision and
   * its steps are never modified (PLANNING-MODE.md — "nothing is overwritten").
   */
  'plan:revise': {
    request: z.object({ planId: z.string().min(1), artifact: planArtifactSchema }),
    response: z.object({ plan: planSchema }),
  },
  /** Approve a plan and lock in step vs auto execution mode. */
  'plan:approve': {
    request: z.object({ planId: z.string().min(1), execMode: z.enum(execModes) }),
    response: z.object({ plan: planSchema }),
  },
  /** Mark a plan abandoned. The record is kept; only changes are discarded. */
  'plan:abandon': {
    request: z.object({ planId: z.string().min(1) }),
    response: z.object({ plan: planSchema }),
  },
  /**
   * Execute an approved plan. Resolves with the final state report when
   * execution finishes *or stops* — a stop is a normal resolution carrying a
   * report, not a rejection.
   */
  'plan:execute': {
    request: z.object({
      planId: z.string().min(1),
      modelId: z.string().min(1),
      /** Reuse the pre-plan checkpoint when resuming after a failed step. */
      prePlanCheckpointId: z.string().min(1).optional(),
    }),
    response: z.object({
      status: z.enum(['completed', 'failed', 'stopped']),
      summary: z.string(),
      prePlanCheckpointId: z.string().min(1),
      rewindToCheckpointId: z.string().nullable(),
    }),
  },
  /** The user's decision at a step's diff review gate (step mode). */
  'plan:review-step': {
    request: z.object({
      stepId: z.string().min(1),
      decision: z.enum(['accept', 'accept-with-edits', 'reject']),
    }),
    response: z.object({ ok: z.literal(true) }),
  },
  /** Roll the workspace back to a checkpoint; reports hand-edited paths. */
  'plan:rewind': {
    request: z.object({ planId: z.string().min(1), checkpointId: z.string().min(1) }),
    response: z.object({ handEditedPaths: z.array(z.string()) }),
  },
  /** Before/after file contents for a step awaiting diff review. */
  'plan:review-files': {
    request: z.object({ stepId: z.string().min(1) }),
    response: z.object({
      files: z.array(
        z.object({
          path: z.string().min(1),
          original: z.string(),
          modified: z.string(),
        }),
      ),
    }),
  },
  /** Re-open a finished plan for editing. */
  'plan:reopen': {
    request: z.object({ planId: z.string().min(1) }),
    response: z.object({ plan: planSchema }),
  },
  /** Reset the failed step and mark the plan approved again. */
  'plan:retry-step': {
    request: z.object({ planId: z.string().min(1) }),
    response: z.object({ plan: planSchema }),
  },
  /** Answer a pending command-approval prompt. */
  'plan:answer-approval': {
    request: z.object({ approvalId: z.string().min(1), approved: z.boolean() }),
    response: z.object({ ok: z.literal(true) }),
  },
  /** Tool calls recorded against an assistant message, for the transcript. */
  'plan:tool-calls': {
    request: z.object({ messageId: z.string().min(1) }),
    response: z.object({ toolCalls: z.array(toolCallRecordSchema) }),
  },
  /** Detected workspace check commands with the allowlist applied. */
  'checks:list': {
    request: z.object({ workspaceId: z.uuid() }),
    response: z.object({ commands: z.array(checkCommandSchema) }),
  },
  /** Replace the workspace's verification allowlist (approved once, per workspace). */
  'checks:set-allowlist': {
    request: z.object({ workspaceId: z.uuid(), commands: z.array(z.string().min(1)) }),
    response: z.object({ commands: z.array(checkCommandSchema) }),
  },
} as const

/**
 * Main → renderer event channels, validated with the same rigor as invokes:
 * main validates before `webContents.send`, preload validates on arrival.
 */
export const ipcEvents = {
  /** Batched watcher events for the open workspace's tree. */
  'fs:changed': z.object({
    workspaceId: z.uuid(),
    events: z.array(
      z.object({
        kind: z.enum(['add', 'change', 'unlink', 'addDir', 'unlinkDir']),
        relPath: z.string().min(1),
      }),
    ),
  }),
  /** The watcher was rebuilt (e.g. .gitignore changed) — refetch the tree. */
  'fs:reset': z.object({ workspaceId: z.uuid() }),
  /** The watcher failed; the tree may be stale until the workspace reopens. */
  'fs:watch-error': z.object({ workspaceId: z.uuid(), message: z.string() }),
  /** A terminal session produced output. */
  'terminal:data': z.object({ terminalId: z.uuid(), data: z.string() }),
  /** A terminal session's shell process exited. */
  'terminal:exit': z.object({ terminalId: z.uuid(), exitCode: z.number().int() }),
  /** /Volumes mount/unmount delta (MODELS.md — drive lifecycle). */
  'volumes:changed': z.object({ mounted: z.array(volumeSchema), unmounted: z.array(volumeSchema) }),
  /** Download queue progress; also carries verify/done/failed_corrupt transitions. */
  'downloads:progress': z.object({
    downloadId: z.string().min(1),
    modelId: z.string().min(1),
    doneBytes: z.number().nonnegative(),
    totalBytes: z.number().nonnegative(),
    status: z.enum(['queued', 'active', 'paused', 'verifying', 'done', 'failed_corrupt', 'failed']),
    speedBps: z.number().nonnegative(),
  }),
  /** App settings changed (e.g. API provider toggled) — refresh derived UI. */
  'settings:changed': z.object({ settings: appSettingsSchema }),
  /** Remote host reconnect backoff (REMOTE.md). */
  'remote:reconnecting': z.object({
    hostId: z.string().min(1),
    attempt: z.number().int().positive(),
    delaySec: z.number().int().positive(),
  }),
  /** Remote host status changed (connect/disconnect/bootstrap). */
  'remote:host-changed': z.object({ host: remoteHostSchema }),
  /** Inference lifecycle transition (load progress, ready, busy, error). */
  'inference:status-changed': inferenceStatusSchema,
  /**
   * A message row changed on disk (streaming snapshot tick or terminal
   * state). The renderer's source of truth for transcript content — the
   * MessagePort token stream is only the smooth per-token animation on top.
   */
  'chat:message-updated': z.object({ conversationId: z.string().min(1), message: messageSchema }),
  /** A subagent run was created or moved through its lifecycle. */
  'subagent:changed': z.object({ run: subagentRunSchema }),

  // ── Planning mode events (PLAN.md Phase 4) ─────────────────────────────
  /** A plan was created, revised, approved, or changed status. */
  'plan:changed': z.object({ plan: planSchema }),
  /** A step row changed — status, checkpoint, diff or error. */
  'plan:step-changed': z.object({ planId: z.string().min(1), step: planStepRowSchema }),
  /** A tool call was executed; renders as a collapsible transcript entry. */
  'plan:tool-call': z.object({
    conversationId: z.string().min(1),
    toolCall: toolCallRecordSchema,
  }),
  /** Exploration progress during the plan phase (PLANNING-MODE.md: shown as progress). */
  'plan:exploration-progress': z.object({
    conversationId: z.string().min(1),
    callsMade: z.number().int().nonnegative(),
    maxCalls: z.number().int().nonnegative(),
  }),
  /**
   * A step's edits are done and awaiting the user's diff review (step mode).
   * The renderer answers with `plan:review-step`.
   */
  'plan:step-awaiting-review': z.object({
    planId: z.string().min(1),
    step: planStepRowSchema,
    diff: z.string(),
    guideNote: guideNoteSchema.nullable().optional(),
  }),
  'plan:guide-note': z.object({
    conversationId: z.string().min(1),
    planId: z.string().min(1),
    guideNote: guideNoteSchema,
  }),
  /**
   * An agent turn changed files and is waiting for Accept / Reject.
   * The renderer answers with `agent:review-turn`.
   */
  'agent:awaiting-review': z.object({
    conversationId: z.string().min(1),
    messageId: z.string().min(1),
    checkpointId: z.string().min(1),
    diff: z.string(),
    changedFiles: z.number().int().nonnegative(),
    guideNote: guideNoteSchema.nullable().optional(),
  }),
  /** Frontier Assist cloud round-trip started or finished for a conversation. */
  'frontier-assist:activity': z.object({
    conversationId: z.string().min(1),
    active: z.boolean(),
  }),
  /**
   * A command needs explicit approval before it runs: a `run_command` tool call
   * (always, in v1) or a verification command that is not allowlisted. The
   * renderer answers with `plan:answer-approval`.
   */
  'plan:approval-requested': z.object({
    approvalId: z.string().min(1),
    command: z.string().min(1),
    cwd: z.string().min(1),
    reason: z.enum(['run_command', 'verification']),
  }),
} as const

export type IpcEventChannel = keyof typeof ipcEvents
export type IpcEventPayload<C extends IpcEventChannel> = z.infer<(typeof ipcEvents)[C]>

export function isKnownEventChannel(channel: string): channel is IpcEventChannel {
  return channel in ipcEvents
}

/** Validate an event payload for `channel`. Throws IpcValidationError. */
export function parseEvent<C extends IpcEventChannel>(
  channel: C,
  payload: unknown,
): IpcEventPayload<C> {
  const result = ipcEvents[channel].safeParse(payload)
  if (!result.success) {
    throw new IpcEventValidationError(channel, z.prettifyError(result.error))
  }
  return result.data as IpcEventPayload<C>
}

export class IpcEventValidationError extends Error {
  readonly code = 'IPC_EVENT_VALIDATION_FAILED' as const

  constructor(
    readonly channel: IpcEventChannel,
    readonly issues: string,
  ) {
    super(`IPC event validation failed on channel "${channel}": ${issues}`)
    this.name = 'IpcEventValidationError'
  }
}

export type IpcChannel = keyof typeof ipcContract

export type IpcRequest<C extends IpcChannel> = z.infer<(typeof ipcContract)[C]['request']>
export type IpcResponse<C extends IpcChannel> = z.infer<(typeof ipcContract)[C]['response']>

/** Typed API surface exposed on `window.forge` by the preload script. */
export interface ForgeApi {
  app: {
    ping(request: IpcRequest<'app:ping'>): Promise<IpcResponse<'app:ping'>>
    getSettings(): Promise<IpcResponse<'app:get-settings'>>
    updateSettings(
      request: IpcRequest<'app:update-settings'>,
    ): Promise<IpcResponse<'app:update-settings'>>
    systemInfo(): Promise<IpcResponse<'app:system-info'>>
    systemMetrics(): Promise<IpcResponse<'app:system-metrics'>>
  }
  workspace: {
    pickFolder(): Promise<IpcResponse<'workspace:pick-folder'>>
    open(request: IpcRequest<'workspace:open'>): Promise<IpcResponse<'workspace:open'>>
    recent(): Promise<IpcResponse<'workspace:recent'>>
    updateSettings(
      request: IpcRequest<'workspace:update-settings'>,
    ): Promise<IpcResponse<'workspace:update-settings'>>
    listRepos(
      request: IpcRequest<'workspace:list-repos'>,
    ): Promise<IpcResponse<'workspace:list-repos'>>
  }
  git: {
    status(request: IpcRequest<'git:status'>): Promise<IpcResponse<'git:status'>>
    commit(request: IpcRequest<'git:commit'>): Promise<IpcResponse<'git:commit'>>
    push(request: IpcRequest<'git:push'>): Promise<IpcResponse<'git:push'>>
  }
  fs: {
    list(request: IpcRequest<'fs:list'>): Promise<IpcResponse<'fs:list'>>
    listAll(request: IpcRequest<'fs:list-all'>): Promise<IpcResponse<'fs:list-all'>>
    read(request: IpcRequest<'fs:read'>): Promise<IpcResponse<'fs:read'>>
    write(request: IpcRequest<'fs:write'>): Promise<IpcResponse<'fs:write'>>
    create(request: IpcRequest<'fs:create'>): Promise<IpcResponse<'fs:create'>>
    rename(request: IpcRequest<'fs:rename'>): Promise<IpcResponse<'fs:rename'>>
    delete(request: IpcRequest<'fs:delete'>): Promise<IpcResponse<'fs:delete'>>
  }
  terminal: {
    create(request: IpcRequest<'terminal:create'>): Promise<IpcResponse<'terminal:create'>>
    write(request: IpcRequest<'terminal:write'>): Promise<IpcResponse<'terminal:write'>>
    resize(request: IpcRequest<'terminal:resize'>): Promise<IpcResponse<'terminal:resize'>>
    kill(request: IpcRequest<'terminal:kill'>): Promise<IpcResponse<'terminal:kill'>>
  }
  models: {
    listVolumes(): Promise<IpcResponse<'volumes:list'>>
    initStore(request: IpcRequest<'volumes:init-store'>): Promise<IpcResponse<'volumes:init-store'>>
    ensureInternalStore(): Promise<IpcResponse<'models:ensure-internal-store'>>
    list(): Promise<IpcResponse<'models:list'>>
    delete(request: IpcRequest<'models:delete'>): Promise<IpcResponse<'models:delete'>>
    listDownloads(): Promise<IpcResponse<'downloads:list'>>
    pickScanFolder(): Promise<IpcResponse<'models:pick-scan-folder'>>
    scanFolder(
      request: IpcRequest<'models:scan-folder'>,
    ): Promise<IpcResponse<'models:scan-folder'>>
    rescanFolderStore(
      request: IpcRequest<'models:rescan-folder-store'>,
    ): Promise<IpcResponse<'models:rescan-folder-store'>>
    unmountStore(
      request: IpcRequest<'models:unmount-store'>,
    ): Promise<IpcResponse<'models:unmount-store'>>
    unmountModel(
      request: IpcRequest<'models:unmount-model'>,
    ): Promise<IpcResponse<'models:unmount-model'>>
  }
  chat: {
    listConversations(
      request: IpcRequest<'chat:conversations:list'>,
    ): Promise<IpcResponse<'chat:conversations:list'>>
    createConversation(
      request: IpcRequest<'chat:conversations:create'>,
    ): Promise<IpcResponse<'chat:conversations:create'>>
    archiveConversation(
      request: IpcRequest<'chat:conversations:archive'>,
    ): Promise<IpcResponse<'chat:conversations:archive'>>
    listMessages(
      request: IpcRequest<'chat:messages:list'>,
    ): Promise<IpcResponse<'chat:messages:list'>>
    send(request: IpcRequest<'chat:send'>): Promise<IpcResponse<'chat:send'>>
    cancel(request: IpcRequest<'chat:cancel'>): Promise<IpcResponse<'chat:cancel'>>
    search(request: IpcRequest<'chat:search'>): Promise<IpcResponse<'chat:search'>>
  }
  subagent: {
    spawn(request: IpcRequest<'subagent:spawn'>): Promise<IpcResponse<'subagent:spawn'>>
    list(request: IpcRequest<'subagent:list'>): Promise<IpcResponse<'subagent:list'>>
    result(request: IpcRequest<'subagent:result'>): Promise<IpcResponse<'subagent:result'>>
    cancel(request: IpcRequest<'subagent:cancel'>): Promise<IpcResponse<'subagent:cancel'>>
  }
  context: {
    searchSymbols(
      request: IpcRequest<'context:search-symbols'>,
    ): Promise<IpcResponse<'context:search-symbols'>>
  }
  completion: {
    inline(request: IpcRequest<'completion:inline'>): Promise<IpcResponse<'completion:inline'>>
    cancel(): Promise<IpcResponse<'completion:cancel'>>
  }
  agent: {
    run(request: IpcRequest<'agent:run'>): Promise<IpcResponse<'agent:run'>>
    reviewTurn(
      request: IpcRequest<'agent:review-turn'>,
    ): Promise<IpcResponse<'agent:review-turn'>>
    reviewFiles(
      request: IpcRequest<'agent:review-files'>,
    ): Promise<IpcResponse<'agent:review-files'>>
    cancel(request: IpcRequest<'agent:cancel'>): Promise<IpcResponse<'agent:cancel'>>
    status(request: IpcRequest<'agent:status'>): Promise<IpcResponse<'agent:status'>>
  }
  plan: {
    create(request: IpcRequest<'plan:create'>): Promise<IpcResponse<'plan:create'>>
    list(request: IpcRequest<'plan:list'>): Promise<IpcResponse<'plan:list'>>
    get(request: IpcRequest<'plan:get'>): Promise<IpcResponse<'plan:get'>>
    revise(request: IpcRequest<'plan:revise'>): Promise<IpcResponse<'plan:revise'>>
    approve(request: IpcRequest<'plan:approve'>): Promise<IpcResponse<'plan:approve'>>
    abandon(request: IpcRequest<'plan:abandon'>): Promise<IpcResponse<'plan:abandon'>>
    execute(request: IpcRequest<'plan:execute'>): Promise<IpcResponse<'plan:execute'>>
    reviewStep(request: IpcRequest<'plan:review-step'>): Promise<IpcResponse<'plan:review-step'>>
    rewind(request: IpcRequest<'plan:rewind'>): Promise<IpcResponse<'plan:rewind'>>
    reviewFiles(
      request: IpcRequest<'plan:review-files'>,
    ): Promise<IpcResponse<'plan:review-files'>>
    reopen(request: IpcRequest<'plan:reopen'>): Promise<IpcResponse<'plan:reopen'>>
    retryStep(request: IpcRequest<'plan:retry-step'>): Promise<IpcResponse<'plan:retry-step'>>
    answerApproval(
      request: IpcRequest<'plan:answer-approval'>,
    ): Promise<IpcResponse<'plan:answer-approval'>>
    toolCalls(request: IpcRequest<'plan:tool-calls'>): Promise<IpcResponse<'plan:tool-calls'>>
    listChecks(request: IpcRequest<'checks:list'>): Promise<IpcResponse<'checks:list'>>
    setAllowlist(
      request: IpcRequest<'checks:set-allowlist'>,
    ): Promise<IpcResponse<'checks:set-allowlist'>>
  }
  remote: {
    list(): Promise<IpcResponse<'remote:list'>>
    add(request: IpcRequest<'remote:add'>): Promise<IpcResponse<'remote:add'>>
    remove(request: IpcRequest<'remote:remove'>): Promise<IpcResponse<'remote:remove'>>
    connect(request: IpcRequest<'remote:connect'>): Promise<IpcResponse<'remote:connect'>>
    bootstrap(request: IpcRequest<'remote:bootstrap'>): Promise<IpcResponse<'remote:bootstrap'>>
    reconcileStore(
      request: IpcRequest<'remote:reconcile-store'>,
    ): Promise<IpcResponse<'remote:reconcile-store'>>
  }
  inference: {
    status(): Promise<IpcResponse<'inference:status'>>
    load(request: IpcRequest<'inference:load'>): Promise<IpcResponse<'inference:load'>>
    unload(): Promise<IpcResponse<'inference:unload'>>
    /**
     * There is deliberately no `onStreamPort` here: a live `MessagePort`
     * cannot survive being handed across the context bridge as a callback
     * argument (it structured-clones into a dead shell — no `.postMessage`/
     * `.start`). Preload forwards the port with `window.postMessage`
     * instead (see preload/index.ts), and `renderer/lib/inferenceStream.ts`
     * listens for it directly with `window.addEventListener('message', …)`
     * — the one documented-safe path for this exact handoff.
     */
  }
  events: {
    /** Subscribe to a validated main→renderer event. Returns unsubscribe. */
    on<C extends IpcEventChannel>(
      channel: C,
      listener: (payload: IpcEventPayload<C>) => void,
    ): () => void
  }
}

export class IpcValidationError extends Error {
  readonly code = 'IPC_VALIDATION_FAILED' as const

  constructor(
    readonly channel: IpcChannel,
    readonly side: 'request' | 'response',
    readonly issues: string,
  ) {
    super(`IPC ${side} validation failed on channel "${channel}": ${issues}`)
    this.name = 'IpcValidationError'
  }
}

export function isKnownChannel(channel: string): channel is IpcChannel {
  return channel in ipcContract
}

/** Parse and validate a request payload for `channel`. Throws IpcValidationError. */
export function parseRequest<C extends IpcChannel>(channel: C, payload: unknown): IpcRequest<C> {
  const result = ipcContract[channel].request.safeParse(payload)
  if (!result.success) {
    throw new IpcValidationError(channel, 'request', z.prettifyError(result.error))
  }
  return result.data as IpcRequest<C>
}

/** Parse and validate a response payload for `channel`. Throws IpcValidationError. */
export function parseResponse<C extends IpcChannel>(channel: C, payload: unknown): IpcResponse<C> {
  const result = ipcContract[channel].response.safeParse(payload)
  if (!result.success) {
    throw new IpcValidationError(channel, 'response', z.prettifyError(result.error))
  }
  return result.data as IpcResponse<C>
}

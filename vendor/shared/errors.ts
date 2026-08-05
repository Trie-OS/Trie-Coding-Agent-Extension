/**
 * Typed error catalogue shared by main and renderer.
 *
 * Fail-loudly policy (ARCHITECTURE.md): every failure mode gets a typed error
 * surfaced to the user. Electron's `ipcMain.handle` rejection mangles thrown
 * errors into plain `Error`s with prefixed messages, so main serializes
 * `ForgeError`s into a tagged envelope that preload detects and re-throws as
 * a real `ForgeError` — codes survive the process boundary.
 */
import { z } from 'zod'

// Every module that defines a zod schema must set this itself — it is *not*
// enough for some other module in the bundle to call it "first", because
// zod v4 compiles a schema's validator at `z.object(...)` construction time,
// not lazily at `.parse()` time. Since ES modules execute their imports
// before their own top-level code, a module imported earlier than
// `ipc-contract.ts` (this one is, via `ipc-contract.ts` importing
// `forgeErrorCodes`) would otherwise build its schema under default
// (JIT'd, `new Function`-based) settings regardless of what
// `ipc-contract.ts` configures afterward — and then throw
// "Code generation from strings disallowed for this context" the moment
// preload's CSP-sandboxed context actually parses with it. This bit
// preload's `deserializeForgeError`, called on every single IPC response.
z.config({ jitless: true })

export const forgeErrorCodes = [
  // Workspace / filesystem
  'WORKSPACE_PATH_MISSING', // path no longer exists or is not a directory
  'WORKSPACE_NOT_OPEN', // fs/terminal op referenced an unknown workspace id
  'PATH_OUTSIDE_WORKSPACE', // path traversal — resolved outside workspace root
  'FILE_NOT_FOUND',
  'FILE_EXISTS', // create/rename target already exists
  'NOT_A_FILE', // read/write on a directory
  'BINARY_FILE', // editor read of a non-text file
  'FILE_CHANGED_ON_DISK', // save raced an external edit (mtime mismatch)
  'FS_OPERATION_FAILED', // underlying fs error (permissions, io) — message has detail
  'WATCHER_FAILED', // file watcher errored; tree may be stale
  'SYMBOL_INDEX_TOO_LARGE', // too many indexable files for symbol search — open a smaller folder
  // Terminal
  'TERMINAL_NOT_FOUND',
  'SHELL_UNAVAILABLE', // $SHELL is unset/nonexistent — nothing to spawn
  'PTY_SPAWN_FAILED',
  // Model manager (PLAN.md Phase 2 — MODELS.md)
  'DRIVE_MANIFEST_CORRUPT', // store.json exists but fails to parse/validate
  'MODEL_MANIFEST_CORRUPT', // a model's manifest.json exists but fails to parse/validate
  'DRIVE_ALREADY_A_STORE', // init requested on a volume that already has store.json
  'STORE_NOT_FOUND', // referenced store id has no known mount/registry row
  'STORE_OFFLINE', // action requires a mounted store that is currently unmounted
  'MODEL_NOT_FOUND',
  'HF_REQUEST_FAILED', // network/HTTP failure talking to the Hugging Face API
  'HF_REPO_GATED', // repo requires a token the user hasn't supplied or that failed
  // Scanned-folder stores (PLAN.md Phase 2.5 — "point Trie IDE at any folder")
  'SCAN_FOLDER_UNREADABLE', // the picked/registered folder can't be read (missing, permissions)
  'SCAN_FOLDER_NOT_A_STORE', // rescan requested a storeId that isn't a scanned_folder store
  'DOWNLOAD_NOT_FOUND',
  'DOWNLOAD_DISK_FULL', // preflight or resume found insufficient free space
  'DOWNLOAD_CORRUPT', // sha256 mismatch at verify time; .part is kept, not retried
  'DOWNLOAD_ALREADY_ACTIVE',
  // Inference host (PLAN.md Phase 3 — MODELS.md §"Inference host" failure modes)
  'LOAD_OOM', // process died allocating weights/KV cache; fit numbers in details
  'DRIVE_OFFLINE', // the model's store went away (load preflight or mid-generation mmap fault)
  'CORRUPT_GGUF', // GGUF header/metadata unreadable
  'INFERENCE_STALL', // > 120 s with no token produced
  'MODEL_FILE_MISSING', // store is mounted but the .gguf is not where the registry says
  'MODEL_WONT_FIT', // fit advisor says won't fit and the caller did not pass allowUnfit
  'INFERENCE_SPAWN_FAILED', // utilityProcess could not be forked
  'INFERENCE_PROCESS_CRASHED', // worker exited outside a clean unload
  'MODEL_LOAD_FAILED', // any other load failure — message carries the backend's text
  'NO_MODEL_LOADED', // generate/cancel with nothing loaded
  'MODEL_BUSY', // one generation at a time (ARCHITECTURE.md §Concurrency)
  'GENERATION_NOT_FOUND', // cancel referenced an unknown/finished request
  'GENERATION_FAILED', // a chat/agent turn failed before or during generation; message carries the detail
  'CHAT_TEMPLATE_UNKNOWN', // GGUF has no usable template and the family has no override
  'VISION_NOT_SUPPORTED', // image attached but model lacks vision or inference isn't wired
  'GRAMMAR_UNSUPPORTED', // GBNF passed to a provider build that cannot constrain (Phase 4)
  'API_AUTH_ERROR', // API provider rejected the key (401/403) or it is missing
  'API_RATE_LIMIT', // API provider returned 429 or quota exceeded
  'API_BAD_REQUEST', // API provider returned 400 (bad params) — e.g. temperature not supported
  'API_SERVER_ERROR', // API provider returned 5xx or another non-retryable HTTP error
  // Chat history (DATA-MODEL.md)
  'CONVERSATION_NOT_FOUND',
  'MESSAGE_NOT_FOUND',
  // Subagents (background runs over the same one-at-a-time inference host)
  'SUBAGENT_RUN_NOT_FOUND', // spawn/cancel/result referenced an unknown run id
  'SUBAGENT_RUN_FINISHED', // cancel requested on a run already in a terminal state
  // Agent tools + planning mode (PLAN.md Phase 4 — PLANNING-MODE.md)
  'GRAMMAR_COMPILE_FAILED', // the IR → GBNF compiler was handed something it cannot express
  'TOOL_CALL_MALFORMED', // model emission was not a valid {thought,tool,args} JSON object
  'TOOL_UNKNOWN', // model called a tool that is not available in this phase
  'TOOL_ARGS_INVALID', // args failed the tool's schema
  'TOOL_FAILED', // the tool ran and failed — message carries the detail
  'TOOL_DENIED', // user rejected an approval-gated call (run_command)
  'EDIT_SEARCH_NOT_FOUND', // edit_file search text absent; details carry the nearest fuzzy match
  'EDIT_SEARCH_AMBIGUOUS', // edit_file search text matched more than once
  'WRITE_FILE_TOO_LARGE', // write_file over the whole-file-rewrite line budget
  'RIPGREP_NOT_FOUND', // the bundled rg binary is missing from the install
  'COMMAND_TIMEOUT', // run_command / verification command exceeded its wall clock
  'COMMAND_SPAWN_FAILED',
  'AGENT_LOOP_EXHAUSTED', // hit the tool-call cap without a terminal declaration
  'PLAN_ARTIFACT_INVALID', // plan emission failed the plan schema or its semantic checks
  'PLAN_NOT_FOUND',
  'PLAN_STEP_NOT_FOUND',
  'PLAN_NOT_APPROVED', // execution requested on a plan that was never approved
  'PLAN_BUSY', // one plan executes at a time per workspace
  'PLAN_STEP_FAILED', // a plan step failed; execution stops with a state report
  'AGENT_TURN_DECLINED', // direct agent mode: model called step_failed (not a system failure)
  'SHADOW_GIT_UNAVAILABLE', // no usable `git` binary for the checkpoint system
  'GIT_UNAVAILABLE', // no usable `git` binary for user-repo status/commit/push
  'GIT_NOT_A_REPO', // active project path is not inside a git worktree
  'GIT_NOTHING_TO_COMMIT', // commit requested with a clean worktree
  'GIT_FAILED', // user-repo git command failed — message carries git's text
  'CHECKPOINT_FAILED', // snapshot/rollback command failed — message carries git's text
  'CHECKPOINT_NOT_FOUND',
  'CHECKPOINT_NESTED_REPOS', // workspace contains nested git repos — snapshots record them as gitlinks, so rollback would silently skip their files
  'CHECKPOINT_TOO_LARGE', // more non-ignored files than a snapshot can cover in reasonable time — open a subfolder
  'VERIFICATION_FAILED', // check command still failing after the one bounded repair attempt
  'CHECK_COMMAND_NOT_ALLOWED', // non-allowlisted command reached the auto-runner
  // Remote hosts (PLAN.md Phase 7 — REMOTE.md)
  'HOST_UNREACHABLE', // SSH tunnel dropped or daemon not responding
  'HOST_KEY_CHANGED', // pinned host key no longer matches — possible MITM or reinstall
  'DAEMON_VERSION_MISMATCH', // remote daemon protocol version differs from app
  'BOOTSTRAP_FAILED', // bootstrap step failed — details carry step + stderr
  'REMOTE_DISK_FULL', // remote store path has insufficient space
  'REMOTE_HOST_NOT_FOUND',
] as const

export type ForgeErrorCode = (typeof forgeErrorCodes)[number]

export class ForgeError extends Error {
  constructor(
    readonly code: ForgeErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ForgeError'
  }
}

const serializedForgeErrorSchema = z.object({
  __forgeError: z.object({
    code: z.enum(forgeErrorCodes),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
})

export type SerializedForgeError = z.infer<typeof serializedForgeErrorSchema>

export function serializeForgeError(error: ForgeError): SerializedForgeError {
  return {
    __forgeError: {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
  }
}

/** Re-hydrate a `ForgeError` if `payload` is a serialized one; otherwise null. */
export function deserializeForgeError(payload: unknown): ForgeError | null {
  const parsed = serializedForgeErrorSchema.safeParse(payload)
  if (!parsed.success) return null
  const { code, message, details } = parsed.data.__forgeError
  return new ForgeError(code, message, details)
}

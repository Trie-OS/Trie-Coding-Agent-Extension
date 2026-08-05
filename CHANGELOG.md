# Changelog

## 0.5.18

- **Open source release:** the extension now lives in its own public repository at [Trie-OS/Trie-Coding-Agent-Extension](https://github.com/Trie-OS/Trie-Coding-Agent-Extension) with full commit history preserved.

## 0.5.17

- **Question reply styling:** Ask/Plan and recommendation answers no longer render in destructive red when they cite file paths without editing anything; the fake-edit guard now applies only to Code-mode implementation turns.

## 0.5.16

- **Strict API tool errors:** OpenAI-compatible backends that reject native tools now fail immediately with the endpoint error instead of silently retrying with prompt-only JSON envelopes.
- **Hybrid GPT-5 fix:** frontier OpenAI requests use `max_completion_tokens`, omit unsupported custom temperatures for GPT-5/o-series models, and surface bounded API error text instead of only `frontier_http_400`.

## 0.5.15

- **Native API tool calling:** OpenAI-compatible backends now receive typed native function definitions generated from the same schema as daemon GBNF. Endpoints that reject tools now surface the API error without silently falling back; `/v1` base URLs are normalized without duplication.
- **Automatic verification and repair:** Code mode automatically selects a safe package check for changed source, runs it through the existing permission boundary, and gives the model exactly one repair attempt before failing loudly.
- **Reasoning-model action profile:** reasoning-tuned models get shorter-thought instructions, earlier explore/stall nudges, and bounded visible reasoning traces without changing coder-model behavior.
- **GPT-5 Hybrid compatibility:** OpenAI frontier requests use `max_completion_tokens`, omit unsupported custom temperatures for GPT-5/o-series models, and expose bounded API error details instead of only `frontier_http_400`.
- **Extension coding smoke:** `npm run bench:coding-smoke` exercises the real extension loop for read/edit and file-creation flows with automatic verification. It is explicitly a deterministic harness smoke suite, not a model-quality benchmark.

## 0.5.14

- **Verification pass:** fixed malformed tool-loop transcript updates left by a partial agent edit; added regression coverage that Code mode stays generation-unlimited regardless of persisted settings.

## 0.5.13

- **No Code generation cap:** Code mode no longer has a local-generation budget at all — only the turn deadline stops a run. The obsolete `modeGenerationsCode` setting is removed on activate.

## 0.5.12

- **Legacy budget migration:** persisted Code generation limits of 16 and tool-call caps of 24 are automatically migrated to unlimited (`0`) on extension activate, and are treated as unlimited at read time until migration runs.
- **Settings:** Code generations / turn is now editable in Trie Settings (`0` = unlimited).
- **Clearer stop reasons:** the agent now distinguishes turn deadline expiry from generation budget exhaustion.

## 0.5.11

- **Faster local tool calls:** the daemon now receives mode-aware per-tool GBNF, constraining tool names and typed arguments instead of accepting any JSON object.
- **Batched exploration:** new `read_files` reads up to eight related files in one model round-trip while preserving a bounded shared result budget.
- **Cheaper context management:** old tool results compact locally first; LLM-based Vibe compaction remains the fallback and has a separate budget.
- **Explore-to-edit bias:** Code mode prompts the model to implement once it has enough context, retries premature ambiguity-based failures, and nudges excessive exploration toward a concrete edit.
- **Unblocked Code turns:** `0` now means unlimited Code generations and tool calls, while the end-to-end deadline remains the safety bound.
- **Non-blocking Hybrid recovery:** slow stuck hints overlap local generation and are inserted at the next safe loop boundary.

## 0.5.10

- **Reliable file creation:** `write_file` no longer fails with `ENOENT` on new paths; missing nested directories resolve to the correct target instead of collapsing to the workspace root.
- **Clearer edit errors:** `edit_file` on a missing file tells the model to use `write_file` or confirm the path first.
- **Thought accordion:** reasoning streams live with a thought icon and preview text; duplicate consecutive thoughts are suppressed.
- **Mode chip colors:** Ask chip is green; Plan chip is yellow.

## 0.5.9

- **Streaming final answers:** synthesis and rewrite tokens stream into the chat as they arrive instead of appearing all at once when the turn finishes.
- **Composer mode picker:** Plan, Ask, and Multitask toggle off on re-select; checkmarks update immediately while the menu stays open.
- **Plan/Ask chips:** selecting Plan or Ask shows a dismissible chip beside the + button (× returns to Code mode), matching Multitask.

## 0.5.8

- **Fixed empty answers:** terminal `step_complete` summaries wrapped in provider tool JSON are unwrapped before display; internal envelopes are refused instead of rendering as blank replies.
- **Errors over fallbacks:** recommendation synthesis failures throw explicit errors; empty successful replies are flagged failed; the webview shows error text instead of generic “try again” placeholders.
- **Safer error surfacing:** shared `sanitizeUserError` redacts credentials/tokens in user-facing messages; compaction, checkpoint, restore, and missing-backend failures post to chat; question timeouts are distinct from user cancel; Hybrid HTTP failures record status for synthesis diagnostics.

## 0.5.7

- **No raw tool JSON in chat:** streaming no longer leaks `{ "thought", "tool", "args" }` envelopes into the thought panel or final reply; internal monologue is never promoted to the answer.
- **Removed live telemetry bar:** the synthesis/local/judge status strip is gone from the chat header.
- **Better recommendation failures:** Hybrid provider errors fall back to evidence-grounded local synthesis instead of dead-end error text.

## 0.5.6

- **Theme-aware diagnostics:** version and live turn telemetry now use VS Code theme foreground tokens with contrast-safe fallbacks.
- **Resilient Hybrid recommendations:** a failed or truncated frontier synthesis now falls back to an evidence-grounded local synthesis, except after an explicit cancellation, deadline expiry, or exhausted local-generation budget.

## 0.5.5

- **Trust boundaries:** workspace paths are canonicalized before I/O; repo-owned permission/hook files are restrictive-only; user grants persist outside the repository; broad wildcard approvals are rejected; `run_verification` requires explicit approval and confirmed skip reasons.
- **Cancellation everywhere:** Stop aborts shell, verification, and grep work; pending questions, permissions, and plan handoffs resolve on cancel.
- **Faster, leaner turns:** lazy shadow-git checkpoints (no empty commits on read-only turns); removed mandatory local self-grade; grounded recommendation drafts skip rewrite; split frontier consult/completion budgets; real verification evidence in final review.
- **No silent context loss:** removed turn-windowing; compaction uses its own generation budget and also triggers on long histories.
- **UI and persistence:** chat-scoped live events; debounced per-chat storage; coalesced multitask snapshots; incremental symbol-index updates; configurable agent budgets; extension CI job.

## 0.5.4

- **Shared turn budgets:** every mode has an end-to-end deadline and local-generation cap; recommendation exploration, judging, synthesis, continuation, and shell execution consume the same deadline.
- **Responsive Hybrid cancellation:** Stop aborts frontier judge/rewrite requests, and failed Hybrid calls no longer fall back to the slow local model.
- **Visible diagnostics:** the chat shows the running extension version and live phase telemetry for generations, exploration, judge/synthesis duration, tokens, retries, and deadline remaining.
- **Evidence-chain validation:** recommendation evidence distinguishes discovery from exact reads; absence claims require a discovered path followed by an exact read. Judge output includes structured rejected claims and evidence IDs.
- **Cleaner thoughts and stronger tests:** orphan reasoning is discarded unless parsing yields a valid tool/final event. Fake-clock/fake-model integration tests cover exploration limits, deadline propagation, local-fallback prevention, cancellation, and truncation safety.

## 0.5.3

- **No restart on synthesis truncation:** final synthesis starts with a 4,096-token ceiling (providers stop naturally when complete). If the provider still reaches its limit, the harness retains the partial answer and requests only the continuation.
- **Safe continuation stitching:** up to two 2,048-token continuation chunks are overlap-deduplicated and appended. A failed or repeatedly truncated continuation returns an explicit failure—never a silently partial answer.

## 0.5.2

- **Separate final synthesis budget:** the 768-token recommendation cap applies only to local tool-loop JSON/drafts. Final recommendation prose always runs through a separate synthesis call (1,800 tokens for Hybrid, configured budget or larger locally).
- **Truncation detection across backends:** daemon `max-tokens`, OpenAI-compatible `finish_reason: length/max_tokens`, and Hybrid provider stop reasons propagate as `truncated`.
- **Complete-answer safety:** truncated final synthesis is detected rather than silently returned.
- **No partial tool envelopes:** truncated loop JSON is discarded and retried concisely; after two truncations the turn stops with a clear message. Recommendation truncation goes directly to evidence-grounded final synthesis.

## 0.5.1

- **Evidence-grounded recommendation judge:** successful exploration results are labeled (`[E1]`, `[E2]`, …) with source tool/path and supplied to both judge and rewrite.
- **Factual rejection:** the judge must return `factuallyGrounded`; unsupported absence claims, contradictions, and uncited current-state claims force a rewrite. Malformed judge output fails closed.
- **Frontier factual rewrite:** factually inadequate drafts route through the configured Hybrid frontier rewrite with evidence as the source of truth; rejected drafts are never returned as a fallback.
- **Hard exploration bounds:** recommendation turns stop local exploration after 3 successful search/read calls or 90 seconds, then synthesize from gathered evidence. Per-generation timeout consumes that same wall-clock budget.
- **Substance over formatting:** judge instructions explicitly ignore headings, list length, scorecard shape, and rhetorical polish as quality evidence.

## 0.5.0

- **Faster recommendation finishes:** when Hybrid is configured, semantic judging and feedback rewrites run on the selected frontier model instead of adding 70B local passes.
- **Removed redundant self-grade:** recommendation answers no longer run a second local semantic grade after the dedicated recommendation judge.
- **Bounded local generation:** recommendation tool-loop envelopes cap output at 768 tokens, preventing malformed JSON turns from consuming the full 2,048-token answer budget.
- **Bounded exploration guidance:** broad harness audits target at most three high-signal files unless critical evidence is still missing.

## 0.4.99

- **Judge-primary recommendation finish:** removed brittle shallow/vague keyword gates from the loop; substance (robust vs one-liner advice) is scored by the LLM judge + one feedback rewrite. Deterministic guards remain only for obvious non-answers (empty, doc handoff, apologies).
- **Carry-forward from 0.4.98:** reply list normalization (comma-separated `1., 2.` → line breaks), markdown tables in final replies, harness improvement prompt guidance, scope-narrowing question block.

## 0.4.98

- **Fix: reply list formatting:** comma-separated `1. …, 2. …` summaries are normalized to one item per line; markdown tables render in final replies.
- **Fix: shallow harness recommendations:** refuse or rewrite generic one-liners per file ("add more logging", "consider exposing options"); harness asks now prompt for Priority gaps / Bottom line sections with concrete file-level fixes.
- **Richer harness rewrite:** recommendation finish path uses structured markdown (sections, optional scorecard table) and higher token budget for agent-harness improvement asks.

## 0.4.97

- **Fix: vague recommendation answers:** refuse `step_complete` summaries that praise architecture or say "focus on optimizing performance" without file-grounded numbered recommendations; LLM judge rewrite path triggers on vague drafts too.
- **Fix: harness improvement intent:** "How can I improve the agent harness" now matches recommendation routing (previously missed because `improve` preceded `harness`).
- **Fix: scope-narrowing questions:** `ask_user_question` is refused on broad improvement asks (e.g. "What specific areas…?") — agent must answer across loop, tools, prompts, permissions, and UI.
- **Fix: question card UI:** resolved question cards no longer duplicate the prompt or answer blocks.

## 0.4.96

- **Fix: streaming thoughts:** reasoning tokens are parsed from partial tool-call JSON via `ThoughtStreamParser` so the UI shows thought text instead of raw JSON; persisted thought blocks replay on chat reload.
- **Fix: recommendation intent gaps:** harness/improvement asks like “Tell me how this agent harness could be improved” now match exploration/recommendation routing (previously required “project/codebase/repo”).
- **Fix: doc-handoff summaries:** `step_complete` is refused when the answer mostly points at docs (“read docs/… for more”) without actionable advice synthesized from files the agent explored.
- **Fix: empty Thought rows:** live reasoning blocks with no final text are removed instead of leaving collapsed empty “Thought” entries.

## 0.4.95

- **Stall guard:** after several tool calls without progress on ambiguous Code-mode tasks, the loop nudges the model to `update_todos` or `ask_user_question` instead of continuing search loops.
- **Noisy-repo guidance:** prompts steer toward `search_symbols` first and narrowly scoped `grep` globs before broad tree scans.
- **Multitask claim enforcement:** sibling agents must call `claim_paths` before `edit_file`/`write_file`; unclaimed paths are refused.

## 0.4.94

- **Permission model breadth:** added agent profiles (`default`, `accept-edits`, `auto-approve`, `explore`) with per-tool permission defaults, wildcard command/path approvals, and outside-workspace access as an explicit approval scope (instead of hard refusal).
- **Tool-specific approval widgets:** shell approvals now render a command preview widget with cwd context; edit/write approvals keep dedicated diff previews.
- **Hooks pipeline:** added `.trie-ide/hooks.json` support for `preTool`, `postTool`, and `postAgent` hooks (deny, rewrite input args, replace outputs, rewrite/deny final summaries).
- **Streaming reasoning:** the webview now streams live reasoning chunks during generation and settles into a collapsed thought block when the model finishes.

## 0.4.93

- **Permanent permission rules:** Always allow writes to `.trie-ide/permissions.json` per workspace (commands and sensitive paths); session denies still take precedence.
- **Diff-aware approval cards:** sensitive write prompts show before/after content blocks instead of path-only previews.
- **Inline edit diffs:** expandable tool rows color −/+ lines for edit_file and write_file results.
- **Collapsible reasoning:** model thoughts render in a collapsed Thinking block by default.
- **Windows shell:** run_command uses cmd.exe on win32; `%VAR%` treated as a shell metachar on Windows.

## 0.4.91

- **In-chat permission cards:** shell commands and sensitive-path writes prompt in the chat (Allow once / Allow for session / Deny) instead of VS Code modal dialogs.
- **Expandable tool rows:** tool activity rows expand to show args and truncated output on demand.
- **Muted tool failures:** recoverable failures start as skipped (□) and escalate to ✗ only when the turn ends; user-denied actions stay skipped.
- **Question & plan persistence:** question answers and plan handoff decisions persist in the transcript and replay on chat reload; submitted answers show on the card.
- **Plan markdown preview:** plan handoff cards render markdown instead of plain preformatted text.
- **Compaction continuity:** a note in the turn accordion shows tokens freed and recent turns kept after compaction.

## 0.4.90

- **Sensitive-path write gate:** normal workspace edits auto-allow; `.env`, keys, credentials, and `.git/hooks` prompt Allow once / Allow for session / Deny with exact-path session memory.
- **Safer shell session allow:** commands with shell metacharacters (`&&`, `|`, `;`, etc.) require exact session match; simple commands use argv-safe prefix matching so approving `npm test` cannot cover `npm test && …`.
- **Diff-only hybrid evidence:** final-review evidence no longer auto-runs package scripts; the model uses `run_verification` explicitly when checks are needed.
- **In-chat ask_user_question:** multiple-choice questions render as chat cards (with Other) instead of VS Code Quick Pick modals.
- **Full plan mode:** persisted plans under `.trie-ide/plans/` via `update_plan`; `exit_plan_mode` shows a plan card (Execute / Stay in Plan / Open plan) and Execute enqueues a Code turn with the approved plan.
- **Compaction tokens:** compaction threshold prefers backend-reported token counts when available.

## 0.4.89

- **Transactional compaction:** memory compaction summarizes a copy of history and only commits on success; recent user tasks stay verbatim; failed summarization drops whole oldest rounds instead of hard-clobbering the live transcript.
- **Truncation protocol:** `read_file` / `grep` / `run_command` results include total-lines, caps, and `next:` paging hints so the model can continue instead of re-reading blindly. Large files default to a 400-line first page.
- **ask_user_question:** new tool for multiple-choice clarifications (Quick Pick) when product intent or ambiguity blocks progress.
- **Session shell permissions:** `run_command` offers Allow once / Allow for session / Deny; session decisions are remembered by command pattern.
- **Create-only write_file + scratchpad:** `write_file` refuses to overwrite existing project files (use `edit_file`); `.trie-ide/scratchpad/<session>/` allows throwaway overwrites.
- **Lazy AGENTS.md:** reading a file injects undiscovered nested `AGENTS.md` instructions for that directory tree once per session.
- **Undo = files + conversation:** restoring a turn checkpoint also rewinds model turns and the chat transcript to before that turn.
- **Safer hybrid evidence:** final-review verification runs package scripts via `execFile` (no `/bin/sh -lc`).

## 0.4.88

- **Release packaging:** ships LLM-as-judge recommendation finishes (light intent routing, judge + one feedback rewrite, no fixed recommendation template).

## 0.4.87

- **LLM-as-judge for recommendations:** recommendation asks use a light intent note only (no fixed “4–7 bullets” template). At finish, an LLM judge scores whether the draft is actionable advice; if not, one rewrite uses the judge’s feedback. Deterministic keyword checklists and hardcoded fallback recommendation lists are gone.

## 0.4.86

- **Prompt routing for recommendations:** recommend/suggest/improve asks get an explicit turn brief up front (explore briefly → prioritized advice in `step_complete.summary`) so the model handles the ask correctly instead of relying on post-hoc refusal/rewrite loops. Synthesis remains only as a last-resort safety net.

## 0.4.85

- **Durable recommendation finishes:** when a recommend/improve ask ends in an architecture dump or `step_failed` apology, the harness does one focused rewrite from exploration notes and always returns a real recommendations answer — no refusal loops, no red “I failed” replies.

## 0.4.84

- **Fix: recommendation asks ending in red apologies:** refuse `step_failed` meta-failures (“I failed to provide recommendations…”) and nudge the model to `step_complete` with concrete advice. Clarifies Ask/Plan is read-only and answering in summary is enough. Caps architecture-dump refusals so the turn cannot loop into abandonment.

## 0.4.83

- **Fix: recommendation asks get advice, not architecture dumps:** when the user asks for recommendations/improvements, `step_complete` summaries that only map files/responsibilities (no should/recommend/improve advice) are refused and the model must return concrete prioritized recommendations.

## 0.4.82

- **Indexing works automatically:** `index.onStartup` defaults to on, and toggling Enable / Index-on-open starts a build immediately (no reload, no waiting for the first `search_symbols`).
- **Fix: stale index after agent edits:** file create/change/delete watchers keep the trie current for `write_file` and external edits, not only editor saves.
- **Fix: rebuild race:** in-flight builds are generation-cancelled so Rebuild / overlapping warm-ups cannot corrupt the trie.
- **Fix: multi-root scope:** indexing is scoped to the primary workspace folder via `RelativePattern`.

## 0.4.81

- **Release packaging:** ships durable line-anchored `edit_file`, harness-assisted search recovery, plan-artifact parse/lint improvements, reply markdown blocks, and lazy-summary guards from the 0.4.78–0.4.80 cycle.

## 0.4.80

- **Durable edit_file:** preferred path is `startLine`/`endLine` + `replace` after `read_file` — no retyping file bytes. Search+replace remains for short unique snippets. On search miss, the harness returns the exact nearest lines plus a ready-to-use line-anchored retry. Fuzzy auto-apply removed in favor of this durable path.
- **Plan artifact parsing:** truncated JSON is salvaged via `tryCloseTruncatedJson` before schema errors; failures name the cause (truncated vs schema vs lint); `risks`/`out_of_scope` are optional; action/file paths must be workspace-relative; parse-time lint rejects empty/whitespace fields and bad verification shapes.

## 0.4.79

- **edit_file just works:** a new locate tier accepts a unique near-match when the model's `search` drifts slightly from the file (a trailing comma, one reflowed line) — the search only locates the range, the original file bytes are replaced, and the result reports which lines drifted. Exact and whitespace tiers still win first; ambiguous or low-similarity searches are still refused.
- **Truncated edits never applied:** tool output cut off mid-`search`/`replace` by the token limit is no longer force-closed into a chopped edit; the model is told to re-issue with a shorter search block.
- **Short-search guidance:** edit_file description, failure recovery, and repair prompts now steer the model to search for only the 3-8 lines being changed instead of whole functions.
- **Reply markdown blocks:** headers (`###`), numbered lists, and bullet lists in final replies now render as real headings and lists instead of raw text.

## 0.4.78

- **Fix: lazy step_complete answers:** the agent now refuses placeholder summaries (`Here are ...`, teaser text) and recommendation requests that skip codebase exploration. The model must read/search the repo first, then finish with a real answer.
- **Empty turn accordions hidden:** turns with no tool activity no longer show a bare "Worked for Ns" accordion — only turns with exploration, edits, commands, todos, or hybrid notes keep the activity chip.

## 0.4.77

- **Assistant reply formatting:** final summaries now render inline markdown — `**bold**`, `*italic*`, `` `code` ``, and links — instead of showing raw markers.
- **Fix: malformed tool calls:** the agent parser no longer grabs bare `{path, startLine}` args objects as the tool call (which produced `Unknown tool: undefined`). It now picks the best `{thought, tool, args}` envelope, recovers args-only payloads, accepts alternate field names (`action`, `arguments`), and handles OpenAI native `tool_calls` streams on LLM API backends.
- **Turn accordions closed by default:** "Worked for…" and nested exploration/edit groups start collapsed; expand to inspect.
- **Trie savings per search:** purple "Trie saved …" chips now appear on the grep/search row that used the symbol index, instead of accumulating in the turn header where they are easy to miss while scrolling.

## 0.4.76

- **Fix: header toolbar clicks:** the Image… composer menu item no longer crashes webview init (missing checkmark on a non-toggle row), so Connect, Settings, History, and New chat stay wired. Header listeners register first so a later init error cannot leave them dead.
- **VS Code theme sync:** chat and settings webviews follow the editor light/dark theme and update live when you change color theme.

## 0.4.75

- **Composer overlay fix:** the image drop target stays hidden during normal chat and appears only while an image file is dragged over the composer.

## 0.4.74

- **Image attachments (release):** ships composer drag-and-drop, paste, file picker, thumbnail chips, user-bubble previews, and multimodal LLM API inference with vision-aware gating for local and cloud backends.

## 0.4.73

- **Image attachments in the composer:** drag-and-drop, paste, or pick images from the **+** menu. Thumbnails appear above the input and in the user bubble when sent.
- **Vision-aware gating:** LLM API / hybrid backends send multimodal `image_url` payloads to vision-capable cloud or local OpenAI-compatible servers (Ollama, LM Studio, etc.). Non-vision local models and the embedded daemon are blocked with clear errors until local VL inference is wired.

## 0.4.72

- **True parallel Multitask:** Architecture, Implementation, and Verification agents now start together instead of waiting on each other. API/hybrid backends run up to six concurrent model turns; daemon backends still serialize generation but keep isolated worktrees.
- **Git worktree isolation:** code-mode Multitask provisions one worktree per sibling under `.trie-ide/multitask/…`, commits child edits on `trie/mt/…` branches, and merges them back into the primary workspace when all children finish.
- **Sibling messaging and path claims:** Multitask children can `post_finding`, `read_sibling_updates`, and `claim_paths` / `release_paths`. Mutating tools refuse paths claimed by another sibling to reduce merge conflicts.
- **Hybrid decompose hang fix:** frontier decomposition now times out after 30s and is skipped for Multitask children so runs no longer stall indefinitely on “Breaking the task into steps…”.

## 0.4.71

- **Repository-local web-search gate:** configured web search is now authorized per active user request at execution time. Ordinary implementation, debugging, architecture, and repository exploration remain local after no-match searches; explicit web research and current external facts still work.
- **New-feature discovery pivot:** add/implement/build requests treat absent feature symbols as expected, bound repeated equivalent searches, and direct the agent to composer/webview/provider or other integration files before planning or editing.
- **Hybrid stuck recovery and bounded generation:** repeated no-result discovery, denied unnecessary web search, and generation timeouts trigger at most one Hybrid recovery instruction per turn when configured, inject it into the local transcript, and continue. Generation now times out clearly instead of leaving “Planning next moves…” active indefinitely.

## 0.4.70

- **Smart rendered-UI verification:** the agent now distinguishes consequential UI/webview behavior from cosmetic presentation, proactively finds and uses existing visual/e2e/component harnesses, and creates a narrow reusable harness only when rendered behavior cannot otherwise be verified.
- **Safe harness execution and artifacts:** `run_verification` accepts existing UI, e2e, visual, Playwright, Cypress, Storybook, and harness package scripts while preserving package-script allowlisting; optional workspace artifact paths report screenshots and preview text reports. Later edits still invalidate prior evidence.

## 0.4.69

- **Real coordinated Multitask agents:** prompts that explicitly request multiple agents now launch isolated child `AgentSession`s with distinct roles, serialize inference safely through the provider-owned queue, pass structured sibling findings forward, and finish with a coordinator synthesis.
- **Cursor-style active agents panel:** the compact floating **N Working** pill expands into one responsive lifecycle row per real child/coordinator, with animated dot-grid activity, collision-proof title/action regions, individual Stop actions, Stop All, and an independent collapse control.

## 0.4.68

- **Restored classic hammer icon:** brought back the recognizable single-color outline hammer/pick geometry from the original 0.4.2 extension instead of the indistinct blob-shaped replacement.

## 0.4.67

- **Complete Multitask experience:** purple styling now spans the inline starting/waiting lifecycle, steering arrow, and compact **N Working** pill with an expandable task panel and **Stop All**. Provider-owned per-chat runtimes preserve navigation, isolate cancellation, and process concurrent prompts FIFO.
- **Durable activity and subagent results:** persisted chats replay full tool, Hybrid, review, and file-change activity; finished subagents appear in an accordion with their actual results. Older histories cannot recover activity that earlier versions did not persist.
- **More reliable autonomous work:** hardened `edit_file` matching and pragmatic verification improve completion without brittle ceremony. Audit fixes scope **Stop All** to the active chat, reject stale steering, track `run_command` mutations, resolve package paths safely, and serialize chat-store writes.

## 0.4.66

- **Purple Multitask styling:** updated the active chip, activity and queue statuses, spinner, running-task accents, and composer placeholder/focus treatment to match Cursor's soft purple Multitask UI while keeping Plan and Ask neutral and preserving Hybrid styling.

## 0.4.65

- **Strict Code-only Multitask:** restoring active background tasks after a webview reload now also forces Code mode, closing the final path that could show Multitask alongside Ask or Plan.

## 0.4.64

- **Code is implicit:** removed Code from the **+** menu because it is the default state reached by dismissing Plan or Ask.
- **Coding-only Multitask:** enabling Multitask exits Plan/Ask and returns to Code; selecting Plan or Ask turns Multitask off.
- **Neutral composer copy:** "Coordinate parallel work…" uses the normal placeholder color instead of orange.

## 0.4.63

- **One mode picker:** Code, Plan, Ask, and Multitask now live exclusively in the composer **+** menu; the duplicate segmented Code/Plan/Ask control was removed.
- **Active-mode chips:** Plan and Ask appear as dismissible neutral chips beside **+**; Multitask keeps its orange chip. Code is the default and intentionally has no chip.

## 0.4.62

- **Interactive background agents:** Multitask submissions now enter a provider-owned FIFO task runner instead of a fragile webview-only queue. Each task has an isolated agent session and explicit Queued, Working, Done, Failed, or Cancelled state.
- **Integrated task UX:** the composer shows active/recent background agents with live status, queued and running agents can be cancelled individually, and each launched agent gets an expandable transcript row showing its prompt and lifecycle.
- **Safe local execution:** agents run one at a time because the embedded daemon has one inference slot and concurrent workspace edits would race checkpoints. Users can still submit more tasks while an agent is working.

## 0.4.61

- **Multitask mode picker (Cursor-style):** composer **+** menu lists Code, Plan, Ask, and **Multitask** with a checkmark on the active choice. Selecting Multitask shows an orange chip beside **+** (dismiss with ×) and switches the placeholder to "Coordinate parallel work…".
- **Explicit opt-in:** Multitask no longer auto-enables from the queue card — you turn it on from **+** first. While Multitask is active, **Send** stays available during a running turn so follow-ups queue immediately; **Stop** hides until you exit Multitask.

## 0.4.60

- **Hybrid guidance is a plain accordion row** — removed the legacy purple card CSS whose `.guide` selector was still boxing the new accordion rows.
- **Rainbow hybrid titles:** "Guidance from Hybrid · …" titles render in the rainbow gradient; the gradient animates only while checking.

## 0.4.59

- **Hybrid guidance always readable:** the guidance accordion body shows exactly the note the frontier model sent back — the same text injected into the local model's conversation. Approvals with no note render "Looks good — no changes requested." instead of an empty body, and the row meta shows ✓ (approved) or ! (concern).
- Empty advisory notes are no longer injected into the local model's conversation.

## 0.4.58

- **Fix: Files Changed card invisible in long chats.** `#messages` is a flex column; once the conversation grew taller than the panel, flex compressed the review card (the only child with `overflow: hidden`) to ~11px. Chat items no longer flex-shrink, so the Keep/Undo review card always renders at full height.
- **Fix: webview error on tool rows without a thought** (`thought.trim` on undefined) surfaced while reproducing the review-card bug in a browser harness.

## 0.4.57

- **Hybrid accordion:** guidance/review rows use the same nested accordion style as Explored/Edited groups — no bordered card, no Done badge. Rainbow animation applies only to the checking title text.

## 0.4.56

- Release bump bundling Hybrid accordion status UI (0.4.55), smart Hybrid routing (0.4.54), and branded hammer restore (0.4.53).

## 0.4.55

- **Visible Hybrid checks:** Hybrid activity is nested inside the active turn accordion and remains visible after completion.
- **Provider-aware status:** while running, the row reads `Checking with Hybrid · <provider> · <model>` using the user's active frontier model.
- **Text-only animation:** the checking label receives a restrained animated rainbow gradient; the card and border remain static.

## 0.4.54

- **Hybrid routing:** greetings, thanks, pings, and other trivial conversational turns never call the frontier model.
- **Local-first finish check:** the local model self-grades first. Confident plain answers and confidently completed work stay local; Hybrid is reserved for low-confidence results, substantive changed-work review when grading fails, uncertainty, or genuinely stuck loops.

## 0.4.53

- **Restore branded hammer:** activity bar uses the original Trie hammer SVG geometry introduced in 0.3.8.

## 0.4.52

- **Fix: activity bar hammer:** replaced the ambiguous solid diagonal glyph with a recognizable 24px hammer outline whose head, claw, and handle remain distinct in VS Code's activity bar.

## 0.4.51

- **Fix: webview controls:** initialize multitask state before updating the composer placeholder. The earlier initialization order threw a `ReferenceError` and prevented all chat controls—including Connect, Settings, History, and New chat—from attaching click handlers.

## 0.4.50

- **Header toolbar:** Connect, Settings, History, and New chat are icon-only buttons with tooltips; New chat uses a bordered + button.
- **Hybrid chip:** clearer dropdown caret (CSS chevron instead of faint unicode glyph).
- **Fix: header clicks:** Hybrid dropdown menu moved outside the chip button (invalid HTML was breaking layout and blocking Connect/Settings clicks).
- **Fix: activity bar icon:** cleaned up `hammer.svg` (removed comment, explicit 24×24) so the sidebar hammer icon loads reliably.

## 0.4.49

- **Multitask UI (Cursor-style):** Code-mode follow-up queue now has a collapsible multitask card above the composer — **N Queued**, send hint, file-icon rows with truncated previews, and a spinner + **Starting Multitask** / **Working…** header while tasks drain. Click **Start Multitasking** to enter multitask mode: orange **Multitask** activity badge with **Planning next moves…** / **Running N tasks…**, plus a purple **Multitask ×** pill on the composer (placeholder becomes "Coordinate parallel work…"). Queued items briefly pulse as **starting** before each follow-up dispatches. Exit multitask with the pill ×; queue still auto-drains when multitask is off.

## 0.4.48

- **Multi-provider hybrid mode:** configure up to **3 frontier providers** (OpenAI, Anthropic, Moonshot), each with up to **3 saved model names**. Settings → Hybrid mode shows collapsible provider slots with API key, model list, and default-model radio.
- **Hybrid chip dropdown:** the chat header **Hybrid** chip is now a dropdown — toggle hybrid on/off and pick the active frontier model (`OpenAI · gpt-4o`, etc.) for this session. Selection is saved to settings.
- **Backward compatible:** legacy `frontierAssist.provider` / `model` / `apiKey` settings migrate into slot 0 on read.

## 0.4.47

- **Fix: codebase indexing settings persist:** `index.enabled`, `index.onStartup`, `index.maxResults`, and `index.scoreThreshold` are `scope: resource` keys — they now save to the workspace folder (`.vscode/settings.json`) via `ConfigurationTarget.WorkspaceFolder` with a URI-scoped configuration object, and load through the same scoped read path. Fixes the settings panel checkbox resetting after reload. Falls back to user settings with a notice when workspace settings are not writable.

## 0.4.46

- **Codebase indexing status:** Settings → Codebase indexing now shows a clear four-state flow — **Not indexed yet** (grey), **Indexing…** with live file progress (`42 / 847 files`), **Indexed ✓** (green, brief flash on completion), then **Indexed** with file/symbol counts and build time. Status updates live when indexing runs on workspace open or from agent symbol search, not only when you click Rebuild.
- **Settings:** Hybrid mode card — removed advisor badge, shorter one-line description.

## 0.4.45

- **Token gauge + memory compaction:** the composer's bottom-right corner now shows live context usage (`12.4k · 38%`) from real backend token counts — amber past 75%, red past 90%. When the conversation passes 75% of the context window (daemon: your configured context length; API backends: assumed 32k), older turns are automatically summarized by the local model and spliced into a compact memory note — a "Compacting…" pulse shows while it runs, then "freed Xk". Click the gauge to compact manually anytime.

## 0.4.44

- **Todos in the turn accordion:** removed the always-visible Todos strip above the composer. Task lists now live inside the **Worked for…** accordion as a collapsible **Todos** group — collapse the turn or the todos section to hide them.

## 0.4.43

- **Activity stream:** removed per-row **trie** badges on grep/search tool rows. Trie speed is still summarized once per turn in the header ("trie saved Xms") when the symbol index was used.

## 0.4.42

- **Summary vs review card:** the final reply text is model prose — it is not proof files changed. The **N Files Changed** card only appears when shadow-git (or successful edit tools) detect real diffs. The agent is now refused if `step_complete` claims file edits without a successful `edit_file`/`write_file`. If a mismatch still slips through, a notice is shown and the reply is marked failed. Review card now renders **above** the summary when changes exist.

## 0.4.41

- **Hybrid UI — minimal:** removed rainbow gradient borders and animated styling. Decompose now shows an numbered **Hybrid · subtasks** list with the actual injected steps (and rationale). Empty "frontier consult finished" placeholder cards are dropped.

## 0.4.40

- **Review card reliability:** the "N Files Changed" card only appears when files actually changed on disk. The agent is now blocked from calling `step_complete` on edit tasks until `edit_file`/`write_file` succeeds — stops hallucinated "I updated X.swift" answers with no real edits. Fallback review card when tools report edits but shadow-git diff is empty. Turn +/− stats no longer count failed edits.

## 0.4.39

- Release build.

## 0.4.38

- **Web search actually runs:** detects research/docs/internet questions and auto-runs `web_search` before the model loop (shows a **Web search** accordion in the activity stream). Blocks `step_complete` until search has run. Fixes Ceramic API response parsing (`result.results` was ignored, so searches returned empty).

## 0.4.37

- Release build.

## 0.4.36

- **Web search behavior:** the agent is now explicitly prompted to call `web_search` for research papers, external docs, and anything outside the repo — and to return full URLs in its answer instead of keyword lists. Final replies linkify `https://…` URLs so they are clickable. Requires Web search configured in Settings (Exa, Tavily, or Ceramic).

## 0.4.35

- **Codebase indexing — per project:** index data and settings (enable, index-on-open, score threshold, max results) now scope to the open workspace folder. Status shows the workspace name. Removed the trie badge from the settings card.

## 0.4.34

- **Fix: Hybrid card flicker** — the rainbow Hybrid card no longer disappears when the frontier consult finishes. It persists as a collapsible accordion (click the header to collapse/expand), transitions from “Checking…” to the guide note in place, and stacks one card per consult per turn.

## 0.4.33

- **Hybrid mode:** Moonshot AI (Kimi) added as a frontier provider alongside OpenAI and Anthropic. Uses the Moonshot OpenAI-compatible API; default model `kimi-k2-0711-preview`.

## 0.4.32

- Release build.

## 0.4.31

- **Hybrid mode v2 (research-backed):** four upgrades to frontier escalation — (1) evidence-grounded final review runs typecheck/tests locally and sends diff + pass/fail output to the frontier reviewer; (2) AutoMix-style local self-grade before finish, consulting frontier only when confidence is low; (3) token-uncertainty mid-turn escalation from daemon generation confidence + loop heuristics; (4) MinionS-style frontier decomposition for large tasks (atomic subtasks the local model executes in order). Per-turn hybrid telemetry logged to Output → Trie Coding Agent. README documents expected cost/quality gains.

## 0.4.30

- **Multi-word symbol search:** `search_symbols` now handles concept-ish queries like "auth token" by splitting the query into words and scoring symbols by subword coverage (`validateAuthToken` matches at ~0.7). Previously multi-word queries returned nothing. True synonym matching ("auth logic" → `validateCredentials`) still needs an embedding layer — planned as a hybrid on top of the same trie index, not a replacement.

## 0.4.29

- **Chat history:** chats now persist across reloads. A new History button in the header opens a full-pane list with fuzzy search, a Workspace: Current/All filter, and Newest/Oldest sort. Click a chat to reopen it — the transcript is replayed and the conversation continues with its full LLM context. Hover a row to delete that chat (✕); deleting the open chat simply starts fresh on the next message. Up to 100 chats are kept, stored locally in extension storage.

## 0.4.28

- **Search score threshold — powered by the trie, not embeddings:** symbol search now scores matches lexically (1.0 exact, ~0.75–0.95 prefix, ~0.65 word initials like `wsi` → `WorkspaceSymbolIndex`, ~0.5–0.65 substring, ~0.35–0.5 typo-tolerant via a bounded edit-distance walk over the trie). A new slider in Settings → Codebase Indexing (default 0.40) filters results by score: raise it for exact-ish only, lower it for fuzzier hits. Every score is explainable — no similarity black box.

## 0.4.27

- **Follow-up queue in all modes:** type while the agent is working and Enter queues the message instead of being ignored. A Cursor-style card above the composer shows "N Queued · ⏎ to Send" with previews; items can be removed individually. Queued follow-ups run automatically (with the mode they were typed in) as each turn finishes. Pressing Enter on an empty composer sends the next queued item now by stopping the current turn. Code-mode queues get a "Start Multitasking" menu with Send now and Clear queue.

## 0.4.26

- Welcome screen: removed the "Get started — pick one" hint block.

## 0.4.25

- **Codebase Indexing settings:** the trie symbol index is now user-visible and configurable. New Settings card with an enable toggle, live status (Standby / Indexing… / Indexed with file, symbol, and build-time counts), index-on-workspace-open option, max symbol results per search, and a Rebuild button. When disabled, `search_symbols` and the `grep` trie fast path politely step aside. Defaults unchanged: enabled, lazy build on first search.

## 0.4.24

- **Trie speed evidence, measured not estimated:** identifier `grep` runs both the trie lookup and the full content scan in the same call, and both are now timed. The trie pill shows real numbers (`trie <1ms · 214× faster`), and the turn header gets a purple **trie saved 1.2s** chip accumulating the measured difference across the turn. `search_symbols` shows its lookup time too.

## 0.4.23

- **Task lists for complex asks (Code mode):** the system prompt now tells the model to plan 3+-step work with `update_todos` first and check items off as it goes. The list renders inline in the activity stream as a Cursor-style checklist (**Created to-do list** → **Updated to-do list**, ✓ strikethrough for done items), updating in place instead of only living in the pinned panel.
- **Copy:** marketplace description and README trimmed; "OpenAI-compatible" → **LLM API** everywhere user-facing.

## 0.4.21

- **Copy:** replaced user-facing "OpenAI-compatible" with **LLM API** in the marketplace description, settings UI, backend chip, README, and setup prompts. Internal setting key unchanged (`trie-ide.backend: openai-compatible`).

## 0.4.20

- Release build.

## 0.4.19

- **Undo in the composer:** after a turn that changed files, **↺ Undo** appears next to Send in the prompt box — same checkpoint restore as the review card. Clears after Keep, a successful undo, or New session.

## 0.4.18

- **Cursor-style message layout:** your prompts stay in a right-aligned bubble; the agent's final reply is plain text on the panel background — no assistant chat bubble.

## 0.4.17

- **Trie indicator: static and persistent.** Removed the animated rainbow text on trie rows (it flickered). `search_symbols` and identifier `grep` calls now show a stable purple left bar + **trie** pill from the moment the tool starts — no pop-in on completion.

## 0.4.16

- **Fix: tool arg type errors.** Local models sometimes emit numbers/booleans instead of quoted strings for `query`, `replace`, `search`, etc. Those are now coerced to strings instead of failing with "`query` must be a string".
- **Fix: Review button visibility.** Review is now a blue text link (`#2563eb`) with no black fill — overrides the global button style that was rendering it invisible.
- **Hybrid rainbow card:** when Hybrid is checking or returns a guide note, it now appears as a full-width rainbow-bordered card at the message level (not buried inside the nested activity accordion).

## 0.4.15

- **Review card matches the Cursor design (light):** seamless card with no internal separators, filename-only rows with per-file **+/−** stats right-aligned, and image/Swift file badges (`▨ AppIcon.png`, `SW PostcardTheme.swift`). Keep is now a soft green button.
- **No black buttons:** the base button style is now white with a border (Send, Connect, Settings, New, welcome hints) — no more near-black `#262626` fills anywhere in the panel.

## 0.4.14

- **Fix: tool errors no longer kill the turn.** A missing `await` in the tool dispatcher let async failures (e.g. `read_file` on a nonexistent path → `ENOENT: stat …`) escape the error handler and abort the whole turn with a red banner. They now come back to the model as a normal ✗ tool result it can recover from.
- **Fix: clearer backend-down error.** A bare `fetch failed` now reads "Could not reach the model backend — the local server may have stopped; check it, then use Connect and retry."
- **Fix: no more double "explored" header.** The top-level turn label no longer repeats the nested **Explored N files** group; explore-only turns finish as **Worked for Xs**, matching Cursor.
- **Fix: errored turns close the accordion** instead of leaving it stuck on "Working…".

## 0.4.13

- **Rainbow trie rows:** when a search is answered by the prefix-trie symbol index (`search_symbols`, or `grep`'s identifier fast path), the row in the nested activity view gets an animated rainbow label and a **⚡ trie** badge — instant index hits are visibly different from full file walks.

## 0.4.12

- **Review card matches Cursor:** header is now **N Files Changed · Review** (Review opens a before ↔ after diff for every file); more than 4 files collapse behind a **⋯ Show N more** row.
- **Checkpoint diagnostics:** a new **Trie Coding Agent** output channel logs every checkpoint snapshot and diff; if a checkpoint can't be taken (git missing, snapshot error), the chat now shows a small notice instead of silently skipping the review card.

## 0.4.11

- **Nested activity accordion:** agent tool calls now render in a Cursor-style collapsible hierarchy — top-level **Worked for Xs / Editing N files +29 −2**, nested **Explored N files**, **Edited filename**, and **Ran N commands** groups with compact rows (`Read package.json L1-55`, `Thought for 1s`, etc.) instead of flat tool cards.

## 0.4.10

- Release build.

## 0.4.9

- **Review card (Keep / Undo):** after any turn that edits files, an interactive **N Files Changed** card appears at the end of the response — per-file **+added / −deleted** stats with file-type badges, click any row to open a before ↔ after diff, then **✓ Keep** to accept or **↺ Undo** to revert the whole turn to its pre-turn checkpoint. Replaces the old plain "Restore checkpoint" button.

## 0.4.8

- **Hybrid chip:** capital **Hybrid** with a layers icon (local model + frontier review stack) — no wand or sparkle clichés.

## 0.4.7

- **Nested exploration UI:** consecutive read-only tools (`grep`, `glob`, `read_file`, `list_dir`, `search_symbols`, `web_search`) collapse into a single collapsible **Explored · N** group — less noise, same detail on expand. Mutating tools (`edit_file`, `write_file`, `run_command`) still get full cards with reasoning.
- **Hybrid always reviews:** when Hybrid mode is on, the frontier model now checks **every** completed turn (not only mutating ones). A pulsing **Hybrid · reviewing local work…** banner shows while it reads the transcript; the review card follows with **Hybrid · review of local work**. Stuck loops show **Hybrid · checking stuck loop…** then **Hybrid · suggestion for local model**. The local model still runs every tool; hybrid only advises.

## 0.4.6

- **Tries in the agent:** new `search_symbols` tool backed by a prefix-trie workspace symbol index (ported from Trie IDE) — instant "where is X declared" lookups across TS/JS, Python, Go, Rust, and Swift. `grep` also consults the trie first for plain-identifier queries, so declarations surface before content matches. The index builds lazily on first use and updates on save.

## 0.4.5

- **edit_file recovery:** when `search` doesn't match, the error now hands the model the *actual* file text — the whole file for small files (≤3 KB), or the closest-matching region (trigram similarity, ported from Trie IDE) with its line number. The model can copy exact text on the very next turn instead of guessing again.

## 0.4.4

- **Activity bar icon:** clearer hammer silhouette (reads at 16px — no more cube/blob).
- **Hybrid chip:** capitalized to **Hybrid**; welcome screen and README copy on cost savings with hybrid mode.

## 0.4.3

- **README:** rewritten for Marketplace — Features, Modes, and simple Install sections; removed broken banner image; clearer API settings copy (not OpenAI-only).
- **Settings descriptions:** `trie-ide.api.*` now describes any OpenAI-compatible endpoint (Ollama, LM Studio, Kimi, etc.).

## 0.4.2

- **Activity bar icon:** hammer outline (Lucide style) — matches VS Code's sidebar icon aesthetic.

## 0.4.1

- **Header chip:** the model chip is hidden until a model is actually loaded (daemon) or configured (OpenAI-compatible) — no more empty grey pill.

## 0.4.0

- **Settings page:** the sidebar **Settings** button now opens a full settings UI — backend picker (embedded daemon vs OpenAI-compatible, with Ollama / LM Studio / OpenAI / Kimi presets), agent budget and sampling, hybrid mode, and web search, all saved as you edit.

## 0.3.9

- **edit_file is whitespace-tolerant:** falls back to trailing-whitespace and indentation-tolerant matching when the exact text isn't found, and re-indents the replacement to match the file. Failed edits now include a line hint so the model can recover instead of looping.
- **Web search tool:** new `web_search` tool backed by **Exa**, **Tavily**, or **Ceramic** — configure via **Settings → Configure web search…** or `trie-ide.webSearch.*`. Queries go directly from your machine to the provider with your API key. The tool is only offered to the agent when configured.

## 0.3.8

- **Sidebar icon:** activity bar uses the Trie hammer logo (`media/hammer.svg`) instead of the hex mark.

## 0.3.7

- **README:** trimmed intro; backend table and description now cover cloud LLM APIs (OpenAI, Kimi, etc.), not just local servers.
- **Marketplace description** updated to match — no longer "local-first only".

## 0.3.6

- **Lucide icons** on Code / Plan / Ask mode picker (`Bot`, `ListChecks`, `MessageCircleQuestion` — same icons as Trie IDE).
- Webview script bundled with esbuild + `lucide` (vanilla, not React).

## 0.3.5

- **Hybrid mode setup:** **Settings** button in the sidebar + **Configure Hybrid Mode** command with a guided wizard (enable, provider, API key, model).
- Settings renamed/described as **Hybrid mode** in VS Code settings (`trie-ide.frontierAssist.*`).
- Sidebar panel title is **Trie Coding Agent** only (removed redundant ": Agent").

## 0.3.4

- **Ollama / LM Studio setup in Connect:** first quick-pick option configures OpenAI-compatible backend (no `.gguf` load step).
- **Welcome screen:** Trie hammer logo + clearer two-path getting-started hint.
- **README:** "Choose your backend" table and separate Ollama / LM Studio quick starts.

## 0.3.3

- **Connect always restarts the embedded daemon** before loading a model, so a stale process from an older session cannot block loads.
- **Find Node.js via login shell** on macOS (VS Code often lacks `node` on PATH).
- **Verify load with `/v1/model/status`** after loading; surface a clear error if the daemon reports no model.

## 0.3.2

- **Fix GGUF model load:** embedded daemon now runs under system Node.js (not VS Code's Electron), so `node-llama-cpp` native bindings load correctly.
- **Fix NODE_PATH resolution:** `node-llama-cpp` is resolved via file URL from extension globalStorage (ESM ignores NODE_PATH).
- **Load progress & errors:** model load shows a percentage notification; failures surface a clear error with a link to the daemon log.

## 0.3.1

- **Fix webview black background:** inline critical CSS plus explicit white backgrounds on `html`, `body`, and `#messages` so VS Code's dark theme cannot bleed through the agent panel.

## 0.3.0

- **Modes:** Code / Plan / Ask picker in the composer. Plan explores read-only and returns a numbered implementation plan; Ask answers questions without changes. Mutating tools are refused by the loop outside Code mode.
- **Checkpoints & rollback:** every Code-mode turn snapshots the workspace into a shadow git repo (`.trie-ide/shadow.git`, never your real `.git`); a **Restore checkpoint** button reverts the agent's changes. Fail-soft when git is unavailable.
- **Workspace context:** the first prompt now includes detected project type (Node, Xcode, Swift package, Rust, Go, Python, Maven/Gradle, Ruby), a suggested verification command, and a compact two-level file tree.

## 0.2.2

- **Slim Marketplace package:** VSIX no longer bundles `node-llama-cpp` (~40 MB). Runtime downloads on first embedded-daemon use into extension storage (requires npm/Node.js).
- New command: **Install Local Inference Runtime**.

## 0.2.1

- Rename extension display name from **Trie IDE Agent** to **Trie Coding Agent** (commands, settings title, UI copy).
- Add marketplace icon (`media/icon.png`) and README banner image.

## 0.2.0

- **Embedded trie-daemon:** extension bundles and auto-starts `trie-daemon` with real `node-llama-cpp` inference — no Trie IDE desktop app or separate npm package required.
- **Server mode:** set `trie-ide.daemon.keepRunning` to expose the embedded daemon to other clients after VS Code closes.
- **External daemon:** set `trie-ide.daemon.command` to spawn your own trie-daemon binary.
- **Pick a .gguf file** in Connect for bare GGUF models without a Trie model store.
- Standalone `trie-daemon` CLI now uses `LlamaCppBackend` by default (`TRIE_FAKE_INFERENCE` for tests only).
- README leads with Ollama/LM Studio quick start; documents all three hosting modes.
- Per-platform VSIX packaging via `npm run package:platform`.

## 0.1.1

- Rebrand: remove all LocalForge references; settings and copy now use Trie IDE / trie-daemon throughout.
- Updated README and marketplace listing copy.

## 0.1.0

- Initial release.
- Agent chat view with the Trie IDE tool loop: `read_file`, `list_dir`, `glob`, `grep`, `edit_file`, `write_file`, approval-gated `run_command`, `update_todos`, `step_complete` / `step_failed`.
- Trie IDE daemon backend (`trie-daemon`, port 7841) with model store browsing, one-command model load, and grammar-constrained generation.
- OpenAI-compatible backend for llama-server / LM Studio / Ollama / cloud endpoints.
- Hybrid frontier assist: advisory-only OpenAI/Anthropic guide notes at stuck-hint and final-review checkpoints.

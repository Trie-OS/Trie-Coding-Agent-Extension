# Changelog

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

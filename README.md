# Trie Coding Agent

AI coding agent for VS Code by Trie ([trie.dev](https://trie.dev)) — run open models locally or plug in any LLM API, with a real tool loop for reading, editing, and running commands in your workspace.

## Features

- **Works alongside you:** Trie autonomously explores your codebase, reads and writes files, and runs terminal commands — always with your approval
- **Bring your own model:** Local `.gguf` via an embedded daemon, or any LLM API — Ollama, LM Studio, OpenAI, Kimi, and more
- **A real agent loop:** `read_file`, `grep`, `glob`, `edit_file`, `write_file`, `run_command`, and a live todo list — then a summary when done
- **Checkpoints & rollback:** Every Code-mode turn snapshots your workspace; one click reverts everything the agent changed
- **Workspace-aware:** Detects your project type (Node, Xcode, Rust, Go, Python, …) and scopes a file tree into the first prompt
- **Hybrid mode:** Your local model runs every tool call — a frontier model chimes in via research-backed escalation (decomposition, uncertainty, self-grade, evidence-grounded review). Frontier-level judgment without frontier-level token bills.
- **Web search:** Optional `web_search` tool via Exa, Tavily, or Ceramic — queries go directly from your machine with your API key

## Modes

Trie adapts to how you work:

- **Code** — full agent: edits files, runs commands (with approval), takes a checkpoint before each turn. Complex asks get a live task list the agent checks off as it works
- **Plan** — read-only exploration, then a numbered implementation plan to review before you switch to Code
- **Ask** — read-only Q&A about your codebase, no file changes

## Install

Trie Coding Agent requires VS Code **1.96.0** or later.

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Trie.trie-ide)
2. Open a folder in VS Code
3. Click the **Trie** hammer icon in the Activity Bar
4. Click **Settings** and pick your backend — or use **Connect** to load a local `.gguf`

### Ollama (easiest)

```bash
ollama pull qwen2.5-coder:7b
```

Then **Settings → LLM API → Ollama preset**, or set `trie-ide.backend` to `openai-compatible` with base URL `http://127.0.0.1:11434/v1` and model `qwen2.5-coder:7b`.

### LM Studio

Load a model, start the local server (port **1234**), then **Settings → LM Studio preset**.

### Embedded daemon (local `.gguf`)

**Connect → Pick a .gguf file.** Requires Node.js and npm on your PATH. On first use the extension downloads the inference runtime (~40 MB) into VS Code storage.

## Settings

Click **Settings** in the sidebar for a full settings page: backend, model, agent budget, hybrid mode, and web search. Everything saves as you edit.

Search **Trie Coding Agent** in VS Code settings for the raw `trie-ide.*` keys.

## Hybrid mode

Your local model does the work — reading files, searching, editing, running commands. That stays on your machine and costs nothing beyond compute.

Hybrid adds a frontier model sparingly, using research-backed escalation instead of calling the cloud on every grep:

| Signal | What it does | Based on |
| --- | --- | --- |
| **MinionS decomposition** | For large tasks, the frontier breaks the ask into atomic subtasks; the local model executes them one at a time | [Minions (Stanford, ICML 2025)](https://arxiv.org/abs/2502.15964) — 97.9% of frontier quality at 5.7× lower cloud cost |
| **Token uncertainty** | When the daemon reports low generation confidence (or the loop is flailing), one mid-turn frontier nudge fires | Cascade routing / AutoMix-style escalation |
| **AutoMix self-grade** | Before finishing, the local model scores its own work; low confidence triggers a frontier consult | [AutoMix (NeurIPS 2024)](https://arxiv.org/abs/2310.12963) |
| **Evidence-grounded review** | At turn end, Trie runs typecheck/tests locally, then sends the diff + pass/fail output to the frontier reviewer | Verifiable process rewards — cheap oracles before expensive judgment |
| **Stuck hints** | After repeated tool failures, a short frontier hint is injected as advisory text | FrugalGPT / RouteLLM cascades |

### What you get (typical Code-mode turn with Hybrid on)

These are design targets grounded in the published cascade/collaboration literature and what the extension actually measures in **Output → Trie Coding Agent**:

- **5.7–30× fewer frontier tokens** than running the whole turn in the cloud — local model owns every tool call; frontier is capped at ~6 short consults per turn
- **~85–98% cost reduction vs cloud-only agenting** on multi-step tasks (same band as FrugalGPT / RouteLLM when the local model handles exploration)
- **Higher finish quality on large asks** — decomposition recovers most of the gap between naive local-only and frontier-only (Minions reports 87% → 98% recovery)
- **Fewer bad completes** — self-grade + verification output catches “looks done but tests fail” before you accept the turn
- **Earlier recovery when stuck** — uncertainty + failure triggers consult earlier than waiting for 4 consecutive tool errors

Per-turn telemetry is logged after each run, e.g. `hybrid: 2 frontier call(s), decomposed=true, uncertainty=1, selfGrade=0.42, evidenceFiles=3`.

Enable in **Settings → Hybrid mode** (OpenAI, Anthropic, or Moonshot AI / Kimi), or run **Trie Coding Agent: Configure Hybrid Mode** from the Command Palette.

## Web search

Gives the agent a `web_search` tool for current docs, APIs, and error messages. Configure in **Settings → Web search** (Exa, Tavily, or Ceramic).

## Safety

- File operations stay inside the workspace root
- `run_command` always asks for explicit approval
- Nothing leaves your machine unless you use a cloud API, hybrid mode, or web search

Part of the [Trie ecosystem](https://trie.dev).

## License

Apache-2.0

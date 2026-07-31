# Trie Coding Agent

AI coding agent for VS Code — run open models locally or plug in any LLM API, with a real tool loop for reading, editing, and running commands in your workspace.

## Features

- **Works alongside you:** Trie autonomously explores your codebase, reads and writes files, and runs terminal commands — always with your approval
- **Bring your own model:** Local `.gguf` via an embedded daemon, or any OpenAI-compatible API — Ollama, LM Studio, OpenAI, Kimi, and more
- **A real agent loop:** `read_file`, `grep`, `glob`, `edit_file`, `write_file`, `run_command`, and a live todo list — then a summary when done
- **Checkpoints & rollback:** Every Code-mode turn snapshots your workspace; one click reverts everything the agent changed
- **Workspace-aware:** Detects your project type (Node, Xcode, Rust, Go, Python, …) and scopes a file tree into the first prompt
- **Hybrid mode:** Your local model runs every tool call — a frontier model (OpenAI or Anthropic) chimes in only when you're stuck or at the finish line. Frontier-level judgment without frontier-level token bills.
- **Web search:** Optional `web_search` tool via Exa, Tavily, or Ceramic — queries go directly from your machine with your API key

## Modes

Trie adapts to how you work:

- **Code** — full agent: edits files, runs commands (with approval), takes a checkpoint before each turn
- **Plan** — read-only exploration, then a numbered implementation plan to review before you switch to Code
- **Ask** — read-only Q&A about your codebase, no file changes

Mutating tools are hard-refused outside Code mode — not just discouraged in the prompt.

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

Then **Settings → OpenAI-compatible API → Ollama preset**, or set `trie-ide.backend` to `openai-compatible` with base URL `http://127.0.0.1:11434/v1` and model `qwen2.5-coder:7b`.

### LM Studio

Load a model, start the local server (port **1234**), then **Settings → LM Studio preset**.

### Embedded daemon (local `.gguf`)

**Connect → Pick a .gguf file.** Requires Node.js and npm on your PATH. On first use the extension downloads the inference runtime (~40 MB) into VS Code storage.

**Connect is only for the embedded daemon.** Ollama, LM Studio, and cloud APIs are configured in **Settings** — no Connect step.

## Settings

Click **Settings** in the sidebar for a full settings page: backend, model, agent budget, hybrid mode, and web search. Everything saves as you edit.

Search **Trie Coding Agent** in VS Code settings for the raw `trie-ide.*` keys.

## Hybrid mode

Your local model does the work — reading files, searching, editing, running commands. That stays on your machine and costs nothing beyond compute.

Hybrid adds a frontier model sparingly: a nudge when the local model stalls, a final read when a turn finishes. It never edits files, runs tools, or drives the loop — and it's hard-capped to a handful of API calls per turn. You spend on intelligence where it counts, not on re-explaining your codebase to GPT on every grep.

Enable in **Settings → Hybrid mode**, or run **Trie Coding Agent: Configure Hybrid Mode** from the Command Palette.

## Web search

Optional. Gives the agent a `web_search` tool for current docs, APIs, and error messages. Configure in **Settings → Web search** (Exa, Tavily, or Ceramic).

## Safety

- File operations stay inside the workspace root
- `run_command` always asks for explicit approval
- Nothing leaves your machine unless you use a cloud API, hybrid mode, or web search

Part of the [Trie ecosystem](https://trie.dev).

## License

Apache-2.0

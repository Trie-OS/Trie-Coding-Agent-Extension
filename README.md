# Trie IDE Agent

A local-first coding agent for VS Code. Run agent loops — read, search, edit, run commands — powered by open GGUF models running **100% on your machine**, with an optional *hybrid* mode where a frontier model quietly reviews the local model's work.

Part of the [Trie OS](https://github.com/Trie-OS) ecosystem. Works with the Trie IDE desktop app and open models you download from Hugging Face — no cloud, no API keys, no subscription required.

## Why this is different

- **Local models, easily.** Point the extension at the Trie IDE daemon (`trie-daemon`) and pick any GGUF model from your Trie IDE model store — external drive or internal folder. One command: *Trie IDE: Connect & Load Local Model*. Generation is grammar-constrained, so even 7–14B models emit well-formed tool calls reliably.
- **A real agent loop.** The same tool-loop contract as the Trie IDE desktop app: the model works through `read_file`, `grep`, `glob`, `edit_file`, `write_file`, `run_command` (always user-approved), and a live todo list, then finishes with a summary you can read.
- **The hybrid approach.** Optionally add an OpenAI or Anthropic key and the frontier model becomes an *advisor, not a driver*: it is consulted only at high-leverage checkpoints — when the local model gets stuck, and as a final review when it declares the task done. It never edits files and never issues tool calls. Most work never becomes a cloud call, so cost stays near zero and your code stays local.

## Requirements

Pick one backend (Settings → Trie IDE Agent):

1. **Trie IDE daemon** (default) — run the Trie IDE desktop app, or start the daemon directly:
   ```bash
   cd app && npm run daemon:local     # serves http://127.0.0.1:7841
   ```
2. **Any OpenAI-compatible server** — llama-server, LM Studio, Ollama, or a cloud endpoint. Set `trie-ide.api.baseUrl` and `trie-ide.api.modelName`.

## Quick start

1. Open the Trie IDE icon in the activity bar.
2. Click **Connect** and pick a model (daemon backend), or configure your OpenAI-compatible server in settings.
3. Describe a task: *"add input validation to the signup form and run the tests"*.
4. Watch the tool calls stream by; approve any shell commands; read the final summary.

## Hybrid mode (frontier assist)

Set `trie-ide.frontierAssist.enabled` to `true` and add a key:

| Setting | Value |
|---|---|
| `trie-ide.frontierAssist.provider` | `openai` or `anthropic` |
| `trie-ide.frontierAssist.model` | empty = provider default |
| `trie-ide.frontierAssist.apiKey` | your key |

Guide notes appear inline in the chat, purple-tagged **Hybrid guide**, and are injected into the local model's context as advice. Hard caps: at most 6 frontier calls per turn, automatic 3-minute cooldown on rate limits, and a failed cloud call never interrupts local work.

## Safety

- All file operations are confined to the workspace root — path escapes are refused.
- `run_command` always asks for explicit approval with the exact command shown.
- Nothing leaves your machine unless you enable hybrid mode or point the backend at a cloud endpoint.

## Settings reference

| Setting | Default | Description |
|---|---|---|
| `trie-ide.backend` | `daemon` | `daemon` or `openai-compatible` |
| `trie-ide.daemon.url` | `http://127.0.0.1:7841` | trie-daemon base URL |
| `trie-ide.daemon.storePath` | *(empty)* | Model store volume path |
| `trie-ide.daemon.contextLength` | `8192` | Context length for model load |
| `trie-ide.api.baseUrl` | `http://127.0.0.1:8080` | OpenAI-compatible server |
| `trie-ide.api.modelName` | *(empty)* | Model name for the server |
| `trie-ide.api.apiKey` | *(empty)* | Optional Bearer token |
| `trie-ide.agent.maxToolCalls` | `24` | Tool-call budget per turn |
| `trie-ide.agent.temperature` | `0.2` | Sampling temperature |
| `trie-ide.agent.maxTokens` | `2048` | Max tokens per response |
| `trie-ide.frontierAssist.*` | disabled | Hybrid advisory mode |

## License

Apache-2.0

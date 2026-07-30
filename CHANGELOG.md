# Changelog

## 0.1.0

- Initial release.
- Agent chat view with the Trie IDE tool loop: `read_file`, `list_dir`, `glob`, `grep`, `edit_file`, `write_file`, approval-gated `run_command`, `update_todos`, `step_complete` / `step_failed`.
- Trie IDE daemon backend (`localforged`, port 7841) with model store browsing, one-command model load, and grammar-constrained generation.
- OpenAI-compatible backend for llama-server / LM Studio / Ollama / cloud endpoints.
- Hybrid frontier assist: advisory-only OpenAI/Anthropic guide notes at stuck-hint and final-review checkpoints.

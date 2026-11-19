# Lexel

Lexel is an open-source, 100% local grammar checker, anti-slop filter, and context-aware writing assistant licensed under Apache-2.0.

It runs completely on your device with zero cloud LLM calls, zero accounts, and zero telemetry.

## Why Lexel

Cloud writing tools send every draft you type to remote servers and charge monthly fees. Lexel splits language checking into three local tiers so everyday typing stays instant and private:

1. **Tier 0 (Deterministic, Zero AI, 0 MB Model RAM):** Runs [Harper](https://github.com/automattic/harper) grammar and spelling checks, Lexel's Aho-Corasick anti-slop scanner, em-dash bans, platform rules (Reddit, X, LinkedIn, GitHub PRs, Git commits, email, chat), and a Secrets Guard (API keys, JWTs, private keys, SSNs, Luhn payment cards) directly in Rust and WebAssembly.
2. **Tier 1 (Optional Local AI, Lazy-Loaded):** When you explicitly trigger a rewrite, Lexel loads a quantized local model (`Qwen2.5-0.5B-Instruct` ~469 MB or `Qwen2.5-1.5B-Instruct` ~1.04 GB) through `llama-server`, Ollama, or a local OpenAI-compatible server on `127.0.0.1`, applies your surface prompt and SQLite FTS5 Voice Memory, and automatically unloads weights after the configured idle timeout.
3. **Tier 2 (Post-AI Deterministic Gatekeeper):** Every AI rewrite is checked before display for zero slop, zero em dashes, preserved numbers/PR IDs/code spans, surface character limits, and final Harper grammar checks.

## What Ships in This Repository

| Component | Path | Description |
| :--- | :--- | :--- |
| **Lexel Desktop** | `apps/lexel-desktop` | Tauri v2 + React 19 native desktop Control Center (Linux, macOS, Windows). Manages GGUF downloads, surface prompts, Harper rules, Managed Websites, Weirpack Studio, Team Style Guide, Personal Text Snippets, global `Cmd/Ctrl+Shift+L` clipboard polish, local writing insights, opt-in draft history, Voice Memory, and the shared browser sync bridge. |
| **Browser Extension** | `packages/lexel-browser` | Chrome, Chromium, Brave, Edge, and Firefox Manifest V3 extension with in-page underlines, Google Docs support, live snippet expansion, floating rewrite pill, Side Panel workbench, and "Managed by Lexel Desktop" live sync (plus standalone fallback). |
| **Language Server (LSP)** | `crates/lexel-ls` | Zero-AI LSP server (`lexel-ls --stdio`) synced with `lexel.db` for VS Code, Cursor, Neovim, Zed, Helix, and Emacs (Harper, anti-slop, secrets guard, invisible Unicode, structure guard, style guide, Quick Fixes, and `Fix All Safe`). |
| **VS Code Extension** | `packages/lexel-vscode` | TypeScript VS Code / Cursor / Windsurf client spawning `lexel-ls` across 18 prose, commit, and source-code languages. |
| **Obsidian Plugin** | `packages/lexel-obsidian` | Offline Obsidian plugin with live readability/issue status bar, safe deterministic fixes, invisible Unicode cleanup, and optional local `lexel-daemon` AI rewrites. |
| **Local Daemon** | `crates/lexel-daemon` | Shared Rust service hosting Native Messaging IPC (`com.lexel.daemon`), token-authenticated `127.0.0.1` loopback HTTP API, GGUF downloader with SHA-256 verification, and local inference lifecycle. |
| **Core Engine** | `crates/lexel-core` | Wraps `vendor/harper` without modifying upstream files. Adds anti-slop scanning, hidden Unicode watermark cleaner, structure guard, team style guide, writing goals, `.weirpack` builder/validator, surface validators, Secrets Guard, and Tier 2 rewrite verification. |
| **Local Database** | `crates/lexel-db` | Single-file SQLite + FTS5 storage (`lexel.db`) for profiles, unified settings, custom surfaces, Voice Memory, local numeric writing stats, and opt-in draft snapshots. |
| **CLI Toolkit** | `crates/lexel-cli` | Zero-AI command-line linter (`lexel check`, `stats`, `synonyms`, `title-case`, `sentence-case`, `normalize`, `weirpack`, `install-git-hook`) with Text, JSON, and SARIF output for CI pipelines. |
| **Shared UI Kit** | `packages/lexel-ui` | Shared monochrome design tokens, Tier 0 TypeScript engine, and React 19 components used across Desktop, Browser Extension, and Obsidian. |
| **ML Crucible & Kaggle** | `ml/crucible` & `ml/kaggle` | 6-Gate Data Crucible, unit-bound numeric grounding verifier, Surgical Counterfactual Mutation (SCM), Masked-SimPO / DPO preference alignment, and ready-to-run Unsloth + Kaggle notebooks. |

## Quick Start for End Users

### 1. One-Command Install (Linux & macOS) or Direct Release Download

Install **Lexel Desktop**, `lexel-daemon`, `lexel-ls` (LSP), and `lexel` (CLI) with one terminal command:

```bash
curl -fsSL https://raw.githubusercontent.com/Lexel-Ai/Lexel/main/scripts/install.sh | bash
```

Or download the latest prebuilt installers from [GitHub Releases](https://github.com/Lexel-Ai/Lexel/releases):
- **Desktop App:** `.AppImage` / `.deb` (Linux), `.dmg` (macOS), or `.msi` / `.exe` (Windows)
- **Browser Extension:** `lexel-chrome.zip` (Chrome, Brave, Edge, Chromium) or `lexel-firefox.zip` (Firefox 128+)

Tier 0 grammar, spelling, anti-slop, platform checks, and Secrets Guard work immediately in the browser extension with zero dependencies (0 MB AI RAM).

### 2. Centralized Settings in Lexel Desktop & Zero-Friction Extension Sync

**Lexel Desktop** is the single Control Center for all settings, grammar rules, personal dictionary, anti-slop terms, surface prompts, privacy blocklists, and local AI model downloads:

1. Launch **Lexel Desktop** (`lexel-desktop`). It initializes `lexel.db`, registers Native Messaging hosts, and starts the local sync bridge on `127.0.0.1:42424`.
2. Open the **Lexel Browser Extension** (or click **Connect Desktop** in the extension popup). The extension automatically pairs its browser-enforced `Origin` with Lexel Desktop and syncs your active profile.
3. In **Lexel Desktop -> AI & Extension Sync**, click **Download GGUF** for **Lexel 1.5B (Standard)** (~1.04 GB) or **Lexel 0.5B (Lite)** (~469 MB). Downloads support HTTP Range resume and SHA-256 verification.
4. Make sure a local inference runtime is available: install [Ollama](https://ollama.com) (Lexel starts it and imports your downloaded GGUF automatically) or place `llama-server` in `~/.local/share/lexel/bin/` (or `~/.local/bin/`).

If you only install the browser extension without Lexel Desktop, Tier 0 grammar, spelling, and anti-slop checks continue working standalone in WebAssembly, and the extension displays a prompt to install Lexel Desktop whenever you want to customize settings or enable the local AI model.

## Building from Source

### Prerequisites

- Rust stable toolchain (Edition 2024)
- Node.js 22+ and `pnpm` 10.10+
- Python 3.11+ and `uv` (for `ml/crucible/` dataset curation & tests)
- For building Tauri desktop installers on Ubuntu/Debian Linux: `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev` (or `libappindicator3-dev`), `librsvg2-dev`, `patchelf`

### Clone and Build

```bash
git clone --recurse-submodules https://github.com/Lexel-Ai/Lexel.git
cd Lexel

# Enable repository Conventional Commit message hook
make install-hooks

# Install JS/TS workspace dependencies
pnpm install

# Build all Rust crates (core, db, daemon, cli)
cargo build --workspace

# Build UI kit, Desktop frontend, and Browser extension
pnpm -r build

# Optional: download both GGUF models, build release daemon, and register Native Messaging
make setup
```

### Run Locally in Development

```bash
# Run Lexel Desktop (Tauri v2 window + embedded shared daemon)
make tauri-dev

# Build unpacked browser extension into packages/lexel-browser/dist
make build-browser

# Package Chrome & Firefox extension archives
make zip-browser

# Build local release artifacts + SHA256SUMS into dist-release/
make package
```

To load the unpacked extension in Chrome/Brave/Edge, open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select `packages/lexel-browser/dist`.

## CLI Usage (Zero AI)

```bash
# Lint files or stdin with Harper + Anti-Slop + Surface + Secrets Guard
cargo run -p lexel-cli -- check README.md --surface docs_markdown --fail-on secrets

# Output SARIF for GitHub Code Scanning
cargo run -p lexel-cli -- check docs/*.md --format sarif

# Validate Lexel's anti-slop Weirpack rules
cargo run -p lexel-cli -- weirpack validate rules/lexel-antislop.weirpack
```

## Contributing

Lexel is built to be easy to contribute to, whether you want to add an anti-slop phrase, tune a platform surface, improve Rust performance, or refine the Desktop/Extension UI.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the contributor guide, repository map, quality gates, and commit format. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for system internals and [SECURITY.md](SECURITY.md) for privacy invariants.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) for upstream attributions including Automattic's Harper.

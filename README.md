<p align="center">
  <img src="assets/brand/lexel-logo.svg" width="180" alt="Lexel logo">
</p>

# Lexel

Lexel is an open-source, 100% local grammar checker, anti-slop filter, and context-aware writing assistant licensed under Apache-2.0.

Everything runs on your device with zero cloud LLM calls, zero accounts, and zero telemetry.

## How Lexel Works

Cloud writing tools send every draft you type to remote servers and charge monthly subscriptions. Lexel keeps everyday checks instant and private while giving you optional offline AI rewrites when you ask for them:

- **Instant Local Writing Checks (Always On, 0 MB AI RAM):** Runs [Harper](https://github.com/automattic/harper) grammar and spelling checks, Lexel's Aho-Corasick anti-slop scanner, em-dash bans, platform rules (Reddit, X, LinkedIn, GitHub PRs, Git commits, email, chat, Markdown docs), hidden invisible Unicode cleanup, punctuation and structure checks, team style guides, personal text snippets, and a Secrets Guard (API keys, JWTs, private keys, SSNs, Luhn payment cards) directly in Rust and WebAssembly.
- **On-Demand Local AI Rewrites (100% Offline):** When you explicitly ask for a rewrite, Lexel loads a quantized local model (**Lexel 1.5B**, fine-tuned Q4_K_M ~940 MB, or **Lexel 0.5B Lite**, ~469 MB) through `llama-server`, Ollama, or a local OpenAI-compatible server on `127.0.0.1`. It applies your platform surface prompt and SQLite FTS5 Voice Memory, then unloads model weights automatically after the idle timeout.
- **Built-In Rewrite Verification:** Before displaying any AI suggestion, Lexel verifies that it contains zero AI clichés, zero em dashes, zero leaked secrets, intact numbers, PR IDs, CLI flags, and inline code spans, valid platform character limits, and clean Harper grammar.

## Download and Install

### One-Command Install (Linux and macOS)

Install **Lexel Desktop**, `lexel-daemon`, `lexel-ls` (LSP), `lexel` (CLI), browser extension archives, and the Native Messaging bridge:

```bash
curl -fsSL https://raw.githubusercontent.com/Lexel-Ai/Lexel/main/scripts/install.sh | bash
```

Pass `--with-models` to download and verify the local AI GGUF models during installation:

```bash
curl -fsSL https://raw.githubusercontent.com/Lexel-Ai/Lexel/main/scripts/install.sh | bash -s -- --with-models
```

### One-Command Install (Windows PowerShell)

```powershell
irm https://raw.githubusercontent.com/Lexel-Ai/Lexel/main/scripts/install.ps1 | iex
```

### Direct Downloads from GitHub Releases

Download prebuilt packages and `SHA256SUMS.txt` from [GitHub Releases](https://github.com/Lexel-Ai/Lexel/releases/latest):

| Product | Downloads |
| :--- | :--- |
| **Lexel Desktop (Linux)** | `lexel-desktop-linux-x86_64.AppImage`, `lexel-desktop-linux-x86_64.deb`, `.rpm` |
| **Lexel Desktop (macOS)** | `lexel-desktop-macos-arm64.dmg` |
| **Lexel Desktop (Windows)** | `lexel-desktop-windows-x86_64-setup.exe`, `lexel-desktop-windows-x86_64.msi` |
| **Browser Extensions** | `lexel-chrome.zip` (Chrome, Brave, Edge, Chromium), `lexel-firefox.zip` (Firefox 128+) |
| **Editor & Notes Plugins** | `lexel-vscode.zip` (VS Code, Cursor, Windsurf), `lexel-obsidian-plugin.zip` (Obsidian) |
| **CLI, Daemon & LSP** | `lexel-cli-*`, `lexel-daemon-*`, `lexel-ls-*` for Linux, macOS, and Windows |
| **Local AI Weights** | `qwen2.5-1.5b-instruct-q4_k_m.gguf` (fine-tuned Lexel 1.5B, ~940 MB) and `qwen2.5-0.5b-instruct-q4_k_m.gguf` (Lexel 0.5B Lite, ~469 MB), downloaded directly inside Lexel Desktop with SHA-256 verification |

Grammar, spelling, anti-slop, platform rules, and Secrets Guard work immediately in the browser extension with zero dependencies and 0 MB AI RAM.

## Setup: Desktop Control Center, Browser Sync & Local AI

**Lexel Desktop** is the central app for all settings, grammar rules, personal dictionary, anti-slop terms, surface prompts, privacy blocklists, and local AI model downloads:

1. Launch **Lexel Desktop** (`lexel-desktop`). On first start it initializes `lexel.db`, registers Native Messaging hosts for Chrome, Chromium, Brave, Edge, and Firefox, and starts the local sync bridge on `127.0.0.1:42424`.
2. Load the browser extension (`lexel-chrome.zip` unzipped via `chrome://extensions` -> Developer mode -> Load unpacked, or `lexel-firefox.zip` in Firefox) and click **Connect Desktop** in the popup. The extension pairs automatically and stays synced with your active profile.
3. Open **Lexel Desktop -> AI & Extension Sync** and click **Download GGUF** for **Lexel 1.5B (Standard)** (~940 MB, fine-tuned anti-slop model) or **Lexel 0.5B (Lite)** (~469 MB). Downloads support HTTP Range resume and automatic SHA-256 verification.
4. Make sure a local inference runtime is installed: install [Ollama](https://ollama.com) (Lexel starts it and registers your downloaded GGUF automatically) or place `llama-server` in `~/.local/share/lexel/bin/` (or `~/.local/bin/`).

If you only install the browser extension without Lexel Desktop, grammar, spelling, anti-slop, and privacy checks continue working standalone in WebAssembly.

## What Ships in This Repository

| Component | Path | Description |
| :--- | :--- | :--- |
| **Lexel Desktop** | `apps/lexel-desktop` | Tauri v2 + React 19 native desktop Control Center (Linux, macOS, Windows). Manages GGUF downloads, surface prompts, Harper rules, Managed Websites, Weirpack Studio, Team Style Guide, Personal Text Snippets, global `Cmd/Ctrl+Shift+L` clipboard polish, local writing insights, opt-in draft history, Voice Memory, and browser sync. |
| **Browser Extension** | `packages/lexel-browser` | Chrome, Chromium, Brave, Edge, and Firefox Manifest V3 extension with in-page underlines, Google Docs support, live snippet expansion, floating rewrite bar, Side Panel workbench, and automatic Lexel Desktop sync. |
| **Language Server (LSP)** | `crates/lexel-ls` | Fast zero-AI LSP server (`lexel-ls --stdio`) synced with `lexel.db` for VS Code, Cursor, Neovim, Zed, Helix, and Emacs (Harper grammar, anti-slop, Secrets Guard, invisible Unicode, structure checks, team style guide, Quick Fixes, and `Fix All Safe`). |
| **VS Code Extension** | `packages/lexel-vscode` | TypeScript VS Code / Cursor / Windsurf client spawning `lexel-ls` across 18 prose, commit, and source-code languages. |
| **Obsidian Plugin** | `packages/lexel-obsidian` | Offline Obsidian plugin with live readability and issue status bar, safe deterministic fixes, invisible Unicode cleanup, and optional local `lexel-daemon` AI rewrites. |
| **Local Daemon** | `crates/lexel-daemon` | Shared Rust service hosting Native Messaging IPC (`com.lexel.daemon`), token-authenticated `127.0.0.1` loopback HTTP API, resumable GGUF downloader with SHA-256 verification, and local inference lifecycle. |
| **Core Engine** | `crates/lexel-core` | Wraps `vendor/harper` cleanly without modifying upstream files. Adds anti-slop scanning, hidden Unicode watermark cleaner, structure guard, team style guide, writing goals, `.weirpack` builder/validator, surface validators, Secrets Guard, and post-rewrite verification. |
| **Local Database** | `crates/lexel-db` | Single-file SQLite + FTS5 storage (`lexel.db`) for profiles, unified settings, custom surfaces, Voice Memory, local numeric writing stats, and opt-in draft snapshots. |
| **CLI Toolkit** | `crates/lexel-cli` | Zero-AI command-line linter (`lexel check`, `stats`, `synonyms`, `title-case`, `sentence-case`, `normalize`, `weirpack`, `install-git-hook`) with Text, JSON, and SARIF output for CI pipelines. |
| **Shared UI Kit** | `packages/lexel-ui` | Shared monochrome design tokens, deterministic TypeScript writing engine, and React 19 components used across Desktop, Browser Extension, and Obsidian. |
| **ML Crucible & Kaggle** | `ml/crucible` & `ml/kaggle` | 6-Gate Data Crucible, unit-bound numeric grounding verifier, Surgical Counterfactual Mutation (SCM), Masked-SimPO preference alignment, and Unsloth Kaggle training notebooks. |

## CLI Usage

```bash
# Lint files or stdin with Harper, Anti-Slop, Surface Rules, and Secrets Guard
lexel check README.md --surface docs_markdown --fail-on secrets

# Output SARIF for GitHub Code Scanning
lexel check docs/*.md --format sarif

# Validate Lexel's anti-slop Weirpack rules
lexel weirpack validate rules/lexel-antislop.weirpack
```

## Building from Source

### Prerequisites

- Rust stable toolchain (Edition 2024)
- Node.js 22+ and `pnpm` 10.10+
- `wasm-pack` (only required if building the browser extension from source)
- Python 3.11+ and `uv` (optional, for `ml/crucible/` dataset curation and tests)
- Linux Tauri dependencies on Ubuntu/Debian: `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `libgtk-3-dev`, `libssl-dev`, `libxdo-dev`, `patchelf`

### Clone and Build

```bash
git clone --recurse-submodules https://github.com/Lexel-Ai/Lexel.git
cd Lexel

# Enable repository Conventional Commit message hook
make install-hooks

# Install JS/TS workspace dependencies
pnpm install

# Build all Rust crates (core, db, daemon, ls, cli)
cargo build --workspace

# Build UI kit, Desktop frontend, VS Code extension, Obsidian plugin, and Browser extension
pnpm -r build

# Optional: download verified GGUF models, build release daemon, and register Native Messaging
make setup
```

### Run Locally in Development

```bash
# Run Lexel Desktop (Tauri v2 window + embedded shared daemon)
make tauri-dev

# Build unpacked browser extension into packages/lexel-browser/dist
make build-browser

# Package Chrome and Firefox extension archives
make zip-browser

# Build local release artifacts + SHA256SUMS into dist-release/
make package
```

## Thank You to Harper

Lexel exists because of [Harper](https://github.com/automattic/harper).

We are genuinely grateful to **Elijah Potter**, **Automattic**, and every **Harper contributor** for building and maintaining a fast, private, open-source English grammar engine in Rust under the Apache-2.0 license. Harper's `harper-core`, multi-language code comment parsers, `harper-thesaurus`, `Weirpack` rule format, WebAssembly engine, and DOM lint framework power the deterministic grammar and spelling foundation across Lexel Desktop, the browser extension, the LSP server, Obsidian, and the CLI.

To respect and support upstream work, Lexel keeps `vendor/harper` completely unmodified as a Git submodule and syncs upstream improvements cleanly via `make sync-harper`. If Lexel helps your writing, please visit [github.com/automattic/harper](https://github.com/automattic/harper), give Harper a star, and support their community.

## Contributing

Contributions are welcome, whether you want to add an anti-slop phrase, refine a platform surface, improve Rust performance, or polish the Desktop and extension UI.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the contributor guide, repository map, quality gates, and commit format. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for system internals and [SECURITY.md](SECURITY.md) for privacy invariants.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) for upstream attributions, including Automattic's Harper and Qwen2.5.

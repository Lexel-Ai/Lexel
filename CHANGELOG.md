# Changelog

All notable changes to Lexel are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

### Added
- **Tier 0 Deterministic Engine (`lexel-core`, `lexel-ui`, `lexel-cli`):**
  - Wraps upstream Harper grammar, spelling, multi-language code comment parsers, readability metrics, offline thesaurus (`harper-thesaurus`), Chicago Title Case, Sentence Case, and typography normalization.
  - Aho-Corasick anti-slop scanner, em-dash ban, custom slop overrides, and verified `.weirpack` archive (`rules/lexel-antislop.weirpack`).
  - Deterministic Secrets Guard blocking API keys, JWTs, private keys, SSNs, and Luhn-valid payment cards.
  - Cross-platform surface validators (`ml/personas/surfaces.json`) covering Reddit, X, LinkedIn, GitHub PRs, Git commits, IDE comments, Discord/Slack, Gmail, Substack, WordPress, Discourse, Markdown docs, and General prose.
  - CLI (`lexel`) with Text, JSON, and SARIF reporting, `--fix-safe`, `--fix-all`, `--fail-on`, `--style-guide`, Weirpack validation/building, and `install-git-hook`.
  - Hidden AI watermark & invisible Unicode scanner/cleaner (`U+200B`, `U+202F`, `U+FEFF`, `U+00AD`, bidi controls), structure & punctuation guard (unclosed delimiters/quotes/backticks, duplicate adjacent words, mixed quotes), Writing Goals & Style Meter (per-surface Flesch-Kincaid grade targets, speaking time, passive hints, hedging density, rhythm variety), shareable Team Style Guide JSON, and live Personal Text Snippets.
- **IDE & Notes Ecosystem (`lexel-ls`, `lexel-vscode`, `lexel-obsidian`):**
  - Native Rust Language Server (`lexel-ls --stdio`) synced with `lexel.db` offering real-time diagnostics, 1-click Quick Fixes, and `Fix All Safe` source actions across 18 languages.
  - VS Code / Cursor / Windsurf extension (`packages/lexel-vscode`) and Obsidian plugin (`packages/lexel-obsidian`).
- **Local Database & Daemon (`lexel-db`, `lexel-daemon`):**
  - SQLite + FTS5 local storage (`lexel.db`) for multi-profile accounts, unified settings, custom surfaces, synced Weirpacks, Voice Memory, numeric-only local writing stats, and opt-in draft snapshots.
  - Token-authenticated, strict-Origin loopback HTTP server (`127.0.0.1:42424`) and cross-platform Native Messaging host (Chrome, Chromium, Brave, Edge, Firefox on Linux, macOS, and Windows).
  - Resumable GGUF model downloader with SHA-256 verification and progress streaming for `lexel-0.5b` and `lexel-1.5b`.
  - Managed `llama-server`, Ollama auto-registration, and local OpenAI-compatible runtime support with idle auto-unload.
- **Lexel Desktop (`apps/lexel-desktop`):**
  - Tauri v2 + React 19 native desktop Control Center with system tray, global `Cmd/Ctrl+Shift+L` clipboard polish hotkey, shared loopback daemon hosting, headless native-messaging fallback, live extension sync events, Quick Rewrite studio with Draft History, editable per-surface AI prompts, Managed Websites, Weirpack Studio, Team Style Guide, Personal Snippets, Local Writing Insights, and GGUF model manager.
- **Browser Extension (`packages/lexel-browser`):**
  - Chrome, Chromium, Brave, Edge, and Firefox Manifest V3 extension with Harper WASM underlines, Google Docs bridge, live snippet expansion, floating rewrite pill, Side Panel workbench, extension icons, in-extension GGUF downloads, and "Managed by Lexel Desktop" companion view with automatic live sync.
- **Open-Source Governance & CI/CD:**
  - Apache-2.0 `LICENSE`, `NOTICE`, `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, GitHub issue/PR templates, CI workflow, tagged multi-platform release workflow, weekly upstream Harper sync workflow, and `scripts/package-release.sh`.

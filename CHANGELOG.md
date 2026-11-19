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
  - CLI (`lexel`) with Text, JSON, and SARIF reporting, `--fix-safe`, `--fix-all`, `--fail-on`, and Weirpack validation/building.
- **Local Database & Daemon (`lexel-db`, `lexel-daemon`):**
  - SQLite + FTS5 local storage (`lexel.db`) for multi-profile accounts, unified settings, custom surfaces, and Voice Memory.
  - Token-authenticated, strict-Origin loopback HTTP server (`127.0.0.1:42424`) and cross-platform Native Messaging host (Chrome, Chromium, Brave, Edge, Firefox on Linux, macOS, and Windows).
  - Resumable GGUF model downloader with SHA-256 verification and progress streaming for `lexel-0.5b` and `lexel-1.5b`.
  - Managed `llama-server`, Ollama auto-registration, and local OpenAI-compatible runtime support with idle auto-unload.
- **Lexel Desktop (`apps/lexel-desktop`):**
  - Tauri v2 + React 19 native desktop application with system tray, shared loopback daemon hosting, headless native-messaging fallback, live extension sync events, Quick Rewrite studio, editable per-surface AI prompts, Harper/Anti-Slop/Privacy/Extension settings, and GGUF model manager.
- **Browser Extension (`packages/lexel-browser`):**
  - Chrome, Chromium, Brave, Edge, and Firefox Manifest V3 extension with Harper WASM underlines, Google Docs bridge, floating rewrite pill, Side Panel workbench, extension icons, in-extension GGUF downloads, and automatic live sync with Lexel Desktop.
- **Open-Source Governance & CI/CD:**
  - Apache-2.0 `LICENSE`, `NOTICE`, `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, GitHub issue/PR templates, CI workflow, tagged multi-platform release workflow, weekly upstream Harper sync workflow, and `scripts/package-release.sh`.

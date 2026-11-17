# Lexel: Master Architecture, Training, and Implementation Plan

**Project:** Lexel (Open-Source, Local-First Grammar + Context-Aware AI Writing Assistant)
**License:** Apache-2.0 (compatible with upstream Harper)
**Target Platforms:** Browser Extension (Chrome, Firefox), IDEs/Editors via LSP & Extensions (VS Code, Cursor, Windsurf, Neovim, Zed, Helix), Desktop App (Linux, macOS, Windows), CLI, Obsidian
**Reference Repositories on Machine:**
- `/home/lawand/harper` (Upstream Harper grammar engine, LSP, WASM, Chrome/VS Code/Obsidian plugins, Tauri desktop app)
- `/home/lawand/Prose` (Reference anti-slop rules, cross-platform reply matrix, deterministic verifier, ML data crucible, training audits)

---

## 1. Product Vision and Non-Negotiable Principles

Lexel aims to replace cloud grammar and writing tools (such as Grammarly) with a free, open-source, 100% local alternative built specifically for developers and everyday writers.

### Core Design Invariants
1. **Zero-Cost Speed Preservation:** When the user does not ask for an AI rewrite, Lexel runs pure Rust Harper grammar/spelling/anti-slop checks in sub-millisecond to single-digit millisecond latency with **0 MB of LLM RAM** loaded.
2. **100% Local & Privacy-First:** No cloud LLM APIs, no telemetry, no text leaving the device. All inference, style memory, and platform personality profiles live locally on disk.
3. **Harper as the Deterministic Foundation:** Lexel does not reimplement English grammar rules or code-comment parsers. It embeds Harper directly and tracks upstream Harper updates cleanly via automated sync commands and CI.
4. **Anti-Slop by Design:** The local 1.5B-class model is fine-tuned and aligned to write crisp, human prose without AI tells (no em dashes, no buzzwords like "delve" or "seamless", no padded intros, no hallucinated metrics).
5. **Context- and Surface-Aware Personality:** Lexel adapts its tone, constraints, and formatting rules to where the user is typing: IDE code comments, Git commits, Reddit, X, LinkedIn, GitHub PRs, Discord, Slack, or email.
6. **Constraint-Safe Hardware Footprint:** Engineered to run smoothly even on thin-and-light laptops (such as 8-thread CPUs with 5 to 8 GB RAM and no discrete GPU) via quantized GGUF inference, lazy loading, and automatic idle unloading.

---

## 2. Two-Tier Hybrid Execution Architecture

Lexel splits language checking and rewriting into two strictly isolated tiers so AI never slows down typing.

```
User Types in IDE / Browser / Desktop App
                  │
                  ▼
┌──────────────────────────────────────────────────────────┐
│ TIER 0: Instant Deterministic Engine (Always On, < 5 ms) │
│ • harper-core (Rust native or harper-wasm in browser)    │
│ • harper-comments / harper-git-commit / harper-tree-sitter│
│ • Lexel Anti-Slop Weirpack + Aho-Corasick Slop Scanner   │
│ • Platform Surface Validator (char limits, links, emoji) │
│   -> Zero LLM calls. Zero GPU/RAM overhead.              │
└─────────────────┬────────────────────────────────────────┘
                  │ Only when user triggers an AI Action
                  │ (Shortcut, Code Action, Rewrite Button)
                  ▼
┌──────────────────────────────────────────────────────────┐
│ TIER 1: Local AI Rewrite Engine (On-Demand, Lazy-Loaded) │
│ • lexel-daemon (Rust + embedded llama.cpp + SQLite)      │
│ • Surface Profile + Sub-context (e.g. r/rust, git-commit)│
│ • Local User Voice Memory (few-shot style retrieval)     │
│ • Quantized Qwen 1.5B (Q4_K_M ~1.0 GB) via Unix Socket / │
│   Native Messaging / Loopback HTTP+SSE                   │
└─────────────────┬────────────────────────────────────────┘
                  │
                  ▼
┌──────────────────────────────────────────────────────────┐
│ TIER 2: Post-AI Deterministic Gatekeeper (< 2 ms)        │
│ • Numeric & Symbol Grounding (preserves #42, 18ms, `fn`) │
│ • Zero-Slop Scanner & Em-Dash Ban                        │
│ • Surface Constraint Check (Reddit 0-link, X <=280 chars)│
│ • Final harper-core grammar pass on AI suggestion        │
└──────────────────────────────────────────────────────────┘
```

---

## 3. Integrating Harper and Automating Upstream Updates

Harper (`/home/lawand/harper`) is Apache-2.0 licensed and already organized as a clean Rust Cargo workspace + pnpm TypeScript workspace. Lexel must **extend** Harper without scattering edits inside `harper-core` source files, otherwise pulling upstream grammar updates will cause merge conflicts.

### 3.1 What Lexel Reuses Directly from Harper (100% Feature Parity)
From `/home/lawand/harper`:
- **Core Rust Library Crates:**
  - `harper-core` (`Document`, `LintGroup`, `FstDictionary`, `Weir` / `Weirpack`, `Masker`, `Dialect` [American, British, Canadian, Australian], `IgnoredLints`, `IsolateEnglish` for mixed-language documents)
  - `harper-comments`, `harper-git-commit`, `harper-jjdescription`, `harper-tree-sitter`, `harper-python`, `harper-html`, `harper-tex`, `harper-typst`, `harper-asciidoc`, `harper-ink`, `harper-literate-haskell`
  - `harper-dictionary-wordlist`, `harper-stats` (readability/writing stats), `harper-thesaurus` (synonym lookups)
  - `harper-wasm` (WASM target for browser, Obsidian, & web sandbox)
- **Headless JS/DOM Engine Packages (`packages/`, UI-agnostic):**
  - `packages/harper.js` (Web Worker + WASM runner)
  - `packages/lint-framework` (`LintFramework.ts`, `computeLintBoxes`, `googleDocsAdapter.ts`, `TextFieldRange.ts`: pure TypeScript DOM geometry and Google Docs bridge, with zero UI framework lock-in; Lexel replaces the popup/overlay UI with its own React components)
- **Editor & App Surfaces Supported (Parity with Harper):**
  - **LSP Editors:** VS Code, Cursor, Windsurf, Neovim, Zed, Helix, Emacs (all served by `lexel-ls`, supporting `userDictPath`, `fileDictPath`, `workspaceDictPath`, `ignored_lints`, `excludePatterns`, `maxFileLength`, `diagnosticSeverity`, `diagnosticDelayMs`, `markdown.IgnoreLinkTitle`, and `codeActions.ForceStable`)
  - **Browsers:** Chrome, Chromium-based browsers, Firefox (MV3 extension with activation key guard `off`/`shift`/`control`, hover vs click popup toggle, per-rule toggles, per-instance `ignoreLint` hash, automatic dialect detection `detectDialect`, and Google Docs bridge)
  - **Notes & Publishing:** Obsidian plugin (`packages/lexel-obsidian`); WordPress plugin (`packages/wordpress-plugin`) is explicitly **deferred post-v0.1** (optional community contribution)
  - **Desktop & CLI:** Cross-platform desktop app (`apps/lexel-desktop`, reusing Harper's `mac_broker` / `windows_broker` / `highlighter` native OS overlay on macOS & Windows, plus clipboard/shortcut fallback on Linux) and full-parity CLI (`lexel-cli` with `lint --only/--ignore/--weirpacks/--format/--count`, `parse`, `spans`, `annotate`, and shell completions)
- **Note on Harper UI Packages:** Lexel does **not** copy or track `packages/chrome-plugin` (Svelte) or `harper-desktop` (SvelteKit) UIs. Lexel builds its own original UI, brand, and extension experience in **React 19 + Vite + Tailwind CSS v4**.

### 3.2 Repository & Dependency Strategy for Clean Upstream Sync
Do **not** maintain an unstructured fork where Lexel edits dozens of files inside `harper-core`. Instead, use a **Layered Upstream Vendor + Wrapper Workspace** pattern:

1. **Git Submodule at `vendor/harper`:**
   - Pin `vendor/harper` to `https://github.com/automattic/harper.git` (excluded from Lexel's root `[workspace].members` because `vendor/harper/Cargo.toml` defines its own Cargo workspace; Lexel crates depend on `vendor/harper/harper-core`, `vendor/harper/harper-comments`, etc. via explicit path dependencies).
   - Lexel's custom Rust crates live separately in `crates/`:
     - `crates/lexel-core` (wraps `harper-core` `LintGroup` + adds Lexel's Weirpack + Aho-Corasick anti-slop + surface rules + deterministic verifier)
     - `crates/lexel-db` (SQLite user voice memory, surface profiles, privacy rules)
     - `crates/lexel-ai` (llama.cpp FFI / sidecar runner, lazy model loader, prompt assembler, constrained decoding/post-check)
     - `crates/lexel-daemon` (background local service exposing Unix socket / Windows Named Pipe, Chrome/Firefox Native Messaging host, and a token-authenticated `127.0.0.1` HTTP/SSE endpoint with strict `Origin` checks for Obsidian/CLI fallback)
     - `crates/lexel-ls` (standalone `tower-lsp-server` binary built directly on `lexel-core` + Harper's parser crates `harper-comments`, `harper-git-commit`, `harper-tree-sitter`, etc., because upstream `harper-ls` is a binary-only crate without a `lib.rs`; mirrors `harper-ls` capabilities, dialects, user/workspace dictionaries, and `ignored_lints` while adding Tier 1 AI Code Actions and local git-diff context for commit messages)
     - `crates/lexel-cli` (CLI for linting, rewriting, syncing Harper, managing models, and inspecting local DB)
2. **Lexel's Own Original Extensions & UI (`apps/` and `packages/`):**
   - `packages/lexel-browser`: Lexel's own Chrome/Firefox MV3 extension built from scratch in **React 19 + Vite + Tailwind CSS v4 + Zustand**, using `lexel-wasm` + Harper's low-level DOM/Google Docs rect helpers (`lint-framework` math/adapters) underneath, with Lexel's own floating AI rewrite bar, surface attitude badge, diff preview, and options/sidepanel UI.
   - `packages/lexel-vscode`: Lexel's own VS Code / Cursor / Windsurf extension pointing to `lexel-ls`, with AI command palette actions, inline rewrite Code Actions, and commit-box polish.
   - `packages/lexel-obsidian`: Lexel's Obsidian plugin running Tier 0 via `lexel-wasm` and optionally calling `lexel-daemon` over authenticated `127.0.0.1` for local AI rewrites inside notes.
   - `apps/lexel-desktop`: Lexel's own **Tauri v2 + React 19** desktop app (reusing Rust OS accessibility patterns where useful, with Lexel's own UI for local GGUF model management, RAM budget controls, surface persona editor, and voice memory).

### 3.3 How Upstream Harper Updates Work (Manual Command & Automated)
1. **Local Developer Command (`make sync-harper` or `just sync-harper`):**
   - Runs `git submodule update --remote --merge vendor/harper`
   - Checks `vendor/harper/harper-ls/Cargo.toml` diff for any newly added upstream parser crates so `lexel-ls` stays in parity
   - Runs `cargo check --workspace` and `cargo test -p lexel-core -p lexel-ls`
   - Rebuilds `lexel-wasm` if `harper-core` changed
   - Prints a concise changelog of new Harper rules/dictionaries pulled in
2. **Automated GitHub Action (`.github/workflows/sync-harper.yml`):**
   - Runs on a weekly schedule (`cron: "0 6 * * 1"`) and via manual `workflow_dispatch`.
   - Fetches `automattic/harper` `master`, updates the `vendor/harper` submodule pointer, runs the full Rust + WASM + extension test suite, and opens an automated Pull Request titled `chore(upstream): sync harper to <sha>` if all checks pass.
3. **Runtime Dictionary / Weirpack Hot Updates (Optional for End Users):**
   - Because `harper-core` natively supports `Weirpack` (`harper-core/src/weirpack`), Lexel can also ship lightweight `.weirpack` anti-slop rule updates independently of full binary releases, while major `harper-core` engine/dictionary releases come through standard app/extension updates.

---

## 4. Recommended Languages, Frameworks, and System Stack

| Layer | Technology Choice | Rationale |
| :--- | :--- | :--- |
| **Core Engine & Daemon** | **Rust** (Edition 2024) | Native compatibility with `harper-core` and `harper-ls`; single static binary; zero GC latency; safe concurrency; fast startup. |
| **Local LLM Inference** | **`llama-cpp-2` (Rust FFI to `llama.cpp`)** behind `InferenceBackend` trait | Single binary with zero orphan child processes, direct `mmap` loading, exact idle memory drop (`drop(model)`), AVX2/Metal/Vulkan support; optional Ollama HTTP adapter uses the same trait for BYOM users. |
| **Local Database** | **SQLite** (`rusqlite` with `bundled` + `fts5` + optional `sqlcipher`) | Zero-server, single-file local persistence (`lexel.db`); fast full-text search (FTS5) for retrieving user style examples; easy backup/export/wipe. |
| **LSP & IDE Layer** | **`tower-lsp-server`** (via `lexel-ls`) + **TypeScript** (`lexel-vscode`) | One LSP binary serves VS Code, Cursor, Windsurf, Neovim, Zed, Helix, and Emacs immediately. |
| **Shared React UI Kit** | **React 19 + Tailwind CSS v4 + Base UI / Radix (`packages/lexel-ui`)** | Single shared component library reused across the browser extension, desktop app, and marketing web playground. |
| **Browser Extension** | **TypeScript + React 19 + Tailwind CSS v4 + Zustand + Vite + `@crxjs/vite-plugin`** | Lexel's own original extension UI; matches your existing React 19 stack in `Prose` while using `lexel-wasm` and Harper's framework-agnostic DOM/Google Docs box geometry underneath. |
| **Browser-to-Local-AI Bridge** | **Chrome Native Messaging** (primary) + authenticated localhost HTTP/SSE fallback | Zero open network ports required by default; bypasses mixed-content/CORS issues in MV3 extensions; authenticates to `lexel-daemon`. |
| **Desktop & Tray App** | **Tauri v2 (Rust + React 19 + Vite)** | Tiny RAM footprint (~40 to 80 MB vs Electron's 300+ MB); full React UI for daemon lifecycle, tray status, model downloads, persona editor, and OS accessibility hooks. |
| **Marketing Web & Docs** | **Next.js (App Router) + React 19 + Tailwind CSS v4 (`apps/lexel-web`)** | Used strictly for the public landing page, documentation, release notes, and an interactive in-browser `lexel-wasm` sandbox (never inside the extension or desktop app). |
| **Model Training & Eval** | **Python 3.11+ (`uv`) / Unsloth / TRL / PyTorch / `llama.cpp` quantizer** | `uv` manages `ml/crucible/` locally (matching `Prose`); Kaggle GPU notebooks run Unsloth and output standard GGUF files + JSON eval reports. |
| **Package Managers & Task Runner** | **`cargo` (Rust) + `pnpm` (JS/TS) + `uv` (Python) + `Makefile` / `justfile`** | `cargo` builds Rust crates; `pnpm` (10.10+) matches `vendor/harper`'s workspace protocol and saves disk via hardlinks; `uv` handles Python ML scripts; `Makefile` + `scripts/` ensure `sync-harper` and builds work without requiring extra global tools. |

---

## 5. What Lexel Brings In from `/home/lawand/Prose`

A direct audit of `/home/lawand/Prose` identified several battle-tested assets and critical scientific lessons that apply directly to Lexel (while discarding Prose's cloud SaaS components like Stripe, Clerk, Supabase, Ayrshare, and 27B vLLM servers):

1. **Deterministic Anti-Slop Rules (`Prose/web/src/lib/verifier.ts`):**
   - Store Prose's `SLOP_WORDS` list (30+ terms including `delve`, `tapestry`, `testament to`, `pivotal`, `seamless`, `leverage`, `unlock`, `game-changer`, `embark`, `synergy`, `holistic`, `furthermore`, `moreover`, `realm`, `harness`, `elevate`, `underscore`) in one canonical data file (`rules/slop_terms.json`) read by both `lexel-core` (Rust Aho-Corasick + `Weirpack`) and `ml/crucible/` (Python training filter) so rules are never duplicated.
   - Port Prose's **Unit-Bound Numeric Verifier** (`UNIT_BOUND_REGEX`), which distinguishes `#42` (PR/issue number) from `42%`, `42ms`, `$42`, `42MB`, preventing small models from corrupting technical numbers during rewrites.
2. **Cross-Platform Reply & Surface Matrix (`Prose/02-architecture/blueprints/cross-platform-anti-slop-reply-matrix.md`):**
   - Bring in Prose's hard surface rules:
     - **Reddit:** 120 to 900 chars, 0 links, 0 emojis, 0 hashtags, zero self-promo openers, direct peer tone.
     - **X / Twitter:** 20 to 280 chars (target <=240), 0 emojis, 0 hashtags, high information density.
     - **LinkedIn:** 80 to 750 chars for comments, no sycophantic openers ("Great post!", "Thanks for sharing!"), no decorative emojis.
   - Extend this matrix inside Lexel to developer surfaces (`git_commit`, `ide_comment`, `github_pr`, `slack_discord`, `email`, `docs_markdown`).
3. **Truth vs. Craft Separation & Session 1/2 Training Lessons (`Prose/03-research/ml-training-and-eval/model-development-master-plan.md`):**
   - Prose's Session 1 audit proved that training on noisy synthetic data destroys length/constraint compliance (69.5% failed bounds).
   - Prose's Session 2 audit proved that fine-tuning on clean style without context grounding increases hallucinated numbers/facts.
   - **Lexel's Adaptation:** Treat user-selected text + surrounding code/thread context as the **closed-world ground truth**. Fine-tune the 1.5B model strictly on **editing, rewriting, and context-matched drafting**, and run Tier 2 deterministic grounding checks on every output.
4. **Training Code & Seed Corpora (`Prose/src/wlab/`, `Prose/deliverables/datasets/`, `Prose/03-research/corpora/`):**
   - Reuse completion-only loss masking (`-100` on prompt tokens from `src/wlab/train.py`), data validation checks (`validate_strict.py`), and clean human writing subsets from `wlab_session2_clean/` (300 rows) and `wlab_pref_v1/` (500 rows) as part of Lexel's general prose seed mix, augmented with developer-specific datasets (git commits, code comments, tech discussions).

---

## 6. Local AI Engine & Resource Management (Built for Real Laptops)

On a typical developer laptop (e.g., 5 to 8 GB RAM, integrated graphics, CPU inference), running a local LLM carelessly will freeze the IDE or browser. Lexel solves this with strict lifecycle rules:

### 6.1 Model Tier Selection
- **Primary Default Model (`lexel-1.5b`):** **`Qwen2.5-1.5B-Instruct`** (Apache-2.0, quantized to `Q4_K_M` GGUF, ~1.0 GB RAM). Chosen as the v0.1 default because it has zero `<think>` token overhead, fast CPU token latency, and mature Unsloth / `llama.cpp` support.
  - Expected CPU speed (8-thread Ryzen/Core): ~12 to 25 tokens/sec (short rewrites of 30 to 80 tokens finish in ~1.5 to 4 seconds).
- **Lite Fallback Model (`lexel-0.5b`):** **`Qwen2.5-0.5B-Instruct`** (Apache-2.0, `Q4_K_M` GGUF, ~400 MB RAM) for 4 to 5 GB RAM laptops or ultra-fast commit/sentence fixes.
- **Optional Challenger (Phase 3 Bake-Off Only):** `Qwen3-1.7B` (with thinking disabled) may be evaluated side by side in Kaggle against `Qwen2.5-1.5B-Instruct`; swapping GGUFs requires zero Rust code changes.
- **User Choice / BYOM:** Advanced users with 16+ GB RAM or GPUs can optionally point `lexel-daemon` to a larger local GGUF (3B/7B) or an existing local Ollama endpoint (`127.0.0.1:11434`).

### 6.2 Lazy Load, Context Budget, and Auto-Unload
- **Cold State (Default):** At boot, `lexel-daemon` uses < 15 MB RAM (SQLite + socket listener only). Harper handles 100% of typing checks.
- **Warm-Up on Trigger:** When the user highlights text or hits the Lexel rewrite shortcut (e.g., `Ctrl+Shift+L` / Code Action), `llama.cpp` memory-maps (`mmap`) the GGUF file in ~200 to 500 ms and streams tokens via SSE/IPC.
- **Tight Context Window (`n_ctx = 1024` or `2048`):** Keeps KV cache under ~40 MB RAM instead of allocating multi-gigabyte context buffers.
- **Idle Auto-Unload:** Configurable TTL (default: **3 minutes** after last AI request). When idle, `lexel-daemon` drops the model context and frees the ~1 GB RAM back to the OS. Users with 16+ GB RAM can toggle **"Keep Model Warm"** in settings.
- **CPU Thread Cap:** Defaults to `physical_cores - 1` (or max 4 to 6 threads) at `nice` low priority so the editor/browser UI never stutters during generation.

---

## 7. Local Privacy-First Database (`lexel.db`)

All user preferences, surface personalities, and writing style history live in a single local SQLite database (`~/.local/share/lexel/lexel.db` on Linux, `~/Library/Application Support/lexel/lexel.db` on macOS, `%APPDATA%\lexel\lexel.db` on Windows).

### 7.1 Core Schema Design
1. **`surface_profiles` (Where the user is writing):**
   - `id` (e.g., `ide_code_comment`, `ide_git_commit`, `web_reddit`, `web_x`, `web_github_pr`, `web_linkedin`, `web_discord_slack`, `web_email`, `general`)
   - `matcher_type` & `matcher_pattern` (URL hostname glob, LSP language ID such as `git-commit` or `rust`, or desktop app process name)
   - `register` (e.g., `concise_technical`, `casual_peer`, `imperative_changelog`, `direct_professional`)
   - `rules_json` (char/word min-max, allow_links, allow_emojis, allow_hashtags, allow_contractions, preserve_code_tokens, forbidden_openers)
   - `prompt_directive` (short instruction tag fed to the 1.5B model)
   - `ai_enabled_by_default` (boolean; user can disable AI on specific apps/domains)
2. **`sub_contexts` (Specific places within a surface):**
   - E.g. `reddit.com/r/rust` vs `reddit.com/r/marketing`, or Git repo `/home/user/work-repo` (Conventional Commits enabled) vs `/home/user/personal` (freeform commits).
   - Stores learned local overrides (preferred commit prefixes `feat:`, `fix:`, repo-specific terminology).
3. **`voice_examples` + `voice_examples_fts` (SQLite FTS5 User Voice Memory):**
   - Captures: `surface_id`, `original_text`, `ai_draft`, `user_final_text`, `action_taken` (`accepted`, `edited`, `rejected`), `edit_distance`, `timestamp`.
   - When the user triggers an AI rewrite on a surface, `lexel-daemon` runs an FTS5 query over `voice_examples` for that surface (filtering for `accepted` or low-edit-distance `edited` items) and injects the top **2 real examples** of the user's own phrasing into the prompt. This adapts the 1.5B model to the user's authentic voice locally without retraining weights.
4. **`user_style_stats` (Extracted Writing Fingerprint):**
   - Tracks rolling averages per surface: average sentence length, contraction ratio, exclamation frequency, banned personal words, and vocabulary preferences.
5. **`privacy_rules` (Zero-Capture Blocklist):**
   - Domain and field exclusions: password inputs, `type="password"`, credit card forms, banking/medical domains, `.env` files, private/incognito browser windows.
   - When matched: **Tier 0 Harper runs in memory-only mode; Tier 1 AI and SQLite logging are strictly blocked.**
   - Supports **1-Click Export (JSON)**, **1-Click Purge**, and **Ephemeral Mode** (no `voice_examples` saved).

### 7.2 Syncing with Harper Dictionaries & Rule Toggles
- `lexel-core` reads and writes Harper's three dictionary scopes (`user_dict`, `file_dict`, and per-repo `workspace_dict`), `ignored_lints`, and per-rule enable/disable flags so adding a technical term (e.g., `Uniffi`, `Ollama`, `Weirpack`) or muting a rule applies across browser, IDE, CLI, and desktop simultaneously.

---

## 8. Surface & Personality Behavior Matrix

Lexel detects the active context automatically and selects the matching profile:

| Surface | Detection Signal | Tier 0 (Harper + Deterministic) | Tier 1 (Local AI Behavior) |
| :--- | :--- | :--- | :--- |
| **IDE Code Comments & Docstrings** | LSP language ID (`rust`, `ts`, `py`, `go`) + `harper-comments` mask | Checks grammar only inside comments/docstrings; ignores code identifiers & snake_case. | Preserves all backticks, symbol names, and URLs. Rewrites verbose comments to concise "why" explanations. Never alters code syntax. |
| **Git / JJ Commits** | LSP (`git-commit`, `scminput`, `jj-commit`) + `harper-git-commit` | Enforces subject length, spelling, capitalization. | Formats into imperative mood (`Add X`, `Fix Y`), supports Conventional Commits (`feat:`, `fix:`) if repo uses them, removes fluff. When triggered, `lexel-ls` reads local `git diff --cached --stat` so file paths stay grounded. |
| **GitHub PRs & Issues** | Browser URL `github.com/*/(pull|issues|compare)` | Checks markdown, code blocks intact, flags AI buzzwords. | Structures repro steps, trade-offs, and concise review comments without sycophancy ("LGTM, great job!" fluff removed). |
| **Reddit** | Browser URL `reddit.com/r/*` (captures subreddit in `sub_contexts`) | Blocks links if configured, flags emojis/hashtags, flags em dashes and AI clichés. | Direct, casual-to-technical peer register. Zero marketing tone, zero emojis, zero sign-offs. Matches subreddit technicality. |
| **X / Twitter** | Browser URL `x.com` / `twitter.com` | Live 280-char counter + flags hashtags/emojis/slop. | Compresses thought into 180 to 240 chars with concrete details, zero engagement-bait openers. |
| **LinkedIn** | Browser URL `linkedin.com` | Flags sycophantic openers and corporate slop list. | Crisp, grounded professional framing; turns vague claims into concrete specifics without hype. |
| **Slack / Discord** | Browser URL or Desktop app window | Relaxed spelling/slang tolerance (ignores `lgtm`, `btw`, `imo`, handles). | Fast cleanup for clarity/tone (e.g., "Make clearer" or "Soften tone") while keeping natural chat brevity. |
| **Email (Gmail / Thunderbird)** | Browser URL or Desktop app | Formal grammar, clarity, passive-voice hints. | Direct subject + concise ask; eliminates filler ("I hope this email finds you well"). |

### 8.1 Browser Surface Detection & Extension Popover UX (`lexel-browser`)
Harper's browser content script already detects hosts/editors (`window.location.hostname` plus `<meta>`/`<link>` DOM checks like `isSubstack()` / `isWordPress()`) to toggle linting per domain. Lexel extends that mechanism into a 3-layer surface router:

1. **URL + Path & Composer Detection (Instant, Local):**
   - Matches hostname and path patterns (e.g., `reddit.com/r/<subreddit>` sets `surface = web_reddit` and `subcontext = r/rust`; `github.com/<owner>/<repo>/pull/*` sets `web_github_pr`).
   - Checks whether the focused field is a reply/comment box vs a new post composer.
   - Falls back to `<meta>` / DOM fingerprints for custom domains (Substack, WordPress, Discourse, self-hosted GitLab/Gitea).
2. **Automatic Tier 0 Rule Activation (WASM, 0 MB AI RAM):**
   - Focusing a text field immediately activates that surface's rules from `ml/personas/surfaces.json` (e.g., on Reddit: flags AI slop, em dashes, emojis, hashtags, self-promo openers, and optional link warnings).
3. **Popup & Floating Bubble Suggestions (On-Demand AI):**
   - Opening the extension popup or clicking the floating Lexel pill displays the detected surface badge (e.g., `Reddit · r/rust`) with a 1-click manual override dropdown.
   - Surfaces context-relevant AI actions (`Rewrite for Reddit`, `Remove AI tone`, `Shorten`, `Draft reply`).
   - **On-Click Thread Grounding:** Only when the user explicitly clicks an AI reply/polish action, the content script reads the immediate parent comment/post title from the DOM (never scraping pages in the background) so `Qwen2.5-1.5B-Instruct` stays grounded in the thread.
   - Accepted or user-edited suggestions save back to `lexel.db` under `(surface, subcontext)` so future rewrites match the user's actual voice in that place.

---

## 9. Training the Local 1.5B AI on Kaggle Free Tier with Unsloth

Kaggle Free Tier provides ~30 hours/week of GPU (`2x T4 16GB` or `P100 16GB`), ~12 hours per session, and ~20 GB working disk. A 1.5B model fits comfortably in 16 GB VRAM even in 4-bit QLoRA with long batch packing, completing full runs in **1 to 2 hours**.

### 9.1 Task Formulation (Instruction Format)
Train the model as a **context-conditioned writing editor**, not an open-ended chatbot. Every training example uses a strict, compact chat template with structured tags so a 1.5B model learns strong task switching:

```text
<|system|>
You are Lexel, a concise human writing editor. Preserve all facts, numbers, URLs, and code tokens. Never use em dashes or AI clichés.
<surface>reddit</surface>
<subcontext>r/rust</subcontext>
<task>rewrite_clear</task>
<voice_examples>
- "Benchmarks look solid, though the allocator spikes above 10k req/s."
</voice_examples>
<|user|>
<source>
In today's fast-paced software landscape, I wanted to delve into why our Rust service is seamlessly leveraging tokio for better performance -- it's truly a game-changer!
</source>
<|assistant|>
We moved our Rust service to tokio and cut tail latency across the board. Curious how it holds up under bursty loads.
```

Core `<task>` primitives to train on:
1. `fix_grammar_flow`: Minimal-edit fluency fix keeping exact user voice.
2. `deslop`: Strip AI clichés, filler, em dashes, and corporate padding.
3. `rewrite_surface`: Adapt draft to target `<surface>` constraints.
4. `shorten`: Compress by 30 to 50% without dropping numbers/entities.
5. `polish_comment`: Clean up code comment / docstring (keeping backticks & symbols untouched).
6. `polish_commit`: Turn rough notes or diff summary into a clean commit message.
7. `reply_draft`: Draft a concise context-matched reply from bullet notes + thread context.

### 9.2 Dataset Construction & Quality Gate (Crucible)
Target **8,000 to 15,000 high-signal examples** (quality beats millions of noisy rows for 1.5B):
1. **Source Corpora:**
   - **Clean Human Tech & Writing:** High-upvoted technical Reddit discussions (curated, deduplicated, PII-scrubbed), open-source Git commit histories (Linux, Rust, ripgrep, Harper itself), clean docstrings/comments from permissive Apache/MIT repos, and Prose's `wlab_session2_clean` + `03-research/corpora/`.
   - **Synthetic Slop-to-Human Reverse Pairs:** Take real, crisp human developer comments/commits/posts as the **target**, and generate "AI-slopified" or "rough typo-ridden" versions as the **input** (`<source>`). This guarantees the target is 100% genuine human writing!
2. **Automated 6-Point Crucible Filter (before training):**
   - Zero banned slop words in targets (`Prose` 30+ word list + expanded list).
   - Zero em dashes (`U+2014`) in targets.
   - 100% entity/number/code-token preservation check between `<source>` and `<target>` (for rewrite tasks).
   - Length and formatting compliance per `<surface>` tag.
   - MinHash deduplication + strict held-out benchmark isolation (300 held-out test cases across all 8 surfaces).

### 9.3 Kaggle Two-Stage Training Pipeline (Unsloth)
Use two separate Kaggle notebooks (each runs well under the 12-hour session limit and saves checkpoints to Kaggle Datasets / Hugging Face Hub):

- **Notebook 1: Stage 1 QLoRA SFT (`lexel-sft-kaggle.ipynb`)**
  - Base model: `unsloth/Qwen2.5-1.5B-Instruct-bnb-4bit` (plus `unsloth/Qwen2.5-0.5B-Instruct-bnb-4bit` for the lite tier)
  - LoRA config: `r=32`, `lora_alpha=64`, `lora_dropout=0`, target all linear projections (`q_proj`, `k_proj`, `v_proj`, `o_proj`, `gate_proj`, `up_proj`, `down_proj`)
  - Sequence packing enabled (`max_seq_length=1024` or `1536`)
  - Completion-only loss masking (`train_on_responses_only` in Unsloth, matching Prose's `_CompletionMaskCollator`)
  - Hyperparameters: 2 epochs, cosine LR `2e-4`, 5% warmup, effective batch size 16–32
  - Runtime on Kaggle T4: ~45 to 90 minutes for 10k examples
  - Output: Saved SFT LoRA adapter uploaded to HF Hub / Kaggle output

- **Notebook 2: Stage 2 Preference Alignment + GGUF Export (`lexel-dpo-gguf-kaggle.ipynb`)**
  - Load Stage 1 adapter and run **DPO / ORPO** via Unsloth `PatchDPOTrainer` on **2,000 to 3,000 counterfactual preference pairs**:
    - `chosen`: crisp, fact-grounded human edit matching `<surface>`
    - `rejected`: fluent output containing subtle AI tells (an em dash, "delve", "seamless", sycophancy opener, exceeded char limit, or altered number/backtick)
  - Run automated evaluation on the 300-case held-out suite (Slop Rate, Numeric/Symbol Preservation Rate, Surface Rule Pass Rate, Harper Lint Pass Rate, Latency).
  - Optionally benchmark against `Qwen3-1.7B` (non-thinking `Q4_K_M`) on CPU tokens/sec and held-out accuracy; ship the winner (default `Qwen2.5-1.5B-Instruct` unless `Qwen3-1.7B` beats it meaningfully at similar latency).
  - Merge LoRA -> 16-bit -> convert & quantize via `unsloth`'s `save_pretrained_gguf(..., quantization_method=["q4_k_m", "q5_k_m", "q8_0"])` (or `llama.cpp` `llama-quantize`).
  - Output: `lexel-1.5b-q4_k_m.gguf` (~1.0 GB) + `lexel-0.5b-q4_k_m.gguf` (~400 MB) + `SHA256SUMS` published to Hugging Face & GitHub Releases.

---

## 10. System Integration & Distribution Plan

### 10.1 Monorepo Structure (`/home/lawand/Lexel`)
```text
Lexel/
├── vendor/
│   └── harper/                  # Git submodule -> github.com/automattic/harper
├── crates/
│   ├── lexel-core/              # Wraps harper-core + anti-slop Weirpack + numeric/surface verifier
│   ├── lexel-db/                # Local SQLite (surfaces, sub_contexts, FTS5 voice_examples, privacy)
│   ├── lexel-ai/                # llama.cpp bindings, lazy load/unload, prompt builder
│   ├── lexel-daemon/            # Local IPC/Native Messaging/HTTP-SSE service
│   ├── lexel-ls/                # LSP (`tower-lsp-server` on lexel-core + Harper parsers + AI Code Actions)
│   ├── lexel-wasm/              # WASM build wrapping harper-wasm + lexel-core Tier 0 rules
│   └── lexel-cli/               # CLI: lint, rewrite, models, sync-harper, db export/wipe
├── packages/
│   ├── lexel-ui/                # Shared React 19 + Tailwind CSS v4 components (diff cards, badges, toggles)
│   ├── lexel-browser/           # Lexel's Chrome/Firefox MV3 extension (React 19 + Vite + lexel-wasm)
│   ├── lexel-vscode/            # Lexel's VS Code / Cursor / Windsurf extension (spawns lexel-ls)
│   └── lexel-obsidian/          # Lexel's Obsidian plugin (lexel-wasm + optional lexel-daemon bridge)
├── apps/
│   ├── lexel-desktop/           # Lexel's Tauri v2 + React 19 desktop app (model, persona & OS overlay)
│   └── lexel-web/               # Next.js + React 19 marketing site, docs & live lexel-wasm sandbox
├── ml/
│   ├── crucible/                # Dataset builder, slop trie, AST/number check, held-out eval
│   ├── kaggle/                  # Unsloth SFT & DPO/GGUF export notebooks
│   └── personas/                # Default surface_profiles seed JSON
├── rules/
│   └── lexel-antislop.weirpack  # Custom Harper Weirpack for deterministic slop detection
├── .github/workflows/
│   ├── ci.yml                   # Rust + WASM + Extension tests
│   └── sync-harper.yml          # Weekly automated upstream Harper submodule sync PR
├── Cargo.toml
├── package.json / pnpm-workspace.yaml
├── Makefile / justfile          # sync-harper, dev-browser, build-ls, build-desktop, test
└── PLAN.md
```

### 10.2 End-User Install Experience (Zero Friction)
1. **Browser-Only Quick Start (0 dependencies):** User installs the Lexel Chrome/Firefox extension. Tier 0 (Harper + Lexel anti-slop + surface checks) works **immediately in WASM** with zero install beyond the extension.
2. **Unlock Local AI Everywhere:** User installs `lexel-daemon` (via `brew`, `cargo`, `.deb`/`.AppImage`, Windows installer, or Tauri `lexel-desktop` app), which registers the Chrome/Firefox Native Messaging manifest and downloads `lexel-1.5b-q4_k_m.gguf` (~1 GB) on first AI toggle.
3. **IDE Setup:** Install `lexel-vscode` (auto-bundles or downloads `lexel-ls`) or point Neovim/Zed/Helix LSP config to `lexel-ls`.

---

## 11. Phased Execution Roadmap

### Zero-Rework Stack Guarantee (No Phase Throwaways)
Every phase builds directly on the previous phase using the same final tools and contracts:
- **Same Language & Core:** `lexel-core`, `lexel-db`, `lexel-ai` (`llama-cpp-2`), and `lexel-daemon` are written once in Rust Edition 2024 and never replaced.
- **Same Prompt & Model Swap:** Phase 2 tests `lexel-daemon` using the base `Qwen2.5-1.5B-Instruct` (`Q4_K_M`) GGUF and the exact `<surface>/<task>/<voice_examples>` schema; Phase 3 only swaps in the fine-tuned `lexel-1.5b-q4_k_m.gguf` (and `lexel-0.5b-q4_k_m.gguf`) with zero daemon code changes.
- **Same Rules Source of Truth:** `rules/slop_terms.json` and `ml/personas/surfaces.json` drive Rust runtime checks, WASM checks, and Python Kaggle dataset filtering simultaneously.
- **Same Frontend Stack:** `packages/lexel-ui` (React 19 + Tailwind CSS v4) is used unchanged across `lexel-browser`, `lexel-desktop`, and `lexel-web`.

### Phase 1: Workspace Foundation & Harper Sync Engine
- Initialize Rust + pnpm workspace in `/home/lawand/Lexel` and add `vendor/harper` as a git submodule.
- Build `crates/lexel-core` wrapping `harper-core` (`LintGroup::new_curated`) + port `SLOP_WORDS`, em-dash rule, and `UNIT_BOUND_REGEX` numeric grounding from `Prose`.
- Package initial anti-slop rules as a Harper `Weirpack` (`rules/lexel-antislop.weirpack`).
- Implement `scripts/sync-harper.sh` (exposed via `make sync-harper` / `just sync-harper`) and `.github/workflows/sync-harper.yml`.
- **Exit Criteria:** `lexel-cli check` runs Harper + Lexel anti-slop checks in <5 ms; `make sync-harper` cleanly pulls upstream Harper commits.

### Phase 2: Local Database, Surface Matrix & Daemon
- Build `crates/lexel-db` (SQLite schema for `surface_profiles`, `sub_contexts`, `voice_examples` with FTS5, `privacy_rules`).
- Seed the 8 default developer & social surface profiles.
- Build `crates/lexel-ai` with `llama.cpp` inference, lazy loading, KV cache cap, and 3-minute idle auto-unload.
- Build `crates/lexel-daemon` with Unix socket / Named Pipe, Chrome Native Messaging host, and Tier 2 Post-AI Gatekeeper.
- **Exit Criteria:** Daemon stays <15 MB RAM when idle, loads a base GGUF on demand, runs rewrite + Tier 2 grounding check, and auto-unloads after timeout.

### Phase 3: Kaggle Free-Tier Model Training (Unsloth)
- Build `ml/crucible/` Python tooling (reusing Prose's completion-masking and strict validator patterns) and curate 8k–15k multi-surface pairs + 2k–3k DPO counterfactual pairs + 300 held-out tests.
- Run Stage 1 SFT and Stage 2 DPO + GGUF quantization on Kaggle free tier (`Qwen2.5-1.5B-Instruct` default + `Qwen2.5-0.5B-Instruct` lite tier).
- Benchmark against base Qwen on Slop Rate, Number/Symbol Preservation, Surface Compliance, and CPU latency.
- **Exit Criteria:** Quantized GGUF beats base model on zero-slop (>95%) and surface compliance while preserving 100% of code tokens and numbers.

### Phase 4: IDE (LSP + VS Code) & Browser Extension
- Build `crates/lexel-ls` (`tower-lsp-server` on `lexel-core` + Harper parser crates) with Code Actions (`Lexel: Deslop`, `Lexel: Concise Comment`, `Lexel: Polish Commit` using local `git diff --cached --stat`).
- Build `packages/lexel-vscode` (spawning `lexel-ls`) with settings for AI toggle, model status indicator, and commit-box polish.
- Build `packages/lexel-browser` (Lexel's own React 19 MV3 extension using `lexel-wasm` + headless DOM/Google Docs box mapping from `lint-framework`):
  - Tier 0 runs via `lexel-wasm` on every keystroke.
  - Domain detector selects `reddit`, `x`, `github`, `linkedin`, `gmail`, etc., shows live surface constraint badges (e.g., X char limit, Reddit link warning), and offers Lexel's custom inline AI rewrite popover via Native Messaging to `lexel-daemon`.
- **Exit Criteria:** Works reliably in VS Code/Zed/Neovim and Chrome/Firefox on GitHub, Reddit, X, and Gmail with zero typing lag when AI is idle.

### Phase 5: Desktop App, Obsidian, Web Site & Open-Source Release
- Build `apps/lexel-desktop` (Tauri v2 + React 19) for model downloads, surface persona customization, local voice-memory viewer/editor, and system-wide quick rewrite hotkey.
- Build `packages/lexel-obsidian` (Tier 0 via `lexel-wasm` + optional authenticated localhost bridge to `lexel-daemon`) and document LSP setup for Neovim, Zed, Helix, and Emacs.
- Build `apps/lexel-web` (Next.js + React 19) for the public site, docs, and an interactive `lexel-wasm` sandbox reusing `packages/lexel-ui`.
- Add automated installer scripts, Homebrew/AUR/Winget packaging, full privacy audit documentation, and release v0.1.0 under Apache-2.0.

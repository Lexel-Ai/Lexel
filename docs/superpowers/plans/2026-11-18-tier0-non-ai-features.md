# Lexel Non-AI Tier 0 Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `.agents/skills/subagent-driven-development/SKILL.md` (or `.agents/skills/executing-plans/SKILL.md` if inline) to implement this plan task-by-task using TDD (`test-driven-development`).

**Goal:** Ship high-impact, zero-AI, sub-5 ms Tier 0 writing features across Rust (`lexel-core`, `lexel-daemon`) and TypeScript (`lexel-lab`, `lexel-browser`) using untapped `vendor/harper` APIs and deterministic scanners, outperforming Grammarly on privacy, slop hygiene, and developer control without modifying `vendor/harper`.

**Architecture:**
- **Never modify `vendor/harper`**. Extend only `crates/lexel-*`, `apps/lexel-lab`, and `packages/lexel-browser`.
- **Single source of truth & privacy-first**: Keep secrets/PII detection deterministic and local in both Rust (`lexel-core`) and TypeScript (`verifier.ts`). Block Tier 1 AI rewrite calls if secrets/PII are present in input text unless explicitly excluded/redacted by the user.
- **Disjoint file ownership per task** so Task 1 + Task 2 can run in parallel, followed by Task 3 + Task 4 in parallel.

---

### Task 1: Rust Core & Daemon Tier 0 Upgrades (`crates/lexel-core`, `crates/lexel-db`, `crates/lexel-daemon`)

**Owns:**
- `crates/lexel-core/Cargo.toml`
- `crates/lexel-core/src/{lib,models,profile,slop,surfaces,harper,verifier,secrets}.rs`
- `crates/lexel-core/tests/core_tests.rs`
- `crates/lexel-db/src/lib.rs`, `crates/lexel-db/tests/db_tests.rs` (only if schema/profile sync needs fields, otherwise `UnifiedSettings` JSON handles new fields cleanly)
- `crates/lexel-daemon/src/{service,http,native_messaging}.rs`
- `crates/lexel-daemon/tests/daemon_tests.rs`

**Scope:**
1. **Secrets & PII Leak Scanner (`crates/lexel-core/src/secrets.rs`):**
   - Deterministic detector (`scan_secrets(text: &str) -> Vec<SecretMatch>`) for OpenAI/Anthropic-style keys (`sk-...`, `sk-ant-...`), GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), AWS access keys (`AKIA[0-9A-Z]{16}`), Slack tokens (`xox[baprs]-...`), Google API keys (`AIza[0-9A-Za-z_-]{35}`), JWTs (`eyJ...\.eyJ...\.[A-Za-z0-9_-]+`), PEM private key headers (`-----BEGIN ... PRIVATE KEY-----`), `Bearer <token>` headers, SSN-shaped tokens (`\b\d{3}-\d{2}-\d{4}\b`), and Luhn-validated 13-19 digit payment card sequences.
   - Redact/mask preview in `SecretMatch` (never return or log raw full secrets in daemon logs/UI summaries; show prefix+length or masked preview e.g. `sk-***...`).
   - Integrate into `tier0_scan` / `verify_ai_rewrite` (`secrets_free: bool`) in `verifier.rs` and `slop`/`Tier0Diagnostic`.
2. **Dialect::Indian & Harper Untapped APIs (`crates/lexel-core/src/harper.rs`):**
   - Add `Indian = 4` to `LexelDialect` and map to `harper_core::Dialect::Indian`.
   - Add `harper-thesaurus` dependency in `crates/lexel-core/Cargo.toml` and expose `synonyms_for(word: &str) -> Vec<String>` via `harper_thesaurus::thesaurus().get_synonyms_freq_sorted(...)`.
   - Expose `to_title_case(text: &str) -> String` using `harper_core::make_title_case` / `harper_core::TitleCase` (verify exact `harper-core` symbol in `vendor/harper/harper-core` before coding).
   - Expose `structured_lint_config()` returning Harper's `StructuredConfig` / curated rule tree (`harper_core::linting::StructuredConfig`) if available in `harper-core`.
   - Expose `validate_and_load_weirpack(bytes: &[u8])` helper if `harper_core::weirpack` exists in vendored `harper-core`.
3. **Custom Anti-Slop Terms, Custom Surfaces & Safe Deterministic Replacements (`profile.rs`, `slop.rs`, `surfaces.rs`, `verifier.rs`):**
   - Extend `UnifiedSettings` (with `#[serde(default)]` for backwards compatibility with existing JSON in `lexel.db`!) with:
     - `custom_slop_terms: Vec<String>`
     - `disabled_slop_terms: Vec<String>`
     - `custom_surfaces: Vec<SurfaceProfile>` (or compatible custom surface struct)
     - `language_mode: String` (`"plaintext" | "markdown" | "typst"`, default `"plaintext"`)
   - Update `slop::find_slop_with_config(text, custom, disabled)` and add deterministic `apply_safe_deterministic_fixes(text, surface_id, custom_slop, disabled_slop)` using a curated safe replacement table (e.g., em dash -> `, ` or `: ` fallback, safe slop phrases like `delve into` -> `explore`, `utilize` -> `use`, `in order to` -> `to`, emoji/hashtag cleanup when `allow_emojis == false` / `allow_hashtags == false`).
4. **Daemon Guard & Routes (`crates/lexel-daemon/src/service.rs`):**
   - Update `tier0_check` to accept optional `language` / custom rules and return `secrets` diagnostics + `safe_fixed_text` or safe fix count.
   - Update `rewrite` to refuse sending text containing detected secrets/PII to Tier 1 AI (returning a clear privacy-guard error explaining which secret categories matched, without logging the text).
   - Add daemon RPC methods/routes: `tier0/title-case`, `tier0/fix-safe`, `tier0/synonyms`, and `harper/structured-rules` (update `http.rs` / `native_messaging.rs` dispatch if actions are explicitly enumerated).

**TDD Verification:**
- Write unit/integration tests first in `crates/lexel-core/tests/core_tests.rs` and `crates/lexel-daemon/tests/daemon_tests.rs`.
- Run `cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`.

---

### Task 2: Shared TypeScript Tier 0 Engine (`verifier.ts`, `types.ts`, `storage.ts`, `surfaces`)

**Owns:**
- `packages/lexel-browser/src/shared/{types,storage,surfaceDetector,verifier}.ts`
- `packages/lexel-browser/src/shared/*.test.ts` (e.g. `verifier.test.ts`)
- `apps/lexel-lab/src/lib/{types,storage,surfaces,verifier}.ts`
- `apps/lexel-lab/src/lib/*.test.ts`

**Scope:**
1. **Unified Types & Storage Backwards Compatibility:**
   - Add `Dialect` value `4` (`Indian`) cleanly to dialect types (`0 | 1 | 2 | 3 | 4`) in both packages.
   - Add `LintLanguage = 'plaintext' | 'markdown' | 'typst'` to settings (`languageMode`, default `'plaintext'`).
   - Add `customSlopTerms: string[]`, `disabledSlopTerms: string[]`, `customSurfaces: SurfaceProfile[]` (plus `weirpackNames?: string[]`) to `ExtensionSettings` / `LabSettings` / `ProfilePayload` with safe defaults in storage normalization so existing saved settings migrate cleanly.
2. **Deterministic Secrets & PII Leak Guard (`verifier.ts` in both browser & lab):**
   - Implement `scanSecretsAndPii(text: string): SecretMatch[]` covering API keys (`sk-`, `sk-ant-`, `ghp_`, `github_pat_`, `AKIA`, `AIza`, `xox...`), JWTs, PEM blocks, `Bearer` tokens, SSN format, and Luhn-checked 13-19 digit card numbers. Return masked snippets only (never expose raw full secret in titles/messages).
   - Emit `LexelSecrets` diagnostics from `scanTier0Diagnostics` with high severity (`category: 'Privacy'`) and add `secretsFree` gate in `verifyAiRewrite`.
3. **One-Click Safe Deterministic Fixes & Customizable Anti-Slop:**
   - Implement `SLOP_SAFE_REPLACEMENTS` + `applySafeDeterministicFixes(text, surface, options)` handling:
     - Safe slop phrase rewrites / removals (respecting `customSlopTerms` and `disabledSlopTerms`)
     - Em dash replacement (`, `)
     - Emoji stripping when `!surface.allowEmojis` and hashtag stripping when `!surface.allowHashtags`
     - Unambiguous single-suggestion Harper lints when passed in (non-overlapping spans, reverse-offset safe application).
   - Ensure `resolveSurfaceProfile(surfaceId, customSurfaces)` resolves both built-in and user-created surfaces cleanly across browser and lab.

**TDD Verification:**
- Write failing Vitest specs in `packages/lexel-browser/src/shared/verifier.test.ts` and `apps/lexel-lab/src/lib/verifier.test.ts` covering secrets detection (valid Luhn vs non-Luhn numbers, JWTs, API keys), `applySafeDeterministicFixes`, custom/disabled slop terms, custom surfaces, and `Dialect.Indian`.
- Run `pnpm --filter @lexel/browser test` and `pnpm --filter @lexel/lab test` and `pnpm -r typecheck`.

---

### Task 3: `apps/lexel-lab` Non-AI Tier 0 Workspace Upgrades

**Depends on:** Task 2 (`apps/lexel-lab/src/lib/*`).
**Owns:**
- `apps/lexel-lab/src/lib/{engine,daemonClient}.ts`
- `apps/lexel-lab/src/App.tsx`
- `apps/lexel-lab/src/components/{RulesWorkspace,SettingsView}.tsx`
- `apps/lexel-lab/src/**/*.test.tsx` (optional UI unit tests if vitest DOM env is configured)

**Scope:**
1. **`engine.ts` Untapped `harper.js` APIs:**
   - Expose `dialect` including `4` (`Indian`), `language` (`LintOptions.language`: `'plaintext' | 'markdown' | 'typst'`), `toTitleCase(text)`, `getStructuredLintConfig()`, `loadWeirpackBytes(bytes)` (returning `WeirpackTestFailures | undefined`), `summarizeStats()`, `exportStatsFile()`, `importStatsFile()`, and `recordSuggestionApplied` / `linter.applySuggestion` integration so Harper stats actually populate when applying suggestions.
   - Enhance `computeTextStats(text, diagnostics)` with `readingTimeSec`, `slopDensity` (slop issues per 100 words), and `secretCount`.
2. **`RulesWorkspace.tsx` Upgrade:**
   - Replace/upgrade flat rule list using `getStructuredLintConfig()` so users browse grouped Harper categories (`Bool` checkboxes + `OneOfMany` `<select>` controls + collapsible/clean group sections) with live search.
   - Add **Anti-Slop Customizer** section: add custom banned terms, toggle built-in slop terms on/off.
   - Add **Custom Surfaces** section: create/delete custom surfaces (max words, emoji/hashtag policy, tone instructions) synced into settings/daemon profile.
   - Add **`.weirpack` Pack Importer**: file input (`accept=".weirpack"`), runs `loadWeirpackBytes`, displays embedded test pass/fail results cleanly.
3. **`App.tsx` & `SettingsView.tsx` Upgrade:**
   - Add toolbar actions: **Fix Safe Issues** (one-click deterministic cleanup without AI) and **Title Case** (`linter.toTitleCase`).
   - Add **Secrets & PII Alert Banner** whenever `LexelSecrets` triggers in the draft, and disable/guard AI rewrite trigger while unacknowledged secrets remain in the draft.
   - Add **Local Writing Stats** drawer/panel showing reading time, slop density, Harper `summarizeStats()`, and JSON stats export/import.
   - Add `Indian English` dialect (`4`) and `Lint Mode` (`Plaintext` / `Markdown` / `Typst`) in `SettingsView.tsx`.
   - Strictly obey `DESIGN.md` tokens and `antislop` rules (no em dashes, no generic AI buzzwords, accessible native `<button>`/`<label>`/`<select>`, WCAG AA contrast).

**Verification:**
- `pnpm --filter @lexel/lab typecheck && pnpm --filter @lexel/lab test && pnpm --filter @lexel/lab build`

---

### Task 4: `packages/lexel-browser` Non-AI Tier 0 Extension Upgrades

**Depends on:** Task 2 (`packages/lexel-browser/src/shared/*`).
**Owns:**
- `packages/lexel-browser/src/background/index.ts`
- `packages/lexel-browser/src/contentScript/{ProtocolClient,AiFloatingPill,LexelSuggestionPopover,LexelLintController}.ts*`
- `packages/lexel-browser/src/popup/PopupApp.tsx`
- `packages/lexel-browser/src/sidepanel/SidePanelApp.tsx`
- `packages/lexel-browser/src/options/OptionsApp.tsx`
- `packages/lexel-browser/src/contentScript/*.test.ts` (if adding tests)

**Scope:**
1. **Background & Protocol Wiring (`background/index.ts`, `ProtocolClient.ts`):**
   - Pass `language: settings.languageMode` into `harper.js` `lint(text, { language })`.
   - Handle `getStructuredRules`, `toTitleCase`, `loadWeirpack`, `fixSafeIssues`, `getStatsSummary`, `exportStats`, `importStats` messages cleanly in `background/index.ts` and `ProtocolClient.ts`.
   - Use `linter.applySuggestion` when recording applied Harper fixes (or stats bridge) so `summarizeStats` tracks real fixes.
   - Enforce Secrets & PII guard in `handleAiRewrite`: refuse sending text containing `scanSecretsAndPii` hits to local/daemon AI and return a clear privacy error message.
2. **Content Script Quick Tools (`AiFloatingPill.tsx`, `LexelSuggestionPopover.tsx`, `LexelLintController.ts`):**
   - Keep `AiFloatingPill` usable for non-AI Tier 0 tools even when AI is disabled (or show a compact non-AI pill state when Tier 0 issues or Title Case / Fix Safe tools are useful), while surfacing a visible Privacy/Secrets alert badge if secrets/PII are detected in the focused editable field.
   - Add **Fix Safe Issues** and **Title Case** one-click actions in the pill / popover without needing any LLM downloaded.
3. **Popup, Side Panel & Options UI (`PopupApp.tsx`, `SidePanelApp.tsx`, `OptionsApp.tsx`):**
   - Expose `Indian English` (`4`) dialect and `Lint Mode` (`Plaintext` / `Markdown` / `Typst`).
   - Add **Fix Safe Issues** & **Secrets Guard status** in `SidePanelApp.tsx` draft helper / active status.
   - Upgrade `OptionsApp.tsx` Rules sub-tab to grouped Harper categories (`getStructuredLintConfig` Bool + OneOfMany controls), plus Anti-Slop Customizer, Custom Surface Builder, `.weirpack` uploader (showing `WeirpackTestFailures`), and Local Writing Stats card.
   - Strictly obey `DESIGN.md` tokens and `antislop` rules (no em dashes, no generic AI buzzwords, accessible controls, WCAG AA contrast).

**Verification:**
- `pnpm --filter @lexel/browser typecheck && pnpm --filter @lexel/browser test && pnpm --filter @lexel/browser build`

---

### Final Gate (Coordinator)
Run full cross-stack verification after all tasks land:
1. `cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`
2. `pnpm -r typecheck && pnpm -r test && pnpm -r build`
3. Check zero em dashes in touched UI/docs files and run antislop contrast checks where new styles/colors are added.
4. Ensure `git status vendor/harper` shows zero edits inside `vendor/harper`.

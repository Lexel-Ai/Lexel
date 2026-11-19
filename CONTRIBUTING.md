# Contributing to Lexel

Thank you for contributing to Lexel. Every contribution is licensed under the [Apache License, Version 2.0](LICENSE) (Section 5).

## Ways to Contribute

You do not need to touch the entire monorepo to make a valuable contribution:

1. **Anti-Slop Rules & Weirpacks (`rules/slop_terms.json`, `rules/lexel-antislop.weirpack`):**
   - Propose new AI filler phrases and plain-English replacements in `rules/slop_terms.json`.
   - Rebuild and verify the Weirpack with `cargo run -p lexel-cli -- weirpack build-antislop rules/lexel-antislop.weirpack`.
2. **Platform Surfaces (`ml/personas/surfaces.json`):**
   - Tune character limits, host patterns, or prompt directives for platforms like Reddit, X, GitHub PRs, LinkedIn, Substack, or Discord.
   - Both Rust (`crates/lexel-core`) and TypeScript (`packages/lexel-ui`, `packages/lexel-browser`, `apps/lexel-desktop`) read directly from `ml/personas/surfaces.json`.
3. **Rust Core, Daemon & CLI (`crates/`):**
   - Improve deterministic Tier 0 checks, Secrets Guard patterns, SQLite FTS5 voice retrieval, Native Messaging, or local GGUF runtime handling.
4. **Desktop App & Browser Extension (`apps/lexel-desktop`, `packages/lexel-browser`, `packages/lexel-ui`):**
   - Improve accessibility, keyboard navigation, site-specific editor adapters, and settings UX. Follow [DESIGN.md](DESIGN.md) for monochrome styling and WCAG AA contrast.
5. **Upstream Harper Syncs (`scripts/sync-harper.sh`):**
   - Run `make sync-harper` to pull upstream grammar rules and dictionary improvements cleanly.

## Architecture Invariants (Read Before Coding)

1. **Never edit files inside `vendor/harper/`.** Extend Harper through `crates/lexel-core`, `.weirpack` rules, and Lexel's own packages so upstream updates merge cleanly.
2. **Keep Tier 0 zero-AI and fast (< 5 ms).** Passive typing checks must never trigger network calls or load LLM weights.
3. **Stay 100% local and privacy-first.** Never add cloud LLM calls, analytics, or telemetry, and never log raw user text.
4. **Single source of truth.** Put anti-slop terms in `rules/slop_terms.json`, surface definitions in `ml/personas/surfaces.json`, and model checksums in `models/manifest.json`.
5. **Use the repo's toolchains.** Use `cargo` for Rust, `pnpm` (never `npm`) for JS/TS workspaces, and `uv` for Python tooling.

## Development Setup

```bash
# 1. Clone with the Harper submodule
git clone --recurse-submodules https://github.com/Lexel-Ai/Lexel.git
cd Lexel

# 2. Install the commit-msg hook so commit headlines match CI checks
make install-hooks

# 3. Install JS/TS workspace dependencies
pnpm install

# 4. Run the baseline verification checks
make rust-check
make rust-test
make typecheck
make test
```

## Verification Gates Before Opening a PR

Run every gate relevant to the stacks you modified:

```bash
# Rust workspace
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

# Tauri Desktop Rust backend (if apps/lexel-desktop/src-tauri changed)
cargo fmt --manifest-path apps/lexel-desktop/src-tauri/Cargo.toml --check
cargo clippy --manifest-path apps/lexel-desktop/src-tauri/Cargo.toml --all-targets -- -D warnings

# TypeScript / React packages & apps (Biome format + lint + tsc + tests + build)
pnpm run check
pnpm -r typecheck
pnpm -r test
pnpm -r build

# Weirpack verification (if rules/ changed)
cargo run -p lexel-cli -- weirpack validate rules/lexel-antislop.weirpack
```

## Commit Message Standard

Lexel enforces Conventional Commits via `scripts/hooks/commit-msg`:

```text
<type>(<scope>): <imperative summary under 72 chars>
```

- **Valid types:** `feat`, `fix`, `perf`, `refactor`, `sec`, `arch`, `ml`, `sync`, `test`, `infra`, `docs`, `revert`
- **Canonical scopes:** `core`, `db`, `daemon`, `cli`, `ui`, `browser`, `desktop`, `rules`, `ml`, `sync`, `deps`, `repo`

Examples:
- `feat(rules): add deterministic replacement for "delve into"`
- `fix(browser): reload WASM linter after desktop dialect change`
- `docs(repo): document Windows native messaging registration`

## Pull Request Process

1. Fork the repository and create a descriptive feature branch from `main`.
2. Keep pull requests focused on one logical change and include unit/integration tests for new behavior or bug fixes.
3. Fill out the PR template checklist and include the exact verification commands you ran.
4. All CI checks must pass before merge.

## Code of Conduct

All contributors and maintainers are expected to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

---
name: quality-gates
description: Pre-commit verification gates and code hygiene rules across Rust, TypeScript, and Python in Lexel.
trigger: always_on
---

# Lexel Quality Gates & Pre-Commit Invariants

Before proposing any commit or declaring a task finished, verify every modified stack passes its local quality gates with zero errors.

---

## 1. Stack Verification Gates

### Rust (`crates/*` & `apps/lexel-desktop/src-tauri`)
```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --manifest-path apps/lexel-desktop/src-tauri/Cargo.toml --check
cargo clippy --manifest-path apps/lexel-desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --workspace
```
- Zero compiler warnings or clippy errors on Lexel crates.
- Tier 0 (`lexel-core`) must stay zero-LLM and pass latency/grounding tests.

### TypeScript / JS (`packages/*`, `apps/*`)
```bash
pnpm run check
pnpm -r typecheck
pnpm -r test
pnpm -r build
```
- Zero TypeScript errors; never silence errors with `@ts-ignore` or implicit `any`.

### Python / ML (`ml/crucible/`)
```bash
uv run pytest
```
- All dataset validation, slop-filter, and numeric-grounding unit tests must pass before running Kaggle training.

---

## 2. Code & Privacy Hygiene Rules

1. **Zero Debug Noise:** Remove temporary `println!`, `dbg!`, and `console.log` statements from production paths (`tracing` is allowed for structured daemon logs with `INFO`/`WARN`/`ERROR` levels, never logging raw user text).
2. **Zero Leaked Secrets or User Text:** Never commit tokens, `.env` secrets, SQLite DB files (`*.db`), or GGUF weights (`*.gguf`) to Git.
3. **Clean Resource Teardown:**
   - Rust (`lexel-ai`): enforce idle auto-unload (`drop(model)`) and bounded `n_ctx`.
   - React (`lexel-browser`, `lexel-desktop`): clean up DOM observers, message ports, and timers in `useEffect` returns.
4. **Honest Reporting:** Report only commands actually run after your final edit and exact pass counts observed.

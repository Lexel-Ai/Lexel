# Project Guidelines: Lexel

Master reference: [PLAN.md](PLAN.md)

## 1. Git Commit & Verification Workflow
After completing any major feature, bug fix, upstream Harper sync, ML pipeline milestone, or passing a major test suite, follow [`.agents/rules/git-commits.md`](.agents/rules/git-commits.md) and [`.agents/rules/quality-gates.md`](.agents/rules/quality-gates.md):
1. Run the relevant verification gates (`cargo fmt --check`, `cargo clippy`, `cargo test`, `pnpm -r typecheck/test/build`, `uv run pytest`).
2. Suggest **strictly ONE ready-to-run single-line bash commit command** (`git add ... && git commit -m "<type>(<scope>): <summary>" -m "- <detail>" ...`, avoiding multi-line `<< 'EOF'` heredocs) following the Conventional Commit format and Circumstance Matrix in `.agents/rules/git-commits.md` and `.gitmessage`.
3. Only report checks and pass counts actually observed after the final edit.

## 2. Architecture & Privacy Invariants
Follow [`.agents/rules/architecture-invariants.md`](.agents/rules/architecture-invariants.md) and [`.agents/rules/karpathy-guidelines.md`](.agents/rules/karpathy-guidelines.md):
- **Never modify `vendor/harper` directly**; extend Harper through `crates/lexel-*`, `.weirpack` rules, and Lexel's own packages.
- **Keep Tier 0 zero-AI and fast (< 5 ms)**; never load `Qwen2.5-1.5B-Instruct` during passive typing checks.
- **100% local & privacy-first**: zero cloud LLM calls, zero telemetry, never log raw user text.
- **Toolchain**: `cargo` (Rust), `pnpm` (JS/TS), `uv` (Python/ML). Never mix `npm` into `pnpm` workspaces.

## 3. UI, Copy & Anti-Slop Rules
- All UI and copy work must obey `antislop` (global/session mode) and Lexel's own zero-slop standard (no em dashes, no generic AI buzzwords, no ungrounded claims).
- Relevant project skills are installed under `.agents/skills/` (symlinked at `.agent/skills/`). Load the matching `SKILL.md` before specialized work (Rust, Tauri v2, Unsloth/HuggingFace, UI/UX, reverse-engineering, testing).

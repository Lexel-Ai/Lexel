## Summary

- What does this PR change and why?
- Link related issue(s): `Refs: #`

## Architecture & Privacy Checklist

- [ ] No files inside `vendor/harper/` were modified directly.
- [ ] Tier 0 checks remain deterministic, fast (< 5 ms), and load 0 MB of LLM RAM.
- [ ] No cloud LLM calls, no telemetry, and no raw user text logging were added.
- [ ] Single source of truth files (`rules/slop_terms.json`, `ml/personas/surfaces.json`, `models/manifest.json`) remain in sync.
- [ ] Contribution is submitted under the Apache License, Version 2.0.

## Verification

List the exact commands you ran locally after your final edit and their results:

- [ ] `cargo fmt --check`
- [ ] `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cargo test --workspace`
- [ ] `cargo check --manifest-path apps/lexel-desktop/src-tauri/Cargo.toml` (if Desktop Rust changed)
- [ ] `pnpm -r typecheck`
- [ ] `pnpm -r test`
- [ ] `pnpm -r build`

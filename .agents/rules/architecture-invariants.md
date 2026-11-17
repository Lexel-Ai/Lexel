---
name: architecture-invariants
description: Core system invariants, Harper sync boundaries, and Tier 0/1/2 isolation rules for Lexel.
trigger: always_on
---

# Lexel Architecture Invariants

1. **Never Hack Inside `vendor/harper`:**
   - All Lexel grammar rules, Weirpacks, slop scanners, AI logic, and UI live in `crates/`, `packages/`, `apps/`, `rules/`, and `ml/`.
   - Keeping `vendor/harper` clean ensures `make sync-harper` and weekly upstream Harper PRs merge without conflicts.

2. **Strict Tier 0 / Tier 1 / Tier 2 Separation:**
   - **Tier 0 (`lexel-core` / `lexel-wasm`):** Deterministic, sub-5 ms, 0 MB AI RAM. Runs on every keystroke. Never waits on `lexel-ai`.
   - **Tier 1 (`lexel-ai` / `lexel-daemon`):** Lazy-loaded on explicit user trigger only, constrained `n_ctx`, idle auto-unload.
   - **Tier 2 (Post-AI Verifier):** Every AI rewrite passes slop check, em-dash ban, number/symbol grounding, surface bounds, and `harper-core` lint before reaching the user.

3. **Single Source of Truth for Rules:**
   - Anti-slop terms live in `rules/slop_terms.json` and surface definitions live in `ml/personas/surfaces.json`, consumed by both Rust (`lexel-core`) and Python (`ml/crucible/`).

4. **100% Local & Privacy-First:**
   - Zero cloud LLM APIs, zero telemetry, zero remote text logging.
   - Native Messaging is primary for browser-to-daemon IPC; any `127.0.0.1` HTTP fallback must require a per-install Bearer token and strict `Origin` checks.

5. **Deep Modules & Code Hygiene:**
   - Keep public crate/package interfaces narrow and internals cohesive.
   - Comment the non-obvious *why* (invariants, edge cases, perf constraints), never narrating the *what*.

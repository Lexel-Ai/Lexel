---
name: git-commit-messages
description: Conventional Commit standard and circumstance matrix for Lexel across Rust, TypeScript, and Python/ML.
trigger: always_on
---

# Lexel Git Commit Standards & Circumstance Matrix

Every significant feature, bug fix, optimization, upstream Harper sync, ML pipeline milestone, or architectural refactor in **Lexel** must propose a structured Conventional Commit message after passing local verification.

---

## 1. Core Commit Anatomy

```text
<type>(<scope>): <imperative summary in 50-72 chars>

- <Circumstance-specific details: motivation, architecture, or root cause>
- <Modules, crates, or packages touched>
- <Measurable impact, latency/RAM numbers, or preserved invariants>

Verification:
- <Exact commands run and observed pass counts (e.g. cargo test -p lexel-core: 18/18 passing)>

Refs: #XX
```

---

## 2. Change Types & Canonical Scopes

### Valid Change Types
| Type | Purpose | When to Use |
| :--- | :--- | :--- |
| `feat` | New Feature | Adding user-facing capabilities, surface profiles, LSP actions, AI tools, or UI workflows |
| `fix` | Bug Fix | Resolving regressions, crash paths, parsing errors, or UI bugs |
| `perf` | Performance | Measurable improvements to Tier 0 latency, GGUF load speed, RAM usage, or bundle size |
| `refactor` | Refactoring | Code restructuring with **zero** behavioral change |
| `sec` | Security & Privacy | Hardening Native Messaging, localhost auth, privacy blocklists, or Tier 2 grounding checks |
| `arch` | Architecture | Workspace layout, SQLite schema migrations, IPC protocol contracts, or ADRs |
| `ml` | Model & Data | Crucible filters, Unsloth Kaggle notebooks, DPO pairs, GGUF quantization, or eval results |
| `sync` | Upstream Sync | Updating `vendor/harper` submodule and verifying parity with upstream rules/parsers |
| `test` | Testing | Adding unit, integration, adversarial, or E2E test suites |
| `infra` | Infrastructure & CI | Cargo workspace, `pnpm` config, GitHub Actions, `Makefile`, or packaging |
| `docs` | Documentation | `PLAN.md`, `README.md`, architecture docs, or guides |
| `revert` | Reversion | Rolling back a faulty commit with explicit link to the reverted SHA |

### Canonical Lexel Scopes
Use a single scope when possible (`repo` when spanning crates, UI, and extension), or comma-separated scopes (e.g. `core,ui,browser`) with no spaces inside parentheses. Keep the headline under 72 chars (`scripts/hooks/commit-msg` enforces `<= 100` chars).
- **Rust Crates:** `core`, `db`, `ai`, `daemon`, `ls`, `wasm`, `cli`
- **JS/TS Apps & Packages:** `ui`, `browser`, `vscode`, `obsidian`, `desktop`, `web`
- **Rules, ML & Tooling:** `rules`, `ml`, `sync`, `deps`, `repo`

---

## 3. Circumstance-Based Matrix

### A. Feature Delivery (`feat`)
Include: **Motivation**, **Architecture** (crates/packages touched), **UX/CLI Impact**, and **Verification**.

```text
feat(core): add deterministic anti-slop scanner and unit-bound metric verifier

- Motivation: Catch AI buzzwords and em dashes at Tier 0 latency (<1ms) and prevent 1.5B rewrites from altering numbers or PR IDs.
- Architecture: Added Aho-Corasick matcher fed by rules/slop_terms.json and unit-bound number extraction in lexel-core.
- Impact: Flags 30+ slop phrases in browser and IDE without loading the local LLM.
- Verification: cargo test -p lexel-core (24/24 passing); cargo clippy -- -D warnings clean.
```

### B. Bug Fix (`fix`)
Include: **Root Cause**, **Blast Radius**, **Resolution**, and **Regression Guard** (the exact test added).

### C. Performance (`perf`)
Include: **Bottleneck**, **Optimization**, and **Before vs. After** measured metrics (ms latency, MB RAM, tokens/sec).

### D. Privacy / Security / Grounding (`sec`)
Include: **Threat Model**, **Defense Layer**, and confirmation that **no secrets, tokens, or user text logs** are exposed.

### E. Upstream Harper Sync (`sync`)
Include: **Upstream Harper SHA**, **New Rules/Parsers Checked** (`vendor/harper/harper-ls/Cargo.toml` diff), and **Test/Build Verification**.

### F. ML Training & Evaluation (`ml`)
Include: **Dataset/Notebook**, **Crucible Filter Status**, and **Held-Out Benchmark Delta** (slop rate, number preservation, surface pass rate).

### G. Pure Refactor (`refactor`)
Explicitly state **Zero Behavioral Drift** and the test suite proving parity.

### H. Breaking Contract (`!`)
Append `!` after type/scope (e.g. `arch(daemon)!:`) and add a `BREAKING CHANGE:` footer with the migration path.

---

## 4. Single Ready-to-Run Commit Rule (After Every Major Test)

Whenever a major milestone, feature, fix, or test suite passes:
1. Run all applicable quality gates in `.agents/rules/quality-gates.md` first.
2. Output **strictly ONE short single-line ready-to-run bash command block** using `git add . && git commit -m "<type>(<scope>): <summary>"` (with a `<= 72`-char imperative headline and no extra `-m` flags or `<< 'EOF'` heredocs so terminal word-wrapping never breaks copy-paste). Put details and verification pass counts in the prose response above the command block.
3. Never invent test counts, timings, or build passes you did not directly observe. Never output duplicate commit blocks (one markdown preview + one bash block).

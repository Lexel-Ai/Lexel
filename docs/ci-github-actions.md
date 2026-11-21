# Running Lexel in GitHub Actions (CI Mode & SARIF)

`lexel check --ci` runs Lexel's deterministic Tier 0 linter (Harper grammar, anti-slop, secrets guard, structure checks, and `.lexel.toml` repository rules) with zero AI dependencies and sub-5 ms per-file latency.

## Exit Codes

- `0`: No blocking findings under the active `--fail-on` policy.
- `1`: Blocking findings detected. In `--ci` mode, `--fail-on` defaults to `slop` (blocks on secrets, AI slop/em dashes, and `.lexel.toml` violations). Pass `--fail-on any` to also fail on every Harper grammar/spelling warning, or `--fail-on secrets` to fail only on leaked credentials.

## Sample `.lexel.toml`

Place `.lexel.toml` at your repository root. Both `lexel check` and `lexel-ls` walk up parent directories to load it automatically:

```toml
dialect = "us"
preset = "strict_technical"
dictionary = ["Lexel", "Weirpack", "SimPO"]
banned_slop_terms = ["synergize => combine"]
allowed_slop_terms = []

[commit]
allowed_types = ["feat", "fix", "perf", "refactor", "sec", "test", "infra", "docs", "revert"]
require_conventional = true
require_imperative = true
max_subject_chars = 72
max_body_line_chars = 100
forbid_trailing_period = true

[docs]
tone = "direct technical"
max_line_chars = 120
max_sentence_words = 35
allow_em_dashes = false

[[style_guide]]
term = "postgres"
preferred = "PostgreSQL"
note = "Use full product name in docs"
```

## Sample GitHub Actions Workflow (`.github/workflows/lexel-docs.yml`)

```yaml
name: Lexel Docs & Commit Gate

on:
  pull_request:
    paths:
      - "**/*.md"
      - "docs/**"
      - ".lexel.toml"

permissions:
  contents: read
  security-events: write

jobs:
  lexel-ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install lexel CLI
        run: |
          curl -fsSL https://github.com/Lexel-Ai/Lexel/releases/latest/download/lexel-cli-linux-x86_64 -o /usr/local/bin/lexel
          chmod +x /usr/local/bin/lexel

      - name: Lint documentation and emit SARIF
        id: lexel
        continue-on-error: true
        run: |
          DOCS=$(git ls-files '*.md' 'docs/**/*.md')
          lexel check --ci --format sarif $DOCS > lexel-results.sarif

      - name: Upload SARIF to GitHub Code Scanning
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: lexel-results.sarif
          category: lexel-writing-lint

      - name: Enforce Lexel CI gate
        if: steps.lexel.outcome == 'failure'
        run: exit 1
```

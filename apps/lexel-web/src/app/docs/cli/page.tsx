import type { Metadata } from 'next';
import { CodeCopyBlock } from '@/components/CodeCopyBlock';
import { DocsShell } from '@/components/DocsShell';

export const metadata: Metadata = {
  title: 'CLI & CI',
  description:
    'Reference for the lexel CLI: file linting, deterministic fixes, CI SARIF output, Git hooks, lexel doctor, lexel bench, and local Voice Memory import/export.',
};

const CORE_COMMANDS = `# Lint files or stdin with Tier 0 (Harper, anti-slop, surface rules, Secrets Guard)
lexel check README.md docs/ --surface docs_markdown

# Apply safe deterministic fixes (slop phrases, em dashes, invisible Unicode)
lexel check README.md --fix-safe --write

# Print offline readability, slop, and secret counts as JSON
lexel stats README.md --json

# Install zero-AI Git commit-msg and pre-commit hooks
lexel install-git-hook --hook both --fail-on slop

# Check runtime, Native Messaging manifests, GGUF SHA-256, and Tier 0 latency
lexel doctor --bench`;

const VOICE_AND_BENCH = `# Seed local SQLite Voice Memory from your own Git commit history or files
lexel voice import --git-log --author "Your Name" --limit 50
lexel voice import --files notes/*.md --surface docs_markdown
lexel voice stats

# View private local writing insights and manage personal crutch-word bans
lexel db insights
lexel db crutch-words

# Export PII-scrubbed preference pairs for local SimPO alignment
lexel db export-simpo --out user_simpo.jsonl

# Benchmark your active local model against the held-out eval suite
lexel bench --eval ml/datasets/lexel_heldout_eval.jsonl`;

const GITHUB_ACTIONS_CI = `name: Lexel Writing Gate
on: [pull_request]

jobs:
  lexel-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install lexel CLI
        run: |
          curl -fsSL https://github.com/Lexel-Ai/Lexel/releases/latest/download/lexel-cli-linux-x86_64 -o /usr/local/bin/lexel
          chmod +x /usr/local/bin/lexel
      - name: Run deterministic Tier 0 check (SARIF)
        run: lexel check --ci --format sarif README.md docs/ > lexel.sarif
      - name: Upload SARIF results
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: lexel.sarif`;

export default function DocsCliPage() {
  return (
    <DocsShell
      title="CLI & CI"
      description="The lexel binary runs fast zero-AI checks locally, installs Git hooks, diagnoses your daemon setup, imports your writing voice, and emits SARIF reports for CI."
    >
      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          Everyday CLI commands
        </h2>
        <CodeCopyBlock code={CORE_COMMANDS} label="Lexel core CLI commands" languageLabel="bash" />
      </section>

      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          Text utilities and Weirpacks
        </h2>
        <p className="m-0" style={{ color: 'var(--lx-fg-muted)' }}>
          In addition to <code className="lx-inline-code">check</code> and{' '}
          <code className="lx-inline-code">stats</code>, the CLI includes offline helpers that never
          touch the network:
        </p>
        <ul className="m-0 space-y-1.5 pl-5" style={{ color: 'var(--lx-fg)' }}>
          <li>
            <code className="lx-inline-code">lexel synonyms &lt;word&gt; [--json]</code>: offline
            English synonyms via <code className="lx-inline-code">harper-thesaurus</code>.
          </li>
          <li>
            <code className="lx-inline-code">lexel title-case</code> and{' '}
            <code className="lx-inline-code">lexel sentence-case</code>: headline and sentence case
            transforms preserving inline code, acronyms, and URLs.
          </li>
          <li>
            <code className="lx-inline-code">lexel normalize</code>: cleans smart quotes, ellipses,
            and redundant spaces outside code blocks.
          </li>
          <li>
            <code className="lx-inline-code">lexel weirpack</code>: validates or builds custom
            Harper <code className="lx-inline-code">.weirpack</code> rule bundles.
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          Voice Memory, SimPO export, and local benchmarking
        </h2>
        <CodeCopyBlock
          code={VOICE_AND_BENCH}
          label="Lexel voice import and benchmark commands"
          languageLabel="bash"
        />
      </section>

      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          GitHub Actions CI gate (SARIF)
        </h2>
        <p className="m-0" style={{ color: 'var(--lx-fg-muted)' }}>
          Pass <code className="lx-inline-code">--ci --format sarif|json|text</code> to fail pull
          requests on secrets, AI slop, or repository{' '}
          <code className="lx-inline-code">.lexel.toml</code> violations without loading any AI
          model in CI:
        </p>
        <CodeCopyBlock
          code={GITHUB_ACTIONS_CI}
          label="GitHub Actions SARIF workflow"
          languageLabel="yaml"
        />
      </section>
    </DocsShell>
  );
}

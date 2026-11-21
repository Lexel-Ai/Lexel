import type { Metadata } from 'next';
import { CodeCopyBlock } from '@/components/CodeCopyBlock';
import { DocsShell } from '@/components/DocsShell';

export const metadata: Metadata = {
  title: '.lexel.toml Configuration',
  description:
    'Commit a .lexel.toml file to configure repository dictionaries, banned or allowed slop terms, commit conventions, docs tone, and team style guides.',
};

const LEXEL_TOML_EXAMPLE = `# .lexel.toml (commit at repository root)
dialect = "us"
preset = "strict_technical"

# Project-specific technical identifiers ignored by spellcheck
dictionary = ["Weirpack", "FTS5", "GGUF", "SQLite", "Uniffi"]

# Add extra repo-banned buzzwords or exempt specific domain terms
banned_slop_terms = ["synergistic", "world-class"]
allowed_slop_terms = ["journey"]

[commit]
require_conventional = true
require_imperative = true
allowed_types = ["feat", "fix", "perf", "refactor", "sec", "arch", "test", "docs", "infra"]
max_subject_chars = 72
max_body_line_chars = 100
forbid_trailing_period = true

[docs]
tone = "direct_technical"
preset = "strict_technical"
max_line_chars = 100
max_sentence_words = 28
allow_em_dashes = false

[[style_guide]]
term = "Github"
preferred = "GitHub"
case_sensitive = true
note = "Use official capitalization."

[[style_guide]]
term = "e-mail"
preferred = "email"
case_sensitive = false
note = "Standardize without hyphen."`;

export default function DocsConfigPage() {
  return (
    <DocsShell
      title=".lexel.toml Configuration"
      description="Commit a .lexel.toml file at your repository root so lexel-cli, lexel-ls, and lexel-daemon enforce shared dictionaries, commit conventions, and team style guides automatically."
    >
      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          Discovery and precedence
        </h2>
        <p className="m-0" style={{ color: 'var(--lx-fg-muted)' }}>
          When you lint a file with <code className="lx-inline-code">lexel check</code> or edit a
          buffer in an LSP editor running <code className="lx-inline-code">lexel-ls</code>, Lexel
          walks upward from the target file&apos;s directory until it finds{' '}
          <code className="lx-inline-code">.lexel.toml</code> (or stops at the repository root). You
          can also pass an explicit path via{' '}
          <code className="lx-inline-code">lexel check --config path/to/.lexel.toml</code>.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          Complete schema reference
        </h2>
        <CodeCopyBlock
          code={LEXEL_TOML_EXAMPLE}
          label=".lexel.toml schema example"
          languageLabel="toml"
        />
      </section>

      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          Key sections
        </h2>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable table region requires keyboard focus per WCAG 2.1.1 */}
        <section tabIndex={0} aria-labelledby="config-sections-caption" className="lx-table-region">
          <table className="lx-table">
            <caption
              id="config-sections-caption"
              className="border-b px-4 py-3 text-left text-xs font-medium"
              style={{ borderColor: 'var(--lx-border)', color: 'var(--lx-fg-muted)' }}
            >
              Supported top-level keys and tables in crates/lexel-core/src/repo_config.rs
            </caption>
            <thead>
              <tr>
                <th scope="col">Section</th>
                <th scope="col">Fields</th>
                <th scope="col">Effect</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Top-level</th>
                <td data-label="Fields" className="lexel-mono text-xs">
                  dialect, preset, dictionary, banned_slop_terms, allowed_slop_terms
                </td>
                <td data-label="Effect">
                  Sets English dialect, Harper rule preset, project vocabulary, and repository
                  anti-slop overrides.
                </td>
              </tr>
              <tr>
                <th scope="row">[commit]</th>
                <td data-label="Fields" className="lexel-mono text-xs">
                  allowed_types, require_conventional, require_imperative, max_subject_chars,
                  max_body_line_chars, forbid_trailing_period
                </td>
                <td data-label="Effect">
                  Validates commit messages in git hooks, CI, and LSP commit buffers, and guides
                  local AI commit polish.
                </td>
              </tr>
              <tr>
                <th scope="row">[docs]</th>
                <td data-label="Fields" className="lexel-mono text-xs">
                  tone, preset, max_line_chars, max_sentence_words, allow_em_dashes
                </td>
                <td data-label="Effect">
                  Enforces documentation line length, sentence length limits, em-dash policy, and
                  tone directives on Markdown docs.
                </td>
              </tr>
              <tr>
                <th scope="row">[[style_guide]]</th>
                <td data-label="Fields" className="lexel-mono text-xs">
                  term, preferred, case_sensitive, note
                </td>
                <td data-label="Effect">
                  Flags non-preferred product names or phrasing with 1-click deterministic
                  replacements across CLI and editors.
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </section>
    </DocsShell>
  );
}

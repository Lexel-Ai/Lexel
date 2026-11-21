import type { Metadata } from 'next';
import { CodeCopyBlock } from '@/components/CodeCopyBlock';
import { DocsShell } from '@/components/DocsShell';

export const metadata: Metadata = {
  title: 'Editor LSP Setup',
  description:
    'Configure lexel-ls over stdio in VS Code, Cursor, Windsurf, Neovim, Zed, Helix, and Emacs for zero-AI grammar, anti-slop, and commit checks.',
};

const NEOVIM_CONFIG = `-- Neovim 0.11+ native LSP config (init.lua)
vim.lsp.config('lexel_ls', {
  cmd = { 'lexel-ls', '--stdio' },
  filetypes = {
    'markdown', 'text', 'gitcommit', 'rust', 'typescript',
    'typescriptreact', 'javascript', 'python', 'go', 'c', 'cpp',
  },
  root_markers = { '.lexel.toml', '.git' },
})
vim.lsp.enable('lexel_ls')`;

const ZED_CONFIG = `// ~/.config/zed/settings.json
{
  "lsp": {
    "lexel-ls": {
      "binary": {
        "path": "lexel-ls",
        "arguments": ["--stdio"]
      }
    }
  },
  "languages": {
    "Markdown": { "language_servers": ["lexel-ls", "..."] },
    "Rust": { "language_servers": ["rust-analyzer", "lexel-ls"] },
    "TypeScript": { "language_servers": ["vtsls", "lexel-ls"] }
  }
}`;

const HELIX_CONFIG = `# ~/.config/helix/languages.toml
[language-server.lexel-ls]
command = "lexel-ls"
args = ["--stdio"]

[[language]]
name = "markdown"
language-servers = ["lexel-ls"]

[[language]]
name = "git-commit"
language-servers = ["lexel-ls"]

[[language]]
name = "rust"
language-servers = ["rust-analyzer", "lexel-ls"]`;

const EMACS_CONFIG = `;; Emacs 29+ built-in Eglot (init.el)
(with-eval-after-load 'eglot
  (add-to-list 'eglot-server-programs
               '((markdown-mode text-mode git-commit-mode)
                 . ("lexel-ls" "--stdio"))))`;

export default function DocsEditorsPage() {
  return (
    <DocsShell
      title="Editor LSP Setup"
      description="One Language Server binary (lexel-ls --stdio) serves VS Code, Cursor, Windsurf, Neovim, Zed, Helix, and Emacs with grammar, anti-slop, secrets guard, and repository .lexel.toml rules."
    >
      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          VS Code, Cursor, and Windsurf
        </h2>
        <p className="m-0" style={{ color: 'var(--lx-fg-muted)' }}>
          Install the <code className="lx-inline-code">lexel-vscode</code> extension archive from
          GitHub Releases (or{' '}
          <code className="lx-inline-code">~/.local/share/lexel/extensions/lexel-vscode.zip</code>).
          It starts <code className="lx-inline-code">lexel-ls --stdio</code> automatically across
          Markdown, plain text, Git commit messages, Rust, TypeScript, JavaScript, Python, Go, C,
          C++, Java, HTML, LaTeX, Typst, AsciiDoc, and Org files.
        </p>
        <ul className="m-0 space-y-1.5 pl-5" style={{ color: 'var(--lx-fg)' }}>
          <li>
            <code className="lx-inline-code">lexel.enable</code>: toggle live grammar, anti-slop,
            secrets guard, and team style diagnostics.
          </li>
          <li>
            <code className="lx-inline-code">lexel.path</code> and{' '}
            <code className="lx-inline-code">lexel.cliPath</code>: optional absolute paths to{' '}
            <code className="lx-inline-code">lexel-ls</code> and{' '}
            <code className="lx-inline-code">lexel</code> when not on{' '}
            <code className="lx-inline-code">PATH</code>.
          </li>
          <li>
            <code className="lx-inline-code">lexel.diffGrounding</code>,{' '}
            <code className="lx-inline-code">lexel.baseBranch</code>, and{' '}
            <code className="lx-inline-code">lexel.useRepoConfig</code>: enable diff-grounded
            commit/PR rewrites and automatic <code className="lx-inline-code">.lexel.toml</code>{' '}
            discovery.
          </li>
          <li>
            Command Palette actions: <strong>Fix All Safe Issues (No AI)</strong>,{' '}
            <strong>Deslop Document (Local AI)</strong>, <strong>Fix Grammar &amp; Flow</strong>,{' '}
            <strong>Shorten Document</strong>, <strong>Polish Commit Message</strong> (grounded in{' '}
            <code className="lx-inline-code">git diff --cached --stat</code>),{' '}
            <strong>Polish PR Description</strong>, <strong>Run Doctor</strong>,{' '}
            <strong>Init .lexel.toml</strong>, <strong>Check Workspace (CI)</strong>, and{' '}
            <strong>Import Git Voice</strong>.
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          Neovim
        </h2>
        <CodeCopyBlock code={NEOVIM_CONFIG} label="Neovim LSP configuration" languageLabel="lua" />
      </section>

      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          Zed
        </h2>
        <CodeCopyBlock code={ZED_CONFIG} label="Zed LSP configuration" languageLabel="json" />
      </section>

      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          Helix
        </h2>
        <CodeCopyBlock
          code={HELIX_CONFIG}
          label="Helix languages.toml configuration"
          languageLabel="toml"
        />
      </section>

      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          Emacs (Eglot)
        </h2>
        <CodeCopyBlock
          code={EMACS_CONFIG}
          label="Emacs Eglot configuration"
          languageLabel="elisp"
        />
      </section>
    </DocsShell>
  );
}

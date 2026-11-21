import type { Metadata } from 'next';
import Link from 'next/link';
import { DocsShell } from '@/components/DocsShell';
import { DOC_NAV_ITEMS } from '@/lib/siteData';

export const metadata: Metadata = {
  title: 'Documentation',
  description:
    'Lexel documentation covering platform installation, 13 writing surfaces, local privacy model, editor LSP setup, CLI, .lexel.toml, and local GGUF model tiers.',
};

export default function DocsOverviewPage() {
  return (
    <DocsShell
      title="Lexel Documentation"
      description="Reference guides for installing Lexel, configuring writing surfaces and editors, enforcing repository style via .lexel.toml, and running local GGUF models."
    >
      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          How the two-tier pipeline works
        </h2>
        <p className="m-0" style={{ color: 'var(--lx-fg-muted)' }}>
          Lexel isolates passive typing checks from AI rewriting so everyday linting stays fast and
          offline:
        </p>
        <ol className="m-0 space-y-2 pl-5" style={{ color: 'var(--lx-fg)' }}>
          <li>
            <strong>Tier 0 (always on, 0 MB AI RAM):</strong> Runs upstream Harper grammar and
            spelling, Aho-Corasick anti-slop matching, em-dash checks, surface bounds, document
            consistency, BLUF and regret shield guards, and Secrets Guard in Rust or WebAssembly.
          </li>
          <li>
            <strong>Tier 1 (explicit trigger only):</strong> Lazy-loads a quantized local model
            (Lexel 1.5B Standard or Lexel 0.5B Lite) via{' '}
            <code className="lx-inline-code">llama-server</code> or Ollama on{' '}
            <code className="lx-inline-code">127.0.0.1</code>, injects your surface directive and
            local SQLite FTS5 Voice Memory, and unloads model weights after the idle timeout.
          </li>
          <li>
            <strong>Tier 2 (post-rewrite verification):</strong> Verifies zero slop, zero em dashes,
            preserved unit-bound numbers and code tokens, surface length bounds, and clean Harper
            grammar before displaying a rewrite.
          </li>
        </ol>
      </section>

      <section className="space-y-4">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          Guides
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {DOC_NAV_ITEMS.filter((item) => item.slug !== '').map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex flex-col justify-between gap-2 rounded-[8px] border p-4 no-underline transition-colors"
              style={{
                backgroundColor: 'var(--lx-card)',
                borderColor: 'var(--lx-border)',
              }}
            >
              <span className="text-base font-semibold" style={{ color: 'var(--lx-fg)' }}>
                {item.title}
              </span>
              <span className="text-sm" style={{ color: 'var(--lx-fg-muted)' }}>
                {item.shortDescription}
              </span>
            </Link>
          ))}
        </div>
      </section>
    </DocsShell>
  );
}

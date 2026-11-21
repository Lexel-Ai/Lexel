import type { Metadata } from 'next';
import { DocsShell } from '@/components/DocsShell';
import { SECURITY_URL } from '@/lib/siteData';

export const metadata: Metadata = {
  title: 'Privacy Model',
  description:
    'How Lexel enforces 100% local execution: zero cloud calls, restricted CSP, 127.0.0.1 Bearer auth, Native Messaging IPC, and deterministic Secrets Guard.',
};

export default function DocsPrivacyPage() {
  return (
    <DocsShell
      title="Privacy Model"
      description="Lexel enforces local-only writing checks and local AI inference at the transport, browser CSP, database, and verifier layers."
    >
      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          1. Zero cloud transmission and strict CSP
        </h2>
        <p className="m-0" style={{ color: 'var(--lx-fg-muted)' }}>
          No draft text, grammar findings, voice examples, or analytics leave your machine. The
          browser extension Content Security Policy in{' '}
          <code className="lx-inline-code">packages/lexel-browser/src/manifest.ts</code> restricts{' '}
          <code className="lx-inline-code">connect-src</code> strictly to{' '}
          <code className="lx-inline-code">&apos;self&apos;</code>,{' '}
          <code className="lx-inline-code">http://127.0.0.1:*</code>, and{' '}
          <code className="lx-inline-code">http://localhost:*</code>.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          2. Native Messaging primary IPC and loopback auth
        </h2>
        <ul className="m-0 space-y-2 pl-5" style={{ color: 'var(--lx-fg)' }}>
          <li>
            Chrome, Chromium, Brave, Edge, and Firefox communicate with{' '}
            <code className="lx-inline-code">com.lexel.daemon</code> over OS-isolated stdio Native
            Messaging (4-byte length-prefixed JSON frames).
          </li>
          <li>
            The local HTTP and SSE bridge binds strictly to{' '}
            <code className="lx-inline-code">127.0.0.1:42424</code> (never{' '}
            <code className="lx-inline-code">0.0.0.0</code>).
          </li>
          <li>
            Every <code className="lx-inline-code">/v1/*</code> route requires a per-install
            64-hex-char Bearer token stored in <code className="lx-inline-code">daemon.token</code>{' '}
            with <code className="lx-inline-code">0o600</code> permissions on Unix, compared in
            constant time.
          </li>
          <li>
            An <code className="lx-inline-code">Origin</code> middleware rejects requests from any
            non-loopback website.
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          3. Secrets Guard and opt-in redact-and-restore
        </h2>
        <p className="m-0" style={{ color: 'var(--lx-fg-muted)' }}>
          Before any local AI call runs, Lexel scans your text deterministically for private key
          blocks, JWTs, GitHub/Stripe/Hugging Face/npm/Slack/AWS/Google API keys, Discord webhooks,
          Bearer auth headers, environment secret assignments, US SSNs, and Luhn-valid payment card
          numbers:
        </p>
        <ul className="m-0 space-y-2 pl-5" style={{ color: 'var(--lx-fg)' }}>
          <li>
            <strong>Default (hard block):</strong> When{' '}
            <code className="lx-inline-code">redactSecrets</code> is off, any detected secret stops
            the AI request immediately so credentials never enter an LLM prompt.
          </li>
          <li>
            <strong>Opt-in redact-and-restore:</strong> When enabled in settings, Lexel swaps each
            detected secret for <code className="lx-inline-code">[LEXEL_REDACTED_n]</code> before
            local inference, restores the original values after generation, and verifies clean
            restoration without logging raw secret text.
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          4. Zero-capture blocklists and local SQLite ownership
        </h2>
        <p className="m-0" style={{ color: 'var(--lx-fg-muted)' }}>
          Password inputs (<code className="lx-inline-code">type=&quot;password&quot;</code>),
          payment fields (<code className="lx-inline-code">autocomplete=&quot;cc-*&quot;</code>),
          and user-configured privacy domains are ignored by the browser content script. All
          preferences and optional Voice Memory examples live in a single local SQLite database (
          <code className="lx-inline-code">~/.local/share/lexel/lexel.db</code> on Linux,{' '}
          <code className="lx-inline-code">~/Library/Application Support/lexel/lexel.db</code> on
          macOS, <code className="lx-inline-code">%APPDATA%\lexel\lexel.db</code> on Windows) with
          1-click JSON export, 1-click purge, and Ephemeral Mode.
        </p>
        <p className="m-0 text-sm" style={{ color: 'var(--lx-fg-muted)' }}>
          To report a security issue privately, see{' '}
          <a
            href={SECURITY_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--lx-signal)' }}
          >
            SECURITY.md on GitHub
          </a>
          .
        </p>
      </section>
    </DocsShell>
  );
}

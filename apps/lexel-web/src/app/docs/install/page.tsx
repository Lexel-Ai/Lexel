import type { Metadata } from 'next';
import { CodeCopyBlock } from '@/components/CodeCopyBlock';
import { DocsShell } from '@/components/DocsShell';
import { InstallTabs } from '@/components/InstallTabs';
import { RELEASES_URL } from '@/lib/siteData';

export const metadata: Metadata = {
  title: 'Install & Sync',
  description:
    'Install Lexel Desktop, lexel-daemon, lexel-ls, lexel CLI, browser extensions, and Native Messaging bridge on Linux, macOS, and Windows.',
};

export default function DocsInstallPage() {
  return (
    <DocsShell
      title="Install & Sync"
      description="Install Lexel Desktop, the local daemon, CLI, LSP binary, and browser extensions on Linux, macOS, or Windows."
    >
      <section className="space-y-4">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          Platform installers
        </h2>
        <InstallTabs />
      </section>

      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          Pair the browser extension with Lexel Desktop
        </h2>
        <p className="m-0" style={{ color: 'var(--lx-fg-muted)' }}>
          Tier 0 grammar, anti-slop, surface rules, and Secrets Guard run inside the browser
          extension immediately with zero daemon dependencies. Pair with Lexel Desktop to share one
          SQLite database (<code className="lx-inline-code">lexel.db</code>) and unlock local AI
          rewrites:
        </p>
        <ol className="m-0 space-y-2 pl-5" style={{ color: 'var(--lx-fg)' }}>
          <li>
            Launch <code className="lx-inline-code">lexel-desktop</code>. On first startup it
            initializes <code className="lx-inline-code">lexel.db</code>, registers Native Messaging
            hosts (<code className="lx-inline-code">com.lexel.daemon</code>) for Chrome, Chromium,
            Brave, Edge, and Firefox, and starts the authenticated loopback server on{' '}
            <code className="lx-inline-code">127.0.0.1:42424</code>.
          </li>
          <li>
            Unzip <code className="lx-inline-code">lexel-chrome.zip</code> and load it via{' '}
            <code className="lx-inline-code">chrome://extensions</code> (Developer mode, Load
            unpacked), or install <code className="lx-inline-code">lexel-firefox.zip</code> in
            Firefox 128+.
          </li>
          <li>
            Click <strong>Connect Desktop</strong> in the extension popup. Profile settings,
            dictionaries, surface overrides, and privacy blocklists stay synced in both directions.
          </li>
          <li>
            Open <strong>Lexel Desktop &gt; AI &amp; Extension Sync</strong> and download a SHA-256
            verified GGUF model (Lexel 1.5B Standard or Lexel 0.5B Lite).
          </li>
        </ol>
      </section>

      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          Verify your installation
        </h2>
        <p className="m-0" style={{ color: 'var(--lx-fg-muted)' }}>
          Run <code className="lx-inline-code">lexel doctor</code> after installing to inspect your
          local runtime, hardware acceleration, Native Messaging manifests, GGUF SHA-256 status, and
          measured Tier 0 latency:
        </p>
        <CodeCopyBlock
          code={`lexel doctor\nlexel check README.md`}
          label="Verify install commands"
          languageLabel="bash"
        />
        <p className="m-0 text-sm" style={{ color: 'var(--lx-fg-muted)' }}>
          All prebuilt binaries, desktop installers, extension archives, and{' '}
          <code className="lx-inline-code">SHA256SUMS.txt</code> are published on{' '}
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--lx-signal)' }}
          >
            GitHub Releases
          </a>
          .
        </p>
      </section>
    </DocsShell>
  );
}

'use client';

import { NibIcon } from 'lexel-ui';
import Link from 'next/link';
import { LICENSE_URL, RELEASES_URL, REPO_URL, SECURITY_URL } from '@/lib/siteData';

export function SiteFooter() {
  return (
    <footer
      className="mt-16 border-t"
      style={{
        backgroundColor: 'var(--lx-surface)',
        borderColor: 'var(--lx-border)',
      }}
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6 md:flex-row md:items-start md:justify-between">
        <div className="max-w-sm space-y-2">
          <div
            className="flex items-center gap-2 text-sm font-semibold"
            style={{ color: 'var(--lx-fg)' }}
          >
            <NibIcon className="h-4 w-4" />
            <span>Lexel</span>
          </div>
          <p className="text-sm" style={{ color: 'var(--lx-fg-muted)' }}>
            Open-source local grammar checker, anti-slop filter, and surface-aware writing assistant
            licensed under Apache-2.0. Zero cloud LLM calls, zero accounts, zero telemetry.
          </p>
        </div>

        <nav aria-label="Footer" className="flex flex-wrap gap-x-10 gap-y-6 text-sm">
          <div className="space-y-2">
            <h2
              className="text-xs font-semibold tracking-wide uppercase"
              style={{ color: 'var(--lx-fg)' }}
            >
              Site
            </h2>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              <li>
                <Link
                  href="/playground/"
                  className="no-underline hover:underline"
                  style={{ color: 'var(--lx-fg-muted)' }}
                >
                  Tier 0 Playground
                </Link>
              </li>
              <li>
                <Link
                  href="/docs/"
                  className="no-underline hover:underline"
                  style={{ color: 'var(--lx-fg-muted)' }}
                >
                  Documentation
                </Link>
              </li>
              <li>
                <Link
                  href="/docs/editors/"
                  className="no-underline hover:underline"
                  style={{ color: 'var(--lx-fg-muted)' }}
                >
                  Editor LSP Setup
                </Link>
              </li>
              <li>
                <Link
                  href="/docs/privacy/"
                  className="no-underline hover:underline"
                  style={{ color: 'var(--lx-fg-muted)' }}
                >
                  Privacy Model
                </Link>
              </li>
            </ul>
          </div>

          <div className="space-y-2">
            <h2
              className="text-xs font-semibold tracking-wide uppercase"
              style={{ color: 'var(--lx-fg)' }}
            >
              Repository
            </h2>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              <li>
                <a
                  href={REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="no-underline hover:underline"
                  style={{ color: 'var(--lx-fg-muted)' }}
                >
                  GitHub Source
                </a>
              </li>
              <li>
                <a
                  href={RELEASES_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="no-underline hover:underline"
                  style={{ color: 'var(--lx-fg-muted)' }}
                >
                  GitHub Releases
                </a>
              </li>
              <li>
                <a
                  href={SECURITY_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="no-underline hover:underline"
                  style={{ color: 'var(--lx-fg-muted)' }}
                >
                  Security Policy
                </a>
              </li>
              <li>
                <a
                  href={LICENSE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="no-underline hover:underline"
                  style={{ color: 'var(--lx-fg-muted)' }}
                >
                  Apache-2.0 License
                </a>
              </li>
            </ul>
          </div>
        </nav>
      </div>
    </footer>
  );
}

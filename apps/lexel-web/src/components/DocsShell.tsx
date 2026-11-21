'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { DOC_NAV_ITEMS } from '@/lib/siteData';

export interface DocsShellProps {
  title: string;
  description: string;
  children: React.ReactNode;
}

function isDocActive(pathname: string, href: string): boolean {
  const normalizedPath = pathname.endsWith('/') ? pathname : `${pathname}/`;
  return normalizedPath === href;
}

export function DocsShell({ title, description, children }: DocsShellProps) {
  const pathname = usePathname() || '/docs/';
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="mb-6 lg:hidden">
        <button
          type="button"
          onClick={() => setMobileNavOpen((prev) => !prev)}
          aria-expanded={mobileNavOpen}
          aria-controls="docs-mobile-nav"
          className="lx-web-btn-secondary w-full justify-between"
        >
          <span>Documentation sections</span>
          <span className="lexel-mono text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
            {mobileNavOpen ? 'Hide' : 'Show'}
          </span>
        </button>

        {mobileNavOpen ? (
          <nav
            id="docs-mobile-nav"
            aria-label="Documentation"
            className="mt-2 rounded-[8px] border p-2"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
            }}
          >
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {DOC_NAV_ITEMS.map((item) => {
                const active = isDocActive(pathname, item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={() => setMobileNavOpen(false)}
                      aria-current={active ? 'page' : undefined}
                      className="flex min-h-[44px] items-center rounded-[6px] px-3 text-sm font-medium no-underline"
                      style={{
                        backgroundColor: active ? 'var(--lx-accent)' : 'transparent',
                        color: active ? 'var(--lx-on-accent)' : 'var(--lx-fg)',
                      }}
                    >
                      {item.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        ) : null}
      </div>

      <div className="grid gap-10 lg:grid-cols-[240px_1fr]">
        <aside className="hidden lg:block">
          <nav
            aria-label="Documentation"
            className="sticky top-20 space-y-1 border-r pr-5"
            style={{ borderColor: 'var(--lx-border)' }}
          >
            <p
              className="m-0 mb-3 px-3 lexel-mono text-xs font-semibold"
              style={{ color: 'var(--lx-fg-muted)' }}
            >
              Documentation
            </p>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {DOC_NAV_ITEMS.map((item) => {
                const active = isDocActive(pathname, item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className="flex min-h-[40px] items-center rounded-[6px] px-3 text-sm font-medium no-underline transition-colors"
                      style={{
                        backgroundColor: active ? 'var(--lx-muted)' : 'transparent',
                        color: active ? 'var(--lx-fg)' : 'var(--lx-fg-muted)',
                        borderLeft: active ? '2px solid var(--lx-signal)' : '2px solid transparent',
                      }}
                    >
                      {item.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </aside>

        <article className="min-w-0 space-y-8">
          <header className="space-y-2 border-b pb-6" style={{ borderColor: 'var(--lx-border)' }}>
            <h1 className="lx-section-title m-0" style={{ color: 'var(--lx-fg)' }}>
              {title}
            </h1>
            <p className="m-0 max-w-2xl text-base" style={{ color: 'var(--lx-fg-muted)' }}>
              {description}
            </p>
          </header>

          <div className="space-y-8 text-sm leading-relaxed sm:text-base">{children}</div>
        </article>
      </div>
    </div>
  );
}

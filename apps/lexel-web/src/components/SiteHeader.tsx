'use client';

import { MoonIcon, NibIcon, SunIcon } from 'lexel-ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { REPO_URL } from '@/lib/siteData';
import {
  applySchemeToDocument,
  COLOR_SCHEME_STORAGE_KEY,
  type ResolvedTheme,
  readStoredScheme,
  toggleThemeScheme,
} from '@/lib/theme';

const NAV_LINKS = [
  { href: '/playground/', label: 'Playground' },
  { href: '/docs/', label: 'Docs' },
  { href: '/#install', label: 'Install' },
];

function isNavActive(pathname: string, href: string): boolean {
  if (href === '/playground/') {
    return pathname.startsWith('/playground');
  }
  if (href === '/docs/') {
    return pathname.startsWith('/docs');
  }
  return false;
}

export function SiteHeader() {
  const pathname = usePathname() || '/';
  const [theme, setTheme] = useState<ResolvedTheme>('light');
  const [menuOpen, setMenuOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setTheme(applySchemeToDocument(readStoredScheme()));

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handleMediaChange = () => {
      if (!readStoredScheme()) {
        setTheme(applySchemeToDocument(null));
      }
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === COLOR_SCHEME_STORAGE_KEY) {
        setTheme(applySchemeToDocument(readStoredScheme()));
      }
    };

    media.addEventListener('change', handleMediaChange);
    window.addEventListener('storage', handleStorage);
    return () => {
      media.removeEventListener('change', handleMediaChange);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  useEffect(() => {
    const el = popoverRef.current;
    if (!el) return;
    const handleToggle = (event: Event) => {
      const toggleEvent = event as ToggleEvent;
      setMenuOpen(toggleEvent.newState === 'open');
    };
    el.addEventListener('toggle', handleToggle);
    return () => {
      el.removeEventListener('toggle', handleToggle);
    };
  }, []);

  const handleToggleTheme = () => {
    setTheme(toggleThemeScheme());
  };

  const closeMobileMenu = () => {
    const el = popoverRef.current;
    if (el && typeof el.hidePopover === 'function') {
      try {
        el.hidePopover();
      } catch {
        // Ignore if already closed or unsupported
      }
    }
    setMenuOpen(false);
  };

  const handleManualMenuToggle = () => {
    const el = popoverRef.current;
    if (!el) return;
    if (typeof el.togglePopover === 'function') {
      return;
    }
    setMenuOpen((prev) => !prev);
  };

  const nextThemeLabel = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <header
      className="sticky top-0 z-40 border-b"
      style={{
        backgroundColor: 'var(--lx-bg)',
        borderColor: 'var(--lx-border)',
      }}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link
          href="/"
          className="inline-flex min-h-[44px] items-center gap-2.5 text-base font-semibold tracking-tight no-underline"
          style={{ color: 'var(--lx-fg)' }}
          aria-current={pathname === '/' ? 'page' : undefined}
        >
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] border"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          >
            <NibIcon className="h-4 w-4" />
          </span>
          <span>Lexel</span>
        </Link>

        <nav aria-label="Primary" className="flex items-center gap-2">
          <ul className="m-0 hidden list-none items-center gap-1 p-0 md:flex">
            {NAV_LINKS.map((item) => {
              const active = isNavActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className="nav-link inline-flex min-h-[44px] items-center px-3 text-sm font-medium no-underline transition-colors"
                    style={{
                      color: active ? 'var(--lx-fg)' : 'var(--lx-fg-muted)',
                    }}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
            <li>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-[44px] items-center px-3 text-sm font-medium no-underline transition-colors"
                style={{ color: 'var(--lx-fg-muted)' }}
              >
                GitHub
              </a>
            </li>
          </ul>

          <button
            type="button"
            onClick={handleToggleTheme}
            aria-label={nextThemeLabel}
            title={nextThemeLabel}
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[6px] border transition-colors"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-control-border)',
              color: 'var(--lx-fg)',
            }}
          >
            {theme === 'dark' ? <SunIcon className="h-4 w-4" /> : <MoonIcon className="h-4 w-4" />}
          </button>

          <button
            type="button"
            popoverTarget="site-mobile-menu"
            popoverTargetAction="toggle"
            aria-controls="site-mobile-menu"
            aria-expanded={menuOpen}
            onClick={handleManualMenuToggle}
            className="site-menu-trigger inline-flex min-h-[44px] items-center gap-2 rounded-[6px] border px-3 text-sm font-medium md:hidden"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-control-border)',
              color: 'var(--lx-fg)',
            }}
          >
            <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M2.5 4.5H13.5M2.5 8H13.5M2.5 11.5H13.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            <span>Menu</span>
          </button>

          <div
            ref={popoverRef}
            id="site-mobile-menu"
            popover="auto"
            className="site-mobile-popover md:hidden"
          >
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              <li>
                <Link
                  href="/"
                  onClick={closeMobileMenu}
                  aria-current={pathname === '/' ? 'page' : undefined}
                  className="flex min-h-[44px] items-center rounded-[6px] px-3 text-sm font-medium no-underline"
                  style={{
                    color: 'var(--lx-fg)',
                    backgroundColor: pathname === '/' ? 'var(--lx-muted)' : 'transparent',
                  }}
                >
                  Home
                </Link>
              </li>
              {NAV_LINKS.map((item) => {
                const active = isNavActive(pathname, item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={closeMobileMenu}
                      aria-current={active ? 'page' : undefined}
                      className="flex min-h-[44px] items-center rounded-[6px] px-3 text-sm font-medium no-underline"
                      style={{
                        color: 'var(--lx-fg)',
                        backgroundColor: active ? 'var(--lx-muted)' : 'transparent',
                      }}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
              <li className="mt-1 border-t pt-1" style={{ borderColor: 'var(--lx-border)' }}>
                <a
                  href={REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={closeMobileMenu}
                  className="flex min-h-[44px] items-center rounded-[6px] px-3 text-sm font-medium no-underline"
                  style={{ color: 'var(--lx-fg-muted)' }}
                >
                  GitHub Repository
                </a>
              </li>
            </ul>
          </div>
        </nav>
      </div>
    </header>
  );
}

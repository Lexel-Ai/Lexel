import type { Metadata, Viewport } from 'next';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Lexel | Local Grammar, Anti-Slop, and Surface-Aware Writing Assistant',
    template: '%s | Lexel',
  },
  description:
    'Open-source, 100% local grammar checker, anti-slop filter, and context-aware writing assistant built in Rust and WebAssembly. Zero cloud LLM calls, zero telemetry.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
        {/* Inline FOUC-prevention script applying stored color-scheme before paint */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Static pre-paint theme script with no user input */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="lexel-root flex min-h-[100dvh] flex-col">
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        <SiteHeader />
        <main id="main-content" className="flex-1">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}

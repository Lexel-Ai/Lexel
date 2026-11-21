import Link from 'next/link';
import { HeroLivePreview } from '@/components/HeroLivePreview';
import { InstallTabs } from '@/components/InstallTabs';
import { SurfaceExplorer } from '@/components/SurfaceExplorer';
import {
  formatMegabytes,
  MODEL_SPECS,
  RELEASES_URL,
  REPO_URL,
  SECURITY_URL,
  SITE_SURFACES,
  SLOP_TERM_COUNT,
} from '@/lib/siteData';

const ARCHITECTURE_TIERS = [
  {
    index: '01',
    tier: 'Tier 0: Always-On Deterministic Engine',
    budget: '< 5 ms | 0 MB AI RAM',
    summary:
      'Runs on every keystroke in Rust or WebAssembly without loading model weights. Combines upstream Harper grammar and spelling, Aho-Corasick anti-slop matching, em-dash checks, surface policies, document consistency, writing guards, and Secrets Guard.',
    details: [
      `${SLOP_TERM_COUNT} canonical AI buzzwords in rules/slop_terms.json`,
      `${SITE_SURFACES.length} built-in platform profiles in ml/personas/surfaces.json`,
      'Secrets Guard catches API keys, JWTs, private keys, SSNs, and Luhn cards',
    ],
  },
  {
    index: '02',
    tier: 'Tier 1: On-Demand Local AI Runtime',
    budget: 'Lazy-loaded | Auto-unloads after idle TTL',
    summary:
      'Wakes only when you explicitly request a rewrite, tone change, or reply draft. Connects to llama-server or Ollama on 127.0.0.1 with prompt-lookup speculative decoding, KV prefix caching, surface rules, and local SQLite FTS5 Voice Memory.',
    details: [
      'Cold daemon stays lean until you invoke an AI action',
      'Prompt prefix caching and token logit_bias suppress em dashes at generation time',
      'Optional opt-in redact-and-restore replaces secrets with [LEXEL_REDACTED_n] before inference',
    ],
  },
  {
    index: '03',
    tier: 'Tier 2: Post-AI Deterministic Gatekeeper',
    budget: 'Runs before every suggestion reaches you',
    summary:
      'Checks every local model draft against hard grounding rules before displaying it. If a gate fails, the daemon runs at most one guided repair pass citing the exact failed constraint.',
    details: [
      'Unit-bound metric verifier keeps #42, 18ms, $42, and 42% intact',
      'Preserves inline `code` spans, CLI flags, and URLs verbatim',
      'Verifies zero slop, zero em dashes, surface length bounds, and clean Harper grammar',
    ],
  },
];

const WHERE_IT_RUNS = [
  {
    surface: 'Browser Extension',
    targets: 'Chrome, Brave, Edge, Chromium, Firefox 128+',
    behavior:
      'Runs Tier 0 in WebAssembly on GitHub, Reddit, X, LinkedIn, Gmail, Substack, WordPress, and Discourse. Pairs over Native Messaging (com.lexel.daemon) for local AI rewrites.',
    docHref: '/docs/install/',
  },
  {
    surface: 'Editors & IDEs via LSP',
    targets: 'VS Code, Cursor, Windsurf, Neovim, Zed, Helix, Emacs',
    behavior:
      'lexel-ls lints comments, docstrings, Markdown, and Git commit messages while ignoring code syntax. Offers deterministic fixes and diff-grounded commit or PR polish.',
    docHref: '/docs/editors/',
  },
  {
    surface: 'Desktop Control Center',
    targets: 'Linux (.AppImage, .deb, .rpm), macOS (arm64 .dmg), Windows (.exe, .msi)',
    behavior:
      'Built with Tauri v2 and React 19. Manages rules, personal dictionaries, surface overrides, GGUF downloads with SHA-256 checks, Voice Memory, and system-wide quick rewrite.',
    docHref: '/docs/install/',
  },
  {
    surface: 'CLI, Obsidian & CI',
    targets: 'lexel CLI, Git hooks, GitHub Actions SARIF, Obsidian plugin',
    behavior:
      'Lint docs and commits in CI with repo-level .lexel.toml rules, run lexel doctor to verify local setup, or run Tier 0 directly inside Obsidian notes.',
    docHref: '/docs/cli/',
  },
];

export default function HomePage() {
  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      {/* 01. Editorial Split Hero with real client-side Tier 0 preview */}
      <section
        className="grid gap-8 border-b py-10 sm:py-14 lg:grid-cols-[1.05fr_0.95fr] lg:items-start lg:gap-12"
        style={{ borderColor: 'var(--lx-border)' }}
      >
        <div className="min-w-0 space-y-6">
          <h1 className="lx-hero-title m-0" style={{ color: 'var(--lx-fg)' }}>
            Local grammar, anti-slop, and surface-aware rewrites on your machine.
          </h1>
          <p
            className="m-0 max-w-xl text-base leading-relaxed sm:text-lg"
            style={{ color: 'var(--lx-fg-muted)' }}
          >
            Lexel checks spelling, grammar, AI buzzwords, em dashes, and leaked secrets in Rust and
            WebAssembly with 0 MB of AI RAM while you type. When you ask for a rewrite, a quantized
            local model loads on demand, matches where you are writing, and unloads when idle.
          </p>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Link href="/playground/" className="lx-web-btn-primary">
              Open Tier 0 Playground
            </Link>
            <a href="#install" className="lx-web-btn-secondary">
              Install Lexel
            </a>
            <Link href="/docs/" className="lx-web-btn-secondary">
              Read Documentation
            </Link>
          </div>

          <dl
            className="m-0 grid grid-cols-1 gap-4 border-t pt-5 text-sm sm:grid-cols-3"
            style={{ borderColor: 'var(--lx-border)' }}
          >
            <div>
              <dt className="lexel-mono text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
                License
              </dt>
              <dd className="m-0 mt-0.5 font-medium" style={{ color: 'var(--lx-fg)' }}>
                Apache-2.0 open source
              </dd>
            </div>
            <div>
              <dt className="lexel-mono text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
                Network policy
              </dt>
              <dd className="m-0 mt-0.5 font-medium" style={{ color: 'var(--lx-fg)' }}>
                0 bytes sent to cloud LLMs
              </dd>
            </div>
            <div>
              <dt className="lexel-mono text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
                Grammar core
              </dt>
              <dd className="m-0 mt-0.5 font-medium" style={{ color: 'var(--lx-fg)' }}>
                Upstream Harper + Weirpacks
              </dd>
            </div>
          </dl>
        </div>

        <HeroLivePreview />
      </section>

      {/* 02. Two-Tier Hybrid Pipeline */}
      <section className="border-b py-12 sm:py-16" style={{ borderColor: 'var(--lx-border)' }}>
        <div className="mb-8 max-w-2xl space-y-2">
          <p className="m-0 lexel-mono text-xs font-medium" style={{ color: 'var(--lx-signal)' }}>
            01 / Execution pipeline
          </p>
          <h2 className="lx-section-title m-0" style={{ color: 'var(--lx-fg)' }}>
            Typing stays instant because AI never runs passively
          </h2>
          <p className="m-0 text-sm sm:text-base" style={{ color: 'var(--lx-fg-muted)' }}>
            Passive checking and on-demand rewriting are strictly separated so your editor or
            browser never stalls on model inference.
          </p>
        </div>

        <div
          className="divide-y rounded-[8px] border"
          style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-card)' }}
        >
          {ARCHITECTURE_TIERS.map((stage) => (
            <div
              key={stage.index}
              className="grid gap-4 p-5 sm:p-6 lg:grid-cols-[260px_1fr_1fr] lg:gap-8"
              style={{ borderColor: 'var(--lx-border)' }}
            >
              <div className="space-y-1">
                <span
                  className="lexel-mono text-xs font-semibold"
                  style={{ color: 'var(--lx-signal)' }}
                >
                  {stage.index}
                </span>
                <h3 className="m-0 text-base font-semibold" style={{ color: 'var(--lx-fg)' }}>
                  {stage.tier}
                </h3>
                <p className="m-0 lexel-mono text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
                  {stage.budget}
                </p>
              </div>
              <p className="m-0 text-sm leading-relaxed" style={{ color: 'var(--lx-fg)' }}>
                {stage.summary}
              </p>
              <ul className="m-0 space-y-1.5 pl-4 text-sm" style={{ color: 'var(--lx-fg-muted)' }}>
                {stage.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* 03. Interactive 13-Surface Matrix */}
      <section className="border-b py-12 sm:py-16" style={{ borderColor: 'var(--lx-border)' }}>
        <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div className="max-w-2xl space-y-2">
            <p className="m-0 lexel-mono text-xs font-medium" style={{ color: 'var(--lx-signal)' }}>
              02 / Context-aware surfaces
            </p>
            <h2 className="lx-section-title m-0" style={{ color: 'var(--lx-fg)' }}>
              Rules adapt to Git commits, code comments, PRs, and social threads
            </h2>
            <p className="m-0 text-sm sm:text-base" style={{ color: 'var(--lx-fg-muted)' }}>
              A commit subject under 72 characters needs different checks than an email or a Reddit
              comment. Inspect the exact rules loaded from{' '}
              <code className="lx-inline-code">ml/personas/surfaces.json</code>.
            </p>
          </div>
          <Link href="/docs/surfaces/" className="lx-web-btn-secondary self-start sm:self-auto">
            View all {SITE_SURFACES.length} surfaces
          </Link>
        </div>

        <SurfaceExplorer />
      </section>

      {/* 04. Where Lexel Runs (Editorial list, not uniform icon cards) */}
      <section className="border-b py-12 sm:py-16" style={{ borderColor: 'var(--lx-border)' }}>
        <div className="mb-8 max-w-2xl space-y-2">
          <p className="m-0 lexel-mono text-xs font-medium" style={{ color: 'var(--lx-signal)' }}>
            03 / Developer &amp; writing surfaces
          </p>
          <h2 className="lx-section-title m-0" style={{ color: 'var(--lx-fg)' }}>
            One local SQLite database synced across browser, editors, desktop, and CLI
          </h2>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {WHERE_IT_RUNS.map((item) => (
            <article
              key={item.surface}
              className="flex flex-col justify-between gap-4 rounded-[8px] border p-5"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
              }}
            >
              <div className="space-y-2">
                <h3 className="m-0 text-base font-semibold" style={{ color: 'var(--lx-fg)' }}>
                  {item.surface}
                </h3>
                <p className="m-0 lexel-mono text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
                  {item.targets}
                </p>
                <p className="m-0 text-sm leading-relaxed" style={{ color: 'var(--lx-fg)' }}>
                  {item.behavior}
                </p>
              </div>
              <div>
                <Link
                  href={item.docHref}
                  className="text-sm font-medium no-underline hover:underline"
                  style={{ color: 'var(--lx-signal)' }}
                >
                  Read setup guide
                </Link>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* 05. Honest Platform Install */}
      <section
        id="install"
        className="scroll-mt-20 border-b py-12 sm:py-16"
        style={{ borderColor: 'var(--lx-border)' }}
      >
        <div className="mb-8 max-w-2xl space-y-2">
          <p className="m-0 lexel-mono text-xs font-medium" style={{ color: 'var(--lx-signal)' }}>
            04 / Install
          </p>
          <h2 className="lx-section-title m-0" style={{ color: 'var(--lx-fg)' }}>
            Install for your platform
          </h2>
          <p className="m-0 text-sm sm:text-base" style={{ color: 'var(--lx-fg-muted)' }}>
            Start with zero-dependency Tier 0 checks, or add verified local GGUF weights for offline
            AI rewrites.
          </p>
        </div>

        <InstallTabs />
      </section>

      {/* 06. Verifiable Local Models & Privacy Spec */}
      <section className="py-12 sm:py-16">
        <div className="grid gap-8 lg:grid-cols-2">
          <div className="min-w-0 space-y-4">
            <p className="m-0 lexel-mono text-xs font-medium" style={{ color: 'var(--lx-signal)' }}>
              05 / Verified model tiers
            </p>
            <h2 className="lx-section-title m-0" style={{ color: 'var(--lx-fg)' }}>
              Quantized GGUF weights verified by SHA-256
            </h2>
            <p className="m-0 text-sm leading-relaxed" style={{ color: 'var(--lx-fg-muted)' }}>
              Lexel Desktop streams official GGUF files from{' '}
              <code className="lx-inline-code">models/manifest.json</code> to a temporary{' '}
              <code className="lx-inline-code">.part</code> file and verifies exact byte length and
              SHA-256 digest before atomic rename.
            </p>

            <div className="space-y-3">
              {MODEL_SPECS.map((model) => (
                <div
                  key={model.id}
                  className="rounded-[8px] border p-4"
                  style={{
                    backgroundColor: 'var(--lx-card)',
                    borderColor: 'var(--lx-border)',
                  }}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="m-0 text-sm font-semibold" style={{ color: 'var(--lx-fg)' }}>
                      {model.label}
                    </h3>
                    <span className="lexel-mono text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
                      {formatMegabytes(model.sizeBytes)} download | ~{model.approxRamMb} MB RAM
                    </span>
                  </div>
                  <p className="m-0 mt-1.5 text-sm" style={{ color: 'var(--lx-fg-muted)' }}>
                    {model.description}
                  </p>
                  <p
                    className="m-0 mt-2 truncate lexel-mono text-xs"
                    style={{ color: 'var(--lx-fg-muted)' }}
                  >
                    sha256: {model.sha256}
                  </p>
                </div>
              ))}
            </div>

            <div className="pt-1">
              <Link href="/docs/models/" className="lx-web-btn-secondary">
                Inspect model &amp; runtime docs
              </Link>
            </div>
          </div>

          <div className="min-w-0 space-y-4">
            <p className="m-0 lexel-mono text-xs font-medium" style={{ color: 'var(--lx-signal)' }}>
              06 / Privacy guarantees
            </p>
            <h2 className="lx-section-title m-0" style={{ color: 'var(--lx-fg)' }}>
              Enforced in architecture, not a policy promise
            </h2>
            <ul
              className="m-0 divide-y rounded-[8px] border list-none p-0"
              style={{
                backgroundColor: 'var(--lx-card)',
                borderColor: 'var(--lx-border)',
              }}
            >
              <li className="space-y-1 p-4" style={{ borderColor: 'var(--lx-border)' }}>
                <p className="m-0 text-sm font-semibold" style={{ color: 'var(--lx-fg)' }}>
                  Restricted extension CSP
                </p>
                <p className="m-0 text-sm" style={{ color: 'var(--lx-fg-muted)' }}>
                  Browser extension <code className="lx-inline-code">connect-src</code> permits only{' '}
                  <code className="lx-inline-code">&apos;self&apos;</code>,{' '}
                  <code className="lx-inline-code">http://127.0.0.1:*</code>, and{' '}
                  <code className="lx-inline-code">http://localhost:*</code>.
                </p>
              </li>
              <li className="space-y-1 p-4" style={{ borderColor: 'var(--lx-border)' }}>
                <p className="m-0 text-sm font-semibold" style={{ color: 'var(--lx-fg)' }}>
                  Loopback Bearer token and Origin checks
                </p>
                <p className="m-0 text-sm" style={{ color: 'var(--lx-fg-muted)' }}>
                  The local HTTP bridge binds strictly to{' '}
                  <code className="lx-inline-code">127.0.0.1</code> with a per-install 64-hex-char
                  Bearer token (<code className="lx-inline-code">0o600</code> on Unix) and rejects
                  non-loopback <code className="lx-inline-code">Origin</code> headers.
                </p>
              </li>
              <li className="space-y-1 p-4" style={{ borderColor: 'var(--lx-border)' }}>
                <p className="m-0 text-sm font-semibold" style={{ color: 'var(--lx-fg)' }}>
                  Secrets Guard &amp; zero-capture blocklists
                </p>
                <p className="m-0 text-sm" style={{ color: 'var(--lx-fg-muted)' }}>
                  Password fields, payment forms, and sensitive domains are excluded. Detected API
                  keys, JWTs, private keys, SSNs, and Luhn payment cards block local AI unless you
                  opt into placeholder redaction.
                </p>
              </li>
            </ul>

            <div className="flex flex-wrap gap-3 pt-1">
              <Link href="/docs/privacy/" className="lx-web-btn-secondary">
                Read Privacy Model
              </Link>
              <a
                href={SECURITY_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="lx-web-btn-secondary"
              >
                Read SECURITY.md
              </a>
              <a
                href={RELEASES_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="lx-web-btn-secondary"
              >
                GitHub Releases
              </a>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="lx-web-btn-secondary"
              >
                Source on GitHub
              </a>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

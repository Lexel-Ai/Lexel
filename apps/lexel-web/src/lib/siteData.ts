import surfacesData from '../../../../ml/personas/surfaces.json';
import modelsManifest from '../../../../models/manifest.json';
import slopTermsData from '../../../../rules/slop_terms.json';

export const REPO_URL = 'https://github.com/Lexel-Ai/Lexel';
export const RELEASES_URL = 'https://github.com/Lexel-Ai/Lexel/releases/latest';
export const SECURITY_URL = 'https://github.com/Lexel-Ai/Lexel/blob/main/SECURITY.md';
export const LICENSE_URL = 'https://github.com/Lexel-Ai/Lexel/blob/main/LICENSE';

export const SLOP_TERM_COUNT = slopTermsData.slopTerms.length;

export interface SiteSurfaceSpec {
  id: string;
  label: string;
  hostPatterns: string[];
  pathRegex?: string;
  register: string;
  minChars: number;
  maxChars: number;
  allowLinks: boolean;
  allowEmojis: boolean;
  allowHashtags: boolean;
  allowEmDashes: boolean;
  bannedOpeners: string[];
  promptDirective: string;
}

export const SITE_SURFACES: readonly SiteSurfaceSpec[] = surfacesData.surfaces as SiteSurfaceSpec[];

export interface ModelSpec {
  id: string;
  tier: string;
  label: string;
  description: string;
  ollamaTag: string;
  ggufRepo: string;
  ggufFilename: string;
  ggufUrl: string;
  sha256: string;
  sizeBytes: number;
  approxRamMb: number;
}

export const MODEL_SPECS: readonly ModelSpec[] = modelsManifest.models as ModelSpec[];

export function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export interface InstallTab {
  id: string;
  label: string;
  summary: string;
  command: string;
  secondaryLabel?: string;
  secondaryCommand?: string;
  notes: string[];
}

export const INSTALL_TABS: readonly InstallTab[] = [
  {
    id: 'unix',
    label: 'Linux & macOS',
    summary:
      'Installs Lexel Desktop, lexel-daemon, lexel-ls (LSP), lexel (CLI), browser and editor extension archives, and registers the Native Messaging bridge.',
    command:
      'curl -fsSL https://raw.githubusercontent.com/Lexel-Ai/Lexel/main/scripts/install.sh | bash',
    secondaryLabel: 'Include verified local AI GGUF models',
    secondaryCommand:
      'curl -fsSL https://raw.githubusercontent.com/Lexel-Ai/Lexel/main/scripts/install.sh | bash -s -- --with-models',
    notes: [
      'Installs binaries to ~/.local/bin and extension archives to ~/.local/share/lexel/extensions (Linux) or ~/Library/Application Support/lexel/extensions (macOS).',
      'Pass --dry-run to inspect every planned action before modifying your system.',
      'Pass --from-source to compile locally instead of fetching GitHub Release binaries.',
    ],
  },
  {
    id: 'windows',
    label: 'Windows (PowerShell)',
    summary:
      'Downloads Windows x86_64 binaries, runs the Lexel Desktop installer (.exe or .msi), saves extension archives, and registers Native Messaging.',
    command: 'irm https://raw.githubusercontent.com/Lexel-Ai/Lexel/main/scripts/install.ps1 | iex',
    notes: [
      'Installs CLI, daemon, and LSP binaries to %APPDATA%\\lexel\\bin and registers com.lexel.daemon for Chrome, Edge, Brave, and Firefox.',
      'You can also download lexel-desktop-windows-x86_64-setup.exe or .msi directly from GitHub Releases.',
    ],
  },
  {
    id: 'releases',
    label: 'Direct Packages',
    summary:
      'Download prebuilt installers, extension archives, and SHA256SUMS.txt directly from GitHub Releases without piping a script.',
    command: `# Verify downloaded archives against SHA256SUMS.txt\nsha256sum -c SHA256SUMS.txt --ignore-missing`,
    notes: [
      'Linux Desktop: .AppImage, .deb, and .rpm. macOS Desktop: arm64 .dmg. Windows Desktop: setup.exe and .msi.',
      'Extensions: lexel-chrome.zip (Chrome, Brave, Edge, Chromium), lexel-firefox.zip (Firefox 128+), lexel-vscode.zip, and lexel-obsidian-plugin.zip.',
      'Standalone binaries: lexel-cli, lexel-daemon, and lexel-ls for Linux, macOS, and Windows.',
    ],
  },
  {
    id: 'source',
    label: 'From Source',
    summary:
      'Build the Rust workspace, React 19 UI packages, and local extensions directly from the repository checkout.',
    command: `git clone --recurse-submodules https://github.com/Lexel-Ai/Lexel.git\ncd Lexel\nbash scripts/install.sh --from-source`,
    notes: [
      'Requires Rust (cargo), Node 22+, and pnpm 10.10+. Do not mix npm into the pnpm workspace.',
      'Upstream Harper lives unmodified in vendor/harper and stays updated via make sync-harper.',
    ],
  },
];

export interface PlaygroundPreset {
  id: string;
  label: string;
  surfaceId: string;
  text: string;
  note: string;
}

export const PLAYGROUND_PRESETS: readonly PlaygroundPreset[] = [
  {
    id: 'slop-linkedin',
    label: 'AI-Slop LinkedIn Post',
    surfaceId: 'web_linkedin',
    note: 'Packed with buzzwords, em dashes, sycophantic opener, hashtags, and filler.',
    text: "Thrilled to announce that in today's fast-paced landscape, we are delving into a game-changer — our team is seamlessly leveraging cutting-edge tooling to unlock holistic synergy across the realm of developer productivity! Furthermore, this pivotal milestone is a testament to our journey. #AI #Productivity",
  },
  {
    id: 'pr-secrets-consistency',
    label: 'PR Note (Grammar + Secrets)',
    surfaceId: 'web_github_pr',
    note: 'Includes a grammar error, an AWS key, mixed US/UK spelling, inconsistent casing, and abrasive tone.',
    text: "Obviously this is an broken build because the color cache ignored our colour profile on Github when running GitHub Actions for v1.2 and 1.3 releases. Why didn't you test with AKIAIOSFODNN7EXAMPLE before merging `cache_lookup`? Please see attached logs for details.",
  },
  {
    id: 'email-bluf',
    label: 'Buried-Ask Email',
    surfaceId: 'web_email',
    note: 'Filler opener, crutch words, and an unbroken wall of text with the request at the bottom.',
    text: 'I hope this email finds you well.\nI just wanted to actually follow up on the staging rollout from Tuesday because basically the database migration took 14 minutes instead of the usual 4 minutes.\nWe checked the connection pool logs and saw that two background workers held read locks while the index build was running.\nThe retry loop recovered after the lock cleared, and error rates stayed at 0.2% across all three nodes.\nWe also reviewed the disk IOPS graphs and confirmed there was no throttling on the primary volume during the window.\nWe are planning to run the same migration in production on Thursday at 09:00 UTC with a 20-second lock timeout.\nHonestly, the rollback script has been verified in staging twice.\nCould you approve the Thursday maintenance window by 16:00 today?',
  },
  {
    id: 'git-commit',
    label: 'Git Commit Message',
    surfaceId: 'ide_git_commit',
    note: 'Past-tense opener, trailing period, em dash, and over-72-char subject line.',
    text: 'Added a really seamless new cache invalidation handler for local SQLite sessions — fixes stale token state across restarts.',
  },
  {
    id: 'reddit-reply',
    label: 'Reddit Technical Reply',
    surfaceId: 'web_reddit',
    note: 'Link violation, promo opener, buzzwords, and em dash on Reddit surface.',
    text: 'Check out our robust solution — we built a next-generation parser at https://example.com/demo that seamlessly elevates latency to 12ms!!',
  },
];

export interface DocNavItem {
  slug: string;
  href: string;
  title: string;
  shortDescription: string;
}

export const DOC_NAV_ITEMS: readonly DocNavItem[] = [
  {
    slug: '',
    href: '/docs/',
    title: 'Overview',
    shortDescription: 'Two-tier local architecture and how Lexel checks your writing.',
  },
  {
    slug: 'install',
    href: '/docs/install/',
    title: 'Install & Sync',
    shortDescription: 'Platform installers, Desktop Control Center, and browser pairing.',
  },
  {
    slug: 'surfaces',
    href: '/docs/surfaces/',
    title: 'Surfaces',
    shortDescription: 'All 13 built-in platform profiles, character bounds, and banned openers.',
  },
  {
    slug: 'privacy',
    href: '/docs/privacy/',
    title: 'Privacy Model',
    shortDescription:
      'Zero cloud calls, 127.0.0.1 Bearer auth, Native Messaging, and Secrets Guard.',
  },
  {
    slug: 'editors',
    href: '/docs/editors/',
    title: 'Editor LSP Setup',
    shortDescription: 'VS Code, Cursor, Windsurf, Neovim, Zed, Helix, and Emacs with lexel-ls.',
  },
  {
    slug: 'cli',
    href: '/docs/cli/',
    title: 'CLI & CI',
    shortDescription: 'Lint files, SARIF CI gates, Git hooks, doctor diagnostics, and benchmarks.',
  },
  {
    slug: 'config',
    href: '/docs/config/',
    title: '.lexel.toml Config',
    shortDescription: 'Repository-level dictionaries, banned slop terms, and commit conventions.',
  },
  {
    slug: 'models',
    href: '/docs/models/',
    title: 'Model Tiers',
    shortDescription:
      'Lexel 0.5B Lite, Lexel 1.5B Standard, SHA-256 verification, and idle unload.',
  },
];

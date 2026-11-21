import * as path from 'node:path';

export interface DocumentSelectorEntry {
  scheme: string;
  language: string;
}

export type DiffGroundingMode = 'auto' | 'staged' | 'branch' | 'off';

export const SUPPORTED_LANGUAGES = [
  'markdown',
  'plaintext',
  'git-commit',
  'rust',
  'typescript',
  'typescriptreact',
  'javascript',
  'javascriptreact',
  'python',
  'go',
  'c',
  'cpp',
  'java',
  'html',
  'latex',
  'typst',
  'asciidoc',
  'org',
] as const;

export const SUPPORTED_DOCUMENT_SELECTOR: DocumentSelectorEntry[] = SUPPORTED_LANGUAGES.flatMap(
  (language) => [
    { scheme: 'file', language },
    { scheme: 'untitled', language },
  ],
);

export const STARTER_LEXEL_TOML = `# Lexel repository configuration (.lexel.toml)
dialect = "us"
preset = "curated"

# Project-specific technical vocabulary ignored by the spell checker
dictionary = [
  "Lexel",
  "Weirpack",
]

# Extra project-banned buzzwords (use "term => replacement" for safe auto-fix)
banned_slop_terms = []

# Built-in slop terms explicitly allowed in this repo
allowed_slop_terms = []

[commit]
allowed_types = ["feat", "fix", "perf", "refactor", "sec", "arch", "test", "infra", "docs", "revert"]
require_conventional = true
require_imperative = true
max_subject_chars = 72
max_body_line_chars = 100
forbid_trailing_period = true

[docs]
tone = "direct technical"
max_line_chars = 120
max_sentence_words = 35
allow_em_dashes = false
`;

/** Resolve the `lexel-ls` binary path from user settings or platform defaults. */
export function resolveLexelLsCommand(
  configuredPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  const trimmed = configuredPath?.trim();
  if (trimmed) {
    return { command: path.normalize(trimmed), args: ['--stdio'] };
  }
  const command = platform === 'win32' ? 'lexel-ls.exe' : 'lexel-ls';
  return { command, args: ['--stdio'] };
}

/** Resolve the `lexel` CLI binary path from user settings or platform defaults. */
export function resolveLexelCliCommand(
  configuredPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  const trimmed = configuredPath?.trim();
  if (trimmed) {
    return path.normalize(trimmed);
  }
  return platform === 'win32' ? 'lexel.exe' : 'lexel';
}

/** Normalize diff grounding mode from workspace settings. */
export function normalizeDiffGroundingMode(raw: string | undefined): DiffGroundingMode {
  switch (raw?.trim().toLowerCase()) {
    case 'staged':
      return 'staged';
    case 'branch':
      return 'branch';
    case 'off':
      return 'off';
    default:
      return 'auto';
  }
}

/** Infer default Lexel surface ID from VS Code language ID and file path. */
export function resolveSurfaceForDocument(languageId: string, filePath?: string): string {
  const base = filePath ? path.basename(filePath).toLowerCase() : '';
  if (
    base.includes('pull_request') ||
    base === 'pr_editmsg' ||
    base === 'pr.md' ||
    base === 'pr-body.md'
  ) {
    return 'web_github_pr';
  }
  if (languageId === 'git-commit' || languageId === 'scminput') {
    return 'ide_git_commit';
  }
  if (['markdown', 'mdx', 'asciidoc', 'org', 'latex', 'typst'].includes(languageId)) {
    return 'docs_markdown';
  }
  return languageId === 'plaintext' ? 'general' : 'ide_code_comment';
}

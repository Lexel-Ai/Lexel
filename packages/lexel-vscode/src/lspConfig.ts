import * as path from 'node:path';

export interface DocumentSelectorEntry {
  scheme: string;
  language: string;
}

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

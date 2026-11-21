import { describe, expect, it } from 'vitest';
import {
  normalizeDiffGroundingMode,
  resolveLexelCliCommand,
  resolveLexelLsCommand,
  resolveSurfaceForDocument,
  STARTER_LEXEL_TOML,
  SUPPORTED_DOCUMENT_SELECTOR,
  SUPPORTED_LANGUAGES,
} from '../src/lspConfig';

describe('lexel-vscode LSP config', () => {
  it('covers prose, commits, and major source code languages', () => {
    expect(SUPPORTED_LANGUAGES).toContain('markdown');
    expect(SUPPORTED_LANGUAGES).toContain('git-commit');
    expect(SUPPORTED_LANGUAGES).toContain('rust');
    expect(SUPPORTED_LANGUAGES).toContain('typescript');
    expect(SUPPORTED_DOCUMENT_SELECTOR.length).toBe(SUPPORTED_LANGUAGES.length * 2);
  });

  it('resolves configured and default platform binary names cleanly', () => {
    expect(resolveLexelLsCommand('', 'linux')).toEqual({
      command: 'lexel-ls',
      args: ['--stdio'],
    });
    expect(resolveLexelLsCommand('', 'win32')).toEqual({
      command: 'lexel-ls.exe',
      args: ['--stdio'],
    });
    expect(resolveLexelLsCommand('/usr/local/bin/lexel-ls', 'darwin')).toEqual({
      command: '/usr/local/bin/lexel-ls',
      args: ['--stdio'],
    });
    expect(resolveLexelCliCommand('', 'linux')).toBe('lexel');
    expect(resolveLexelCliCommand('', 'win32')).toBe('lexel.exe');
    expect(resolveLexelCliCommand('/opt/lexel/bin/lexel', 'darwin')).toBe('/opt/lexel/bin/lexel');
  });

  it('normalizes diff grounding modes and infers commit/PR/docs surfaces', () => {
    expect(normalizeDiffGroundingMode('staged')).toBe('staged');
    expect(normalizeDiffGroundingMode('branch')).toBe('branch');
    expect(normalizeDiffGroundingMode('off')).toBe('off');
    expect(normalizeDiffGroundingMode('unknown')).toBe('auto');

    expect(resolveSurfaceForDocument('git-commit', '/repo/.git/COMMIT_EDITMSG')).toBe(
      'ide_git_commit',
    );
    expect(resolveSurfaceForDocument('markdown', '/repo/.github/PULL_REQUEST_TEMPLATE.md')).toBe(
      'web_github_pr',
    );
    expect(resolveSurfaceForDocument('markdown', '/repo/README.md')).toBe('docs_markdown');
    expect(resolveSurfaceForDocument('rust', '/repo/src/lib.rs')).toBe('ide_code_comment');
    expect(STARTER_LEXEL_TOML).toContain('[commit]');
    expect(STARTER_LEXEL_TOML).toContain('[docs]');
  });
});

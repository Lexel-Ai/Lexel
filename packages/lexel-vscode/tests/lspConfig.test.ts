import { describe, expect, it } from 'vitest';
import {
  resolveLexelLsCommand,
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
  });
});

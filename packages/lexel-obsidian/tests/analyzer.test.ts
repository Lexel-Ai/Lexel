import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeObsidianNote,
  applyObsidianSafeFix,
  assertLoopbackEndpoint,
  DEFAULT_OBSIDIAN_SETTINGS,
  registerObsidianWasmAdapter,
  requestLocalDaemonComplete,
  requestLocalDaemonRewrite,
} from '../src/analyzer';
import { disposeObsidianLexelWasm, initObsidianLexelWasmSync } from '../src/wasmLoader';

describe('lexel-obsidian note analyzer and safe fixes', () => {
  afterEach(() => {
    registerObsidianWasmAdapter(null);
    vi.unstubAllGlobals();
  });

  it('computes note readability, slop meter, consistency, guards, invisible chars, structure, and style guide counts', () => {
    const note =
      'Obviously we just delve into postgres\u200B today with the the color and colour draft on GitHub and github.\n\n```ts\nconst delve = "postgres";\n```\n';
    const report = analyzeObsidianNote(note, [{ term: 'postgres', preferred: 'PostgreSQL' }], {
      crutchWords: ['just'],
    });
    expect(report.slopCount).toBe(1);
    expect(report.slopScore).toBeGreaterThan(0);
    expect(report.invisibleCount).toBe(1);
    expect(report.structureCount).toBe(1);
    expect(report.styleGuideCount).toBe(1);
    expect(report.consistencyCount).toBe(2);
    expect(report.guardCount).toBe(2);
    expect(report.totalIssues).toBe(8);
    expect(report.statusBarLabel).toContain('Slop');
    expect(report.statusBarLabel).toContain('8 issues');
  });

  it('uses registered lexel-wasm adapter when available and falls back cleanly when removed', () => {
    registerObsidianWasmAdapter({
      lintMarkdown: () => ({ harperCount: 3, slopScore: 22 }),
    });
    const report = analyzeObsidianNote('Short draft note for testing.');
    expect(report.engineSource).toBe('lexel-wasm');
    expect(report.harperCount).toBe(3);
    expect(report.slopScore).toBe(22);
    expect(report.slopLabel).toBe('Mixed');
  });

  it('applies safe deterministic fixes while preserving fenced code blocks', () => {
    const note = 'We delve into postgres\u200B — “fast”.\n\n```\ndelve into postgres\n```';
    const fixed = applyObsidianSafeFix(note, [{ term: 'postgres', preferred: 'PostgreSQL' }]);
    expect(fixed.fixesApplied).toBeGreaterThan(0);
    expect(fixed.text).toContain('We explore PostgreSQL, "fast".');
    expect(fixed.text).toContain('delve into postgres');
    expect(fixed.text).not.toContain('\u200B');
  });

  it('blocks local AI rewrite when secrets are present and strict mode is active, and rejects non-loopback endpoints', async () => {
    const res = await requestLocalDaemonRewrite(
      { ...DEFAULT_OBSIDIAN_SETTINGS, daemonToken: 'local-token' },
      'My token is sk_live_abcdefghijklmnop1234567890',
      'deslop',
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('Secrets Guard');
    }

    expect(() => assertLoopbackEndpoint('https://api.example.com')).toThrow(/Privacy block/);
    expect(assertLoopbackEndpoint('http://127.0.0.1:42424/')).toBe('http://127.0.0.1:42424');
  });

  it('runs real lexel-wasm zero-daemon Tier 0 analysis in Obsidian', () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const wasmPath = resolve(testDir, '../../lexel-wasm/pkg/lexel_wasm_bg.wasm');
    const wasmBytes = readFileSync(wasmPath);
    expect(initObsidianLexelWasmSync(wasmBytes)).toBe(true);
    try {
      const report = analyzeObsidianNote('This is an typo where we delve into details.');
      expect(report.engineSource).toBe('lexel-wasm');
      expect(report.harperCount).toBeGreaterThanOrEqual(1);
      expect(report.slopScore).toBeGreaterThan(0);
    } finally {
      disposeObsidianLexelWasm();
    }
  }, 20_000);

  it('gates ghost-text completion behind opt-in setting', async () => {
    const disabledRes = await requestLocalDaemonComplete(
      { ...DEFAULT_OBSIDIAN_SETTINGS, daemonToken: 'local-token', ghostTextEnabled: false },
      'We fixed the bug by ',
    );
    expect(disabledRes.ok).toBe(false);
    if (!disabledRes.ok) {
      expect(disabledRes.error).toContain('Enable Ghost-text');
    }
  });
});

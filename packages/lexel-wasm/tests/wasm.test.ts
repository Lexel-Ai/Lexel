import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  analyzeReadabilityWasm,
  checkConsistencyWasm,
  checkGuardsWasm,
  detectPastedAiWasm,
  initLexelWasmSync,
  isLexelWasmReady,
  LexelWasmEngine,
  listSurfacesWasm,
  scoreSlopMeterWasm,
  toTitleCaseWasm,
} from '../src/index';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(__dirname, '../pkg/lexel_wasm_bg.wasm');

beforeAll(() => {
  const bytes = readFileSync(wasmPath);
  initLexelWasmSync(bytes);
}, 20_000);

describe('lexel-wasm Tier 0 bindings', () => {
  it('initializes and runs full Tier 0 checks with Harper, slop meter, consistency, guards, and safe fixes', () => {
    expect(isLexelWasmReady()).toBe(true);

    const engine = new LexelWasmEngine();
    try {
      const text =
        'This is an typo. We should delve into colour and color settings on Github for v1.0 and 1.1 — obviously, see attached.';
      const report = engine.check(text, {
        surfaceId: 'web_email',
        language: 'markdown',
        crutchWords: ['just'],
      });

      expect(report.harper.length).toBeGreaterThan(0);
      expect(report.slop.length).toBeGreaterThan(0);
      expect(report.slopMeter.score).toBeGreaterThan(20);
      expect(report.consistency.some((c) => c.kind === 'spelling_dialect')).toBe(true);
      expect(report.consistency.some((c) => c.kind === 'product_casing')).toBe(true);
      expect(report.consistency.some((c) => c.kind === 'version_format')).toBe(true);
      expect(report.guards.some((g) => g.kind === 'abrasive_tone')).toBe(true);
      expect(report.guards.some((g) => g.kind === 'missing_attachment')).toBe(true);

      // Verify UTF-16 span accuracy even after an em dash (3 UTF-8 bytes, 1 UTF-16 code unit).
      const obviousGuard = report.guards.find((g) => g.kind === 'abrasive_tone');
      expect(obviousGuard).toBeDefined();
      if (obviousGuard) {
        expect(text.slice(obviousGuard.start, obviousGuard.end)).toBe(obviousGuard.matchedText);
      }

      const fixed = engine.applySafeFixes('This is an typo and we should delve into it — fast.', {
        surfaceId: 'web_email',
        includeHarper: true,
      });
      expect(fixed.fixesApplied).toBeGreaterThanOrEqual(2);
      expect(fixed.text).toContain('a typo');
      expect(fixed.text).not.toContain('—');
    } finally {
      engine.free();
    }
  });

  it('reuses paragraph-hash cache on incremental edits', () => {
    const engine = new LexelWasmEngine();
    try {
      const paras = [
        'First paragraph stays unchanged across edits.',
        'Second paragraph has an typo here.',
        'Third paragraph stays unchanged across edits.',
      ];
      const r1 = engine.check(paras.join('\n\n'), { surfaceId: 'web_github_pr' });
      expect(r1.cacheStats.paragraphsTotal).toBe(3);
      expect(r1.cacheStats.cacheHits).toBe(0);
      expect(r1.cacheStats.cacheMisses).toBe(3);

      paras[1] = 'Second paragraph fixed cleanly now.';
      const r2 = engine.check(paras.join('\n\n'), { surfaceId: 'web_github_pr' });
      expect(r2.cacheStats.cacheHits).toBe(2);
      expect(r2.cacheStats.cacheMisses).toBe(1);
    } finally {
      engine.free();
    }
  });

  it('exposes standalone slop meter, pasted-AI detector, consistency, guards, readability, surfaces, and title case', () => {
    const aiPaste =
      "In today's rapidly evolving landscape, teams delve into seamless solutions — unlocking holistic synergy across every cutting-edge paradigm.";
    const meter = scoreSlopMeterWasm(aiPaste);
    expect(meter.score).toBeGreaterThanOrEqual(45);

    const pasted = detectPastedAiWasm(aiPaste);
    expect(pasted.shouldOfferHumanize).toBe(true);

    const consistency = checkConsistencyWasm('Send email and e-mail to Github.');
    expect(consistency.some((i) => i.kind === 'hyphenation')).toBe(true);
    expect(consistency.some((i) => i.kind === 'product_casing')).toBe(true);

    const guards = checkGuardsWasm("I just wanted to ask why didn't you reply?", {
      surfaceId: 'web_discord_slack',
      crutchWords: ['just'],
    });
    expect(guards.some((g) => g.kind === 'crutch_word')).toBe(true);
    expect(guards.some((g) => g.kind === 'abrasive_tone')).toBe(true);

    expect(analyzeReadabilityWasm('Short clear sentences work well.').words).toBe(5);
    expect(listSurfacesWasm().length).toBeGreaterThanOrEqual(10);
    expect(toTitleCaseWasm('fast local writing tools')).toBe('Fast Local Writing Tools');
  });
});

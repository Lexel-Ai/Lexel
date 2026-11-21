import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initLexelWasmSync, LexelWasmEngine } from 'lexel-wasm';
import { afterEach, describe, expect, it } from 'vitest';
import { PLAYGROUND_PRESETS } from './siteData';
import {
  analyzeTier0Client,
  applySafeTier0Fixes,
  applySingleDiagnosticFix,
  setWasmEngineForTesting,
} from './tier0Engine';

afterEach(() => {
  setWasmEngineForTesting(null);
});

describe('tier0Engine client playground adapter', () => {
  it('flags AI slop, em dashes, hashtags, and weak openers on LinkedIn preset', () => {
    const preset = PLAYGROUND_PRESETS.find((p) => p.id === 'slop-linkedin');
    expect(preset).toBeDefined();
    if (!preset) return;

    const result = analyzeTier0Client({
      text: preset.text,
      surfaceId: preset.surfaceId,
      dialect: 'American',
      crutchWords: [],
    });

    expect(result.counts.slop).toBeGreaterThan(3);
    expect(result.counts.surface).toBeGreaterThan(0);
    expect(result.slopMeter.score).toBeGreaterThanOrEqual(45);
    expect(result.slopMeter.verdict).toBe('AI-Heavy');

    const fixed = applySafeTier0Fixes(preset.text, preset.surfaceId);
    expect(fixed.fixesApplied).toBeGreaterThan(0);
    expect(fixed.text).not.toContain('—');
    expect(fixed.text).not.toContain('#AI');
  });

  it('catches secrets, mixed US/UK spelling, product casing, version mismatch, and regret shield', () => {
    const preset = PLAYGROUND_PRESETS.find((p) => p.id === 'pr-secrets-consistency');
    expect(preset).toBeDefined();
    if (!preset) return;

    const result = analyzeTier0Client({
      text: preset.text,
      surfaceId: preset.surfaceId,
      dialect: 'American',
      crutchWords: [],
    });

    expect(result.counts.secrets).toBe(1);
    expect(result.counts.consistency).toBeGreaterThanOrEqual(3);
    expect(result.counts.guards).toBeGreaterThanOrEqual(2);
  });

  it('detects buried ask, wall of text, and personal crutch words on email surface', () => {
    const preset = PLAYGROUND_PRESETS.find((p) => p.id === 'email-bluf');
    expect(preset).toBeDefined();
    if (!preset) return;

    const result = analyzeTier0Client({
      text: preset.text,
      surfaceId: preset.surfaceId,
      dialect: 'American',
      crutchWords: ['just', 'actually', 'basically', 'honestly'],
    });

    expect(result.counts.guards).toBeGreaterThanOrEqual(5);
    expect(result.diagnostics.some((d) => d.ruleLabel.includes('BLUF'))).toBe(true);
    expect(result.diagnostics.some((d) => d.ruleLabel === 'Wall of Text')).toBe(true);
    expect(result.diagnostics.some((d) => d.ruleLabel === 'Crutch Word')).toBe(true);
  });

  it('applies single diagnostic fixes cleanly', () => {
    const source = 'We use Github and GitHub for hosting.';
    const result = analyzeTier0Client({
      text: source,
      surfaceId: 'docs_markdown',
      dialect: 'American',
      crutchWords: [],
    });
    const casingHit = result.diagnostics.find((d) => d.ruleLabel === 'Product Casing');
    expect(casingHit).toBeDefined();
    if (!casingHit) return;

    const fixed = applySingleDiagnosticFix(source, casingHit);
    expect(fixed).toBe('We use GitHub and GitHub for hosting.');
  });

  it('stays clean on plain human prose', () => {
    const result = analyzeTier0Client({
      text: 'We moved the parser to Rust and cut tail latency to 4ms on an 8-core laptop.',
      surfaceId: 'web_reddit',
      dialect: 'American',
      crutchWords: ['just', 'actually'],
    });

    expect(result.diagnostics).toHaveLength(0);
    expect(result.slopMeter.score).toBe(0);
    expect(result.slopMeter.verdict).toBe('Human');
  });

  it('runs full Rust Harper + Tier 0 checks when lexel-wasm is loaded', () => {
    const wasmPath = resolve(
      import.meta.dirname,
      '../../../../packages/lexel-wasm/pkg/lexel_wasm_bg.wasm',
    );
    expect(existsSync(wasmPath)).toBe(true);

    initLexelWasmSync(readFileSync(wasmPath));
    const engine = new LexelWasmEngine();
    setWasmEngineForTesting(engine);

    try {
      const preset = PLAYGROUND_PRESETS.find((p) => p.id === 'pr-secrets-consistency');
      expect(preset).toBeDefined();
      if (!preset) return;

      const result = analyzeTier0Client({
        text: preset.text,
        surfaceId: preset.surfaceId,
        dialect: 'American',
        crutchWords: [],
      });

      expect(result.engineKind).toBe('wasm');
      expect(result.counts.harper).toBeGreaterThan(0);
      expect(result.counts.secrets).toBe(1);
      expect(result.counts.consistency).toBeGreaterThanOrEqual(3);
      expect(result.counts.guards).toBeGreaterThanOrEqual(2);
    } finally {
      setWasmEngineForTesting(null);
      engine.free();
    }
  }, 20_000);
});

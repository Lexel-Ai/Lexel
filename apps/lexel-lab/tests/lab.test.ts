import { describe, expect, it } from 'vitest';
import { computeTextStats } from '../src/lib/engine';
import { createDefaultLabState, parseImportedLabState } from '../src/lib/storage';
import { scanTier0Diagnostics, verifyAiRewrite } from '../src/lib/verifier';

describe('lexel-lab engine & verifier', () => {
  it('computes deterministic text statistics', () => {
    expect(computeTextStats('')).toEqual({ chars: 0, words: 0, sentences: 0 });
    expect(computeTextStats('Hello world. Second line!')).toEqual({
      chars: 25,
      words: 4,
      sentences: 2,
    });
  });

  it('flags slop, em dashes, and surface violations on Reddit', () => {
    const res = scanTier0Diagnostics(
      'In todays fast-paced landscape, delve into https://example.com #rust — great!',
      'web_reddit',
    );
    expect(res.slopLints.length).toBeGreaterThanOrEqual(2);
    expect(res.surfaceLints.length).toBeGreaterThanOrEqual(2);
  });

  it('verifies Tier 2 numeric and code-token grounding', () => {
    const good = verifyAiRewrite(
      'Fix `LexelLintController` latency from 42ms to 18ms on #42.',
      'Lowered `LexelLintController` latency from 42ms to 18ms on #42.',
      'web_github_pr',
    );
    expect(good.numbersPreserved).toBe(true);
    expect(good.tokensPreserved).toBe(true);
    expect(good.zeroSlop).toBe(true);
  });

  it('round-trips and validates JSON backup import', () => {
    const def = createDefaultLabState();
    const parsed = parseImportedLabState(JSON.stringify({ ...def, dialect: 1, subcontext: 'r/tokio' }));
    expect(parsed.dialect).toBe(1);
    expect(parsed.subcontext).toBe('r/tokio');
  });
});

import { describe, expect, it } from 'vitest';
import {
  extractUnitBoundMetrics,
  sanitizeModelOutput,
  scanTier0Diagnostics,
  verifyAiRewrite,
} from '../src/shared/verifier';

describe('verifier', () => {
  it('flags AI slop phrases and em dashes at Tier 0', () => {
    const text =
      "In today's fast-paced world, we delve into a seamless solution — a true game-changer.";
    const { slopLints } = scanTier0Diagnostics(text, 'general');
    expect(slopLints.length).toBeGreaterThanOrEqual(4);
    expect(slopLints.some((l) => l.problem_text.toLowerCase() === 'delve')).toBe(true);
    expect(slopLints.some((l) => l.problem_text.includes('—'))).toBe(true);
  });

  it('enforces Reddit rules (links, emojis, hashtags, openers)', () => {
    const text = 'Check out our tool 🚀 #rust https://example.com';
    const { surfaceLints } = scanTier0Diagnostics(text, 'web_reddit');
    expect(surfaceLints.length).toBeGreaterThanOrEqual(4);
  });

  it('distinguishes PR #42 from 42% and 18ms in unit-bound metrics', () => {
    const metrics = extractUnitBoundMetrics('Fixed #42, latency dropped 42% down to 18ms.');
    expect(metrics.map((m) => `${m.unit}:${m.value}`)).toEqual(['#:42', '%:42', 'ms:18']);
  });

  it('passes clean grounded rewrites and catches altered numbers or dropped backticks', () => {
    const source = 'Fixed `run_lint()` for issue #42; P99 latency dropped from 140ms to 18ms.';
    const clean = 'Fixed `run_lint()` for #42, cutting P99 latency from 140ms to 18ms.';
    const cleanGates = verifyAiRewrite(source, clean, 'web_github_pr');
    expect(cleanGates.zeroSlop).toBe(true);
    expect(cleanGates.numbersPreserved).toBe(true);
    expect(cleanGates.tokensPreserved).toBe(true);
    expect(cleanGates.surfaceCompliant).toBe(true);

    const hallucinated = 'Fixed issue #42, cutting latency from 140ms to 12ms seamlessly.';
    const badGates = verifyAiRewrite(source, hallucinated, 'web_github_pr');
    expect(badGates.zeroSlop).toBe(false);
    expect(badGates.numbersPreserved).toBe(false);
    expect(badGates.tokensPreserved).toBe(false);
  });

  it('strips accidental <think> blocks and surrounding quotes', () => {
    expect(sanitizeModelOutput('<think>reasoning</think>\n"Clean text."')).toBe('Clean text.');
  });
});

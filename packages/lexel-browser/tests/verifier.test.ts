import { describe, expect, it } from 'vitest';
import {
  applySafeDeterministicFixes,
  extractUnitBoundMetrics,
  findSlopMatches,
  hasSecrets,
  sanitizeModelOutput,
  scanSecretsAndPii,
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

  it('detects API keys, JWTs, PEM headers, SSNs, and Luhn-valid cards with masked previews', () => {
    const text = [
      'key=sk-proj-abc1234567890abcdef123456',
      'gh=ghp_1234567890abcdef1234567890abcdef1234',
      'aws=AKIAIOSFODNN7EXAMPLE',
      'jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      'pem=-----BEGIN RSA PRIVATE KEY-----',
      'ssn=123-45-6789',
      'card=4111 1111 1111 1111',
      'id=4111 1111 1111 1112',
    ].join(' ');

    const hits = scanSecretsAndPii(text);
    const kinds = hits.map((h) => h.kind);
    expect(kinds).toContain('api_key');
    expect(kinds).toContain('github_token');
    expect(kinds).toContain('aws_access_key');
    expect(kinds).toContain('jwt');
    expect(kinds).toContain('private_key');
    expect(kinds).toContain('ssn');
    expect(hits.filter((h) => h.kind === 'payment_card')).toHaveLength(1);
    expect(hasSecrets(text)).toBe(true);
    for (const h of hits) {
      expect(h.maskedPreview).not.toContain('abc1234567890abcdef');
      expect(h.maskedPreview).not.toContain('4111 1111 1111');
    }

    const diag = scanTier0Diagnostics(text, 'general');
    expect(diag.secretLints.length).toBeGreaterThanOrEqual(7);
  });

  it('supports custom and disabled slop terms plus one-click safe deterministic fixes', () => {
    const customHits = findSlopMatches('Let us circle back on this seamless release.', {
      customTerms: ['circle back'],
      disabledTerms: ['seamless'],
    });
    expect(customHits.some((h) => h.term.toLowerCase() === 'circle back')).toBe(true);
    expect(customHits.some((h) => h.term.toLowerCase() === 'seamless')).toBe(false);

    const fixed = applySafeDeterministicFixes(
      'We must delve into this — utilize 🚀 #rust',
      'web_reddit',
    );
    expect(fixed.text).not.toContain('—');
    expect(fixed.text.toLowerCase()).not.toContain('delve into');
    expect(fixed.text.toLowerCase()).not.toContain('utilize');
    expect(fixed.text).not.toContain('#rust');
    expect(fixed.fixesApplied).toBeGreaterThanOrEqual(4);
  });
});

import {
  HARPER_RULE_PRESETS,
  applyRulePreset,
  applySafeGrammarLints,
  computeReadabilityMetrics,
  normalizeTypography,
  toSentenceCase,
  toTitleCase,
} from 'lexel-ui';
import { describe, expect, it } from 'vitest';
import { detectSurfaceFromLocation } from '../src/shared/surfaceDetector';
import {
  applySafeDeterministicFixes,
  findSlopMatches,
  scanSecretsAndPii,
  scanTier0Diagnostics,
} from '../src/shared/verifier';

describe('zero-AI enhancements in lexel-ui & lexel-browser', () => {
  it('routes substack, wordpress, and discourse DOM signatures to dedicated surfaces', () => {
    const substackDoc = new DOMParser().parseFromString(
      '<html><head><link rel="preconnect" href="https://substackcdn.com"></head><body></body></html>',
      'text/html',
    );
    expect(detectSurfaceFromLocation('https://notes.example.org/post', { doc: substackDoc }).surfaceId).toBe(
      'web_substack',
    );

    const wpDoc = new DOMParser().parseFromString(
      '<html><head><meta name="generator" content="WordPress 6.7"></head><body></body></html>',
      'text/html',
    );
    expect(detectSurfaceFromLocation('https://blog.example.org/wp-admin', { doc: wpDoc }).surfaceId).toBe(
      'web_wordpress',
    );

    const discDoc = new DOMParser().parseFromString(
      '<html><head><meta name="generator" content="Discourse 3.4.0"></head><body></body></html>',
      'text/html',
    );
    expect(detectSurfaceFromLocation('https://forum.example.org/t/123', { doc: discDoc }).surfaceId).toBe(
      'web_discourse',
    );
  });

  it('detects extended secret types and attaches 1-click [REDACTED] suggestions', () => {
    const text = [
      'stripe=sk_live_abcdefghijklmnop1234567890',
      'hf=hf_abcdefghijklmnopqrstuvwxyz123456',
      'npm=npm_abcdefghijklmnopqrstuvwxyz123456',
      'hook=https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz012345',
      'DB_PASSWORD=supersecretpassword123',
    ].join('\n');

    const secrets = scanSecretsAndPii(text);
    expect(secrets.map((s) => s.kind)).toEqual([
      'stripe_key',
      'huggingface_token',
      'npm_token',
      'discord_webhook',
      'env_secret',
    ]);

    const diags = scanTier0Diagnostics(text, 'general');
    expect(diags.secretLints.length).toBe(5);
    expect(diags.secretLints[0].suggestions[0]).toEqual({
      kind: 0,
      replacement_text: '[REDACTED]',
    });
  });

  it('ignores code blocks, inline code, and quote lines in slop scan and safe fixes', () => {
    const text = [
      'We delve into bugs and circle back soon.',
      '',
      '`delve()` inside inline code stays intact.',
      '',
      '> delve into quoted prose stays intact',
      '',
      '```ts',
      'const utilize = true;',
      '```',
    ].join('\n');

    const hits = findSlopMatches(text, { customTerms: ['circle back => follow up'] });
    expect(hits.map((h) => h.term.toLowerCase())).toEqual(['delve', 'circle back']);
    expect(hits[0].suggestion).toBe('explore');
    expect(hits[1].suggestion).toBe('follow up');

    const diags = scanTier0Diagnostics(text, 'general', {
      customSlopTerms: ['circle back => follow up'],
    });
    expect(diags.slopLints[0].suggestions[0].replacement_text).toBe('explore');

    const fixed = applySafeDeterministicFixes(text, 'general', {
      customSlopTerms: ['circle back => follow up'],
    });
    expect(fixed.text).toContain('We explore bugs and follow up soon.');
    expect(fixed.text).toContain('`delve()` inside inline code stays intact.');
    expect(fixed.text).toContain('> delve into quoted prose stays intact');
    expect(fixed.text).toContain('const utilize = true;');
  });

  it('validates git commit rules and excess punctuation cleanly', () => {
    const commit =
      'Added a massive change that breaks our 72-character subject rule right here.\n';
    const { surfaceLints } = scanTier0Diagnostics(commit, 'ide_git_commit');
    expect(surfaceLints.some((l) => l.message_html.includes('72 characters'))).toBe(true);
    expect(surfaceLints.some((l) => l.message_html.includes('trailing period'))).toBe(true);
    expect(surfaceLints.some((l) => l.message_html.includes('imperative'))).toBe(true);

    const loud = scanTier0Diagnostics('Check this now!!!', 'web_email');
    expect(loud.surfaceLints.some((l) => l.message_html.includes('Repeated punctuation'))).toBe(
      true,
    );
  });

  it('provides sentence case, typography normalization, readability, presets, and batch grammar fixes', () => {
    expect(toSentenceCase('HELLO WORLD. SECOND LINE!')).toBe('Hello world. Second line!');
    expect(toSentenceCase('this API uses `delve()` and SQL. second sentence here!')).toBe(
      'This API uses `delve()` and SQL. Second sentence here!',
    );
    expect(toTitleCase('how the CLI runs on JSON data')).toBe('How the CLI Runs on JSON Data');

    const norm = normalizeTypography(
      '“Smart quotes”…  and   spaces   \n\n```py\n    keep_indent  = 1\n```',
    );
    expect(norm.text).toContain('"Smart quotes"... and spaces');
    expect(norm.text).toContain('    keep_indent  = 1');

    const stats = computeReadabilityMetrics(
      'Short tests run quickly. Clear prose helps engineers.',
    );
    expect(stats.words).toBe(8);
    expect(stats.sentences).toBe(2);
    expect(stats.fleschReadingEase).toBeGreaterThan(30);

    const strictCfg = applyRulePreset({}, 'strict_technical');
    expect(strictCfg.OxfordComma).toBe(true);
    expect(strictCfg.NoOxfordComma).toBe(false);
    expect(HARPER_RULE_PRESETS.length).toBe(4);
    expect(applyRulePreset(strictCfg, 'curated')).toEqual({});

    const grammarFixed = applySafeGrammarLints('Here is an typo and a error.', [
      {
        span: { start: 8, end: 10 },
        message_html: 'Use a',
        problem_text: 'an',
        lint_kind: 'Miscellaneous',
        lint_kind_pretty: 'AnA',
        suggestions: [{ kind: 0, replacement_text: 'a' }],
        context_hash: 'h1',
        source: 'Here is an typo and a error.',
      },
      {
        span: { start: 20, end: 21 },
        message_html: 'Use an',
        problem_text: 'a',
        lint_kind: 'Miscellaneous',
        lint_kind_pretty: 'AnA',
        suggestions: [{ kind: 0, replacement_text: 'an' }],
        context_hash: 'h2',
        source: 'Here is an typo and a error.',
      },
    ]);
    expect(grammarFixed.applied).toBe(2);
    expect(grammarFixed.text).toBe('Here is a typo and an error.');
  });
});

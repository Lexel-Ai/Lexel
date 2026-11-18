import {
  applyRulePreset,
  applySafeGrammarLints,
  normalizeTypography,
  toSentenceCase,
  toTitleCase,
} from 'lexel-ui';
import { describe, expect, it } from 'vitest';
import { computeWritingMetrics } from '../src/lib/engine';
import { LAB_PRESETS } from '../src/lib/presets';
import {
  applySafeDeterministicFixes,
  scanSecretsAndPii,
  scanTier0Diagnostics,
} from '../src/lib/verifier';

describe('lexel-lab zero-AI enhancements', () => {
  it('computes extended readability metrics in computeWritingMetrics', () => {
    const metrics = computeWritingMetrics(
      'Short tests check behavior. Another sentence that keeps running on and on with twenty five or more separate individual words to trigger the long sentence counter in the inspector.',
      { slopCount: 1, secretCount: 0 },
    );
    expect(metrics.words).toBe(29);
    expect(metrics.sentences).toBe(2);
    expect(metrics.longSentences).toBe(1);
    expect(metrics.fleschKincaidGrade).toBeGreaterThan(0);
    expect(metrics.fleschReadingEase).toBeGreaterThanOrEqual(0);
  });

  it('includes git_commit and docs_markdown sample presets and validates commit rules', () => {
    const commitPreset = LAB_PRESETS.find((p) => p.id === 'git_commit');
    expect(commitPreset?.surfaceId).toBe('ide_git_commit');
    const diags = scanTier0Diagnostics(commitPreset!.text, commitPreset!.surfaceId);
    expect(diags.surfaceLints.some((l) => l.message_html.includes('72 characters'))).toBe(true);
    expect(diags.surfaceLints.some((l) => l.message_html.includes('trailing period'))).toBe(true);

    const docsPreset = LAB_PRESETS.find((p) => p.id === 'docs_markdown');
    expect(docsPreset?.surfaceId).toBe('docs_markdown');
    const docsDiags = scanTier0Diagnostics(docsPreset!.text, docsPreset!.surfaceId);
    expect(docsDiags.slopLints.some((l) => l.problem_text.toLowerCase() === 'delve')).toBe(true);
    expect(docsDiags.slopLints.some((l) => l.problem_text.toLowerCase() === 'utilize')).toBe(false);
  });

  it('transforms text deterministically with zero AI', () => {
    expect(toSentenceCase('THIS API WORKS. SECOND LINE!')).toBe('This api works. Second line!');
    expect(toTitleCase('local testing for the win')).toBe('Local Testing for the Win');
    expect(normalizeTypography('“Curly”  quotes… ').text).toBe('"Curly" quotes...');

    const fixed = applySafeDeterministicFixes('We delve into speed.', 'general');
    expect(fixed.text).toBe('We explore speed.');

    const cfg = applyRulePreset({}, 'formal_academic');
    expect(cfg.AvoidContractions).toBe(true);

    const safeLints = applySafeGrammarLints('Here is an crash.', [
      {
        span: { start: 8, end: 10 },
        message_html: 'Use a',
        problem_text: 'an',
        lint_kind: 'Miscellaneous',
        lint_kind_pretty: 'AnA',
        suggestions: [{ kind: 0, replacement_text: 'a' }],
        context_hash: 'h1',
        source: 'Here is an crash.',
      },
    ]);
    expect(safeLints.text).toBe('Here is a crash.');

    expect(
      scanSecretsAndPii('NPM=npm_abcdefghijklmnopqrstuvwxyz123456').map((s) => s.kind),
    ).toContain('npm_token');
  });
});

import { describe, expect, it } from 'vitest';
import {
  analyzeObsidianNote,
  applyObsidianSafeFix,
  DEFAULT_OBSIDIAN_SETTINGS,
  requestLocalDaemonRewrite,
} from '../src/analyzer';

describe('lexel-obsidian note analyzer and safe fixes', () => {
  it('computes note readability, slop, invisible chars, structure, and style guide counts', () => {
    const note =
      'We delve into postgres\u200B today with the the draft.\n\n```ts\nconst delve = "postgres";\n```\n';
    const report = analyzeObsidianNote(note, [{ term: 'postgres', preferred: 'PostgreSQL' }]);
    expect(report.slopCount).toBe(1);
    expect(report.invisibleCount).toBe(1);
    expect(report.structureCount).toBe(1);
    expect(report.styleGuideCount).toBe(1);
    expect(report.totalIssues).toBe(4);
    expect(report.statusBarLabel).toContain('4 issues');
  });

  it('applies safe deterministic fixes while preserving fenced code blocks', () => {
    const note = 'We delve into postgres\u200B — “fast”.\n\n```\ndelve into postgres\n```';
    const fixed = applyObsidianSafeFix(note, [{ term: 'postgres', preferred: 'PostgreSQL' }]);
    expect(fixed.fixesApplied).toBeGreaterThan(0);
    expect(fixed.text).toContain('We explore PostgreSQL, "fast".');
    expect(fixed.text).toContain('delve into postgres');
    expect(fixed.text).not.toContain('\u200B');
  });

  it('blocks local AI rewrite when secrets are present in selection', async () => {
    const res = await requestLocalDaemonRewrite(
      { ...DEFAULT_OBSIDIAN_SETTINGS, daemonToken: 'local-token' },
      'My token is sk_live_abcdefghijklmnop1234567890',
      'deslop',
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('Secrets Guard');
    }
  });
});

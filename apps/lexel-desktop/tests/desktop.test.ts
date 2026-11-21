import {
  BUILTIN_SURFACES,
  composeHunkText,
  computeDiffHunks,
  DEFAULT_TONE_PILLS,
  HARPER_RULE_PRESETS,
  resetSurfaceOverride,
  summarizeHunkState,
  upsertSurfaceOverride,
} from 'lexel-ui';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  daemonRpc,
  downloadModel,
  expandContextSnippet,
  getDesktopEnvInfo,
  getDoctorReport,
  getNativeHostStatus,
  getRedactPreview,
  getWeeklyInsights,
  importVoiceSamples,
  isTauriRuntime,
  rewriteStreamWithTask,
  rewriteWithTask,
} from '../src/lib/desktopClient';
import { mergeSurfaceCatalog } from '../src/lib/surfaces';
import { buildLiveTier0Snapshot } from '../src/lib/tier0Bridge';
import type {
  DaemonStatusPayload,
  Tier0CheckResponse,
  UnifiedDaemonSettings,
} from '../src/lib/types';

describe('lexel-desktop client, shared hunk diff, & v0.2 workflows', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('detects browser preview fallback outside Tauri and exposes all 13 surfaces', async () => {
    expect(isTauriRuntime()).toBe(false);
    const status = await daemonRpc<DaemonStatusPayload>('status');
    expect(status.activeProfile.id).toBe('default');

    const { surfaces, customOnlyIds } = mergeSurfaceCatalog(
      status.activeProfile.settings.customSurfaces,
    );
    expect(surfaces.length).toBe(BUILTIN_SURFACES.length);
    expect(customOnlyIds.size).toBe(0);
    expect(DEFAULT_TONE_PILLS.map((p) => p.label)).toEqual([
      'Fix only',
      'Shorter',
      'Direct',
      'Softer',
      'De-slop',
    ]);
  });

  it('computes hunk-level diff and composes partial accept/reject accurately', () => {
    const original = 'We delve into fast latency and leverage local cache.';
    const suggested = 'We explore fast latency and use local cache.';
    const hunks = computeDiffHunks(original, suggested);
    const changeHunks = hunks.filter((h) => h.kind === 'change');
    expect(changeHunks.length).toBe(2);
    expect(composeHunkText(hunks)).toBe(suggested);

    // Reject only the second hunk ("leverage" -> "use")
    const secondId = changeHunks[1].id;
    const partialHunks = hunks.map((h) => (h.id === secondId ? { ...h, accepted: false } : h));
    expect(composeHunkText(partialHunks)).toBe('We explore fast latency and leverage local cache.');

    const summary = summarizeHunkState(partialHunks);
    expect(summary.totalChanges).toBe(2);
    expect(summary.acceptedChanges).toBe(1);
    expect(summary.isPartial).toBe(true);
  });

  it('persists surface prompt edits via patchSettings and resets cleanly', async () => {
    const reddit = BUILTIN_SURFACES.find((s) => s.id === 'web_reddit');
    expect(reddit).toBeDefined();
    if (!reddit) return;
    const updatedSurfaces = upsertSurfaceOverride([], reddit, {
      promptDirective: 'Custom desktop prompt for technical Reddit replies.',
    });

    const patched = await daemonRpc<{ settings: UnifiedDaemonSettings }>('patchSettings', {
      patch: { customSurfaces: updatedSurfaces },
    });
    const merged = mergeSurfaceCatalog(patched.settings.customSurfaces);
    expect(merged.surfaces.find((s) => s.id === 'web_reddit')?.promptDirective).toBe(
      'Custom desktop prompt for technical Reddit replies.',
    );

    const reset = resetSurfaceOverride(patched.settings.customSurfaces, 'web_reddit');
    expect(reset).toEqual([]);
  });

  it('runs deterministic Tier 0 check, 2-takes rewrite, streaming, redact preview, snippets, doctor, and voice import', async () => {
    const diag = await daemonRpc<Tier0CheckResponse>('tier0Check', {
      text: 'In todays fast-paced landscape — delve into #rust with sk-proj-abc1234567890abcdef123456',
      surfaceId: 'web_reddit',
    });
    expect(diag.slop.length).toBeGreaterThanOrEqual(2);
    expect(diag.slop.some((s) => s.isEmDash)).toBe(true);
    expect(diag.surface.length).toBeGreaterThanOrEqual(1);
    expect(diag.secrets.length).toBe(1);
    expect(diag.secrets[0].maskedPreview).toContain('***');

    const redact = await getRedactPreview('Use AKIAIOSFODNN7EXAMPLE in staging.');
    expect(redact.redactedCount).toBe(1);
    expect(redact.redactedText).toContain('[LEXEL_REDACTED_1]');

    const rules = await daemonRpc<{ rules: Array<{ id: string; enabled: boolean }> }>(
      'harperRules',
    );
    expect(rules.rules.length).toBeGreaterThan(0);

    const twoTakes = await rewriteWithTask({
      text: 'We delve into latency in order to ship faster.',
      task: 'deslop',
      surfaceId: 'web_reddit',
      subcontext: 'r/rust',
      candidates: 2,
    });
    expect(twoTakes.suggestion).toContain('explore');
    expect(twoTakes.gates.zeroSlop).toBe(true);
    expect(twoTakes.candidates?.length).toBe(2);

    const streamedChunks: string[] = [];
    const streamed = await rewriteStreamWithTask(
      {
        text: "Obviously, why didn't you test the patch?",
        task: 'softer',
        surfaceId: 'web_github_pr',
        subcontext: null,
      },
      {
        onChunk: (delta) => streamedChunks.push(delta),
      },
    );
    expect(streamed.suggestion).not.toMatch(/obviously/i);
    expect(streamedChunks.length).toBeGreaterThan(0);

    const expanded = await expandContextSnippet({
      trigger: '/standup',
      surfaceId: 'web_discord_slack',
      notes: 'Shipped hunk diff UI',
    });
    expect(expanded.expandedText).toContain('Shipped hunk diff UI');

    const voiceReport = await importVoiceSamples(
      [
        { surfaceId: 'web_email', text: 'Shipped the fix for PR 42. Ready for your review.' },
        {
          surfaceId: 'web_email',
          text: 'Leaked key AKIAIOSFODNN7EXAMPLE should be skipped cleanly.',
        },
      ],
      'paste',
    );
    expect(voiceReport.importedCount).toBe(1);
    expect(voiceReport.skippedSecretsCount).toBe(1);

    const insights = await getWeeklyInsights(7);
    expect(insights.checksInPeriod).toBeGreaterThanOrEqual(1);
    expect(insights.voiceExamplesCount).toBe(1);

    const doctor = await getDoctorReport(false);
    expect(doctor.ok).toBe(true);
    expect(doctor.tier0LatencyMs).not.toBeNull();
    expect(doctor.privacyProof.zeroTelemetry).toBe(true);

    const email = BUILTIN_SURFACES.find((s) => s.id === 'web_email');
    expect(email).toBeDefined();
    if (!email) return;
    const live = buildLiveTier0Snapshot({
      text: "Obviously, why didn't you test the color and colour on Github and GitHub — we delve into it just honestly.",
      profile: email,
      dialect: 0,
      customSlopTerms: [],
      disabledSlopTerms: [],
      crutchWords: ['just', 'honestly'],
      tier0Response: null,
      redactSecrets: false,
      onTriggerTone: () => undefined,
      onBanCrutchWord: () => undefined,
      onRunSafeFix: () => undefined,
    });
    expect(live.slopScore).toBeGreaterThan(20);
    expect(live.slopBreakdown.emDashCount).toBeGreaterThanOrEqual(1);
    expect(live.alerts.some((a) => a.kind === 'consistency')).toBe(true);
    expect(live.alerts.some((a) => a.kind === 'regret')).toBe(true);
    expect(live.alerts.some((a) => a.kind === 'crutch')).toBe(true);

    const env = await getDesktopEnvInfo();
    expect(env.dbPath).toContain('lexel.db');
    const native = await getNativeHostStatus();
    expect(native.hostName).toBe('com.lexel.daemon');
    expect(native.targets.some((t) => t.browser === 'Microsoft Edge')).toBe(true);
    expect(HARPER_RULE_PRESETS.length).toBeGreaterThanOrEqual(3);
    await expect(downloadModel('lexel-0.5b')).rejects.toThrow(/native Lexel Desktop app/i);
  });
});

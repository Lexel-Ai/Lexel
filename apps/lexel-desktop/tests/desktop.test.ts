import {
  BUILTIN_SURFACES,
  HARPER_RULE_PRESETS,
  resetSurfaceOverride,
  upsertSurfaceOverride,
} from 'lexel-ui';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  daemonRpc,
  downloadModel,
  getDesktopEnvInfo,
  getNativeHostStatus,
  isTauriRuntime,
  rewriteWithTask,
} from '../src/lib/desktopClient';
import { mergeSurfaceCatalog } from '../src/lib/surfaces';
import type {
  DaemonStatusPayload,
  Tier0CheckResponse,
  UnifiedDaemonSettings,
} from '../src/lib/types';

describe('lexel-desktop client & catalog', () => {
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
  });

  it('persists surface prompt edits via patchSettings and resets cleanly', async () => {
    const reddit = BUILTIN_SURFACES.find((s) => s.id === 'web_reddit')!;
    const updatedSurfaces = upsertSurfaceOverride([], reddit, {
      promptDirective: 'Custom desktop prompt for technical Reddit replies.',
    });

    const patched = await daemonRpc<{ settings: UnifiedDaemonSettings }>('patchSettings', {
      patch: { customSurfaces: updatedSurfaces },
    });
    const merged = mergeSurfaceCatalog(patched.settings.customSurfaces);
    expect(
      merged.surfaces.find((s) => s.id === 'web_reddit')?.promptDirective,
    ).toBe('Custom desktop prompt for technical Reddit replies.');

    const reset = resetSurfaceOverride(patched.settings.customSurfaces, 'web_reddit');
    expect(reset).toEqual([]);
  });

  it('runs deterministic Tier 0 check, safe rewrite, and Native Host inspection', async () => {
    const diag = await daemonRpc<Tier0CheckResponse>('tier0Check', {
      text: 'In todays fast-paced landscape — delve into #rust with sk-proj-abc1234567890abcdef123456',
      surfaceId: 'web_reddit',
    });
    expect(diag.slop.length).toBeGreaterThanOrEqual(2);
    expect(diag.slop.some((s) => s.isEmDash)).toBe(true);
    expect(diag.surface.length).toBeGreaterThanOrEqual(1);
    expect(diag.secrets.length).toBe(1);
    expect(diag.secrets[0].maskedPreview).toContain('***');

    const rules = await daemonRpc<{ rules: Array<{ id: string; enabled: boolean }> }>('harperRules');
    expect(rules.rules.length).toBeGreaterThan(0);
    expect(rules.rules[0].id).toBeTruthy();

    const rewrite = await rewriteWithTask({
      text: 'We delve into latency.',
      task: 'deslop',
      surfaceId: 'web_reddit',
      subcontext: 'r/rust',
    });
    expect(rewrite.suggestion).toBe('We explore latency.');
    expect(rewrite.gates.zeroSlop).toBe(true);

    const env = await getDesktopEnvInfo();
    expect(env.dbPath).toContain('lexel.db');
    const native = await getNativeHostStatus();
    expect(native.hostName).toBe('com.lexel.daemon');
    expect(native.targets.some((t) => t.browser === 'Microsoft Edge')).toBe(true);
    expect(HARPER_RULE_PRESETS.length).toBeGreaterThanOrEqual(3);
    await expect(downloadModel('lexel-0.5b')).rejects.toThrow(/native Lexel Desktop app/i);
  });
});

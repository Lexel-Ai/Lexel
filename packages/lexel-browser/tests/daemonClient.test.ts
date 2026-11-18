import { afterEach, describe, expect, it, vi } from 'vitest';
import { callNativeDaemon } from '../src/shared/daemonClient';
import {
  inferTierFromModelName,
  MODEL_MANIFEST_SPECS,
  resolveModelNameForTier,
} from '../src/shared/models';

describe('model manifest & native daemon client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes both 0.5B and 1.5B models from models/manifest.json', () => {
    expect(MODEL_MANIFEST_SPECS.map((m) => m.id)).toEqual(['lexel-0.5b', 'lexel-1.5b']);
    expect(resolveModelNameForTier('lexel-0.5b', '')).toBe('qwen2.5:0.5b');
    expect(resolveModelNameForTier('lexel-1.5b', '')).toBe('qwen2.5:1.5b');
    expect(inferTierFromModelName('0.5b')).toBe('lexel-0.5b');
    expect(inferTierFromModelName('qwen2.5:1.5b')).toBe('lexel-1.5b');
    expect(inferTierFromModelName('llama3.2:3b')).toBe('custom');
  });

  it('reports install-native-host hint with extension id when Chrome blocks native host', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        lastError: { message: 'Access to the specified native messaging host is forbidden.' },
        sendNativeMessage: (_host: string, _msg: unknown, cb: (res: unknown) => void) => cb(undefined),
      },
    });

    const res = await callNativeDaemon('status');
    expect(res.connected).toBe(false);
    expect(res.forbidden).toBe(true);
    expect(res.installHint).toContain('--extension-id abcdefghijklmnopabcdefghijklmnop');
  });

  it('parses successful native messaging envelopes from lexel-daemon', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test-id',
        lastError: undefined,
        sendNativeMessage: (_host: string, _msg: unknown, cb: (res: unknown) => void) =>
          cb({ id: '1', ok: true, data: { ok: true, version: '0.1.0' } }),
      },
    });

    const res = await callNativeDaemon<{ ok: boolean; version: string }>('health');
    expect(res.connected).toBe(true);
    expect(res.data?.ok).toBe(true);
    expect(res.data?.version).toBe('0.1.0');
  });
});

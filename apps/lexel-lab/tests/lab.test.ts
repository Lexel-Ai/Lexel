import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDaemonStatus } from '../src/lib/daemonClient';
import { computeTextStats, computeWritingMetrics } from '../src/lib/engine';
import { MODEL_MANIFEST_SPECS } from '../src/lib/models';
import {
  applyDaemonProfileToLabState,
  createDefaultLabState,
  labStateToDaemonPatch,
  parseImportedLabState,
} from '../src/lib/storage';
import {
  applySafeDeterministicFixes,
  findSlopMatches,
  scanSecretsAndPii,
  scanTier0Diagnostics,
  verifyAiRewrite,
} from '../src/lib/verifier';

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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips and validates JSON backup import', () => {
    const def = createDefaultLabState();
    const parsed = parseImportedLabState(JSON.stringify({ ...def, dialect: 1, subcontext: 'r/tokio' }));
    expect(parsed.dialect).toBe(1);
    expect(parsed.subcontext).toBe('r/tokio');
  });

  it('maps unified daemon profile settings to and from Lab state', () => {
    expect(MODEL_MANIFEST_SPECS.map((m) => m.id)).toEqual(['lexel-0.5b', 'lexel-1.5b']);
    const def = createDefaultLabState();
    const patch = labStateToDaemonPatch(def);
    const hydrated = applyDaemonProfileToLabState(def, {
      id: 'work',
      name: 'Work',
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
      settings: {
        theme: 'light',
        aiEnabled: false,
        mainModelTier: 'lexel-0.5b',
        customModel: 'qwen2.5:0.5b',
        runtime: 'auto',
        ollamaEndpoint: 'http://127.0.0.1:11434',
        openaiCompatEndpoint: 'http://127.0.0.1:8080',
        temperature: 0.2,
        maxTokens: 200,
        idleUnloadSecs: 120,
        keepWarm: true,
        saveVoiceMemory: true,
        dialect: 1,
        isolateEnglish: true,
        openSuggestionsOnHover: false,
        activationKey: 'shift',
        lintDelayMs: 50,
        defaultEnable: false,
        lintConfig: { AvoidWeaselWords: true },
        userDictionary: ['Weirpack'],
        ignoredLints: '',
        privacyBlocklist: ['1password.com'],
        domainStatuses: { 'reddit.com': false },
        surfaceOverrides: { 'example.com': 'web_x' },
      },
    });
    expect(patch.mainModelTier).toBe('lexel-1.5b');
    expect(hydrated.theme).toBe('light');
    expect(hydrated.aiSettings.enabled).toBe(false);
    expect(hydrated.aiSettings.mainModelTier).toBe('lexel-0.5b');
    expect(hydrated.aiSettings.model).toBe('qwen2.5:0.5b');
    expect(hydrated.defaultEnable).toBe(false);
    expect(hydrated.domainStatuses['reddit.com']).toBe(false);
  });

  it('sends Bearer authorization header when calling lexel-daemon', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ daemonRunning: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await fetchDaemonStatus({
      enabled: true,
      endpoint: 'http://127.0.0.1:42424',
      token: 'secret-token',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
  });

  it('scans secrets/PII, custom slop terms, and applies safe deterministic fixes', () => {
    const hits = scanSecretsAndPii('Use sk-proj-abc1234567890abcdef123456 or 4111-1111-1111-1111');
    expect(hits.map((h) => h.kind)).toEqual(['api_key', 'payment_card']);
    expect(
      findSlopMatches('Please circle back seamlessly.', {
        customTerms: ['circle back'],
        disabledTerms: ['seamlessly'],
      }).map((h) => h.term.toLowerCase()),
    ).toEqual(['circle back']);

    const fixed = applySafeDeterministicFixes(
      'In order to delve into latency — utilize 42ms 🚀 #rust',
      'web_reddit',
    );
    expect(fixed.text).not.toContain('—');
    expect(fixed.text).toContain('42ms');
    expect(fixed.fixesApplied).toBeGreaterThanOrEqual(4);

    const metrics = computeWritingMetrics(
      'One two three four five six seven eight nine ten.',
      { slopCount: 1, secretCount: 1 },
    );
    expect(metrics.words).toBe(10);
    expect(metrics.readingTimeSec).toBe(3);
    expect(metrics.slopDensity).toBe(10);
    expect(metrics.secretCount).toBe(1);
  });
});

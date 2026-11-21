import fs from 'node:fs';
import path from 'node:path';
import { initLexelWasmSync, LexelWasmEngine } from 'lexel-wasm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  daemonComplete,
  daemonDoctor,
  daemonRewriteStream,
  type StreamChunkPayload,
} from '../src/shared/daemonClient';
import { extractSmartThreadContext, scopeThreadContextLocally } from '../src/shared/threadContext';
import {
  analyzeFullTier0,
  checkDocumentConsistency,
  checkPastedAiSlop,
  checkWritingGuards,
  computeSlopMeter,
} from '../src/shared/tier0Engine';
import { tier0ReportToLintGroups } from '../src/shared/wasmEngine';

describe('Tier 0 slop meter, pasted-AI pill, consistency & writing guards', () => {
  it('scores high-slop pasted text and offers humanize pill above 120 chars', () => {
    const slopPaste =
      "In today's fast-paced digital landscape, it is important to note that we must delve into leveraging robust synergies — transforming our seamless paradigm to unlock game-changing outcomes for stakeholders.";
    const pasted = checkPastedAiSlop(slopPaste);
    expect(pasted.shouldOffer).toBe(true);
    expect(pasted.score).toBeGreaterThanOrEqual(28);
    expect(pasted.slopCount).toBeGreaterThanOrEqual(2);

    const shortText = 'We delve into code.';
    expect(checkPastedAiSlop(shortText).shouldOffer).toBe(false);

    const human =
      'We moved the cache purge out of the request path and dropped p95 latency from 420ms to 85ms on staging.';
    const meter = computeSlopMeter(human);
    expect(meter.label).toBe('Human');
    expect(meter.score).toBeLessThan(18);
  });

  it('catches document-wide consistency variants while ignoring fenced code blocks', () => {
    const doc = [
      'Update the color scheme and keep the colour token aligned.',
      'Send an e-mail to the email alias for GitHub and github webhooks on v1.2 and 1.2 today.',
      '```ts',
      'const colour = "red";',
      '```',
    ].join('\n');

    const warnings = checkDocumentConsistency(doc);
    expect(warnings.some((w) => w.kind === 'spelling_variant')).toBe(true);
    expect(warnings.some((w) => w.kind === 'hyphenation')).toBe(true);
    expect(warnings.some((w) => w.kind === 'product_casing')).toBe(true);
    expect(warnings.some((w) => w.kind === 'version_format')).toBe(true);
  });

  it('flags BLUF walls of text, buried asks, Regret Shield, and personal crutch words', () => {
    const emailDraft = [
      'Obviously, as I already said yesterday, we just need to finish the migration soon.',
      'Line 2 of context with extra detail about the staging rollout.',
      'Line 3 of context explaining why the old worker pool timed out.',
      'Line 4 of context noting the retry queue behavior.',
      'Line 5 of context listing the affected regions.',
      'Line 6 of context with another detail.',
      'Please see attached for the full log output. Can you approve the deploy by 4pm?',
    ].join('\n');

    const guards = checkWritingGuards(emailDraft, 'web_email', { crutchWords: ['just'] });
    expect(guards.some((g) => g.kind === 'bluf_wall_of_text')).toBe(true);
    expect(guards.some((g) => g.kind === 'bluf_buried_ask')).toBe(true);
    expect(guards.some((g) => g.kind === 'regret_abrasive')).toBe(true);
    expect(guards.some((g) => g.kind === 'regret_missing_attachment')).toBe(true);
    expect(guards.some((g) => g.kind === 'crutch_word')).toBe(true);

    const bundle = analyzeFullTier0(emailDraft, 'web_email', { crutchWords: ['just'] });
    expect(bundle.guardWarnings.length).toBeGreaterThanOrEqual(4);
  });
});

describe('Smart thread context extraction and scoping', () => {
  it('extracts GitHub PR review diff hunks and parent comments on explicit call', () => {
    const doc = new DOMParser().parseFromString(
      `<html><body>
        <h1>Fix token cache invalidation</h1>
        <table class="diff-table">
          <tr><td class="blob-code-deletion">- cache.clear()</td></tr>
          <tr><td class="blob-code-addition">+ cache.delete(key)</td></tr>
        </table>
        <div class="review-thread-component">
          <div class="comment-body">Does cache.delete(key) also clear expired aliases?</div>
          <textarea id="reply-box"></textarea>
        </div>
      </body></html>`,
      'text/html',
    );
    const textarea = doc.getElementById('reply-box') as HTMLElement;
    const extracted = extractSmartThreadContext(textarea, doc, 'github.com');
    expect(extracted.sourceHint).toContain('PR diff');
    expect(extracted.rawContext).toContain('Fix token cache invalidation');
    expect(extracted.rawContext).toContain('cache.delete(key)');
  });

  it('deterministically scopes long thread contexts down to ~300 tokens favoring overlap', () => {
    const longBlocks = Array.from({ length: 12 }, (_, idx) =>
      idx === 7
        ? 'The sqlite cache_invalidation_key drops stale entries during WAL checkpoints in lexel-daemon.'
        : `Unrelated chatter block ${idx} discussing weekend plans and lunch menus in detail. `.repeat(
            4,
          ),
    ).join('\n\n');

    const scoped = scopeThreadContextLocally(
      'Checking sqlite cache_invalidation_key behavior during checkpoints.',
      longBlocks,
      120,
    );
    expect(scoped.truncated).toBe(true);
    expect(scoped.estimatedTokens).toBeLessThanOrEqual(150);
    expect(scoped.scopedText).toContain('cache_invalidation_key');
  });
});

describe('v0.2 daemon streaming, ghost completion, and doctor RPCs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('streams chunks over chrome.runtime.connectNative and resolves terminal RewriteResult', async () => {
    const receivedChunks: StreamChunkPayload[] = [];
    let msgListener: ((msg: unknown) => void) | null = null;
    const disconnected = vi.fn();

    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test-ext',
        lastError: undefined,
        connectNative: () => ({
          onMessage: {
            addListener: (fn: (msg: unknown) => void) => {
              msgListener = fn;
            },
          },
          onDisconnect: { addListener: () => {} },
          disconnect: disconnected,
          postMessage: () => {
            queueMicrotask(() => {
              msgListener?.({
                ok: true,
                stream: true,
                done: false,
                data: { delta: 'Shipped ', accumulated: 'Shipped ' },
              });
              msgListener?.({
                ok: true,
                stream: true,
                done: false,
                data: { delta: 'today.', accumulated: 'Shipped today.' },
              });
              msgListener?.({
                ok: true,
                stream: true,
                done: true,
                data: {
                  original: 'We seamlessly shipped today.',
                  suggestion: 'Shipped today.',
                  model: 'qwen2.5:1.5b',
                  latencyMs: 210,
                  gates: {
                    zeroSlop: true,
                    numbersPreserved: true,
                    tokensPreserved: true,
                    surfaceCompliant: true,
                    warnings: [],
                  },
                  surfaceId: 'web_x',
                  subcontext: null,
                  fastPath: false,
                  retried: false,
                  candidates: [
                    {
                      label: 'Direct',
                      suggestion: 'Shipped today.',
                      gates: {
                        zeroSlop: true,
                        numbersPreserved: true,
                        tokensPreserved: true,
                        surfaceCompliant: true,
                        warnings: [],
                      },
                    },
                  ],
                },
              });
            });
          },
        }),
      },
    });

    const res = await daemonRewriteStream(
      {
        text: 'We seamlessly shipped today.',
        task: 'deslop',
        surfaceId: 'web_x',
        subcontext: null,
        candidates: 2,
      },
      (chunk) => receivedChunks.push(chunk),
    );

    expect(res.connected).toBe(true);
    expect(receivedChunks.map((c) => c.delta)).toEqual(['Shipped ', 'today.']);
    expect(res.data?.suggestion).toBe('Shipped today.');
    expect(disconnected).toHaveBeenCalledTimes(1);
  });

  it('forwards complete and doctor RPCs over Native Messaging', async () => {
    const seenKinds: string[] = [];
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test-ext',
        lastError: undefined,
        sendNativeMessage: (_host: string, req: { kind: string }, cb: (res: unknown) => void) => {
          seenKinds.push(req.kind);
          if (req.kind === 'complete') {
            cb({
              ok: true,
              data: {
                completion: 'clearing stale keys on write',
                model: 'qwen2.5:0.5b',
                latencyMs: 95,
                gates: {
                  zeroSlop: true,
                  numbersPreserved: true,
                  tokensPreserved: true,
                  surfaceCompliant: true,
                  warnings: [],
                },
              },
            });
          } else {
            cb({
              ok: true,
              data: {
                ok: true,
                version: '0.2.0',
                httpPort: 42424,
                tier0LatencyMs: 0.42,
              },
            });
          }
        },
      },
    });

    const comp = await daemonComplete({
      prefix: 'We fixed the cache invalidation bug by ',
      surfaceId: 'web_github_pr',
    });
    expect(comp.connected).toBe(true);
    expect(comp.data?.completion).toBe('clearing stale keys on write');

    const doc = await daemonDoctor(true);
    expect(doc.connected).toBe(true);
    expect(doc.data?.tier0LatencyMs).toBe(0.42);
    expect(seenKinds).toEqual(['complete', 'doctor']);
  });
});

describe('zero-daemon lexel-wasm Tier 0 integration', () => {
  it('loads real lexel_wasm_bg.wasm and maps Harper + slop + consistency + guards into lint groups', () => {
    const wasmPath = path.resolve(import.meta.dirname, '../../lexel-wasm/pkg/lexel_wasm_bg.wasm');
    const wasmBytes = fs.readFileSync(wasmPath);
    initLexelWasmSync(wasmBytes);
    const engine = new LexelWasmEngine();
    try {
      const text = 'Obviously we delve into an error on GitHub and github — color and colour.';
      const report = engine.check(text, {
        surfaceId: 'web_email',
        language: 'markdown',
        crutchWords: ['obviously'],
      });
      const mapped = tier0ReportToLintGroups(text, report);
      expect(mapped.slopCount).toBeGreaterThanOrEqual(2);
      expect(mapped.consistencyCount).toBeGreaterThanOrEqual(2);
      expect(mapped.guardCount).toBeGreaterThanOrEqual(1);
      expect(mapped.bySource.LexelAntiSlop?.length).toBeGreaterThanOrEqual(2);
      expect(mapped.bySource.LexelConsistency?.length).toBeGreaterThanOrEqual(2);
      expect(mapped.bySource.LexelGuard?.length).toBeGreaterThanOrEqual(1);
    } finally {
      engine.free();
    }
  }, 20_000);
});

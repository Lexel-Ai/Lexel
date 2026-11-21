import type { LintOptions } from 'harper.js';
import type { DoctorReportData } from 'lexel-ui';
import type { UnpackedLintGroups } from 'lint-framework';
import { LRUCache } from 'lru-cache';
import type { StreamChunkPayload } from '../shared/daemonClient';
import type { LocalAiHealth } from '../shared/localAiClient';
import { DEFAULT_AI_SETTINGS } from '../shared/storage';
import type {
  ActivationKey,
  AiSettings,
  AiTaskId,
  ExtensionRequest,
  GhostCompletionRequest,
  GhostCompletionResponse,
  Hotkey,
  LintResponse,
  PageLintSummary,
  RewriteResult,
  ScopedThreadContext,
  SurfaceId,
} from '../shared/types';

async function send<T>(msg: ExtensionRequest): Promise<T> {
  return (await chrome.runtime.sendMessage(msg)) as T;
}

export default class ProtocolClient {
  private static readonly lintCache = new LRUCache<string, Promise<UnpackedLintGroups>>({
    max: 3000,
    ttl: 45_000,
    ttlAutopurge: true,
  });

  public static clearCache(): void {
    this.lintCache.clear();
  }

  public static async lint(
    text: string,
    domain: string,
    options?: LintOptions,
    surface?: { surfaceId: SurfaceId; subcontext: string | null },
  ): Promise<UnpackedLintGroups> {
    const key = JSON.stringify([
      domain,
      surface?.surfaceId ?? 'general',
      surface?.subcontext ?? null,
      text,
      options?.language ?? 'markdown',
      options?.isolateEnglish ?? false,
    ]);

    let pending = this.lintCache.get(key);
    if (!pending) {
      pending = send<LintResponse>({
        kind: 'lint',
        text,
        domain,
        surfaceId: surface?.surfaceId,
        subcontext: surface?.subcontext,
        options: options as Record<string, unknown> | undefined,
      }).then((res) => res?.lints ?? {});
      this.lintCache.set(key, pending);
    }
    return pending;
  }

  public static async ignoreHash(contextHash: string): Promise<void> {
    this.lintCache.clear();
    await send({ kind: 'ignoreLint', contextHash });
  }

  public static async getActivationKey(): Promise<ActivationKey> {
    const res = await send<{ key: ActivationKey }>({ kind: 'getActivationKey' });
    return res?.key ?? 'off';
  }

  public static async getHotkey(): Promise<Hotkey> {
    const res = await send<{ hotkey: Hotkey }>({ kind: 'getHotkey' });
    return res?.hotkey ?? { modifiers: ['Alt'], key: 'l' };
  }

  public static async getDelay(): Promise<number> {
    const res = await send<{ delay: number }>({ kind: 'getDelay' });
    return res?.delay ?? 0;
  }

  public static async getOpenSuggestionsOnHover(): Promise<boolean> {
    const res = await send<{ enabled: boolean }>({ kind: 'getOpenSuggestionsOnHover' });
    return res?.enabled !== false;
  }

  public static async addToUserDictionary(words: string[]): Promise<void> {
    this.lintCache.clear();
    await send({ kind: 'addToUserDictionary', words });
  }

  public static async setRuleEnabled(ruleId: string, enabled: boolean): Promise<void> {
    this.lintCache.clear();
    const res = await send<{ config: Record<string, boolean | null> }>({ kind: 'getConfig' });
    const nextConfig = { ...(res?.config ?? {}), [ruleId]: enabled };
    await send({ kind: 'setConfig', config: nextConfig });
  }

  public static async openOptions(): Promise<void> {
    await send({ kind: 'openOptions' });
  }

  public static async openSidePanel(): Promise<void> {
    await send({ kind: 'openSidePanel' });
  }

  public static async setDomainEnabled(domain: string, enabled: boolean): Promise<void> {
    this.lintCache.clear();
    await send({ kind: 'setDomainStatus', domain, enabled, overrideValue: false });
  }

  public static async getPrivacyBlocklist(): Promise<string[]> {
    const res = await send<{ domains: string[] }>({ kind: 'getPrivacyBlocklist' });
    return res?.domains ?? [];
  }

  public static async getSurfaceOverride(domain: string): Promise<SurfaceId | null> {
    const res = await send<{ surfaceId: SurfaceId | null }>({ kind: 'getSurfaceOverride', domain });
    return res?.surfaceId ?? null;
  }

  public static async getAiSettings(): Promise<AiSettings> {
    const res = await send<{ settings?: AiSettings }>({ kind: 'getAiSettings' });
    return res?.settings ?? DEFAULT_AI_SETTINGS;
  }

  public static async getAiHealth(): Promise<LocalAiHealth> {
    const res = await send<LocalAiHealth>({ kind: 'aiHealth' });
    return res ?? { ok: false, models: [], error: 'Extension background worker did not respond.' };
  }

  public static async setAiEnabled(enabled: boolean): Promise<void> {
    await send({ kind: 'toggleAi', enabled });
  }

  public static async getTheme(): Promise<'dark' | 'light'> {
    const res = await send<{ theme: 'dark' | 'light' }>({ kind: 'getTheme' });
    return res?.theme ?? 'dark';
  }

  public static async getGhostTextEnabled(): Promise<boolean> {
    const res = await send<{ enabled?: boolean }>({ kind: 'getGhostTextEnabled' });
    return res?.enabled === true;
  }

  public static async setGhostTextEnabled(enabled: boolean): Promise<void> {
    await send({ kind: 'setGhostTextEnabled', enabled });
  }

  public static async getRedactSecrets(): Promise<boolean> {
    const res = await send<{ enabled?: boolean }>({ kind: 'getRedactSecrets' });
    return res?.enabled === true;
  }

  public static async setRedactSecrets(enabled: boolean): Promise<void> {
    await send({ kind: 'setRedactSecrets', enabled });
  }

  public static async getCrutchWords(): Promise<string[]> {
    const res = await send<{ words?: string[] }>({ kind: 'getCrutchWords' });
    return res?.words ?? [];
  }

  public static async setCrutchWords(words: string[]): Promise<void> {
    await send({ kind: 'setCrutchWords', words });
  }

  public static async getPrivacyStats(): Promise<{
    localSecretBlocks: number;
    redactSecrets: boolean;
    blocklistCount: number;
  }> {
    const res = await send<{
      localSecretBlocks?: number;
      redactSecrets?: boolean;
      blocklistCount?: number;
    }>({ kind: 'getPrivacyStats' });
    return {
      localSecretBlocks: res?.localSecretBlocks ?? 0,
      redactSecrets: res?.redactSecrets === true,
      blocklistCount: res?.blocklistCount ?? 0,
    };
  }

  public static async getDoctorReport(
    bench = false,
  ): Promise<{ ok: true; report: DoctorReportData } | { ok: false; error: string }> {
    return send({ kind: 'getDoctorReport', bench });
  }

  public static async aiRewrite(params: {
    text: string;
    task: AiTaskId;
    surfaceId: SurfaceId;
    subcontext: string | null;
    threadContext?: string;
    domain?: string;
    candidates?: 1 | 2;
    redactSecrets?: boolean | null;
  }): Promise<{ ok: true; result: RewriteResult } | { ok: false; error: string }> {
    return send({ kind: 'aiRewrite', ...params });
  }

  /**
   * Stream local AI rewrite tokens over a Chrome runtime port backed by Native Messaging chunks,
   * with clean cancellation and automatic fallback to `aiRewrite`.
   */
  public static aiRewriteStream(
    params: {
      text: string;
      task: AiTaskId;
      surfaceId: SurfaceId;
      subcontext: string | null;
      threadContext?: string;
      domain?: string;
      candidates?: 1 | 2;
      redactSecrets?: boolean | null;
    },
    onChunk: (chunk: StreamChunkPayload) => void,
    signal?: AbortSignal,
  ): Promise<{ ok: true; result: RewriteResult } | { ok: false; error: string }> {
    if (typeof chrome === 'undefined' || typeof chrome.runtime?.connect !== 'function') {
      return this.aiRewrite(params);
    }

    return new Promise((resolve) => {
      let settled = false;
      const port = chrome.runtime.connect({ name: 'lexel-rewrite-stream' });

      const finish = (res: { ok: true; result: RewriteResult } | { ok: false; error: string }) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        try {
          port.disconnect();
        } catch {
          // Port may already be closed.
        }
        resolve(res);
      };

      const onAbort = () => {
        finish({ ok: false, error: 'Rewrite cancelled.' });
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      port.onMessage.addListener((msg: unknown) => {
        const frame = msg as
          | { type: 'chunk'; delta: string; accumulated: string }
          | { type: 'complete'; result: RewriteResult }
          | { type: 'error'; error: string };
        if (!frame || typeof frame !== 'object') return;
        if (frame.type === 'chunk') {
          onChunk({ delta: frame.delta, accumulated: frame.accumulated });
        } else if (frame.type === 'complete') {
          finish({ ok: true, result: frame.result });
        } else if (frame.type === 'error') {
          finish({ ok: false, error: frame.error });
        }
      });

      port.onDisconnect.addListener(() => {
        if (!settled) {
          finish({
            ok: false,
            error: chrome.runtime.lastError?.message ?? 'Rewrite stream closed before completing.',
          });
        }
      });

      port.postMessage({ kind: 'aiRewriteStream', ...params });
    });
  }

  public static async ghostComplete(
    params: GhostCompletionRequest,
  ): Promise<{ ok: true; result: GhostCompletionResponse } | { ok: false; error: string }> {
    return send({ kind: 'ghostComplete', ...params });
  }

  public static async scopeThreadContext(
    source: string,
    threadContext: string,
    maxTokens = 300,
  ): Promise<ScopedThreadContext> {
    const res = await send<{ scoped?: ScopedThreadContext }>({
      kind: 'scopeThreadContext',
      source,
      threadContext,
      maxTokens,
    });
    return (
      res?.scoped ?? {
        scopedText: threadContext.slice(0, maxTokens * 4),
        estimatedTokens: Math.ceil(threadContext.length / 4),
        originalTokens: Math.ceil(threadContext.length / 4),
        truncated: false,
        keptBlocks: 1,
        totalBlocks: 1,
      }
    );
  }

  public static async saveVoiceExample(params: {
    surfaceId: SurfaceId;
    subcontext: string | null;
    original: string;
    rewritten: string;
    action: 'accepted' | 'edited';
  }): Promise<void> {
    await send({ kind: 'saveVoiceExample', example: params });
  }

  public static async setPageSummary(
    summary: Omit<PageLintSummary, 'tabId' | 'updatedAt'>,
  ): Promise<void> {
    await send({ kind: 'setPageSummary', summary });
  }

  public static async setActiveDraft(draft: {
    text: string;
    surfaceId: SurfaceId;
    subcontext: string | null;
  }): Promise<void> {
    await send({ kind: 'setActiveDraft', draft });
  }

  public static async toTitleCase(text: string): Promise<string> {
    const res = await send<{ text: string }>({ kind: 'toTitleCase', text });
    return res?.text ?? text;
  }

  public static async fixSafeIssues(
    text: string,
    surfaceId: SurfaceId,
  ): Promise<{ text: string; fixesApplied: number; categories: string[] }> {
    const res = await send<{
      result: { text: string; fixesApplied: number; categories: string[] };
    }>({ kind: 'fixSafeIssues', text, surfaceId });
    return res?.result ?? { text, fixesApplied: 0, categories: [] };
  }

  public static async fixAllSafe(
    text: string,
    surfaceId: SurfaceId,
  ): Promise<{ text: string; fixesApplied: number; categories: string[] }> {
    const res = await send<{
      result: { text: string; fixesApplied: number; categories: string[] };
    }>({ kind: 'fixAllSafe', text, surfaceId });
    return res?.result ?? { text, fixesApplied: 0, categories: [] };
  }

  public static async toSentenceCase(text: string): Promise<string> {
    const res = await send<{ text: string }>({ kind: 'toSentenceCase', text });
    return res?.text ?? text;
  }

  public static async normalizeTypography(
    text: string,
  ): Promise<{ text: string; fixesApplied: number; categories: string[] }> {
    const res = await send<{
      result: { text: string; fixesApplied: number; categories: string[] };
    }>({ kind: 'normalizeTypography', text });
    return res?.result ?? { text, fixesApplied: 0, categories: [] };
  }

  public static async allowSlopTerm(term: string): Promise<void> {
    await send({ kind: 'allowSlopTerm', term });
  }

  public static async getCustomSurfaces(): Promise<import('../shared/types').SurfaceProfile[]> {
    const res = await send<{ surfaces?: import('../shared/types').SurfaceProfile[] }>({
      kind: 'getCustomSurfaces',
    });
    return res?.surfaces ?? [];
  }

  public static async getCustomSlopConfig(): Promise<{
    customTerms: string[];
    disabledTerms: string[];
  }> {
    const res = await send<{ customTerms?: string[]; disabledTerms?: string[] }>({
      kind: 'getCustomSlopConfig',
    });
    return {
      customTerms: res?.customTerms ?? [],
      disabledTerms: res?.disabledTerms ?? [],
    };
  }

  public static async getSnippets(): Promise<import('../shared/types').TextSnippet[]> {
    const res = await send<{ snippets?: import('../shared/types').TextSnippet[] }>({
      kind: 'getSnippets',
    });
    return res?.snippets ?? [];
  }
}

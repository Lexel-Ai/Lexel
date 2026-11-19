import type { LintOptions } from 'harper.js';
import type { UnpackedLintGroups } from 'lint-framework';
import { LRUCache } from 'lru-cache';
import type { LocalAiHealth } from '../shared/localAiClient';
import { DEFAULT_AI_SETTINGS } from '../shared/storage';
import type {
  ActivationKey,
  AiSettings,
  AiTaskId,
  ExtensionRequest,
  Hotkey,
  LintResponse,
  PageLintSummary,
  RewriteResult,
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

  public static async aiRewrite(params: {
    text: string;
    task: AiTaskId;
    surfaceId: SurfaceId;
    subcontext: string | null;
    threadContext?: string;
    domain?: string;
  }): Promise<{ ok: true; result: RewriteResult } | { ok: false; error: string }> {
    return send({ kind: 'aiRewrite', ...params });
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

  public static async getSnippets(): Promise<import('../shared/types').TextSnippet[]> {
    const res = await send<{ snippets?: import('../shared/types').TextSnippet[] }>({
      kind: 'getSnippets',
    });
    return res?.snippets ?? [];
  }
}

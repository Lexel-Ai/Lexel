import { DEFAULT_PRIVACY_DOMAINS } from './surfaceDetector';
import type { AiSettings, PageLintSummary, SurfaceId, VoiceExample } from './types';

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: true,
  provider: 'ollama',
  endpoint: 'http://127.0.0.1:11434',
  model: 'qwen2.5:1.5b',
  temperature: 0.3,
  maxTokens: 280,
  saveVoiceMemory: true,
};

const KEYS = {
  aiSettings: 'lexel_ai_settings',
  theme: 'lexel_theme',
  voiceExamples: 'lexel_voice_examples',
  privacyBlocklist: 'lexel_privacy_blocklist',
  surfaceOverrides: 'lexel_surface_overrides',
  pageSummaries: 'lexel_page_summaries',
  activeDraft: 'lexel_active_draft',
} as const;

export async function getAiSettings(): Promise<AiSettings> {
  const res = await chrome.storage.local.get({ [KEYS.aiSettings]: DEFAULT_AI_SETTINGS });
  return { ...DEFAULT_AI_SETTINGS, ...(res[KEYS.aiSettings] as Partial<AiSettings>) };
}

export async function setAiSettings(settings: AiSettings): Promise<void> {
  await chrome.storage.local.set({ [KEYS.aiSettings]: settings });
}

export async function getTheme(): Promise<'dark' | 'light'> {
  const res = await chrome.storage.local.get({ [KEYS.theme]: 'dark' });
  return res[KEYS.theme] === 'light' ? 'light' : 'dark';
}

export async function setTheme(theme: 'dark' | 'light'): Promise<void> {
  await chrome.storage.local.set({ [KEYS.theme]: theme });
}

export async function getVoiceExamples(surfaceId?: SurfaceId): Promise<VoiceExample[]> {
  const res = await chrome.storage.local.get({ [KEYS.voiceExamples]: [] as VoiceExample[] });
  const list = (res[KEYS.voiceExamples] as VoiceExample[]) ?? [];
  return surfaceId ? list.filter((item) => item.surfaceId === surfaceId) : list;
}

export async function saveVoiceExample(
  input: Omit<VoiceExample, 'id' | 'createdAt'>,
): Promise<VoiceExample> {
  const existing = await getVoiceExamples();
  const entry: VoiceExample = {
    ...input,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
  };
  const updated = [entry, ...existing].slice(0, 150);
  await chrome.storage.local.set({ [KEYS.voiceExamples]: updated });
  return entry;
}

export async function deleteVoiceExample(id: string): Promise<void> {
  const existing = await getVoiceExamples();
  await chrome.storage.local.set({
    [KEYS.voiceExamples]: existing.filter((item) => item.id !== id),
  });
}

export async function getPrivacyBlocklist(): Promise<string[]> {
  const res = await chrome.storage.local.get({
    [KEYS.privacyBlocklist]: DEFAULT_PRIVACY_DOMAINS,
  });
  return (res[KEYS.privacyBlocklist] as string[]) ?? DEFAULT_PRIVACY_DOMAINS;
}

export async function setPrivacyBlocklist(domains: string[]): Promise<void> {
  const cleaned = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  await chrome.storage.local.set({ [KEYS.privacyBlocklist]: cleaned });
}

export async function getSurfaceOverride(domain: string): Promise<SurfaceId | null> {
  const res = await chrome.storage.local.get({
    [KEYS.surfaceOverrides]: {} as Record<string, SurfaceId>,
  });
  const map = (res[KEYS.surfaceOverrides] as Record<string, SurfaceId>) ?? {};
  return map[domain.toLowerCase()] ?? null;
}

export async function setSurfaceOverride(domain: string, surfaceId: SurfaceId | null): Promise<void> {
  const res = await chrome.storage.local.get({
    [KEYS.surfaceOverrides]: {} as Record<string, SurfaceId>,
  });
  const map = { ...((res[KEYS.surfaceOverrides] as Record<string, SurfaceId>) ?? {}) };
  const key = domain.toLowerCase();
  if (surfaceId) {
    map[key] = surfaceId;
  } else {
    delete map[key];
  }
  await chrome.storage.local.set({ [KEYS.surfaceOverrides]: map });
}

export async function setPageSummary(summary: PageLintSummary): Promise<void> {
  const res = await chrome.storage.local.get({
    [KEYS.pageSummaries]: {} as Record<number, PageLintSummary>,
  });
  const map = { ...((res[KEYS.pageSummaries] as Record<number, PageLintSummary>) ?? {}) };
  map[summary.tabId] = summary;
  await chrome.storage.local.set({ [KEYS.pageSummaries]: map });
}

export async function getPageSummary(tabId: number): Promise<PageLintSummary | null> {
  const res = await chrome.storage.local.get({
    [KEYS.pageSummaries]: {} as Record<number, PageLintSummary>,
  });
  const map = (res[KEYS.pageSummaries] as Record<number, PageLintSummary>) ?? {};
  return map[tabId] ?? null;
}

export async function setActiveDraft(draft: {
  text: string;
  surfaceId: SurfaceId;
  subcontext: string | null;
}): Promise<void> {
  await chrome.storage.local.set({ [KEYS.activeDraft]: draft });
}

export async function getActiveDraft(): Promise<{
  text: string;
  surfaceId: SurfaceId;
  subcontext: string | null;
} | null> {
  const res = await chrome.storage.local.get(KEYS.activeDraft);
  return (
    (res[KEYS.activeDraft] as {
      text: string;
      surfaceId: SurfaceId;
      subcontext: string | null;
    } | null) ?? null
  );
}

import { inferTierFromModelName, resolveModelNameForTier } from './models';
import { DEFAULT_PRIVACY_DOMAINS } from './surfaceDetector';
import type {
  AiSettings,
  LintLanguage,
  PageLintSummary,
  StoredWeirpack,
  StyleGuideRule,
  SurfaceId,
  SurfaceProfile,
  TextSnippet,
  UnifiedDaemonSettings,
  VoiceExample,
} from './types';

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: true,
  mainModelTier: 'lexel-1.5b',
  runtime: 'auto',
  provider: 'ollama',
  endpoint: 'http://127.0.0.1:11434',
  openAiCompatEndpoint: 'http://127.0.0.1:8080',
  model: 'qwen2.5:1.5b',
  temperature: 0.3,
  maxTokens: 280,
  idleUnloadSecs: 180,
  keepWarm: false,
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
  languageMode: 'lexel_language_mode',
  customSlopTerms: 'lexel_custom_slop_terms',
  disabledSlopTerms: 'lexel_disabled_slop_terms',
  customSurfaces: 'lexel_custom_surfaces',
  weirpacks: 'lexel_weirpacks',
  styleGuide: 'lexel_style_guide',
  snippets: 'lexel_snippets',
} as const;

const DOMAIN_KEY_PREFIX = 'domainStatus ';

export function normalizeAiSettings(partial?: Partial<AiSettings>): AiSettings {
  const merged = { ...DEFAULT_AI_SETTINGS, ...(partial ?? {}) };
  if (!partial?.mainModelTier && partial?.model) {
    merged.mainModelTier = inferTierFromModelName(partial.model);
  }
  if (merged.mainModelTier !== 'custom') {
    merged.model = resolveModelNameForTier(merged.mainModelTier, merged.model);
  }
  return merged;
}

export async function getAiSettings(): Promise<AiSettings> {
  const res = await chrome.storage.local.get({ [KEYS.aiSettings]: DEFAULT_AI_SETTINGS });
  return normalizeAiSettings(res[KEYS.aiSettings] as Partial<AiSettings>);
}

export async function setAiSettings(settings: AiSettings): Promise<void> {
  await chrome.storage.local.set({ [KEYS.aiSettings]: normalizeAiSettings(settings) });
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

export async function getAllSurfaceOverrides(): Promise<Record<string, SurfaceId>> {
  const res = await chrome.storage.local.get({
    [KEYS.surfaceOverrides]: {} as Record<string, SurfaceId>,
  });
  return (res[KEYS.surfaceOverrides] as Record<string, SurfaceId>) ?? {};
}

export async function getSurfaceOverride(domain: string): Promise<SurfaceId | null> {
  const map = await getAllSurfaceOverrides();
  return map[domain.toLowerCase()] ?? null;
}

export async function setSurfaceOverride(
  domain: string,
  surfaceId: SurfaceId | null,
): Promise<void> {
  const map = { ...(await getAllSurfaceOverrides()) };
  const key = domain.toLowerCase();
  if (surfaceId) {
    map[key] = surfaceId;
  } else {
    delete map[key];
  }
  await chrome.storage.local.set({ [KEYS.surfaceOverrides]: map });
}

export async function getAllDomainStatuses(): Promise<Record<string, boolean>> {
  const all = await chrome.storage.local.get(null);
  const map: Record<string, boolean> = {};
  for (const [key, val] of Object.entries(all)) {
    if (key.startsWith(DOMAIN_KEY_PREFIX) && typeof val === 'boolean') {
      map[key.slice(DOMAIN_KEY_PREFIX.length)] = val;
    }
  }
  return map;
}

export async function applyUnifiedSettingsToStorage(
  settings: UnifiedDaemonSettings,
): Promise<void> {
  const currentAll = await chrome.storage.local.get(null);
  const keysToRemove = Object.keys(currentAll).filter((k) => k.startsWith(DOMAIN_KEY_PREFIX));
  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }

  const aiSettings: AiSettings = {
    enabled: settings.aiEnabled,
    mainModelTier: settings.mainModelTier,
    runtime: settings.runtime,
    provider: settings.runtime === 'openai_compat' ? 'openai_compat' : 'ollama',
    endpoint:
      settings.runtime === 'openai_compat'
        ? settings.openaiCompatEndpoint
        : settings.ollamaEndpoint,
    openAiCompatEndpoint: settings.openaiCompatEndpoint,
    model: resolveModelNameForTier(settings.mainModelTier, settings.customModel),
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    idleUnloadSecs: settings.idleUnloadSecs,
    keepWarm: settings.keepWarm,
    saveVoiceMemory: settings.saveVoiceMemory,
  };

  const payload: Record<string, unknown> = {
    [KEYS.theme]: settings.theme === 'light' ? 'light' : 'dark',
    [KEYS.aiSettings]: aiSettings,
    [KEYS.privacyBlocklist]: settings.privacyBlocklist,
    [KEYS.surfaceOverrides]: settings.surfaceOverrides,
    dialect: settings.dialect,
    isolateEnglish: settings.isolateEnglish,
    openSuggestionsOnHover: settings.openSuggestionsOnHover,
    activationKey: settings.activationKey,
    delay: settings.lintDelayMs,
    defaultEnable: settings.defaultEnable !== false,
    userDictionary: settings.userDictionary,
    ignoredLints: settings.ignoredLints,
    lintConfig: JSON.stringify(settings.lintConfig ?? {}),
    [KEYS.languageMode]: settings.languageMode ?? 'plaintext',
    [KEYS.customSlopTerms]: settings.customSlopTerms ?? [],
    [KEYS.disabledSlopTerms]: settings.disabledSlopTerms ?? [],
    [KEYS.customSurfaces]: settings.customSurfaces ?? [],
    [KEYS.weirpacks]: settings.weirpacks ?? [],
    [KEYS.styleGuide]: settings.styleGuide ?? [],
    [KEYS.snippets]: settings.snippets ?? [],
  };

  if (settings.hotkey) {
    payload.hotkey = settings.hotkey;
  }

  for (const [domain, enabled] of Object.entries(settings.domainStatuses ?? {})) {
    payload[`${DOMAIN_KEY_PREFIX}${domain.toLowerCase()}`] = enabled;
  }

  await chrome.storage.local.set(payload);
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

export async function getLanguageMode(): Promise<LintLanguage> {
  const res = await chrome.storage.local.get({ [KEYS.languageMode]: 'plaintext' });
  const v = res[KEYS.languageMode];
  return v === 'markdown' || v === 'typst' ? v : 'plaintext';
}

export async function setLanguageMode(language: LintLanguage): Promise<void> {
  await chrome.storage.local.set({ [KEYS.languageMode]: language });
}

export async function getCustomSlopConfig(): Promise<{
  customTerms: string[];
  disabledTerms: string[];
}> {
  const res = await chrome.storage.local.get({
    [KEYS.customSlopTerms]: [] as string[],
    [KEYS.disabledSlopTerms]: [] as string[],
  });
  return {
    customTerms: Array.isArray(res[KEYS.customSlopTerms])
      ? (res[KEYS.customSlopTerms] as string[])
      : [],
    disabledTerms: Array.isArray(res[KEYS.disabledSlopTerms])
      ? (res[KEYS.disabledSlopTerms] as string[])
      : [],
  };
}

export async function setCustomSlopConfig(
  customTerms: string[],
  disabledTerms: string[],
): Promise<void> {
  await chrome.storage.local.set({
    [KEYS.customSlopTerms]: [...new Set(customTerms.map((t) => t.trim()).filter(Boolean))],
    [KEYS.disabledSlopTerms]: [...new Set(disabledTerms.map((t) => t.trim()).filter(Boolean))],
  });
}

export async function getCustomSurfaces(): Promise<SurfaceProfile[]> {
  const res = await chrome.storage.local.get({ [KEYS.customSurfaces]: [] as SurfaceProfile[] });
  return Array.isArray(res[KEYS.customSurfaces])
    ? (res[KEYS.customSurfaces] as SurfaceProfile[])
    : [];
}

export async function setCustomSurfaces(surfaces: SurfaceProfile[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.customSurfaces]: surfaces });
}

export async function getStoredWeirpacks(): Promise<StoredWeirpack[]> {
  const res = await chrome.storage.local.get({ [KEYS.weirpacks]: [] as StoredWeirpack[] });
  return Array.isArray(res[KEYS.weirpacks]) ? (res[KEYS.weirpacks] as StoredWeirpack[]) : [];
}

export async function setStoredWeirpacks(packs: StoredWeirpack[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.weirpacks]: packs });
}

export async function getStyleGuide(): Promise<StyleGuideRule[]> {
  const res = await chrome.storage.local.get({ [KEYS.styleGuide]: [] as StyleGuideRule[] });
  return Array.isArray(res[KEYS.styleGuide]) ? (res[KEYS.styleGuide] as StyleGuideRule[]) : [];
}

export async function setStyleGuide(rules: StyleGuideRule[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.styleGuide]: rules });
}

export async function getSnippets(): Promise<TextSnippet[]> {
  const res = await chrome.storage.local.get({ [KEYS.snippets]: [] as TextSnippet[] });
  return Array.isArray(res[KEYS.snippets]) ? (res[KEYS.snippets] as TextSnippet[]) : [];
}

export async function setSnippets(snippets: TextSnippet[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.snippets]: snippets });
}

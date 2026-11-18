import { Dialect } from 'harper.js';
import { inferTierFromModelName, resolveModelNameForTier } from './models';
import type {
  AiSettings,
  DaemonConnectionConfig,
  DaemonProfile,
  LabSettingsState,
  SurfaceId,
  UnifiedDaemonSettings,
  VoiceExample,
} from './types';

const STORAGE_KEY = 'lexel_lab_state_v1';

export const DEFAULT_DAEMON_CONNECTION: DaemonConnectionConfig = {
  enabled: true,
  endpoint: 'http://127.0.0.1:42424',
  token: '',
};

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

export const DEFAULT_LAB_DRAFT =
  'In todays fast-paced landscape, I wanted to delve into why our Rust service is seamlessly leveraging tokio for 42ms p99 latency — its truly a game-changer! Check https://example.com #rust 🚀';

const DEFAULT_PRIVACY_DOMAINS = [
  '1password.com',
  'bitwarden.com',
  'accounts.google.com',
  'chase.com',
  'bankofamerica.com',
  'paypal.com',
  'stripe.com',
];

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

export function createDefaultLabState(): LabSettingsState {
  return {
    theme: 'dark',
    surfaceId: 'web_reddit',
    subcontext: 'r/rust',
    dialect: Dialect.American,
    isolateEnglish: false,
    openSuggestionsOnHover: true,
    activationKey: 'off',
    delayMs: 0,
    defaultEnable: true,
    lintConfig: {},
    ignoredLints: '',
    userDictionary: [],
    privacyBlocklist: [...DEFAULT_PRIVACY_DOMAINS],
    domainStatuses: {},
    surfaceOverrides: {},
    languageMode: 'plaintext',
    customSlopTerms: [],
    disabledSlopTerms: [],
    customSurfaces: [],
    weirpacks: [],
    aiSettings: { ...DEFAULT_AI_SETTINGS },
    daemonConnection: { ...DEFAULT_DAEMON_CONNECTION },
    voiceExamples: [],
    draftText: DEFAULT_LAB_DRAFT,
    threadContext: '',
  };
}

export function loadLabState(): LabSettingsState {
  const defaults = createDefaultLabState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<LabSettingsState>;
    return {
      ...defaults,
      ...parsed,
      aiSettings: normalizeAiSettings(parsed.aiSettings),
      daemonConnection: {
        ...DEFAULT_DAEMON_CONNECTION,
        ...(parsed.daemonConnection ?? {}),
      },
      lintConfig:
        parsed.lintConfig && typeof parsed.lintConfig === 'object' ? parsed.lintConfig : {},
      userDictionary: Array.isArray(parsed.userDictionary) ? parsed.userDictionary : [],
      privacyBlocklist: Array.isArray(parsed.privacyBlocklist)
        ? parsed.privacyBlocklist
        : defaults.privacyBlocklist,
      domainStatuses:
        parsed.domainStatuses && typeof parsed.domainStatuses === 'object'
          ? parsed.domainStatuses
          : {},
      surfaceOverrides:
        parsed.surfaceOverrides && typeof parsed.surfaceOverrides === 'object'
          ? parsed.surfaceOverrides
          : {},
      languageMode:
        parsed.languageMode === 'markdown' || parsed.languageMode === 'typst'
          ? parsed.languageMode
          : 'plaintext',
      customSlopTerms: Array.isArray(parsed.customSlopTerms) ? parsed.customSlopTerms : [],
      disabledSlopTerms: Array.isArray(parsed.disabledSlopTerms) ? parsed.disabledSlopTerms : [],
      customSurfaces: Array.isArray(parsed.customSurfaces) ? parsed.customSurfaces : [],
      weirpacks: Array.isArray(parsed.weirpacks) ? parsed.weirpacks : [],
      voiceExamples: Array.isArray(parsed.voiceExamples) ? parsed.voiceExamples : [],
    };
  } catch {
    return defaults;
  }
}

export function saveLabState(state: LabSettingsState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage quota issues in restricted browsing contexts.
  }
}

export function clearLabState(): LabSettingsState {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore
  }
  return createDefaultLabState();
}

export function createVoiceExampleEntry(
  input: Omit<VoiceExample, 'id' | 'createdAt'>,
): VoiceExample {
  return {
    ...input,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
  };
}

export function applyDaemonProfileToLabState(
  prev: LabSettingsState,
  profile: DaemonProfile,
  voiceExamples?: VoiceExample[],
): LabSettingsState {
  const s = profile.settings;
  const effectiveModel = resolveModelNameForTier(s.mainModelTier, s.customModel);
  return {
    ...prev,
    theme: s.theme === 'light' ? 'light' : 'dark',
    dialect: s.dialect as Dialect,
    isolateEnglish: s.isolateEnglish,
    openSuggestionsOnHover: s.openSuggestionsOnHover,
    activationKey: s.activationKey,
    delayMs: s.lintDelayMs,
    defaultEnable: s.defaultEnable !== false,
    lintConfig: s.lintConfig ?? {},
    ignoredLints: s.ignoredLints ?? '',
    userDictionary: s.userDictionary ?? [],
    privacyBlocklist: s.privacyBlocklist ?? [],
    domainStatuses: s.domainStatuses ?? {},
    surfaceOverrides: s.surfaceOverrides ?? {},
    languageMode:
      s.languageMode === 'markdown' || s.languageMode === 'typst'
        ? s.languageMode
        : prev.languageMode,
    customSlopTerms: s.customSlopTerms ?? prev.customSlopTerms,
    disabledSlopTerms: s.disabledSlopTerms ?? prev.disabledSlopTerms,
    customSurfaces: s.customSurfaces ?? prev.customSurfaces,
    aiSettings: {
      enabled: s.aiEnabled,
      mainModelTier: s.mainModelTier,
      runtime: s.runtime,
      provider: s.runtime === 'openai_compat' ? 'openai_compat' : 'ollama',
      endpoint: s.runtime === 'openai_compat' ? s.openaiCompatEndpoint : s.ollamaEndpoint,
      openAiCompatEndpoint: s.openaiCompatEndpoint,
      model: effectiveModel,
      temperature: s.temperature,
      maxTokens: s.maxTokens,
      idleUnloadSecs: s.idleUnloadSecs,
      keepWarm: s.keepWarm,
      saveVoiceMemory: s.saveVoiceMemory,
    },
    voiceExamples: voiceExamples ?? prev.voiceExamples,
  };
}

export function labStateToDaemonPatch(state: LabSettingsState): Partial<UnifiedDaemonSettings> {
  return {
    theme: state.theme,
    aiEnabled: state.aiSettings.enabled,
    mainModelTier: state.aiSettings.mainModelTier,
    customModel: state.aiSettings.model,
    runtime: state.aiSettings.runtime,
    ollamaEndpoint:
      state.aiSettings.provider === 'ollama'
        ? state.aiSettings.endpoint
        : 'http://127.0.0.1:11434',
    openaiCompatEndpoint:
      state.aiSettings.provider === 'openai_compat'
        ? state.aiSettings.endpoint
        : state.aiSettings.openAiCompatEndpoint,
    temperature: state.aiSettings.temperature,
    maxTokens: state.aiSettings.maxTokens,
    idleUnloadSecs: state.aiSettings.idleUnloadSecs,
    keepWarm: state.aiSettings.keepWarm,
    saveVoiceMemory: state.aiSettings.saveVoiceMemory,
    dialect: state.dialect,
    isolateEnglish: state.isolateEnglish,
    openSuggestionsOnHover: state.openSuggestionsOnHover,
    activationKey: state.activationKey,
    lintDelayMs: state.delayMs,
    defaultEnable: state.defaultEnable,
    lintConfig: state.lintConfig as Record<string, boolean | null>,
    userDictionary: state.userDictionary,
    ignoredLints: state.ignoredLints,
    privacyBlocklist: state.privacyBlocklist,
    domainStatuses: state.domainStatuses,
    surfaceOverrides: state.surfaceOverrides,
    languageMode: state.languageMode,
    customSlopTerms: state.customSlopTerms,
    disabledSlopTerms: state.disabledSlopTerms,
    customSurfaces: state.customSurfaces,
  };
}

export function parseImportedLabState(jsonText: string): LabSettingsState {
  const defaults = createDefaultLabState();
  const parsed = JSON.parse(jsonText) as Partial<LabSettingsState>;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid JSON backup file.');
  }
  const validSurfaces = new Set<SurfaceId>([
    'web_reddit',
    'web_x',
    'web_github_pr',
    'web_linkedin',
    'web_discord_slack',
    'web_email',
    'general',
  ]);
  const customIds = new Set((parsed.customSurfaces ?? []).map((s) => s.id));
  return {
    ...defaults,
    ...parsed,
    surfaceId:
      parsed.surfaceId && (validSurfaces.has(parsed.surfaceId) || customIds.has(parsed.surfaceId))
        ? parsed.surfaceId
        : defaults.surfaceId,
    aiSettings: normalizeAiSettings(parsed.aiSettings),
    daemonConnection: {
      ...DEFAULT_DAEMON_CONNECTION,
      ...(parsed.daemonConnection ?? {}),
    },
    lintConfig:
      parsed.lintConfig && typeof parsed.lintConfig === 'object' ? parsed.lintConfig : {},
    userDictionary: Array.isArray(parsed.userDictionary) ? parsed.userDictionary : [],
    privacyBlocklist: Array.isArray(parsed.privacyBlocklist)
      ? parsed.privacyBlocklist
      : defaults.privacyBlocklist,
    domainStatuses:
      parsed.domainStatuses && typeof parsed.domainStatuses === 'object'
        ? parsed.domainStatuses
        : {},
    surfaceOverrides:
      parsed.surfaceOverrides && typeof parsed.surfaceOverrides === 'object'
        ? parsed.surfaceOverrides
        : {},
    languageMode:
      parsed.languageMode === 'markdown' || parsed.languageMode === 'typst'
        ? parsed.languageMode
        : 'plaintext',
    customSlopTerms: Array.isArray(parsed.customSlopTerms) ? parsed.customSlopTerms : [],
    disabledSlopTerms: Array.isArray(parsed.disabledSlopTerms) ? parsed.disabledSlopTerms : [],
    customSurfaces: Array.isArray(parsed.customSurfaces) ? parsed.customSurfaces : [],
    weirpacks: Array.isArray(parsed.weirpacks) ? parsed.weirpacks : [],
    voiceExamples: Array.isArray(parsed.voiceExamples) ? parsed.voiceExamples : [],
  };
}

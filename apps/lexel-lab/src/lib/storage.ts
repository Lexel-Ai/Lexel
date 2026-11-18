import { Dialect } from 'harper.js';
import type { AiSettings, LabSettingsState, SurfaceId, VoiceExample } from './types';

const STORAGE_KEY = 'lexel_lab_state_v1';

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: true,
  provider: 'ollama',
  endpoint: 'http://127.0.0.1:11434',
  model: 'qwen2.5:1.5b',
  temperature: 0.3,
  maxTokens: 280,
  saveVoiceMemory: true,
};

export const DEFAULT_LAB_DRAFT =
  'In todays fast-paced landscape, I wanted to delve into why our Rust service is seamlessly leveraging tokio for 42ms p99 latency — its truly a game-changer! Check https://example.com #rust 🚀';

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
    lintConfig: {},
    ignoredLints: '',
    userDictionary: [],
    aiSettings: { ...DEFAULT_AI_SETTINGS },
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
      aiSettings: { ...DEFAULT_AI_SETTINGS, ...(parsed.aiSettings ?? {}) },
      lintConfig: parsed.lintConfig && typeof parsed.lintConfig === 'object' ? parsed.lintConfig : {},
      userDictionary: Array.isArray(parsed.userDictionary) ? parsed.userDictionary : [],
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
  return {
    ...defaults,
    ...parsed,
    surfaceId: parsed.surfaceId && validSurfaces.has(parsed.surfaceId) ? parsed.surfaceId : defaults.surfaceId,
    aiSettings: { ...DEFAULT_AI_SETTINGS, ...(parsed.aiSettings ?? {}) },
    lintConfig: parsed.lintConfig && typeof parsed.lintConfig === 'object' ? parsed.lintConfig : {},
    userDictionary: Array.isArray(parsed.userDictionary) ? parsed.userDictionary : [],
    voiceExamples: Array.isArray(parsed.voiceExamples) ? parsed.voiceExamples : [],
  };
}

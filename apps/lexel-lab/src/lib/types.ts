import type { Dialect, LintConfig } from 'harper.js';
import type {
  AiTaskId,
  BuiltinSurfaceId,
  GateCheckSummary,
  QuickActionDef,
  RulePresetId,
  SurfaceId,
  SurfaceProfile,
} from 'lexel-ui';
import type { MainModelTier, RuntimeKind } from './models';

export type {
  AiTaskId,
  BuiltinSurfaceId,
  QuickActionDef,
  RulePresetId,
  SurfaceId,
  SurfaceProfile,
};

export type LintLanguage = 'plaintext' | 'markdown' | 'typst';

export interface StoredWeirpack {
  name: string;
  bytesBase64: string;
  ruleCount: number;
  enabled: boolean;
}

export type ActivationKey = 'off' | 'shift' | 'control';
export type AiProviderKind = 'ollama' | 'openai_compat';

export type { MainModelTier, RuntimeKind };

export interface DaemonConnectionConfig {
  enabled: boolean;
  endpoint: string;
  token: string;
}

export interface InstalledModelStatus {
  id: string;
  tier: string;
  label: string;
  description: string;
  ollamaTag: string;
  ggufFilename: string;
  ggufPath: string;
  ggufInstalled: boolean;
  ggufSizeValid: boolean;
  ollamaInstalled: boolean;
  approxRamMb: number;
  sizeBytes: number;
}

export interface DaemonRuntimeSnapshot {
  activeBackend: string;
  modelLoaded: boolean;
  loadedModel: string | null;
  llamaServerAvailable: boolean;
  ollamaBinaryAvailable: boolean;
  ollamaRunning: boolean;
  ollamaModels: string[];
  lastError: string | null;
}

export interface UnifiedDaemonSettings {
  theme: 'dark' | 'light';
  aiEnabled: boolean;
  mainModelTier: MainModelTier;
  customModel: string;
  runtime: RuntimeKind;
  ollamaEndpoint: string;
  openaiCompatEndpoint: string;
  temperature: number;
  maxTokens: number;
  idleUnloadSecs: number;
  keepWarm: boolean;
  saveVoiceMemory: boolean;
  dialect: number;
  isolateEnglish: boolean;
  openSuggestionsOnHover: boolean;
  activationKey: ActivationKey;
  lintDelayMs: number;
  defaultEnable?: boolean;
  lintConfig: Record<string, boolean | null>;
  userDictionary: string[];
  ignoredLints: string;
  privacyBlocklist: string[];
  domainStatuses: Record<string, boolean>;
  surfaceOverrides: Record<string, string>;
  languageMode?: LintLanguage;
  customSlopTerms?: string[];
  disabledSlopTerms?: string[];
  customSurfaces?: SurfaceProfile[];
}

export interface DaemonProfile {
  id: string;
  name: string;
  isActive: boolean;
  settings: UnifiedDaemonSettings;
  createdAt: number;
  updatedAt: number;
}

export interface DaemonStatusPayload {
  version: string;
  daemonRunning: boolean;
  httpPort: number;
  dataDir: string;
  modelsDir: string;
  activeProfile: DaemonProfile;
  profiles: DaemonProfile[];
  runtime: DaemonRuntimeSnapshot;
  models: InstalledModelStatus[];
}

export interface AiSettings {
  enabled: boolean;
  mainModelTier: MainModelTier;
  runtime: RuntimeKind;
  provider: AiProviderKind;
  endpoint: string;
  openAiCompatEndpoint: string;
  model: string;
  temperature: number;
  maxTokens: number;
  idleUnloadSecs: number;
  keepWarm: boolean;
  saveVoiceMemory: boolean;
}

export interface VoiceExample {
  id: string;
  surfaceId: SurfaceId;
  subcontext: string | null;
  original: string;
  rewritten: string;
  action: 'accepted' | 'edited';
  createdAt: number;
}

export interface RewriteResult {
  original: string;
  suggestion: string;
  model: string;
  latencyMs: number;
  gates: GateCheckSummary;
  surfaceId: SurfaceId;
  subcontext: string | null;
}

export interface LabSettingsState {
  theme: 'dark' | 'light';
  surfaceId: SurfaceId;
  subcontext: string;
  dialect: Dialect;
  isolateEnglish: boolean;
  openSuggestionsOnHover: boolean;
  activationKey: ActivationKey;
  delayMs: number;
  defaultEnable: boolean;
  lintConfig: LintConfig;
  ignoredLints: string;
  userDictionary: string[];
  privacyBlocklist: string[];
  domainStatuses: Record<string, boolean>;
  surfaceOverrides: Record<string, string>;
  languageMode: LintLanguage;
  customSlopTerms: string[];
  disabledSlopTerms: string[];
  customSurfaces: SurfaceProfile[];
  weirpacks: StoredWeirpack[];
  aiSettings: AiSettings;
  daemonConnection: DaemonConnectionConfig;
  voiceExamples: VoiceExample[];
  draftText: string;
  threadContext: string;
}

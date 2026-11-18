import type { Dialect, LintConfig } from 'harper.js';
import type { GateCheckSummary } from 'lexel-ui';
import type { MainModelTier, RuntimeKind } from './models';

export type BuiltinSurfaceId =
  | 'web_reddit'
  | 'web_x'
  | 'web_github_pr'
  | 'web_linkedin'
  | 'web_discord_slack'
  | 'web_email'
  | 'general';

export type SurfaceId = BuiltinSurfaceId | (string & {});

export type LintLanguage = 'plaintext' | 'markdown' | 'typst';

export interface StoredWeirpack {
  name: string;
  bytesBase64: string;
  ruleCount: number;
  enabled: boolean;
}

export type AiTaskId =
  | 'fix_grammar_flow'
  | 'deslop'
  | 'rewrite_surface'
  | 'shorten'
  | 'reply_draft';

export type ActivationKey = 'off' | 'shift' | 'control';
export type AiProviderKind = 'ollama' | 'openai_compat';

export type { MainModelTier, RuntimeKind };

export interface QuickActionDef {
  id: AiTaskId;
  label: string;
}

export interface SurfaceProfile {
  id: SurfaceId;
  label: string;
  hostPatterns: string[];
  pathRegex?: string;
  register: string;
  minChars: number;
  maxChars: number;
  allowLinks: boolean;
  allowEmojis: boolean;
  allowHashtags: boolean;
  allowEmDashes: boolean;
  bannedOpeners: string[];
  promptDirective: string;
  quickActions: QuickActionDef[];
}

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

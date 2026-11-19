import type { AiTaskId, GateCheckSummary, RulePresetId, SurfaceProfile } from 'lexel-ui';

export type MainModelTier = 'lexel-0.5b' | 'lexel-1.5b' | 'custom';
export type RuntimeKind = 'auto' | 'llama_server' | 'ollama' | 'openai_compat';

export interface Hotkey {
  modifiers: Array<'Ctrl' | 'Shift' | 'Alt'>;
  key: string;
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
  activationKey: 'off' | 'shift' | 'control';
  lintDelayMs: number;
  defaultEnable: boolean;
  hotkey?: Hotkey;
  lintConfig: Record<string, boolean | null>;
  userDictionary: string[];
  ignoredLints: string;
  privacyBlocklist: string[];
  domainStatuses: Record<string, boolean>;
  surfaceOverrides: Record<string, string>;
  languageMode: 'plaintext' | 'markdown' | 'typst';
  customSlopTerms: string[];
  disabledSlopTerms: string[];
  customSurfaces: SurfaceProfile[];
}

export interface DaemonProfile {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  settings: UnifiedDaemonSettings;
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

export interface ToggleAiResponse {
  activeProfile: DaemonProfile;
  activated: boolean;
  activationError: string | null;
  runtime: DaemonRuntimeSnapshot;
}

export interface HarperRuleInfo {
  id: string;
  description: string;
  defaultEnabled: boolean;
  enabled: boolean;
}

export interface HarperRulesPayload {
  rules: HarperRuleInfo[];
  lintConfig: Record<string, boolean | null>;
  dialect: number;
  isolateEnglish: boolean;
}

export interface HarperDiagnosticItem {
  rule: string;
  lintKind: string;
  message: string;
  problemText: string;
  start: number;
  end: number;
  suggestions: string[];
}

export interface RustSlopHit {
  term: string;
  start: number;
  end: number;
  isEmDash: boolean;
  suggestion?: string | null;
}

export interface RustSurfaceViolation {
  kind: string;
  message: string;
  start: number;
  end: number;
}

export interface RustSecretMatch {
  kind: string;
  label: string;
  start: number;
  end: number;
  maskedPreview: string;
}

export interface Tier0CheckResponse {
  harper: HarperDiagnosticItem[];
  slop: RustSlopHit[];
  surface: RustSurfaceViolation[];
  secrets: RustSecretMatch[];
  safeFixedText: string;
  safeFixesCount: number;
  blocked: boolean;
}

export interface RewriteResponse {
  original: string;
  suggestion: string;
  model: string;
  latencyMs: number;
  gates: GateCheckSummary;
  surfaceId: string;
  subcontext: string | null;
}

export interface VoiceExample {
  id: string;
  surfaceId: string;
  subcontext: string | null;
  original: string;
  rewritten: string;
  action: string;
  createdAt: number;
}

export interface DesktopEnvInfo {
  platform: string;
  arch: string;
  dataDir: string;
  dbPath: string;
  modelsDir: string;
  daemonBin: string | null;
}

export interface NativeHostTargetStatus {
  browser: string;
  manifestPath: string;
  installed: boolean;
}

export interface NativeHostStatusReport {
  hostName: string;
  daemonBin: string | null;
  targets: NativeHostTargetStatus[];
}

export interface NativeHostInstallReport {
  daemonBin: string;
  writtenManifests: string[];
}

export interface DownloadModelReport {
  id: string;
  ggufPath: string;
  bytesDownloaded: number;
  sha256: string;
  verified: boolean;
  alreadyPresent: boolean;
}

export interface DownloadProgress {
  modelId: string;
  bytesDownloaded: number;
  totalBytes: number;
  percent: number;
}

export type DesktopTabId = 'studio' | 'surfaces' | 'rules' | 'system';

export type { AiTaskId, RulePresetId };

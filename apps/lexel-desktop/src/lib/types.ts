import type {
  AiTaskId,
  DoctorReportData,
  GateCheckSummary,
  InvisibleCharHit,
  RewriteCandidate,
  RulePresetId,
  StructureIssue,
  StyleGuideHit,
  StyleGuideRule,
  SurfaceProfile,
  TextSnippet,
  TonePillId,
} from 'lexel-ui';

export type MainModelTier = 'lexel-0.5b' | 'lexel-1.5b' | 'custom';
export type RuntimeKind = 'auto' | 'llama_server' | 'ollama' | 'openai_compat';

export interface Hotkey {
  modifiers: Array<'Ctrl' | 'Shift' | 'Alt'>;
  key: string;
}

export interface StoredWeirpack {
  name: string;
  bytesBase64: string;
  ruleCount: number;
  enabled: boolean;
}

export interface ExtendedTextSnippet extends TextSnippet {
  surfaceId?: string | null;
  adaptToSurface?: boolean;
  category?: string;
  builtIn?: boolean;
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
  weirpacks?: StoredWeirpack[];
  styleGuide?: StyleGuideRule[];
  snippets?: ExtendedTextSnippet[];
  redactSecrets?: boolean;
  ghostTextEnabled?: boolean;
  crutchWords?: string[];
  whisperModelPath?: string;
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

export interface ConsistencyIssue {
  kind: string;
  message: string;
  variants: string[];
  preferred?: string;
}

export interface GuardWarning {
  kind: 'bluf' | 'wall_of_text' | 'regret' | 'missing_attachment' | 'crutch' | string;
  message: string;
  problemText?: string;
  suggestedAction?: TonePillId;
}

export interface Tier0SlopMeterPayload {
  score: number;
  clicheCount: number;
  emDashCount: number;
  fillerOpenerCount: number;
  flatRhythm: boolean;
}

export interface Tier0CheckResponse {
  harper: HarperDiagnosticItem[];
  slop: RustSlopHit[];
  surface: RustSurfaceViolation[];
  secrets: RustSecretMatch[];
  invisibleChars?: InvisibleCharHit[];
  structure?: StructureIssue[];
  styleGuide?: StyleGuideHit[];
  consistency?: ConsistencyIssue[];
  guards?: GuardWarning[];
  slopMeter?: Tier0SlopMeterPayload;
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
  fastPath?: boolean;
  retried?: boolean;
  failedConstraints?: string[];
  candidates?: RewriteCandidate[];
  redactedCount?: number;
  restoredCleanly?: boolean;
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

export interface WritingStatsSummary {
  totalChecks: number;
  totalWordsChecked: number;
  totalGrammarHits: number;
  totalSlopHits: number;
  totalSecretBlocks: number;
  totalFixesApplied: number;
  topSurfaces: Array<[string, number]>;
}

export interface CrutchWordStat {
  word: string;
  count: number;
  banned: boolean;
}

export interface SlopPatternStat {
  term: string;
  count: number;
}

export interface DailyInsightBucket {
  day: string;
  checks: number;
  words: number;
  slopHits: number;
  grammarHits: number;
  fixesApplied: number;
}

export interface WeeklyInsightsReport {
  periodDays: number;
  checksInPeriod: number;
  wordsInPeriod: number;
  slopCaughtInPeriod: number;
  grammarHitsInPeriod: number;
  secretsBlockedInPeriod: number;
  fixesAppliedInPeriod: number;
  clarityScore: number | null;
  clarityDelta: number | null;
  concisenessScore: number | null;
  concisenessDelta: number | null;
  topCrutchWords: CrutchWordStat[];
  bannedCrutchWords: string[];
  topSlopPatterns: SlopPatternStat[];
  dailyBuckets: DailyInsightBucket[];
  voiceExamplesCount: number;
}

export interface DraftSnapshot {
  id: string;
  profileId: string;
  surfaceId: string;
  title: string;
  content: string;
  wordCount: number;
  createdAt: number;
}

export interface ClipboardPolishReport {
  original: string;
  polished: string;
  fixesApplied: number;
  secretsBlocked: number;
  categories: string[];
}

export interface RewriteBeforePasteReport {
  original: string;
  rewritten: string;
  surfaceId: string;
  detectedApp: string | null;
  usedAi: boolean;
  pastedAutomatically: boolean;
  secretsBlocked: number;
  fixesApplied: number;
  note: string;
}

export interface ActiveWindowSurface {
  appName: string | null;
  windowTitle: string | null;
  detectedSurfaceId: string;
  supported: boolean;
  note: string;
}

export interface OsOverlayCapabilities {
  platform: string;
  globalShortcut: string;
  rewriteBeforePasteShortcut?: string;
  clipboardPolishReady: boolean;
  activeWindowDetectionSupported?: boolean;
  nativeOverlayMode: string;
  notes: string;
}

export interface RedactPreviewResponse {
  redactedText: string;
  redactedCount: number;
  placeholders: Array<{
    placeholder: string;
    kind: string;
    label: string;
    maskedPreview: string;
  }>;
}

export interface ExpandSnippetResponse {
  trigger: string;
  rawExpansion: string;
  expandedText: string;
  surfaceId: string;
  adaptedWithAi: boolean;
  latencyMs: number;
}

export interface TranscribeResponse {
  rawTranscript: string;
  cleanedText: string;
  rewritten: RewriteResponse | null;
  latencyMs: number;
  whisperModel: string;
}

export interface GitVoiceImportReport {
  importedCount: number;
  skippedSecretsCount: number;
  repoPath: string;
  samples: Array<{ surfaceId: string; text: string }>;
}

export type DesktopTabId = 'studio' | 'insights' | 'surfaces' | 'rules' | 'system';

export type {
  AiTaskId,
  DoctorReportData,
  InvisibleCharHit,
  RewriteCandidate,
  RulePresetId,
  StructureIssue,
  StyleGuideHit,
  StyleGuideRule,
  TextSnippet,
  TonePillId,
};

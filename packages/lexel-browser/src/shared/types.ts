import type { Dialect, LintConfig } from 'harper.js';
import type {
  AiTaskId as BaseAiTaskId,
  GateCheckSummary as BaseGateCheckSummary,
  TextSnippet as BaseTextSnippet,
  BuiltinSurfaceId,
  QuickActionDef,
  RulePresetId,
  StyleGuideRule,
  SurfaceId,
  SurfaceProfile,
} from 'lexel-ui';
import type { UnpackedLintGroups } from 'lint-framework';
import type { MainModelTier, RuntimeKind } from './models';

export type AiTaskId = BaseAiTaskId | 'direct' | 'softer' | 'bluf' | 'natural_english';

export interface GateCheckSummary extends BaseGateCheckSummary {
  grammarClean?: boolean;
}

export interface TextSnippet extends BaseTextSnippet {
  surfaceId?: SurfaceId | null;
  adaptToSurface?: boolean;
  category?: string;
  builtIn?: boolean;
}

export type {
  BuiltinSurfaceId,
  QuickActionDef,
  RulePresetId,
  StyleGuideRule,
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

export interface DetectedSurfaceContext {
  surfaceId: SurfaceId;
  label: string;
  subcontext: string | null;
  composerKind: 'reply' | 'post' | 'editor';
  domain: string;
  isBlocked: boolean;
  blockReason?: string;
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
  redactSecrets?: boolean;
  ghostTextEnabled?: boolean;
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
  redactSecrets?: boolean;
  ghostTextEnabled?: boolean;
  crutchWords?: string[];
  whisperModelPath?: string;
  dialect: number;
  isolateEnglish: boolean;
  openSuggestionsOnHover: boolean;
  activationKey: ActivationKey;
  lintDelayMs: number;
  defaultEnable?: boolean;
  hotkey?: Hotkey;
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
  weirpacks?: StoredWeirpack[];
  styleGuide?: StyleGuideRule[];
  snippets?: TextSnippet[];
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

export interface PrivacyProofSnapshot {
  localOnlyVerified: boolean;
  loopbackEnforced: boolean;
  totalSecretBlocks: number;
  redactSecretsEnabled: boolean;
  zeroTelemetry: boolean;
}

export interface DoctorNativeMessagingEntry {
  browser: string;
  manifestPath: string;
  installed: boolean;
  validJson: boolean;
  hostBinaryExists: boolean;
  allowedOrigins?: string[];
}

export interface DoctorReport {
  ok: boolean;
  version: string;
  httpPort: number;
  dataDir: string;
  modelsDir: string;
  runtime: DaemonRuntimeSnapshot;
  runtimeDetails?: {
    llamaServerPath?: string | null;
    llamaServerVersion?: string | null;
    speculativeLookupSupported?: boolean;
    speculativeLookupFlag?: string | null;
    cachePromptSupported?: boolean;
    hardwareAcceleration?: string;
  };
  whisper?: {
    binaryAvailable: boolean;
    binaryPath: string | null;
    modelAvailable: boolean;
    modelPath: string | null;
  };
  nativeMessaging?: DoctorNativeMessagingEntry[];
  tier0LatencyMs?: number;
  measuredTokPerSec?: number | null;
  privacyProof?: PrivacyProofSnapshot;
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

export interface RewriteCandidate {
  label: string;
  suggestion: string;
  gates: GateCheckSummary;
  retried?: boolean;
}

export interface RewriteResult {
  original: string;
  suggestion: string;
  model: string;
  latencyMs: number;
  gates: GateCheckSummary;
  surfaceId: SurfaceId;
  subcontext: string | null;
  fastPath?: boolean;
  retried?: boolean;
  failedConstraints?: string[];
  candidates?: RewriteCandidate[];
  redactedCount?: number;
  restoredCleanly?: boolean;
}

export interface GhostCompletionRequest {
  prefix: string;
  suffix?: string;
  surfaceId: SurfaceId;
  subcontext?: string | null;
  domain?: string;
  maxTokens?: number;
}

export interface GhostCompletionResponse {
  completion: string;
  model: string;
  latencyMs: number;
  gates: GateCheckSummary;
}

export interface ScopedThreadContext {
  scopedText: string;
  estimatedTokens: number;
  originalTokens: number;
  truncated: boolean;
  keptBlocks: number;
  totalBlocks: number;
}

export interface SlopSpanContribution {
  kind: 'cliche' | 'em_dash' | 'filler_opener' | 'flat_rhythm' | 'crutch_word';
  text: string;
  start: number;
  end: number;
  weight: number;
  suggestion?: string;
}

export interface SlopMeterReport {
  /** 0 = clean human prose, 100 = dense AI slop */
  score: number;
  label: 'Human' | 'Mixed' | 'High Slop';
  clicheCount: number;
  emDashCount: number;
  fillerOpenerCount: number;
  rhythmFlatness: number;
  spans: SlopSpanContribution[];
}

export interface PastedAiCheck {
  shouldOffer: boolean;
  score: number;
  slopCount: number;
  charCount: number;
  reason: string;
}

export interface ConsistencyWarning {
  kind: 'spelling_variant' | 'hyphenation' | 'product_casing' | 'version_format';
  message: string;
  variants: string[];
  start: number;
  end: number;
}

export interface WritingGuardWarning {
  kind:
    | 'bluf_wall_of_text'
    | 'bluf_buried_ask'
    | 'regret_abrasive'
    | 'regret_missing_attachment'
    | 'crutch_word';
  severity: 'warn' | 'info';
  title: string;
  message: string;
  problemText: string;
  start: number;
  end: number;
  suggestedTask?: AiTaskId;
  actionLabel?: string;
}

export interface PageLintSummary {
  tabId: number;
  domain: string;
  surfaceId: SurfaceId;
  subcontext: string | null;
  harperCount: number;
  slopCount: number;
  surfaceWarningCount: number;
  slopScore?: number;
  guardCount?: number;
  consistencyCount?: number;
  engineSource?: 'lexel-wasm' | 'harper-js';
  updatedAt: number;
}

export interface Hotkey {
  modifiers: Array<'Ctrl' | 'Shift' | 'Alt'>;
  key: string;
}

export type ExtensionRequest =
  | {
      kind: 'lint';
      text: string;
      domain: string;
      surfaceId?: SurfaceId;
      subcontext?: string | null;
      options?: Record<string, unknown>;
    }
  | { kind: 'getConfig' }
  | { kind: 'setConfig'; config: LintConfig }
  | { kind: 'getLintDescriptions' }
  | { kind: 'getDefaultLintConfig' }
  | { kind: 'getDialect' }
  | { kind: 'setDialect'; dialect: Dialect }
  | { kind: 'getIsolateEnglish' }
  | { kind: 'setIsolateEnglish'; isolateEnglish: boolean }
  | { kind: 'getOpenSuggestionsOnHover' }
  | { kind: 'setOpenSuggestionsOnHover'; enabled: boolean }
  | { kind: 'getDelay' }
  | { kind: 'setDelay'; delay: number }
  | { kind: 'getActivationKey' }
  | { kind: 'setActivationKey'; key: ActivationKey }
  | { kind: 'getHotkey' }
  | { kind: 'setHotkey'; hotkey: Hotkey }
  | { kind: 'getDomainStatus'; domain: string }
  | { kind: 'setDomainStatus'; domain: string; enabled: boolean; overrideValue?: boolean }
  | { kind: 'getDomainStatuses' }
  | { kind: 'removeDomainStatus'; domain: string }
  | { kind: 'getDefaultStatus' }
  | { kind: 'setDefaultStatus'; enabled: boolean }
  | { kind: 'getEnabledDomains' }
  | { kind: 'getUserDictionary' }
  | { kind: 'setUserDictionary'; words: string[] }
  | { kind: 'addToUserDictionary'; words: string[] }
  | { kind: 'ignoreLint'; contextHash: string }
  | { kind: 'clearIgnoredLints' }
  | { kind: 'getAiSettings' }
  | { kind: 'setAiSettings'; settings: AiSettings }
  | { kind: 'toggleAi'; enabled: boolean }
  | { kind: 'setMainModel'; model: string }
  | { kind: 'unloadAi' }
  | { kind: 'downloadModel'; modelId: string }
  | { kind: 'deleteModel'; modelId: string }
  | { kind: 'aiHealth' }
  | { kind: 'aiListModels' }
  | {
      kind: 'aiRewrite';
      text: string;
      task: AiTaskId;
      surfaceId: SurfaceId;
      subcontext: string | null;
      threadContext?: string;
      domain?: string;
      candidates?: 1 | 2;
      redactSecrets?: boolean | null;
    }
  | {
      kind: 'ghostComplete';
      prefix: string;
      suffix?: string;
      surfaceId: SurfaceId;
      subcontext?: string | null;
      domain?: string;
      maxTokens?: number;
    }
  | { kind: 'getGhostTextEnabled' }
  | { kind: 'setGhostTextEnabled'; enabled: boolean }
  | { kind: 'getRedactSecrets' }
  | { kind: 'setRedactSecrets'; enabled: boolean }
  | { kind: 'getCrutchWords' }
  | { kind: 'setCrutchWords'; words: string[] }
  | { kind: 'getDoctorReport'; bench?: boolean }
  | { kind: 'getPrivacyStats' }
  | { kind: 'scopeThreadContext'; source: string; threadContext: string; maxTokens?: number }
  | {
      kind: 'expandContextSnippet';
      trigger: string;
      surfaceId: SurfaceId;
      subcontext?: string | null;
      threadContext?: string;
      notes?: string;
      adaptWithAi?: boolean;
    }
  | { kind: 'getDaemonStatus' }
  | { kind: 'syncFromDaemon' }
  | { kind: 'listProfiles' }
  | { kind: 'createProfile'; name: string; cloneFromActive?: boolean }
  | { kind: 'switchProfile'; profileId: string }
  | { kind: 'renameProfile'; profileId: string; name: string }
  | { kind: 'deleteProfile'; profileId: string }
  | { kind: 'getVoiceExamples'; surfaceId?: SurfaceId }
  | { kind: 'saveVoiceExample'; example: Omit<VoiceExample, 'id' | 'createdAt'> }
  | { kind: 'deleteVoiceExample'; id: string }
  | { kind: 'getPrivacyBlocklist' }
  | { kind: 'setPrivacyBlocklist'; domains: string[] }
  | { kind: 'getSurfaceOverride'; domain: string }
  | { kind: 'getSurfaceOverrides' }
  | { kind: 'setSurfaceOverride'; domain: string; surfaceId: SurfaceId | null }
  | { kind: 'getTheme' }
  | { kind: 'setTheme'; theme: 'dark' | 'light' }
  | { kind: 'setPageSummary'; summary: Omit<PageLintSummary, 'tabId' | 'updatedAt'> }
  | { kind: 'getPageSummary'; tabId: number }
  | {
      kind: 'setActiveDraft';
      draft: { text: string; surfaceId: SurfaceId; subcontext: string | null };
    }
  | { kind: 'getActiveDraft' }
  | { kind: 'openSidePanel'; windowId?: number }
  | { kind: 'openOptions' }
  | { kind: 'getStructuredLintConfig' }
  | { kind: 'toTitleCase'; text: string }
  | { kind: 'fixSafeIssues'; text: string; surfaceId: SurfaceId }
  | { kind: 'loadWeirpack'; name: string; bytesBase64: string }
  | { kind: 'getWeirpacks' }
  | { kind: 'toggleWeirpack'; name: string; enabled: boolean }
  | { kind: 'removeWeirpack'; name: string }
  | { kind: 'getLanguageMode' }
  | { kind: 'setLanguageMode'; language: LintLanguage }
  | { kind: 'getCustomSlopConfig' }
  | { kind: 'setCustomSlopConfig'; customTerms: string[]; disabledTerms: string[] }
  | { kind: 'allowSlopTerm'; term: string }
  | { kind: 'applyRulePreset'; presetId: RulePresetId }
  | { kind: 'fixAllSafe'; text: string; surfaceId: SurfaceId }
  | { kind: 'toSentenceCase'; text: string }
  | { kind: 'normalizeTypography'; text: string }
  | { kind: 'lookupSynonyms'; word: string }
  | { kind: 'getCustomSurfaces' }
  | { kind: 'setCustomSurfaces'; surfaces: SurfaceProfile[] }
  | { kind: 'getStyleGuide' }
  | { kind: 'setStyleGuide'; rules: StyleGuideRule[] }
  | { kind: 'getSnippets' }
  | { kind: 'setSnippets'; snippets: TextSnippet[] }
  | { kind: 'getStatsSummary' }
  | { kind: 'exportStats' }
  | { kind: 'importStats'; statsJson: string }
  | { kind: 'applySuggestionStat'; text: string; lintKind: string; replacement: string }
  | { kind: 'exportAllData' }
  | { kind: 'purgeAllData' };

export type LintResponse = { kind: 'lints'; lints: UnpackedLintGroups };

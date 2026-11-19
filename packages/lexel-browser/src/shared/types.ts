import type { Dialect, LintConfig } from 'harper.js';
import type {
  AiTaskId,
  BuiltinSurfaceId,
  GateCheckSummary,
  QuickActionDef,
  RulePresetId,
  StyleGuideRule,
  SurfaceId,
  SurfaceProfile,
  TextSnippet,
} from 'lexel-ui';
import type { UnpackedLintGroups } from 'lint-framework';
import type { MainModelTier, RuntimeKind } from './models';

export type {
  AiTaskId,
  BuiltinSurfaceId,
  QuickActionDef,
  RulePresetId,
  StyleGuideRule,
  SurfaceId,
  SurfaceProfile,
  TextSnippet,
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

export interface PageLintSummary {
  tabId: number;
  domain: string;
  surfaceId: SurfaceId;
  subcontext: string | null;
  harperCount: number;
  slopCount: number;
  surfaceWarningCount: number;
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

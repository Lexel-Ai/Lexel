import type { Dialect, LintConfig } from 'harper.js';
import type { GateCheckSummary } from 'lexel-ui';
import type { UnpackedLintGroups } from 'lint-framework';

export type SurfaceId =
  | 'web_reddit'
  | 'web_x'
  | 'web_github_pr'
  | 'web_linkedin'
  | 'web_discord_slack'
  | 'web_email'
  | 'general';

export type AiTaskId =
  | 'fix_grammar_flow'
  | 'deslop'
  | 'rewrite_surface'
  | 'shorten'
  | 'reply_draft';

export type ActivationKey = 'off' | 'shift' | 'control';

export type AiProviderKind = 'ollama' | 'openai_compat';

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
  provider: AiProviderKind;
  endpoint: string;
  model: string;
  temperature: number;
  maxTokens: number;
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
  | { kind: 'aiHealth' }
  | { kind: 'aiListModels' }
  | {
      kind: 'aiRewrite';
      text: string;
      task: AiTaskId;
      surfaceId: SurfaceId;
      subcontext: string | null;
      threadContext?: string;
    }
  | { kind: 'getVoiceExamples'; surfaceId?: SurfaceId }
  | { kind: 'saveVoiceExample'; example: Omit<VoiceExample, 'id' | 'createdAt'> }
  | { kind: 'deleteVoiceExample'; id: string }
  | { kind: 'getPrivacyBlocklist' }
  | { kind: 'setPrivacyBlocklist'; domains: string[] }
  | { kind: 'getSurfaceOverride'; domain: string }
  | { kind: 'setSurfaceOverride'; domain: string; surfaceId: SurfaceId | null }
  | { kind: 'getTheme' }
  | { kind: 'setTheme'; theme: 'dark' | 'light' }
  | { kind: 'setPageSummary'; summary: Omit<PageLintSummary, 'tabId' | 'updatedAt'> }
  | { kind: 'getPageSummary'; tabId: number }
  | { kind: 'setActiveDraft'; draft: { text: string; surfaceId: SurfaceId; subcontext: string | null } }
  | { kind: 'getActiveDraft' }
  | { kind: 'openSidePanel'; windowId?: number }
  | { kind: 'openOptions' }
  | { kind: 'exportAllData' }
  | { kind: 'purgeAllData' };

export type LintResponse = { kind: 'lints'; lints: UnpackedLintGroups };

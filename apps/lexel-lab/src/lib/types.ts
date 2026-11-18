import type { Dialect, LintConfig } from 'harper.js';
import type { GateCheckSummary } from 'lexel-ui';

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

export interface LabSettingsState {
  theme: 'dark' | 'light';
  surfaceId: SurfaceId;
  subcontext: string;
  dialect: Dialect;
  isolateEnglish: boolean;
  openSuggestionsOnHover: boolean;
  activationKey: ActivationKey;
  delayMs: number;
  lintConfig: LintConfig;
  ignoredLints: string;
  userDictionary: string[];
  aiSettings: AiSettings;
  voiceExamples: VoiceExample[];
  draftText: string;
  threadContext: string;
}

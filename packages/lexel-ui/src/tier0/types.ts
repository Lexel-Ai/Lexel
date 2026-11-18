export type BuiltinSurfaceId =
  | 'web_reddit'
  | 'web_x'
  | 'web_github_pr'
  | 'web_linkedin'
  | 'web_discord_slack'
  | 'web_email'
  | 'web_substack'
  | 'web_wordpress'
  | 'web_discourse'
  | 'ide_git_commit'
  | 'ide_code_comment'
  | 'docs_markdown'
  | 'general';

export type SurfaceId = BuiltinSurfaceId | (string & {});

export type AiTaskId =
  | 'fix_grammar_flow'
  | 'deslop'
  | 'rewrite_surface'
  | 'shorten'
  | 'reply_draft';

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

export interface Tier0Suggestion {
  kind: number;
  replacement_text: string;
}

export interface Tier0Lint {
  span: { start: number; end: number };
  message_html: string;
  problem_text: string;
  lint_kind: string;
  lint_kind_pretty: string;
  suggestions: Tier0Suggestion[];
  context_hash: string;
  source: string;
}

export interface Tier0Options {
  allowCustomTerms?: boolean;
  customSlopTerms?: string[];
  disabledSlopTerms?: string[];
  customSurfaces?: SurfaceProfile[];
}

export interface UnitBoundMetric {
  raw: string;
  value: string;
  unit: string;
}

export type RulePresetId = 'curated' | 'strict_technical' | 'formal_academic' | 'casual_chat';

export interface RulePresetDefinition {
  id: RulePresetId;
  label: string;
  description: string;
  rules: Record<string, boolean | null>;
}

export interface ReadabilityMetrics {
  chars: number;
  words: number;
  sentences: number;
  syllables: number;
  longSentences: number;
  avgWordsPerSentence: number;
  readingTimeSec: number;
  fleschReadingEase: number;
  fleschKincaidGrade: number;
  passiveHintCount: number;
}

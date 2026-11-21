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

export interface StyleGuideRule {
  term: string;
  preferred: string;
  caseSensitive?: boolean;
  note?: string | null;
}

export interface TextSnippet {
  trigger: string;
  expansion: string;
  label?: string;
}

export interface InvisibleCharHit {
  codepoint: string;
  label: string;
  start: number;
  end: number;
  replacement: string;
}

export interface StructureIssue {
  kind: string;
  message: string;
  problemText: string;
  start: number;
  end: number;
  suggestion?: string;
}

export interface StyleGuideHit {
  term: string;
  preferred: string;
  note?: string | null;
  start: number;
  end: number;
}

export interface SurfaceGradeTarget {
  minGrade: number;
  maxGrade: number;
  audienceLabel: string;
}

export type SlopMeterContributorKind = 'cliche' | 'em_dash' | 'filler_opener' | 'flat_rhythm';
export type SlopMeterLabel = 'human' | 'mild_ai' | 'likely_ai' | 'heavy_slop';

export interface SlopMeterSpan {
  kind: SlopMeterContributorKind;
  label: string;
  matchedText: string;
  start: number;
  end: number;
  weight: number;
}

export interface Tier0SlopMeterBreakdown {
  clichePoints: number;
  emDashPoints: number;
  fillerOpenerPoints: number;
  flatRhythmPoints: number;
  clicheDensityPer100Words: number;
  emDashCount: number;
  fillerOpenerCount: number;
  sentenceLengthStddev: number;
}

export interface SlopMeterOptions {
  allowEmDashes?: boolean;
  customSlopTerms?: string[];
  disabledSlopTerms?: string[];
  surfaceBannedOpeners?: string[];
}

export interface SlopMeterReport {
  score: number;
  humanScore: number;
  label: SlopMeterLabel;
  wordCount: number;
  clicheCount: number;
  emDashCount: number;
  fillerOpenerCount: number;
  rhythmFlatness: number;
  breakdown: Tier0SlopMeterBreakdown;
  contributors: SlopMeterSpan[];
}

export interface PastedAiThresholds {
  minChars?: number;
  minScore?: number;
  minSignals?: number;
  minDensityPer100Words?: number;
}

export interface PastedAiAssessment {
  shouldOfferHumanize: boolean;
  charCount: number;
  wordCount: number;
  slopScore: number;
  slopDensityPer100Words: number;
  signalCount: number;
  reason: string | null;
  meter: SlopMeterReport;
}

export type ConsistencyKind =
  | 'spelling_dialect'
  | 'hyphenation'
  | 'product_casing'
  | 'version_format';

export interface ConsistencyIssue {
  kind: ConsistencyKind;
  message: string;
  found: string;
  preferred: string;
  start: number;
  end: number;
  groupKey: string;
}

export type WritingGuardKind =
  | 'wall_of_text'
  | 'buried_ask'
  | 'abrasive_tone'
  | 'missing_attachment'
  | 'crutch_word';

export type WritingGuardSeverity = 'info' | 'warning';

export interface WritingGuardHit {
  kind: WritingGuardKind;
  severity: WritingGuardSeverity;
  ruleId: string;
  message: string;
  matchedText: string;
  start: number;
  end: number;
  suggestion?: string;
  quickAction?: string;
}

export interface ParagraphCacheStats {
  paragraphsTotal: number;
  cacheHits: number;
  cacheMisses: number;
}

export interface Tier0Options {
  allowCustomTerms?: boolean;
  customSlopTerms?: string[];
  disabledSlopTerms?: string[];
  customSurfaces?: SurfaceProfile[];
  styleGuide?: StyleGuideRule[];
  crutchWords?: string[];
  hasAttachmentSignal?: boolean;
  preferredDialect?: number;
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
  speakingTimeSec: number;
  fleschReadingEase: number;
  fleschKincaidGrade: number;
  passiveHintCount: number;
  hedgingCount: number;
  hedgingPercent: number;
  sentenceVarietyScore: number;
}

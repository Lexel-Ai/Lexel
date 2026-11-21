import initWasm, {
  analyze_readability_wasm,
  check_consistency_wasm,
  check_guards_wasm,
  detect_pasted_ai_wasm,
  initSync,
  list_surfaces_wasm,
  normalize_typography_wasm,
  LexelWasmEngine as RawLexelWasmEngine,
  score_slop_meter_wasm,
  to_sentence_case_wasm,
  to_title_case_wasm,
} from '../pkg/lexel_wasm.js';

export type WasmInitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface HarperDiagnostic {
  rule: string;
  lintKind: string;
  message: string;
  problemText: string;
  start: number;
  end: number;
  suggestions: string[];
}

export interface SlopHit {
  term: string;
  start: number;
  end: number;
  isEmDash: boolean;
  suggestion?: string;
}

export interface SurfaceViolation {
  kind: string;
  message: string;
  start: number;
  end: number;
}

export interface SecretMatch {
  kind: string;
  label: string;
  start: number;
  end: number;
  maskedPreview: string;
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

export interface StyleGuideRule {
  term: string;
  preferred: string;
  caseSensitive?: boolean;
  note?: string | null;
}

export interface StyleGuideHit {
  term: string;
  preferred: string;
  note?: string | null;
  start: number;
  end: number;
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

export interface SlopMeterBreakdown {
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
  breakdown: SlopMeterBreakdown;
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
  reason?: string | null;
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

export interface StoredWeirpack {
  name: string;
  bytesBase64: string;
  ruleCount: number;
  enabled?: boolean;
}

export interface SurfaceProfile {
  id: string;
  label: string;
  hostPatterns: string[];
  pathRegex?: string | null;
  register: string;
  minChars: number;
  maxChars: number;
  allowLinks: boolean;
  allowEmojis: boolean;
  allowHashtags: boolean;
  allowEmDashes: boolean;
  bannedOpeners: string[];
  promptDirective: string;
  quickActions: Array<{ id: string; label: string }>;
}

export interface Tier0CheckOptions {
  surfaceId?: string;
  language?: string;
  dialect?: number;
  lintConfig?: Record<string, boolean | null>;
  userDictionary?: string[];
  ignoredLints?: string;
  customSlopTerms?: string[];
  disabledSlopTerms?: string[];
  customSurfaces?: SurfaceProfile[];
  styleGuide?: StyleGuideRule[];
  crutchWords?: string[];
  weirpacks?: StoredWeirpack[];
  hasAttachmentSignal?: boolean;
}

export interface Tier0Report {
  harper: HarperDiagnostic[];
  slop: SlopHit[];
  surface: SurfaceViolation[];
  secrets: SecretMatch[];
  invisibleChars: InvisibleCharHit[];
  structure: StructureIssue[];
  styleGuide: StyleGuideHit[];
  slopMeter: SlopMeterReport;
  consistency: ConsistencyIssue[];
  guards: WritingGuardHit[];
  safeFixedText: string;
  safeFixesCount: number;
  cacheStats: ParagraphCacheStats;
}

export interface SafeFixResult {
  text: string;
  fixesApplied: number;
  categories: string[];
}

export interface ReadabilityReport {
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
  passiveVoiceCount: number;
  hedgingCount: number;
  hedgingPercent: number;
  sentenceVarietyScore: number;
}

let wasmReady = false;
let initPromise: Promise<void> | null = null;

/** Initialize the Lexel Tier 0 WebAssembly binary asynchronously (browser / web / extension). */
export async function initLexelWasm(input?: WasmInitInput): Promise<void> {
  if (wasmReady) return;
  if (!initPromise) {
    initPromise = initWasm(input === undefined ? undefined : { module_or_path: input })
      .then(() => {
        wasmReady = true;
      })
      .catch((err: unknown) => {
        initPromise = null;
        throw err;
      });
  }
  await initPromise;
}

/** Initialize the Lexel Tier 0 WebAssembly binary synchronously from bytes or a compiled Module (Node / tests / workers). */
export function initLexelWasmSync(module: BufferSource | WebAssembly.Module): void {
  if (wasmReady) return;
  initSync({ module });
  wasmReady = true;
}

/** Return true once the WebAssembly module has finished loading. */
export function isLexelWasmReady(): boolean {
  return wasmReady;
}

function assertReady(): void {
  if (!wasmReady) {
    throw new Error('Lexel WASM is not initialized. Call await initLexelWasm() first.');
  }
}

/** Stateful Tier 0 WASM engine with cached Harper linter and paragraph-hash cache. */
export class LexelWasmEngine {
  private readonly raw: RawLexelWasmEngine;

  constructor() {
    assertReady();
    this.raw = new RawLexelWasmEngine();
  }

  /** Run full deterministic Tier 0 checks (Harper, slop meter, consistency, guards, safe fixes). */
  check(text: string, options?: Tier0CheckOptions): Tier0Report {
    return this.raw.check(text, options ?? undefined) as Tier0Report;
  }

  /** Run only Harper diagnostics with paragraph-hash caching. */
  checkHarper(text: string, options?: Tier0CheckOptions): HarperDiagnostic[] {
    return this.raw.check_harper(text, options ?? undefined) as HarperDiagnostic[];
  }

  /** Apply deterministic safe fixes (slop, surface cleanup, style guide, and optionally safe Harper fixes). */
  applySafeFixes(
    text: string,
    options?: Tier0CheckOptions & { includeHarper?: boolean },
  ): SafeFixResult {
    const includeHarper = options?.includeHarper ?? true;
    return this.raw.apply_safe_fixes(text, options ?? undefined, includeHarper) as SafeFixResult;
  }

  /** Clear cached paragraph lints. */
  clearCache(): void {
    this.raw.clear_cache();
  }

  /** Return count of currently cached paragraphs. */
  cachedParagraphs(): number {
    return this.raw.cached_paragraphs();
  }

  /** Release the underlying WASM engine handle. */
  free(): void {
    this.raw.free();
  }
}

/** Initialize WASM if needed and construct a new stateful `LexelWasmEngine`. */
export async function createLexelWasmEngine(input?: WasmInitInput): Promise<LexelWasmEngine> {
  await initLexelWasm(input);
  return new LexelWasmEngine();
}

/** Score text with the Live Human vs. AI-slop meter. */
export function scoreSlopMeterWasm(text: string, options?: SlopMeterOptions): SlopMeterReport {
  assertReady();
  return score_slop_meter_wasm(text, options ?? undefined) as SlopMeterReport;
}

/** Decide whether pasted text should surface the "Humanize pasted text" pill. */
export function detectPastedAiWasm(
  text: string,
  options?: SlopMeterOptions,
  thresholds?: PastedAiThresholds,
): PastedAiAssessment {
  assertReady();
  return detect_pasted_ai_wasm(
    text,
    options ?? undefined,
    thresholds ?? undefined,
  ) as PastedAiAssessment;
}

/** Run the document-wide consistency checker (US/UK spelling, hyphenation, product casing, versions). */
export function checkConsistencyWasm(text: string, preferredDialect?: number): ConsistencyIssue[] {
  assertReady();
  return check_consistency_wasm(text, preferredDialect) as ConsistencyIssue[];
}

/** Run BLUF/wall-of-text, regret shield, and personal crutch-word guards. */
export function checkGuardsWasm(
  text: string,
  options?: {
    surfaceId?: string;
    crutchWords?: string[];
    hasAttachmentSignal?: boolean;
  },
): WritingGuardHit[] {
  assertReady();
  return check_guards_wasm(
    text,
    options?.surfaceId,
    options?.crutchWords ?? undefined,
    options?.hasAttachmentSignal,
  ) as WritingGuardHit[];
}

/** Compute offline Flesch-Kincaid readability and rhythm metrics. */
export function analyzeReadabilityWasm(text: string): ReadabilityReport {
  assertReady();
  return analyze_readability_wasm(text) as ReadabilityReport;
}

/** Return all built-in surface profiles embedded from `ml/personas/surfaces.json`. */
export function listSurfacesWasm(): SurfaceProfile[] {
  assertReady();
  return list_surfaces_wasm() as SurfaceProfile[];
}

/** Convert text to Chicago-style title case. */
export function toTitleCaseWasm(text: string): string {
  assertReady();
  return to_title_case_wasm(text);
}

/** Convert text to sentence case outside code blocks and quotes. */
export function toSentenceCaseWasm(text: string): string {
  assertReady();
  return to_sentence_case_wasm(text);
}

/** Normalize curly quotes, ellipses, non-breaking spaces, and hidden Unicode characters. */
export function normalizeTypographyWasm(text: string): SafeFixResult {
  assertReady();
  return normalize_typography_wasm(text) as SafeFixResult;
}

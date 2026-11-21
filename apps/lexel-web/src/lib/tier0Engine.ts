import {
  applySafeDeterministicFixesShared,
  BUILTIN_SURFACES,
  computeReadabilityMetrics,
  type ReadabilityMetrics,
  resolveSurfaceProfileShared,
  type SafeFixResult,
  type SurfaceId,
  type SurfaceProfile,
  scanConsistencyIssues,
  scanTier0DiagnosticsShared,
  scanWritingGuards,
  scoreSlopMeter,
  type Tier0Lint,
} from 'lexel-ui';
import type { LexelWasmEngine, Tier0Report } from 'lexel-wasm';

export type DialectId = 'American' | 'British' | 'Canadian' | 'Australian';

const DIALECT_TO_CODE: Record<DialectId, number> = {
  American: 0,
  British: 1,
  Canadian: 2,
  Australian: 3,
};

export type DiagnosticCategory =
  | 'harper'
  | 'slop'
  | 'surface'
  | 'consistency'
  | 'guards'
  | 'secrets'
  | 'structure';

export interface PlaygroundDiagnostic {
  id: string;
  category: DiagnosticCategory;
  ruleLabel: string;
  message: string;
  problemText: string;
  start: number;
  end: number;
  suggestion?: string;
}

export interface SlopMeterFactor {
  label: string;
  count: number;
  points: number;
}

export interface SlopMeterReport {
  score: number;
  verdict: 'Human' | 'Mixed' | 'AI-Heavy';
  factors: SlopMeterFactor[];
}

export interface Tier0AnalysisResult {
  engineKind: 'wasm' | 'js-fallback';
  engineLabel: string;
  elapsedMs: number;
  surface: SurfaceProfile;
  readability: ReadabilityMetrics;
  slopMeter: SlopMeterReport;
  diagnostics: PlaygroundDiagnostic[];
  counts: Record<DiagnosticCategory, number>;
}

const CONSISTENCY_LABELS: Record<string, string> = {
  spelling_dialect: 'Spelling Consistency',
  hyphenation: 'Hyphenation Consistency',
  product_casing: 'Product Casing',
  version_format: 'Version Format',
};

const GUARD_LABELS: Record<string, string> = {
  wall_of_text: 'Wall of Text',
  buried_ask: 'BLUF (Lead With the Ask)',
  abrasive_tone: 'Regret Shield',
  missing_attachment: 'Regret Shield (Attachment)',
  crutch_word: 'Crutch Word',
};

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

function mapTier0Lint(
  lint: Tier0Lint,
  category: DiagnosticCategory,
  fallbackRule: string,
  index: number,
): PlaygroundDiagnostic {
  return {
    id: `${category}-${index}-${lint.context_hash}`,
    category,
    ruleLabel: lint.lint_kind_pretty || fallbackRule,
    message: stripHtmlTags(lint.message_html),
    problemText: lint.problem_text,
    start: lint.span.start,
    end: lint.span.end,
    suggestion: lint.suggestions[0]?.replacement_text,
  };
}

function mapSlopVerdict(score: number): SlopMeterReport['verdict'] {
  if (score >= 45) return 'AI-Heavy';
  if (score >= 18) return 'Mixed';
  return 'Human';
}

function mapWasmReportToDiagnostics(text: string, report: Tier0Report): PlaygroundDiagnostic[] {
  const out: PlaygroundDiagnostic[] = [];
  let idx = 0;

  for (const h of report.harper) {
    out.push({
      id: `harper-${idx++}-${h.start}`,
      category: 'harper',
      ruleLabel: h.rule || h.lintKind || 'Harper Grammar',
      message: h.message,
      problemText: h.problemText || text.slice(h.start, h.end),
      start: h.start,
      end: h.end,
      suggestion: h.suggestions[0],
    });
  }

  for (const s of report.secrets) {
    out.push({
      id: `secrets-${idx++}-${s.start}`,
      category: 'secrets',
      ruleLabel: 'Secrets Guard',
      message: `Detected ${s.label} (${s.maskedPreview}). Redact or remove before sending.`,
      problemText: text.slice(s.start, s.end),
      start: s.start,
      end: s.end,
      suggestion: '[REDACTED]',
    });
  }

  for (const hit of report.slop) {
    out.push({
      id: `slop-${idx++}-${hit.start}`,
      category: 'slop',
      ruleLabel: hit.isEmDash ? 'Em Dash Ban' : 'LexelAntiSlop',
      message: hit.isEmDash
        ? 'Em dash detected. Replace with a comma, period, or parentheses.'
        : hit.suggestion
          ? `Common AI buzzword ("${hit.term}"). Replace with "${hit.suggestion}".`
          : `Common AI buzzword ("${hit.term}"). Use specific, plain phrasing.`,
      problemText: text.slice(hit.start, hit.end) || hit.term,
      start: hit.start,
      end: hit.end,
      suggestion: hit.isEmDash ? ', ' : hit.suggestion,
    });
  }

  for (const v of report.surface) {
    out.push({
      id: `surface-${idx++}-${v.start}`,
      category: 'surface',
      ruleLabel: 'LexelSurface',
      message: v.message,
      problemText: text.slice(v.start, v.end),
      start: v.start,
      end: v.end,
    });
  }

  for (const c of report.consistency) {
    out.push({
      id: `consistency-${idx++}-${c.start}`,
      category: 'consistency',
      ruleLabel: CONSISTENCY_LABELS[c.kind] ?? 'Consistency',
      message: c.message,
      problemText: c.found,
      start: c.start,
      end: c.end,
      suggestion: c.preferred,
    });
  }

  for (const g of report.guards) {
    out.push({
      id: `guards-${idx++}-${g.start}`,
      category: 'guards',
      ruleLabel: GUARD_LABELS[g.kind] ?? 'Writing Guard',
      message: g.message,
      problemText: g.matchedText,
      start: g.start,
      end: g.end,
      suggestion: g.suggestion,
    });
  }

  for (const inv of report.invisibleChars) {
    out.push({
      id: `inv-${idx++}-${inv.start}`,
      category: 'structure',
      ruleLabel: 'Invisible Unicode',
      message: `Hidden Unicode character ${inv.label} (${inv.codepoint}).`,
      problemText: text.slice(inv.start, inv.end) || inv.codepoint,
      start: inv.start,
      end: inv.end,
      suggestion: inv.replacement,
    });
  }

  for (const st of report.structure) {
    out.push({
      id: `struct-${idx++}-${st.start}`,
      category: 'structure',
      ruleLabel: 'Structure',
      message: st.message,
      problemText: st.problemText,
      start: st.start,
      end: st.end,
      suggestion: st.suggestion,
    });
  }

  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

let wasmEngine: LexelWasmEngine | null = null;
let wasmInitPromise: Promise<LexelWasmEngine | null> | null = null;

/** Inject a pre-initialized LexelWasmEngine (used by Node/Vitest integration tests). */
export function setWasmEngineForTesting(engine: LexelWasmEngine | null): void {
  wasmEngine = engine;
  wasmInitPromise = null;
}

export async function initTier0Engine(): Promise<{
  kind: 'wasm' | 'js-fallback';
  label: string;
  note: string;
}> {
  if (wasmEngine) {
    return {
      kind: 'wasm',
      label: 'lexel-wasm (Rust + Harper)',
      note: 'Running compiled Rust Tier 0 (Harper grammar, slop meter, consistency, guards, paragraph cache) locally in WebAssembly. Zero server requests.',
    };
  }

  if (typeof window !== 'undefined' && typeof fetch === 'function') {
    if (!wasmInitPromise) {
      wasmInitPromise = (async () => {
        try {
          const mod = await import('lexel-wasm');
          return await mod.createLexelWasmEngine('/wasm/lexel_wasm_bg.wasm');
        } catch {
          return null;
        }
      })();
    }
    const loaded = await wasmInitPromise;
    if (loaded) {
      wasmEngine = loaded;
      return {
        kind: 'wasm',
        label: 'lexel-wasm (Rust + Harper)',
        note: 'Running compiled Rust Tier 0 (Harper grammar, slop meter, consistency, guards, paragraph cache) locally in WebAssembly. Zero server requests.',
      };
    }
  }

  return {
    kind: 'js-fallback',
    label: 'lexel-ui Tier 0 (Client-side)',
    note: 'Running deterministic anti-slop, surface rules, secrets guard, consistency, and writing guards in your browser. Zero server requests.',
  };
}

export function analyzeTier0Client(params: {
  text: string;
  surfaceId: SurfaceId;
  dialect: DialectId;
  crutchWords: readonly string[];
}): Tier0AnalysisResult {
  const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const profile = resolveSurfaceProfileShared(params.surfaceId);
  const readability = computeReadabilityMetrics(params.text);
  const dialectCode = DIALECT_TO_CODE[params.dialect];

  if (wasmEngine) {
    const report = wasmEngine.check(params.text, {
      surfaceId: params.surfaceId,
      language: 'markdown',
      dialect: dialectCode,
      crutchWords: [...params.crutchWords],
    });
    const diagnostics = mapWasmReportToDiagnostics(params.text, report);
    const counts: Record<DiagnosticCategory, number> = {
      harper: 0,
      slop: 0,
      surface: 0,
      consistency: 0,
      guards: 0,
      secrets: 0,
      structure: 0,
    };
    for (const item of diagnostics) {
      counts[item.category] += 1;
    }

    const slopMeter: SlopMeterReport = {
      score: Math.round(report.slopMeter.score),
      verdict: mapSlopVerdict(report.slopMeter.score),
      factors: [
        {
          label: 'AI buzzwords',
          count: report.slopMeter.clicheCount,
          points: Math.round(report.slopMeter.breakdown.clichePoints),
        },
        {
          label: 'Em dashes',
          count: report.slopMeter.emDashCount,
          points: Math.round(report.slopMeter.breakdown.emDashPoints),
        },
        {
          label: 'Weak surface openers',
          count: report.slopMeter.fillerOpenerCount,
          points: Math.round(report.slopMeter.breakdown.fillerOpenerPoints),
        },
        {
          label: 'Flat sentence rhythm',
          count: report.slopMeter.breakdown.flatRhythmPoints > 0 ? 1 : 0,
          points: Math.round(report.slopMeter.breakdown.flatRhythmPoints),
        },
      ],
    };

    const endTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return {
      engineKind: 'wasm',
      engineLabel: 'lexel-wasm (Rust + Harper)',
      elapsedMs: Math.max(0.1, Number((endTime - startTime).toFixed(2))),
      surface: profile,
      readability,
      slopMeter,
      diagnostics,
      counts,
    };
  }

  // Fallback using canonical @tier0 lexel-ui checks when WASM is unavailable (e.g. SSR/jsdom)
  const core = scanTier0DiagnosticsShared(params.text, profile);
  const consistencyHits = scanConsistencyIssues(params.text, dialectCode);
  const guardHits = scanWritingGuards(params.text, params.surfaceId, [...params.crutchWords]);
  const meter = scoreSlopMeter(params.text, {
    allowEmDashes: profile.allowEmDashes,
    surfaceBannedOpeners: profile.bannedOpeners,
  });

  const diagnostics: PlaygroundDiagnostic[] = [
    ...core.secretLints.map((l, i) => mapTier0Lint(l, 'secrets', 'Secrets Guard', i)),
    ...core.slopLints.map((l, i) => mapTier0Lint(l, 'slop', 'Anti-Slop', i)),
    ...core.surfaceLints.map((l, i) => mapTier0Lint(l, 'surface', 'Surface Policy', i)),
    ...consistencyHits.map((c, i) => ({
      id: `consistency-${i}-${c.start}`,
      category: 'consistency' as const,
      ruleLabel: CONSISTENCY_LABELS[c.kind] ?? 'Consistency',
      message: c.message,
      problemText: c.found,
      start: c.start,
      end: c.end,
      suggestion: c.preferred,
    })),
    ...guardHits.map((g, i) => ({
      id: `guards-${i}-${g.start}`,
      category: 'guards' as const,
      ruleLabel: GUARD_LABELS[g.kind] ?? 'Writing Guard',
      message: g.message,
      problemText: g.matchedText,
      start: g.start,
      end: g.end,
      suggestion: g.suggestion,
    })),
    ...core.invisibleLints.map((l, i) => mapTier0Lint(l, 'structure', 'Invisible Unicode', i)),
    ...core.structureLints.map((l, i) => mapTier0Lint(l, 'structure', 'Structure', i)),
  ].sort((a, b) => a.start - b.start || a.end - b.end);

  const counts: Record<DiagnosticCategory, number> = {
    harper: 0,
    slop: 0,
    surface: 0,
    consistency: 0,
    guards: 0,
    secrets: 0,
    structure: 0,
  };
  for (const item of diagnostics) {
    counts[item.category] += 1;
  }

  const slopMeter: SlopMeterReport = {
    score: Math.round(meter.score),
    verdict: mapSlopVerdict(meter.score),
    factors: [
      {
        label: 'AI buzzwords',
        count: meter.clicheCount,
        points: Math.round(meter.breakdown.clichePoints),
      },
      {
        label: 'Em dashes',
        count: meter.emDashCount,
        points: Math.round(meter.breakdown.emDashPoints),
      },
      {
        label: 'Weak surface openers',
        count: meter.fillerOpenerCount,
        points: Math.round(meter.breakdown.fillerOpenerPoints),
      },
      {
        label: 'Flat sentence rhythm',
        count: meter.breakdown.flatRhythmPoints > 0 ? 1 : 0,
        points: Math.round(meter.breakdown.flatRhythmPoints),
      },
    ],
  };

  const endTime = typeof performance !== 'undefined' ? performance.now() : Date.now();

  return {
    engineKind: 'js-fallback',
    engineLabel: 'lexel-ui Tier 0 (Client-side)',
    elapsedMs: Math.max(0.1, Number((endTime - startTime).toFixed(2))),
    surface: profile,
    readability,
    slopMeter,
    diagnostics,
    counts,
  };
}

export function applySafeTier0Fixes(
  text: string,
  surfaceId: SurfaceId,
  dialect: DialectId = 'American',
): SafeFixResult {
  if (wasmEngine) {
    return wasmEngine.applySafeFixes(text, {
      surfaceId,
      language: 'markdown',
      dialect: DIALECT_TO_CODE[dialect],
      includeHarper: true,
    });
  }
  const profile = resolveSurfaceProfileShared(surfaceId);
  return applySafeDeterministicFixesShared(text, profile);
}

export function applySingleDiagnosticFix(text: string, item: PlaygroundDiagnostic): string {
  if (item.suggestion === undefined) return text;
  const before = text.slice(0, item.start);
  const after = text.slice(item.end);
  const joined = `${before}${item.suggestion}${after}`;
  return joined.replace(/[ \t]{2,}/g, ' ').replace(/ ([.,!?;:])/g, '$1');
}

export function getAllSurfaces(): readonly SurfaceProfile[] {
  return BUILTIN_SURFACES;
}

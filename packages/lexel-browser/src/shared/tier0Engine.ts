import {
  detectPastedAi,
  scanConsistencyIssues,
  scanWritingGuards,
  scoreSlopMeter,
  type Tier0Options,
} from 'lexel-ui';
import type {
  ConsistencyWarning,
  PastedAiCheck,
  SlopMeterReport,
  SurfaceId,
  WritingGuardWarning,
} from './types';

export interface FullTier0Analysis {
  slopMeter: SlopMeterReport;
  consistencyWarnings: ConsistencyWarning[];
  guardWarnings: WritingGuardWarning[];
  engineSource: 'lexel-wasm' | 'harper-js';
}

function mapSlopLabel(score: number): SlopMeterReport['label'] {
  if (score >= 45) return 'High Slop';
  if (score >= 18) return 'Mixed';
  return 'Human';
}

/**
 * Compute live Human vs AI-Slop score (0-100) using `lexel-ui`'s canonical Tier 0 scorer
 * (1-for-1 mirror of Rust `lexel-core::slop_meter`).
 */
export function computeSlopMeter(
  text: string,
  options?: Pick<Tier0Options, 'customSlopTerms' | 'disabledSlopTerms'> & {
    crutchWords?: string[];
  },
): SlopMeterReport {
  const raw = scoreSlopMeter(text, {
    customSlopTerms: options?.customSlopTerms,
    disabledSlopTerms: options?.disabledSlopTerms,
  });

  return {
    score: raw.score,
    label: mapSlopLabel(raw.score),
    clicheCount: raw.clicheCount,
    emDashCount: raw.emDashCount,
    fillerOpenerCount: raw.fillerOpenerCount,
    rhythmFlatness: raw.rhythmFlatness,
    spans: raw.contributors.map((c) => ({
      kind: c.kind,
      text: c.matchedText,
      start: c.start,
      end: c.end,
      weight: c.weight,
    })),
  };
}

/**
 * Decide whether freshly pasted text warrants showing the quiet "Humanize pasted text" pill,
 * delegating directly to `lexel-ui`'s canonical `detectPastedAi` helper.
 */
export function checkPastedAiSlop(
  pastedText: string,
  options?: Pick<Tier0Options, 'customSlopTerms' | 'disabledSlopTerms'>,
): PastedAiCheck {
  const assessment = detectPastedAi(pastedText, {
    customSlopTerms: options?.customSlopTerms,
    disabledSlopTerms: options?.disabledSlopTerms,
  });
  return {
    shouldOffer: assessment.shouldOfferHumanize,
    score: assessment.slopScore,
    slopCount: assessment.signalCount,
    charCount: assessment.charCount,
    reason:
      assessment.reason ??
      `Pasted text scored ${assessment.slopScore}/100 (${assessment.signalCount} AI tell${assessment.signalCount === 1 ? '' : 's'}).`,
  };
}

/**
 * Document-wide consistency checker (mixed US/UK spelling, hyphenation, product casing, versions),
 * delegating to `lexel-ui`'s canonical `scanConsistencyIssues`.
 */
export function checkDocumentConsistency(
  text: string,
  preferredDialect?: number,
): ConsistencyWarning[] {
  return scanConsistencyIssues(text, preferredDialect).map((issue) => ({
    kind: issue.kind === 'spelling_dialect' ? 'spelling_variant' : issue.kind,
    message: issue.message,
    variants: [issue.found, issue.preferred],
    start: issue.start,
    end: issue.end,
  }));
}

/**
 * BLUF (wall-of-text / buried ask), Regret Shield (abrasive tone / missing attachment),
 * and Personal Crutch-Word bans via `lexel-ui`'s canonical `scanWritingGuards`.
 */
export function checkWritingGuards(
  text: string,
  surfaceId: SurfaceId,
  options?: { crutchWords?: string[]; hasAttachmentSignal?: boolean },
): WritingGuardWarning[] {
  return scanWritingGuards(
    text,
    surfaceId,
    options?.crutchWords,
    options?.hasAttachmentSignal ?? false,
  ).map((hit) => {
    switch (hit.kind) {
      case 'wall_of_text':
        return {
          kind: 'bluf_wall_of_text',
          severity: hit.severity === 'warning' ? 'warn' : 'info',
          title: 'Wall of text',
          message: hit.message,
          problemText: hit.matchedText,
          start: hit.start,
          end: hit.end,
          suggestedTask: 'bluf',
          actionLabel: 'Lead with the ask',
        };
      case 'buried_ask':
        return {
          kind: 'bluf_buried_ask',
          severity: hit.severity === 'warning' ? 'warn' : 'info',
          title: 'Buried ask (BLUF)',
          message: hit.message,
          problemText: hit.matchedText,
          start: hit.start,
          end: hit.end,
          suggestedTask: 'bluf',
          actionLabel: 'Lead with the ask',
        };
      case 'abrasive_tone':
        return {
          kind: 'regret_abrasive',
          severity: 'warn',
          title: 'Regret Shield',
          message: hit.message,
          problemText: hit.matchedText,
          start: hit.start,
          end: hit.end,
          suggestedTask: 'softer',
          actionLabel: 'Keep it direct',
        };
      case 'missing_attachment':
        return {
          kind: 'regret_missing_attachment',
          severity: 'warn',
          title: 'Attachment check',
          message: hit.message,
          problemText: hit.matchedText,
          start: hit.start,
          end: hit.end,
        };
      default:
        return {
          kind: 'crutch_word',
          severity: 'info',
          title: 'Crutch word',
          message: hit.message,
          problemText: hit.matchedText,
          start: hit.start,
          end: hit.end,
          suggestedTask: 'shorten',
          actionLabel: 'Tighten draft',
        };
    }
  });
}

export function analyzeFullTier0(
  text: string,
  surfaceId: SurfaceId,
  options?: Pick<Tier0Options, 'customSlopTerms' | 'disabledSlopTerms'> & {
    crutchWords?: string[];
    hasAttachmentSignal?: boolean;
    preferredDialect?: number;
  },
): FullTier0Analysis {
  return {
    slopMeter: computeSlopMeter(text, options),
    consistencyWarnings: checkDocumentConsistency(text, options?.preferredDialect),
    guardWarnings: checkWritingGuards(text, surfaceId, options),
    engineSource: 'harper-js',
  };
}

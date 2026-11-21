import {
  type GuardAlertItem,
  type SlopMeterBreakdown,
  type SurfaceProfile,
  scanConsistencyIssues,
  scanTier0DiagnosticsShared,
  scanWritingGuards,
  scoreSlopMeter,
  type TonePillId,
} from 'lexel-ui';
import type { Tier0CheckResponse } from './types';

export interface LiveTier0Snapshot {
  slopScore: number;
  slopLabel: string;
  slopBreakdown: SlopMeterBreakdown;
  alerts: GuardAlertItem[];
}

function formatSlopLabel(label: string): string {
  switch (label) {
    case 'human':
      return 'Natural voice';
    case 'mild_ai':
      return 'Mild AI tells';
    case 'likely_ai':
      return 'Likely AI prose';
    case 'heavy_slop':
      return 'Heavy AI slop';
    default:
      return label;
  }
}

/**
 * Assemble live Tier 0 Slop Meter and Writing Guards signals for Studio's right inspector.
 * Uses @tier0's deterministic checks (`scoreSlopMeter`, `scanConsistencyIssues`,
 * `scanWritingGuards`, `scanTier0DiagnosticsShared`) in <2 ms with zero LLM calls.
 */
export function buildLiveTier0Snapshot(params: {
  text: string;
  profile: SurfaceProfile;
  dialect?: number;
  customSlopTerms: string[];
  disabledSlopTerms: string[];
  crutchWords: string[];
  tier0Response: Tier0CheckResponse | null;
  redactSecrets: boolean;
  onTriggerTone: (tone: TonePillId) => void;
  onBanCrutchWord: (word: string) => void;
  onRunSafeFix: () => void;
}): LiveTier0Snapshot {
  const {
    text,
    profile,
    dialect,
    customSlopTerms,
    disabledSlopTerms,
    crutchWords,
    tier0Response,
    redactSecrets,
    onTriggerTone,
    onBanCrutchWord,
    onRunSafeFix,
  } = params;

  const diag = scanTier0DiagnosticsShared(text, profile, {
    customSlopTerms,
    disabledSlopTerms,
    crutchWords,
    preferredDialect: dialect,
  });

  const meter = scoreSlopMeter(text, {
    allowEmDashes: profile.allowEmDashes,
    customSlopTerms,
    disabledSlopTerms,
    surfaceBannedOpeners: profile.bannedOpeners,
  });

  const slopScore = tier0Response?.slopMeter?.score ?? meter.score;
  const slopLabel = formatSlopLabel(meter.label);
  const slopBreakdown: SlopMeterBreakdown = tier0Response?.slopMeter
    ? {
        clicheCount: tier0Response.slopMeter.clicheCount,
        emDashCount: tier0Response.slopMeter.emDashCount,
        fillerOpenerCount: tier0Response.slopMeter.fillerOpenerCount,
        flatRhythm: tier0Response.slopMeter.flatRhythm,
      }
    : {
        clicheCount: meter.clicheCount,
        emDashCount: meter.emDashCount,
        fillerOpenerCount: meter.fillerOpenerCount,
        flatRhythm: meter.breakdown.flatRhythmPoints > 0,
      };

  const alerts: GuardAlertItem[] = [];

  // 1. Secrets Guard warnings
  for (const secret of diag.secrets) {
    alerts.push({
      id: `secret-${secret.kind}-${secret.start}`,
      kind: 'secret',
      severity: 'danger',
      title: `${secret.label} detected (${secret.maskedPreview})`,
      detail: redactSecrets
        ? 'Redact-and-restore is on: Lexel will swap this for a placeholder before local AI and restore it after.'
        : 'AI rewrites are blocked while this secret is in the draft. Remove it or enable Redact-and-Restore in Rules.',
    });
  }

  // 2. Document-Wide Consistency warnings (mixed US/UK spelling, hyphenation, product casing, versions)
  const consistencyIssues = scanConsistencyIssues(text, dialect);
  for (let i = 0; i < Math.min(4, consistencyIssues.length); i++) {
    const issue = consistencyIssues[i];
    alerts.push({
      id: `consistency-${issue.kind}-${issue.start}-${i}`,
      kind: 'consistency',
      severity: 'warn',
      title: `${issue.found} vs ${issue.preferred}`,
      detail: issue.message,
    });
  }

  // 3. Writing Guards (BLUF / wall-of-text, Regret Shield, missing attachment, personal crutch words)
  const guards = scanWritingGuards(text, profile.id, crutchWords, false);
  const seenCrutch = new Set<string>();
  const bannedLower = new Set(crutchWords.map((w) => w.toLowerCase()));

  for (let i = 0; i < guards.length; i++) {
    const g = guards[i];
    if (g.kind === 'wall_of_text' || g.kind === 'buried_ask') {
      alerts.push({
        id: `guard-${g.kind}-${g.start}-${i}`,
        kind: 'bluf',
        severity: 'warn',
        title: g.kind === 'wall_of_text' ? 'Wall of text detected' : 'Buried ask (BLUF)',
        detail: g.message,
        actionLabel: 'Lead with the ask',
        onAction: () => onTriggerTone('bluf'),
      });
    } else if (g.kind === 'abrasive_tone') {
      alerts.push({
        id: `guard-regret-${g.start}-${i}`,
        kind: 'regret',
        severity: 'warn',
        title: `Sharp phrasing: "${g.matchedText}"`,
        detail: g.message,
        actionLabel: 'Keep it direct, drop the edge',
        onAction: () => onTriggerTone('softer'),
      });
    } else if (g.kind === 'missing_attachment') {
      alerts.push({
        id: `guard-attach-${g.start}-${i}`,
        kind: 'regret',
        severity: 'warn',
        title: 'Attachment referenced',
        detail: g.message,
      });
    } else if (g.kind === 'crutch_word') {
      const word = g.matchedText.toLowerCase();
      if (seenCrutch.has(word)) continue;
      seenCrutch.add(word);
      const alreadyBanned = bannedLower.has(word);
      alerts.push({
        id: `guard-crutch-${word}`,
        kind: 'crutch',
        severity: 'info',
        title: `Crutch word "${g.matchedText}"`,
        detail: g.message,
        actionLabel: alreadyBanned ? undefined : `Ban "${word}"`,
        onAction: alreadyBanned ? undefined : () => onBanCrutchWord(word),
      });
    }
  }

  // 4. Hidden Unicode / Invisible characters
  if (diag.invisibleLints.length > 0) {
    alerts.push({
      id: 'invisible-chars',
      kind: 'invisible',
      severity: 'warn',
      title: `${diag.invisibleLints.length} hidden Unicode watermark${diag.invisibleLints.length === 1 ? '' : 's'}`,
      detail: 'Zero-width or directional characters found in the draft.',
      actionLabel: 'Strip cleanly',
      onAction: onRunSafeFix,
    });
  }

  // 5. Surface rule violations
  for (let i = 0; i < Math.min(3, diag.surfaceLints.length); i++) {
    const sl = diag.surfaceLints[i];
    alerts.push({
      id: `surface-${i}-${sl.span.start}`,
      kind: 'surface',
      severity: 'warn',
      title: `${profile.label} rule`,
      detail: sl.message_html.replace(/<[^>]+>/g, ''),
    });
  }

  return {
    slopScore,
    slopLabel,
    slopBreakdown,
    alerts,
  };
}

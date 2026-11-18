import surfacesData from '../../../../ml/personas/surfaces.json';
import type { GateCheckSummary } from '../components/RewriteDiffCard';
import {
  SLOP_TERMS,
  applySafeFixesForProfile,
  findSlopMatchesWithConfig,
  ignoredProseRanges,
  overlapsIgnoredRanges,
  scanSecretsAndPii,
  type SafeFixResult,
  type SecretMatch,
  type SlopHit,
} from './secretsAndFixes';
import type {
  SurfaceId,
  SurfaceProfile,
  Tier0Lint,
  Tier0Options,
  UnitBoundMetric,
} from './types';

export const BUILTIN_SURFACES: readonly SurfaceProfile[] =
  surfacesData.surfaces as SurfaceProfile[];

const GENERAL_SURFACE: SurfaceProfile =
  BUILTIN_SURFACES.find((s) => s.id === 'general') ?? {
    id: 'general',
    label: 'General',
    hostPatterns: ['*'],
    register: 'clear_human',
    minChars: 4,
    maxChars: 8000,
    allowLinks: true,
    allowEmojis: true,
    allowHashtags: true,
    allowEmDashes: false,
    bannedOpeners: [],
    promptDirective:
      'Edit for clarity, active verbs, and natural human rhythm. Preserve every fact, number, URL, and code token.',
    quickActions: [
      { id: 'fix_grammar_flow', label: 'Fix & polish' },
      { id: 'deslop', label: 'Remove AI tone' },
      { id: 'shorten', label: 'Shorten' },
    ],
  };

const EMOJI_REGEX = /\p{Extended_Pictographic}/gu;
const URL_REGEX = /https?:\/\/[^\s<>()]+/gi;
const HASHTAG_REGEX = /(?:^|\s)(#[a-zA-Z][a-zA-Z0-9_]{1,})/g;
const BACKTICK_OR_FLAG_REGEX =
  /`[^`]+`|https?:\/\/[^\s<>()]+|(?:^|\s)(--?[a-zA-Z0-9_-]{2,})/g;
const METRIC_REGEX =
  /(?<prefix>#|\$|€|£)?(?<num>\d[\d,]*(?:\.\d+)?)(?<suffix>%|ms|s|x|k|m|b|mb|gb|kb|px)?/gi;

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function stableHash(key: string): string {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `lexel_${(hash >>> 0).toString(16)}`;
}

export function resolveSurfaceProfileShared(
  id: SurfaceId,
  customSurfaces?: SurfaceProfile[],
): SurfaceProfile {
  return (
    customSurfaces?.find((s) => s.id === id) ??
    BUILTIN_SURFACES.find((s) => s.id === id) ??
    GENERAL_SURFACE
  );
}

export function extractUnitBoundMetrics(text: string): UnitBoundMetric[] {
  const results: UnitBoundMetric[] = [];
  for (const match of text.matchAll(METRIC_REGEX)) {
    const groups = match.groups;
    if (!groups?.num) continue;
    const prefix = groups.prefix ?? '';
    const suffix = (groups.suffix ?? '').toLowerCase();
    const unit = prefix || suffix || 'plain';
    const value = groups.num.replaceAll(',', '');
    results.push({
      raw: match[0],
      value,
      unit,
    });
  }
  return results;
}

export function extractCodeAndUrlTokens(text: string): string[] {
  const matches = text.match(BACKTICK_OR_FLAG_REGEX) ?? [];
  return [...new Set(matches.map((m) => m.trim()).filter(Boolean))];
}

export function findSlopMatches(
  text: string,
  options?: { customTerms?: string[]; disabledTerms?: string[] },
): SlopHit[] {
  return findSlopMatchesWithConfig(text, SLOP_TERMS, options);
}

function makeLint(
  text: string,
  start: number,
  end: number,
  lintKind: string,
  lintKindPretty: string,
  messageHtml: string,
  suggestions: Array<{ kind: number; replacement_text: string }> = [],
): Tier0Lint {
  return {
    span: { start, end },
    message_html: messageHtml,
    problem_text: text.slice(start, end),
    lint_kind: lintKind,
    lint_kind_pretty: lintKindPretty,
    suggestions,
    context_hash: stableHash(`${lintKindPretty}:${start}:${text.slice(start, end)}`),
    source: text,
  };
}

/** Scan text for deterministic slop, surface violations, commit conventions, and secrets. */
export function scanTier0DiagnosticsShared(
  text: string,
  profile: SurfaceProfile,
  options?: Tier0Options,
): {
  slopLints: Tier0Lint[];
  surfaceLints: Tier0Lint[];
  secretLints: Tier0Lint[];
  secrets: SecretMatch[];
} {
  const slopLints: Tier0Lint[] = [];
  const surfaceLints: Tier0Lint[] = [];
  const secretLints: Tier0Lint[] = [];
  const ignored = ignoredProseRanges(text);

  for (const hit of findSlopMatches(text, {
    customTerms: options?.customSlopTerms,
    disabledTerms: options?.disabledSlopTerms,
  })) {
    const suggestions =
      hit.suggestion !== undefined
        ? [
            {
              kind: hit.suggestion === '' ? 1 : 0,
              replacement_text: hit.suggestion,
            },
          ]
        : [];
    const hint = hit.suggestion !== undefined
      ? hit.suggestion === ''
        ? `Common AI filler (<code>${escapeHtml(hit.term)}</code>). Remove it cleanly.`
        : `Common AI buzzword (<code>${escapeHtml(hit.term)}</code>). Replace with <code>${escapeHtml(hit.suggestion)}</code>.`
      : `Common AI buzzword ("${escapeHtml(hit.term)}"). Use specific, plain phrasing.`;

    slopLints.push(
      makeLint(
        text,
        hit.start,
        hit.end,
        'Style',
        'LexelAntiSlop',
        hint,
        suggestions,
      ),
    );
  }

  if (!profile.allowEmDashes) {
    for (const match of text.matchAll(/\s*—\s*/g)) {
      if (typeof match.index !== 'number') continue;
      const start = match.index;
      const end = start + match[0].length;
      if (overlapsIgnoredRanges(start, end, ignored)) continue;
      slopLints.push(
        makeLint(
          text,
          start,
          end,
          'Punctuation',
          'LexelAntiSlop',
          'Em dash detected. Replace with a comma, period, or parentheses.',
          [{ kind: 0, replacement_text: ', ' }],
        ),
      );
    }
  }

  if (!profile.allowLinks) {
    for (const match of text.matchAll(URL_REGEX)) {
      if (typeof match.index !== 'number') continue;
      const start = match.index;
      const end = start + match[0].length;
      if (overlapsIgnoredRanges(start, end, ignored)) continue;
      surfaceLints.push(
        makeLint(
          text,
          start,
          end,
          'Miscellaneous',
          'LexelSurface',
          `Links are disallowed on ${escapeHtml(profile.label)}. Remove URL before posting.`,
        ),
      );
    }
  }

  if (!profile.allowHashtags) {
    for (const match of text.matchAll(HASHTAG_REGEX)) {
      if (typeof match.index !== 'number' || !match[1]) continue;
      const offset = match.index + match[0].indexOf(match[1]);
      const end = offset + match[1].length;
      if (overlapsIgnoredRanges(offset, end, ignored)) continue;
      surfaceLints.push(
        makeLint(
          text,
          offset,
          end,
          'Style',
          'LexelSurface',
          `Hashtags are flagged on ${escapeHtml(profile.label)}.`,
          [{ kind: 1, replacement_text: '' }],
        ),
      );
    }
  }

  if (!profile.allowEmojis) {
    for (const match of text.matchAll(EMOJI_REGEX)) {
      if (typeof match.index !== 'number') continue;
      const start = match.index;
      const end = start + match[0].length;
      if (overlapsIgnoredRanges(start, end, ignored)) continue;
      surfaceLints.push(
        makeLint(
          text,
          start,
          end,
          'Style',
          'LexelSurface',
          `Avoid decorative emojis on ${escapeHtml(profile.label)}.`,
          [{ kind: 1, replacement_text: '' }],
        ),
      );
    }
  }

  if (profile.id !== 'web_discord_slack') {
    for (const match of text.matchAll(/[!?]{3,}/g)) {
      if (typeof match.index !== 'number') continue;
      const start = match.index;
      const end = start + match[0].length;
      if (overlapsIgnoredRanges(start, end, ignored)) continue;
      const single = match[0][0] === '?' ? '?' : '!';
      surfaceLints.push(
        makeLint(
          text,
          start,
          end,
          'Punctuation',
          'LexelSurface',
          `Repeated punctuation (${escapeHtml(match[0])}) weakens tone on ${escapeHtml(profile.label)}.`,
          [{ kind: 0, replacement_text: single }],
        ),
      );
    }
  }

  const lower = text.toLowerCase();
  for (const opener of profile.bannedOpeners) {
    const idx = lower.indexOf(opener.toLowerCase());
    if (idx !== -1 && !overlapsIgnoredRanges(idx, idx + opener.length, ignored)) {
      surfaceLints.push(
        makeLint(
          text,
          idx,
          idx + opener.length,
          'Style',
          'LexelSurface',
          `Weak/engagement-bait opener ("${escapeHtml(text.slice(idx, idx + opener.length))}") for ${escapeHtml(profile.label)}.`,
        ),
      );
    }
  }

  if (profile.id === 'ide_git_commit') {
    const firstNewline = text.indexOf('\n');
    const subjectRaw = firstNewline === -1 ? text : text.slice(0, firstNewline);
    const subjectTrimmed = subjectRaw.trimEnd();
    if (subjectTrimmed.length > 72) {
      surfaceLints.push(
        makeLint(
          text,
          72,
          subjectTrimmed.length,
          'Style',
          'LexelSurface',
          `Git commit subject exceeds 72 characters (${subjectTrimmed.length} chars).`,
        ),
      );
    }
    if (subjectTrimmed.endsWith('.')) {
      const dotPos = subjectTrimmed.length - 1;
      surfaceLints.push(
        makeLint(
          text,
          dotPos,
          dotPos + 1,
          'Punctuation',
          'LexelSurface',
          'Omit trailing period on Git commit subject line.',
          [{ kind: 1, replacement_text: '' }],
        ),
      );
    }
    const nonConventionalMatch = /^(?:added|fixed|updated|removed|refactored)\b/i.exec(
      subjectTrimmed,
    );
    if (nonConventionalMatch) {
      surfaceLints.push(
        makeLint(
          text,
          0,
          nonConventionalMatch[0].length,
          'Style',
          'LexelSurface',
          `Use imperative verb mood ("${escapeHtml(nonConventionalMatch[0].replace(/(?:ed|d)$/i, ''))}") instead of past tense in commit titles.`,
        ),
      );
    }
  }

  if (text.length > profile.maxChars) {
    surfaceLints.push(
      makeLint(
        text,
        profile.maxChars,
        text.length,
        'Miscellaneous',
        'LexelSurface',
        `Exceeds ${escapeHtml(profile.label)} target length (${text.length}/${profile.maxChars} chars).`,
      ),
    );
  }

  const secrets = scanSecretsAndPii(text);
  for (const secret of secrets) {
    secretLints.push(
      makeLint(
        text,
        secret.start,
        secret.end,
        'Security',
        'LexelSecrets',
        `Detected ${escapeHtml(secret.label)} (${escapeHtml(secret.maskedPreview)}). Redact or remove before sending.`,
        [{ kind: 0, replacement_text: '[REDACTED]' }],
      ),
    );
  }

  return { slopLints, surfaceLints, secretLints, secrets };
}

export function applySafeDeterministicFixesShared(
  text: string,
  profile: SurfaceProfile,
  options?: Tier0Options,
): SafeFixResult {
  return applySafeFixesForProfile(
    text,
    profile,
    options?.disabledSlopTerms,
    options?.customSlopTerms,
  );
}

export function sanitizeModelOutput(raw: string): string {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (cleaned.startsWith('```') && cleaned.endsWith('```')) {
    cleaned = cleaned.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
  }
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    if (cleaned.length >= 2) {
      cleaned = cleaned.slice(1, -1).trim();
    }
  }
  return cleaned;
}

export function verifyAiRewriteShared(
  source: string,
  candidate: string,
  profile: SurfaceProfile,
  options?: Tier0Options,
): GateCheckSummary {
  const warnings: string[] = [];

  const slopHits = findSlopMatches(candidate, {
    customTerms: options?.customSlopTerms,
    disabledTerms: options?.disabledSlopTerms,
  });
  const hasEmDash = !profile.allowEmDashes && /—/.test(candidate);
  const zeroSlop = slopHits.length === 0 && !hasEmDash;
  if (slopHits.length > 0) {
    warnings.push(`Contains AI phrasing: ${slopHits.map((s) => `"${s.term}"`).join(', ')}`);
  }
  if (hasEmDash) {
    warnings.push('Contains forbidden em dash.');
  }

  const sourceMetrics = extractUnitBoundMetrics(source);
  const candidateMetrics = extractUnitBoundMetrics(candidate);
  const missingOrChangedMetrics = sourceMetrics.filter(
    (sm) => !candidateMetrics.some((cm) => cm.value === sm.value && cm.unit === sm.unit),
  );
  const inventedMetrics = candidateMetrics.filter(
    (cm) => !sourceMetrics.some((sm) => sm.value === cm.value && sm.unit === cm.unit),
  );
  const numbersPreserved = missingOrChangedMetrics.length === 0 && inventedMetrics.length === 0;
  if (!numbersPreserved) {
    if (missingOrChangedMetrics.length > 0) {
      warnings.push(
        `Missing/altered numbers: ${missingOrChangedMetrics.map((m) => m.raw).join(', ')}`,
      );
    }
    if (inventedMetrics.length > 0) {
      warnings.push(`Invented numbers: ${inventedMetrics.map((m) => m.raw).join(', ')}`);
    }
  }

  const sourceTokens = extractCodeAndUrlTokens(source);
  const missingTokens = sourceTokens.filter((tok) => !candidate.includes(tok));
  const tokensPreserved = missingTokens.length === 0;
  if (!tokensPreserved) {
    warnings.push(`Dropped code/URL token: ${missingTokens.join(', ')}`);
  }

  const { surfaceLints, secrets } = scanTier0DiagnosticsShared(candidate, profile, options);
  const surfaceCompliant = surfaceLints.length === 0 && candidate.length <= profile.maxChars;
  if (!surfaceCompliant) {
    if (candidate.length > profile.maxChars) {
      warnings.push(
        `Exceeds ${profile.label} limit (${candidate.length}/${profile.maxChars} chars).`,
      );
    }
    for (const lint of surfaceLints) {
      if (!lint.message_html.includes('Exceeds')) {
        warnings.push(lint.message_html);
      }
    }
  }
  if (secrets.length > 0) {
    warnings.push(`Contains potential secret/PII: ${secrets.map((s) => s.label).join(', ')}`);
  }

  return {
    zeroSlop,
    numbersPreserved,
    tokensPreserved,
    surfaceCompliant,
    warnings,
  };
}

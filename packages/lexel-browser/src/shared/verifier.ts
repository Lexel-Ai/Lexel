import { SuggestionKind } from 'harper.js';
import {
  applySafeFixesForProfile,
  findSlopMatchesWithConfig,
  hasSecrets,
  scanSecretsAndPii,
  SLOP_SAFE_REPLACEMENTS,
  type GateCheckSummary,
  type SafeFixResult,
  type SecretMatch,
} from 'lexel-ui';
import type { UnpackedLint } from 'lint-framework';
import slopConfig from '../../../../rules/slop_terms.json';
import { resolveSurfaceProfile } from './surfaceDetector';
import type { SurfaceId, SurfaceProfile } from './types';

export const SLOP_TERMS: string[] = slopConfig.slopTerms;
export { hasSecrets, scanSecretsAndPii, SLOP_SAFE_REPLACEMENTS };
export type { SafeFixResult, SecretMatch };

export interface UnitBoundMetric {
  raw: string;
  value: number;
  unit: string;
}

export interface Tier0Options {
  customSlopTerms?: string[];
  disabledSlopTerms?: string[];
  customSurfaces?: SurfaceProfile[];
}

const UNIT_BOUND_REGEX =
  /(?<=^|[\s(\[])(#|\$)?(\d+(?:[.,]\d+)?)\s*(%|ms|s|sec|min|hrs?|kb|mb|gb|x|k|m|b)?(?=[\s,.;:!?/\)\]]|$)/gi;

const URL_REGEX = /https?:\/\/[^\s)>\]]+/gi;
const BACKTICK_REGEX = /`[^`\n]+`/g;
// Hashtags start with a letter so issue/PR references like #42 are never flagged.
const HASHTAG_REGEX = /(^|\s)(#[a-zA-Z][a-zA-Z0-9_]{1,})/g;
const EMOJI_REGEX = /\p{Extended_Pictographic}/gu;

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString();
}

export function extractUnitBoundMetrics(text: string): UnitBoundMetric[] {
  const metrics: UnitBoundMetric[] = [];
  for (const match of text.matchAll(UNIT_BOUND_REGEX)) {
    const prefix = match[1] ?? '';
    const numStr = (match[2] ?? '').replace(/,/g, '');
    const value = Number.parseFloat(numStr);
    if (Number.isNaN(value)) continue;
    const suffix = (match[3] ?? '').toLowerCase();
    const unit = prefix || suffix || 'count';
    metrics.push({ raw: match[0].trim(), value, unit });
  }
  return metrics;
}

export function extractCodeAndUrlTokens(text: string): string[] {
  const backticks = text.match(BACKTICK_REGEX) ?? [];
  const urls = text.match(URL_REGEX) ?? [];
  return [...new Set([...backticks, ...urls])];
}

export function findSlopMatches(
  text: string,
  options?: { customTerms?: string[]; disabledTerms?: string[] },
): Array<{ term: string; start: number; end: number }> {
  return findSlopMatchesWithConfig(text, SLOP_TERMS, options);
}

export function scanTier0Diagnostics(
  text: string,
  surfaceOrId: SurfaceId | SurfaceProfile,
  options?: Tier0Options,
): {
  slopLints: UnpackedLint[];
  surfaceLints: UnpackedLint[];
  secretLints: UnpackedLint[];
  secrets: SecretMatch[];
} {
  const profile =
    typeof surfaceOrId === 'string'
      ? resolveSurfaceProfile(surfaceOrId, options?.customSurfaces)
      : surfaceOrId;
  const slopLints: UnpackedLint[] = [];
  const surfaceLints: UnpackedLint[] = [];
  const secretLints: UnpackedLint[] = [];

  for (const hit of findSlopMatches(text, {
    customTerms: options?.customSlopTerms,
    disabledTerms: options?.disabledSlopTerms,
  })) {
    slopLints.push({
      span: { start: hit.start, end: hit.end },
      message_html: `Common AI buzzword ("${hit.term}"). Use specific, plain phrasing.`,
      problem_text: hit.term,
      lint_kind: 'Style',
      lint_kind_pretty: 'Anti-Slop',
      suggestions: [],
      context_hash: stableHash(`slop:${hit.start}:${hit.term}`),
      source: text,
    });
  }

  if (!profile.allowEmDashes) {
    const emDashRegex = /\s*—\s*|\s+--\s+/g;
    for (const match of text.matchAll(emDashRegex)) {
      if (typeof match.index !== 'number') continue;
      const start = match.index;
      const end = start + match[0].length;
      slopLints.push({
        span: { start, end },
        message_html: 'Em dash detected. Replace with a comma, period, or parentheses.',
        problem_text: match[0],
        lint_kind: 'Punctuation',
        lint_kind_pretty: 'Anti-Slop',
        suggestions: [
          { kind: SuggestionKind.Replace, replacement_text: ', ' },
          { kind: SuggestionKind.Replace, replacement_text: '. ' },
        ],
        context_hash: stableHash(`emdash:${start}`),
        source: text,
      });
    }
  }

  const lowerTrimmed = text.trimStart().toLowerCase();
  const leadingOffset = text.length - text.trimStart().length;
  for (const opener of profile.bannedOpeners) {
    if (lowerTrimmed.startsWith(opener)) {
      const start = leadingOffset;
      const end = start + opener.length;
      surfaceLints.push({
        span: { start, end },
        message_html: `Generic opener on ${profile.label}. Start directly with your point.`,
        problem_text: text.slice(start, end),
        lint_kind: 'Style',
        lint_kind_pretty: `${profile.label} Tone`,
        suggestions: [{ kind: SuggestionKind.Remove, replacement_text: '' }],
        context_hash: stableHash(`opener:${opener}`),
        source: text,
      });
      break;
    }
  }

  if (!profile.allowLinks) {
    for (const match of text.matchAll(URL_REGEX)) {
      if (typeof match.index !== 'number') continue;
      surfaceLints.push({
        span: { start: match.index, end: match.index + match[0].length },
        message_html: `External links are often auto-removed or flagged as spam on ${profile.label}.`,
        problem_text: match[0],
        lint_kind: 'Enhancement',
        lint_kind_pretty: `${profile.label} Rule`,
        suggestions: [],
        context_hash: stableHash(`link:${match.index}:${match[0]}`),
        source: text,
      });
    }
  }

  if (!profile.allowHashtags) {
    for (const match of text.matchAll(HASHTAG_REGEX)) {
      if (typeof match.index !== 'number') continue;
      const tag = match[2];
      const start = match.index + match[1].length;
      surfaceLints.push({
        span: { start, end: start + tag.length },
        message_html: `Hashtags reduce signal quality on ${profile.label}.`,
        problem_text: tag,
        lint_kind: 'Style',
        lint_kind_pretty: `${profile.label} Rule`,
        suggestions: [{ kind: SuggestionKind.Remove, replacement_text: '' }],
        context_hash: stableHash(`tag:${start}:${tag}`),
        source: text,
      });
    }
  }

  if (!profile.allowEmojis) {
    for (const match of text.matchAll(EMOJI_REGEX)) {
      if (typeof match.index !== 'number') continue;
      surfaceLints.push({
        span: { start: match.index, end: match.index + match[0].length },
        message_html: `Decorative emoji flagged by ${profile.label} profile.`,
        problem_text: match[0],
        lint_kind: 'Style',
        lint_kind_pretty: `${profile.label} Rule`,
        suggestions: [{ kind: SuggestionKind.Remove, replacement_text: '' }],
        context_hash: stableHash(`emoji:${match.index}`),
        source: text,
      });
    }
  }

  if (text.length > profile.maxChars) {
    surfaceLints.push({
      span: { start: profile.maxChars, end: text.length },
      message_html: `Exceeds ${profile.label} character target (${text.length}/${profile.maxChars}).`,
      problem_text: text.slice(profile.maxChars, Math.min(text.length, profile.maxChars + 24)),
      lint_kind: 'Readability',
      lint_kind_pretty: `${profile.label} Length`,
      suggestions: [],
      context_hash: stableHash(`len:${profile.id}:${text.length}`),
      source: text,
    });
  }

  const secrets = scanSecretsAndPii(text);
  for (const secret of secrets) {
    secretLints.push({
      span: { start: secret.start, end: secret.end },
      message_html: `Sensitive ${secret.label} (${secret.maskedPreview}) detected. Keep secrets out of public drafts and AI prompts.`,
      problem_text: secret.maskedPreview,
      lint_kind: 'Miscellaneous',
      lint_kind_pretty: 'Secrets Guard',
      suggestions: [],
      context_hash: stableHash(`secret:${secret.kind}:${secret.start}`),
      source: text,
    });
  }

  return { slopLints, surfaceLints, secretLints, secrets };
}

export function applySafeDeterministicFixes(
  text: string,
  surfaceOrId: SurfaceId | SurfaceProfile,
  options?: Tier0Options,
): SafeFixResult {
  const profile =
    typeof surfaceOrId === 'string'
      ? resolveSurfaceProfile(surfaceOrId, options?.customSurfaces)
      : surfaceOrId;
  return applySafeFixesForProfile(text, profile, options?.disabledSlopTerms);
}

export function sanitizeModelOutput(raw: string): string {
  let cleaned = raw.trim();
  // Strip accidental markdown fences or <think> tags if an untrained model emits them.
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (cleaned.startsWith('```') && cleaned.endsWith('```')) {
    cleaned = cleaned.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
  }
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned;
}

export function verifyAiRewrite(
  source: string,
  candidate: string,
  surfaceId: SurfaceId,
  options?: Tier0Options,
): GateCheckSummary {
  const profile = resolveSurfaceProfile(surfaceId, options?.customSurfaces);
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
    warnings.push('Contains an em dash.');
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
        `Source number altered/dropped: ${missingOrChangedMetrics.map((m) => m.raw).join(', ')}`,
      );
    }
    if (inventedMetrics.length > 0) {
      warnings.push(
        `Ungrounded number introduced: ${inventedMetrics.map((m) => m.raw).join(', ')}`,
      );
    }
  }

  const sourceTokens = extractCodeAndUrlTokens(source);
  const missingTokens = sourceTokens.filter((tok) => !candidate.includes(tok));
  const tokensPreserved = missingTokens.length === 0;
  if (!tokensPreserved) {
    warnings.push(`Dropped code/URL token: ${missingTokens.join(', ')}`);
  }

  const { surfaceLints, secrets } = scanTier0Diagnostics(candidate, profile, options);
  const surfaceCompliant = surfaceLints.length === 0 && candidate.length <= profile.maxChars;
  if (!surfaceCompliant) {
    if (candidate.length > profile.maxChars) {
      warnings.push(`Exceeds ${profile.label} limit (${candidate.length}/${profile.maxChars} chars).`);
    }
    for (const lint of surfaceLints) {
      if (!lint.message_html.includes('Exceeds')) {
        warnings.push(lint.message_html);
      }
    }
  }

  const secretsFree = secrets.length === 0;
  for (const secret of secrets) {
    warnings.push(`Sensitive ${secret.label} (${secret.maskedPreview}) detected.`);
  }

  return {
    zeroSlop,
    numbersPreserved,
    tokensPreserved,
    surfaceCompliant,
    secretsFree,
    warnings,
  };
}

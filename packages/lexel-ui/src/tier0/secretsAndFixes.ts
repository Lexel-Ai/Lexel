import slopConfig from '../../../../rules/slop_terms.json';
import type { ReadabilityMetrics, RulePresetDefinition, RulePresetId, Tier0Lint } from './types';

export interface SecretMatch {
  kind: string;
  label: string;
  start: number;
  end: number;
  maskedPreview: string;
}

export interface SafeFixSurfacePolicy {
  allowEmDashes: boolean;
  allowHashtags: boolean;
  allowEmojis: boolean;
}

export interface SafeFixResult {
  text: string;
  fixesApplied: number;
  categories: string[];
}

export interface SlopHit {
  term: string;
  start: number;
  end: number;
  suggestion?: string;
}

export const SLOP_TERMS: string[] = [...slopConfig.slopTerms];

const SAFE_REPLACEMENT_MAP: ReadonlyMap<string, string> = new Map(
  Object.entries(slopConfig.safeReplacements as Record<string, string>).map(([k, v]) => [
    k.toLowerCase(),
    v,
  ]),
);

export const SLOP_SAFE_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = Object.entries(
  slopConfig.safeReplacements as Record<string, string>,
).sort((a, b) => b[0].length - a[0].length);

const EMOJI_REGEX = /\p{Extended_Pictographic}/gu;
const CARD_CANDIDATE_REGEX = /(?:^|\b|\s)(\d(?:[\s-]?\d){12,18})(?=\b|$)/g;

const SECRET_RULES: Array<{ kind: string; label: string; regex: RegExp }> = [
  {
    kind: 'private_key',
    label: 'Private key block',
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    kind: 'jwt',
    label: 'JSON Web Token',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    kind: 'github_token',
    label: 'GitHub personal access token',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  {
    kind: 'stripe_key',
    label: 'Stripe API key',
    regex: /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g,
  },
  {
    kind: 'huggingface_token',
    label: 'Hugging Face access token',
    regex: /\bhf_[A-Za-z0-9]{20,}\b/g,
  },
  {
    kind: 'npm_token',
    label: 'npm access token',
    regex: /\bnpm_[A-Za-z0-9]{20,}\b/g,
  },
  {
    kind: 'discord_webhook',
    label: 'Discord webhook URL',
    regex:
      /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/g,
  },
  {
    kind: 'aws_access_key',
    label: 'AWS access key ID',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    kind: 'google_api_key',
    label: 'Google API key',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    kind: 'slack_token',
    label: 'Slack token',
    regex: /\bxox[baprs]-[0-9A-Za-z-]{16,}\b/g,
  },
  {
    kind: 'api_key',
    label: 'API secret key',
    regex: /\bsk-(?:proj-|ant-[a-z0-9-]+-)?[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    kind: 'bearer_token',
    label: 'Bearer auth header',
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  },
  {
    kind: 'env_secret',
    label: 'Environment credential assignment',
    regex:
      /\b[A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_TOKEN|PRIVATE_KEY|AUTH_TOKEN)\s*=\s*['"]?[A-Za-z0-9._~+/=-]{12,}['"]?/gim,
  },
  {
    kind: 'ssn',
    label: 'US SSN-like number',
    regex:
      /\b(?:00[1-9]|0[1-9]\d|[1-5]\d{2}|6(?:[0-5]\d|6[0-5]|6[7-9]|[7-9]\d)|[78]\d{2})-(?:0[1-9]|[1-9]\d)-(?:000[1-9]|00[1-9]\d|0[1-9]\d{2}|[1-9]\d{3})\b/g,
  },
];

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function maskSecretValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= 6) return '[REDACTED]';
  return `${trimmed.slice(0, 3)}***(${trimmed.length} chars)`;
}

function passesLuhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19 || /^0+$/.test(digits)) {
    return false;
  }
  let sum = 0;
  let doubleNext = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (doubleNext) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    doubleNext = !doubleNext;
  }
  return sum % 10 === 0;
}

/** Deterministically scan text for credentials, tokens, private key headers, SSNs, and Luhn cards. */
export function scanSecretsAndPii(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const rule of SECRET_RULES) {
    for (const match of text.matchAll(rule.regex)) {
      if (typeof match.index !== 'number') continue;
      const start = match.index;
      const end = start + match[0].length;
      if (matches.some((m) => start < m.end && end > m.start)) continue;
      matches.push({
        kind: rule.kind,
        label: rule.label,
        start,
        end,
        maskedPreview: maskSecretValue(match[0]),
      });
    }
  }
  for (const match of text.matchAll(CARD_CANDIDATE_REGEX)) {
    if (typeof match.index !== 'number' || !match[1]) continue;
    const rawCard = match[1];
    const digits = rawCard.replace(/\D/g, '');
    if (!passesLuhn(digits)) continue;
    const start = match.index + match[0].indexOf(rawCard);
    const end = start + rawCard.length;
    if (!matches.some((m) => start < m.end && end > m.start)) {
      matches.push({
        kind: 'payment_card',
        label: 'Payment card number',
        start,
        end,
        maskedPreview: maskSecretValue(rawCard),
      });
    }
  }
  matches.sort((a, b) => a.start - b.start || a.end - b.end);
  return matches;
}

export function hasSecrets(text: string): boolean {
  return scanSecretsAndPii(text).length > 0;
}

/**
 * Identify UTF-16 [start, end] ranges inside fenced code blocks, inline code spans,
 * and Markdown quote lines so style/slop rules do not produce false positives on code or quotes.
 */
export function ignoredProseRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(/```[\s\S]*?(?:```|$)/g)) {
    if (typeof match.index === 'number') {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  for (const match of text.matchAll(/`[^`\n]+`/g)) {
    if (typeof match.index === 'number') {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  for (const match of text.matchAll(/^[ \t]*>[^\n]*/gm)) {
    if (typeof match.index === 'number') {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  if (ranges.length <= 1) return ranges;

  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = ranges[i];
    if (curr[0] <= prev[1]) {
      prev[1] = Math.max(prev[1], curr[1]);
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

export function overlapsIgnoredRanges(
  start: number,
  end: number,
  ranges: ReadonlyArray<readonly [number, number]>,
): boolean {
  return ranges.some(([rStart, rEnd]) => start < rEnd && end > rStart);
}

/** Parse optional `"term => replacement"` syntax used for user-defined slop overrides. */
export function parseCustomSlopEntry(raw: string): { term: string; replacement?: string } {
  const idx = raw.indexOf('=>');
  if (idx >= 0) {
    const term = raw.slice(0, idx).trim();
    const replacement = raw.slice(idx + 2).trim();
    return { term, replacement };
  }
  return { term: raw.trim() };
}

export function findSlopMatchesWithConfig(
  text: string,
  baseTerms: readonly string[],
  options?: { customTerms?: string[]; disabledTerms?: string[] },
): SlopHit[] {
  const disabledSet = new Set(
    (options?.disabledTerms ?? [])
      .map((t) => parseCustomSlopEntry(t).term.toLowerCase())
      .filter(Boolean),
  );
  const terms = new Map<string, string | undefined>();
  for (const t of baseTerms) {
    if (!disabledSet.has(t.toLowerCase())) {
      terms.set(t, SAFE_REPLACEMENT_MAP.get(t.toLowerCase()));
    }
  }
  for (const raw of options?.customTerms ?? []) {
    const parsed = parseCustomSlopEntry(raw);
    if (parsed.term && !disabledSet.has(parsed.term.toLowerCase())) {
      terms.set(
        parsed.term,
        parsed.replacement !== undefined
          ? parsed.replacement
          : SAFE_REPLACEMENT_MAP.get(parsed.term.toLowerCase()),
      );
    }
  }

  const ignored = ignoredProseRanges(text);
  const hits: SlopHit[] = [];
  for (const [term, suggestion] of terms.entries()) {
    const regex = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi');
    for (const match of text.matchAll(regex)) {
      if (typeof match.index !== 'number') continue;
      const start = match.index;
      const end = start + match[0].length;
      if (overlapsIgnoredRanges(start, end, ignored)) continue;
      hits.push({
        term: match[0],
        start,
        end,
        suggestion,
      });
    }
  }
  hits.sort((a, b) => a.start - b.start || a.end - b.end);
  return hits;
}

function preserveMatchedCase(matched: string, replacement: string): string {
  if (!replacement) return '';
  const first = matched[0];
  if (first && first >= 'A' && first <= 'Z') {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function splitProseAndIgnored(text: string): Array<{ slice: string; ignored: boolean }> {
  const ranges = ignoredProseRanges(text);
  if (ranges.length === 0) return [{ slice: text, ignored: false }];
  const parts: Array<{ slice: string; ignored: boolean }> = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) {
      parts.push({ slice: text.slice(cursor, start), ignored: false });
    }
    parts.push({ slice: text.slice(start, end), ignored: true });
    cursor = end;
  }
  if (cursor < text.length) {
    parts.push({ slice: text.slice(cursor), ignored: false });
  }
  return parts;
}

function buildReplacementPairs(
  disabledSet: ReadonlySet<string>,
  customSlopTerms?: readonly string[],
): Array<readonly [string, string]> {
  const pairs: Array<readonly [string, string]> = [];
  const customMap = new Map<string, string>();
  for (const raw of customSlopTerms ?? []) {
    const parsed = parseCustomSlopEntry(raw);
    if (
      parsed.term &&
      parsed.replacement !== undefined &&
      !disabledSet.has(parsed.term.toLowerCase())
    ) {
      customMap.set(parsed.term.toLowerCase(), parsed.replacement);
      pairs.push([parsed.term, parsed.replacement]);
    }
  }
  for (const [phrase, replacement] of SLOP_SAFE_REPLACEMENTS) {
    const key = phrase.trim().toLowerCase();
    if (disabledSet.has(key) || customMap.has(key)) continue;
    pairs.push([phrase, replacement]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs;
}

/** Deterministically clean safe slop phrases, em dashes, emojis, and hashtags outside code/quote blocks. */
export function applySafeFixesForProfile(
  text: string,
  policy: SafeFixSurfacePolicy,
  disabledSlopTerms?: string[],
  customSlopTerms?: string[],
): SafeFixResult {
  const disabledSet = new Set(
    (disabledSlopTerms ?? [])
      .map((t) => parseCustomSlopEntry(t).term.trim().toLowerCase())
      .filter(Boolean),
  );
  const replacementPairs = buildReplacementPairs(disabledSet, customSlopTerms);

  let fixesApplied = 0;
  const categories = new Set<string>();
  const segments = splitProseAndIgnored(text);

  const transformed = segments
    .map(({ slice, ignored }) => {
      if (ignored) return slice;
      let current = slice;
      let localFixes = 0;

      if (!policy.allowEmDashes) {
        const emRe = /\s*—\s*|\s+--\s+/g;
        const emMatches = current.match(emRe);
        if (emMatches && emMatches.length > 0) {
          current = current.replace(emRe, ', ');
          localFixes += emMatches.length;
          categories.add('em_dash');
        }
      }

      for (const [phrase, replacement] of replacementPairs) {
        const trimmedPhrase = phrase.trimEnd();
        const startBoundary = /^[a-z0-9]/i.test(trimmedPhrase) ? '\\b' : '';
        const endBoundary = /[a-z0-9]$/i.test(trimmedPhrase) ? '\\b' : '';
        const trailingSpace = phrase.endsWith(' ') ? '\\s*' : '';
        const re = new RegExp(
          `${startBoundary}${escapeRegExp(trimmedPhrase)}${endBoundary}${trailingSpace}`,
          'gi',
        );
        current = current.replace(re, (matched) => {
          localFixes += 1;
          categories.add('slop');
          return preserveMatchedCase(matched, replacement);
        });
      }

      if (!policy.allowHashtags) {
        const tagRe = /(?:^|\s)#[a-zA-Z][a-zA-Z0-9_]{1,}/g;
        const tagMatches = current.match(tagRe);
        if (tagMatches && tagMatches.length > 0) {
          current = current.replace(tagRe, '');
          localFixes += tagMatches.length;
          categories.add('hashtag');
        }
      }

      if (!policy.allowEmojis) {
        const emojiMatches = current.match(EMOJI_REGEX);
        if (emojiMatches && emojiMatches.length > 0) {
          current = current.replace(EMOJI_REGEX, '');
          localFixes += emojiMatches.length;
          categories.add('emoji');
        }
      }

      if (localFixes > 0) {
        current = current.replace(/(?<=\S)[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '');
      }
      fixesApplied += localFixes;
      return current;
    })
    .join('');

  return {
    text: fixesApplied > 0 ? transformed.trim() : text,
    fixesApplied,
    categories: [...categories],
  };
}

const TITLE_MINOR_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'but',
  'by',
  'for',
  'from',
  'in',
  'into',
  'nor',
  'of',
  'on',
  'onto',
  'or',
  'over',
  'per',
  'the',
  'to',
  'via',
  'with',
]);

/** Convert text to headline title case while preserving acronyms, URLs, and inline code spans. */
export function toTitleCase(text: string): string {
  const parts = splitProseAndIgnored(text);
  return parts
    .map(({ slice, ignored }) => {
      if (ignored) return slice;
      const tokens = slice.split(/(\s+)/);
      const wordIndices = tokens.map((tok, i) => (/\S/.test(tok) ? i : -1)).filter((i) => i >= 0);
      const firstIdx = wordIndices[0] ?? -1;
      const lastIdx = wordIndices[wordIndices.length - 1] ?? -1;

      return tokens
        .map((tok, idx) => {
          if (!tok || /^\s+$/.test(tok)) return tok;
          if (/^https?:\/\//i.test(tok) || /^[A-Z0-9_]{2,}$/.test(tok)) return tok;
          const lower = tok.toLowerCase();
          if (idx !== firstIdx && idx !== lastIdx && TITLE_MINOR_WORDS.has(lower)) {
            return lower;
          }
          return tok.replace(/[A-Za-z][A-Za-z']*/g, (word) => {
            if (word.length >= 2 && word === word.toUpperCase()) return word;
            return word[0].toUpperCase() + word.slice(1).toLowerCase();
          });
        })
        .join('');
    })
    .join('');
}

/** Normalize sentence capitalization outside code/quote blocks while keeping URLs and acronyms intact. */
export function toSentenceCase(text: string): string {
  const parts = splitProseAndIgnored(text);
  const hasLowercase = parts.some(({ slice, ignored }) => !ignored && /[a-z]/.test(slice));
  let atSentenceStart = true;

  return parts
    .map(({ slice, ignored }) => {
      if (ignored) {
        if (slice.startsWith('```') || slice.trimStart().startsWith('>')) {
          atSentenceStart = true;
        }
        return slice;
      }
      return slice
        .split(/(\s+)/)
        .map((tok) => {
          if (!tok || /^\s+$/.test(tok)) {
            if (tok.includes('\n\n') || /\n\s*\n/.test(tok)) {
              atSentenceStart = true;
            }
            return tok;
          }
          if (/^https?:\/\//i.test(tok)) {
            atSentenceStart = /[.!?]["')\]]*$/.test(tok);
            return tok;
          }
          const alphaOnly = tok.replace(/[^A-Za-z]/g, '');
          const isShortAcronym =
            hasLowercase &&
            alphaOnly.length >= 2 &&
            alphaOnly.length <= 5 &&
            alphaOnly === alphaOnly.toUpperCase();
          let updated = tok;
          if (!isShortAcronym && /[A-Za-z]/.test(tok)) {
            const lower = tok.toLowerCase();
            if (atSentenceStart) {
              updated = lower.replace(/[a-z]/, (ch) => ch.toUpperCase());
            } else {
              updated = lower;
            }
          }
          atSentenceStart = /[.!?]["')\]]*$/.test(tok);
          return updated;
        })
        .join('');
    })
    .join('');
}

/** Normalize curly quotes, ellipses, non-breaking spaces, and redundant blank lines outside code blocks. */
export function normalizeTypography(text: string): SafeFixResult {
  let fixesApplied = 0;
  const categories = new Set<string>();
  const parts = splitProseAndIgnored(text);

  const out = parts
    .map(({ slice, ignored }) => {
      if (ignored) return slice;
      let current = slice;

      const curlyDouble = current.match(/[“”]/g)?.length ?? 0;
      const curlySingle = current.match(/[‘’]/g)?.length ?? 0;
      if (curlyDouble > 0 || curlySingle > 0) {
        current = current.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
        fixesApplied += curlyDouble + curlySingle;
        categories.add('quotes');
      }

      const ellipses = current.match(/…/g)?.length ?? 0;
      if (ellipses > 0) {
        current = current.replace(/…/g, '...');
        fixesApplied += ellipses;
        categories.add('typography');
      }

      const nbspCount = current.match(/\u00A0/g)?.length ?? 0;
      if (nbspCount > 0) {
        current = current.replace(/\u00A0/g, ' ');
        fixesApplied += nbspCount;
        categories.add('whitespace');
      }

      const cleaned = current
        .replace(/(?<=\S)[ \t]{2,}/g, ' ')
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n');
      if (cleaned !== current) {
        fixesApplied += 1;
        categories.add('whitespace');
        current = cleaned;
      }

      return current;
    })
    .join('');

  return {
    text: fixesApplied > 0 ? out : text,
    fixesApplied,
    categories: [...categories],
  };
}

const SAFE_HARPER_KINDS = new Set([
  'Agreement',
  'BoundaryError',
  'Capitalization',
  'Formatting',
  'Grammar',
  'Miscellaneous',
  'Nonstandard',
  'Punctuation',
  'Redundancy',
  'Repetition',
  'Spelling',
  'Style',
  'Typo',
  'Usage',
  'WordChoice',
]);

/** Apply unambiguous single-suggestion Harper lints in reverse span order so offsets never drift. */
export function applySafeGrammarLints(
  text: string,
  lints: readonly Tier0Lint[],
): { text: string; applied: number } {
  const candidates = lints
    .filter(
      (lint) =>
        lint.suggestions.length === 1 &&
        SAFE_HARPER_KINDS.has(lint.lint_kind) &&
        lint.span.start >= 0 &&
        lint.span.end <= text.length &&
        lint.span.start <= lint.span.end,
    )
    .sort((a, b) => b.span.start - a.span.start || b.span.end - a.span.end);

  let current = text;
  let lastStart = current.length + 1;
  let applied = 0;

  for (const lint of candidates) {
    if (lint.span.end > lastStart) continue;
    const suggestion = lint.suggestions[0];
    const replacement = suggestion.kind === 1 ? '' : suggestion.replacement_text;
    const before = current.slice(0, lint.span.start);
    const after = current.slice(lint.span.end);
    const next = `${before}${replacement}${after}`;
    if (next !== current) {
      current = next;
      applied += 1;
    }
    lastStart = lint.span.start;
  }

  return { text: current, applied };
}

function countSyllablesWord(rawWord: string): number {
  const word = rawWord.toLowerCase().replace(/[^a-z]/g, '');
  if (!word) return 0;
  if (word.length <= 3) return 1;
  const stripped = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
  const groups = stripped.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

/** Compute offline Flesch-Kincaid readability, reading time, and passive voice hint counts. */
export function computeReadabilityMetrics(text: string): ReadabilityMetrics {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      chars: 0,
      words: 0,
      sentences: 0,
      syllables: 0,
      longSentences: 0,
      avgWordsPerSentence: 0,
      readingTimeSec: 0,
      fleschReadingEase: 0,
      fleschKincaidGrade: 0,
      passiveHintCount: 0,
    };
  }

  const wordTokens = trimmed.split(/\s+/).filter(Boolean);
  const words = wordTokens.length;
  let syllables = 0;
  for (const token of wordTokens) {
    syllables += countSyllablesWord(token);
  }
  syllables = Math.max(syllables, words > 0 ? 1 : 0);

  const sentenceChunks = trimmed
    .split(/[.!?]+(?:\s+|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  const sentences = Math.max(sentenceChunks.length, words > 0 ? 1 : 0);
  const longSentences = sentenceChunks.filter((s) => s.split(/\s+/).length >= 25).length;

  const avgWordsPerSentence = words > 0 ? Number((words / sentences).toFixed(1)) : 0;
  const readingTimeSec = words > 0 ? Math.max(1, Math.round((words / 200) * 60)) : 0;

  const wordsPerSentence = words / sentences;
  const syllablesPerWord = words > 0 ? syllables / words : 0;
  const rawEase = 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord;
  const rawGrade = 0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59;

  const passiveMatches = trimmed.match(
    /\b(?:am|is|are|was|were|be|been|being)\s+[a-z]{3,}(?:ed|en)\b/gi,
  );

  return {
    chars: text.length,
    words,
    sentences,
    syllables,
    longSentences,
    avgWordsPerSentence,
    readingTimeSec,
    fleschReadingEase: Number(Math.max(0, Math.min(100, rawEase)).toFixed(1)),
    fleschKincaidGrade: Number(Math.max(0, rawGrade).toFixed(1)),
    passiveHintCount: passiveMatches ? passiveMatches.length : 0,
  };
}

export const HARPER_RULE_PRESETS: ReadonlyArray<RulePresetDefinition> = [
  {
    id: 'curated',
    label: 'Curated Default',
    description: 'Balanced Harper grammar, spelling, and clarity defaults with minimal noise.',
    rules: {},
  },
  {
    id: 'strict_technical',
    label: 'Strict Technical',
    description:
      'Flags filler words, hedging, long sentences, repetition, and enforces Oxford commas.',
    rules: {
      BoringWords: true,
      FillerWords: true,
      Hedging: true,
      LongSentences: true,
      RepeatedWords: true,
      AvoidCurses: true,
      OxfordComma: true,
      NoOxfordComma: false,
    },
  },
  {
    id: 'formal_academic',
    label: 'Formal / Academic',
    description:
      'Adds contraction checks and spelled-number guidance alongside strict prose clarity.',
    rules: {
      AvoidContractions: true,
      BoringWords: true,
      FillerWords: true,
      Hedging: true,
      LongSentences: true,
      RepeatedWords: true,
      AvoidCurses: true,
      SpelledNumbers: true,
      OxfordComma: true,
      NoOxfordComma: false,
    },
  },
  {
    id: 'casual_chat',
    label: 'Casual Chat',
    description:
      'Relaxes sentence capitalization, contraction, and long-sentence checks for quick messages.',
    rules: {
      LongSentences: false,
      SentenceCapitalization: false,
      AvoidCurses: false,
      AvoidContractions: false,
    },
  },
];

export function applyRulePreset(
  baseConfig: Record<string, boolean | null>,
  presetId: RulePresetId,
): Record<string, boolean | null> {
  if (presetId === 'curated') {
    return {};
  }
  const preset = HARPER_RULE_PRESETS.find((p) => p.id === presetId);
  if (!preset) return baseConfig;
  return {
    ...baseConfig,
    ...preset.rules,
  };
}

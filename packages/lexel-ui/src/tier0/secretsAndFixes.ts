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
    kind: 'ssn',
    label: 'US SSN-like number',
    regex: /\b(?:00[1-9]|0[1-9]\d|[1-5]\d{2}|6(?:[0-5]\d|6[0-5]|6[7-9]|[7-9]\d)|[78]\d{2})-(?:0[1-9]|[1-9]\d)-(?:000[1-9]|00[1-9]\d|0[1-9]\d{2}|[1-9]\d{3})\b/g,
  },
];

export const SLOP_SAFE_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ['it is important to note that ', ''],
  ["in today's fast-paced world, ", ''],
  ["in today's fast-paced landscape, ", ''],
  ['delve into', 'explore'],
  ['delving into', 'exploring'],
  ['utilize', 'use'],
  ['utilizing', 'using'],
  ['utilization', 'use'],
  ['leverage', 'use'],
  ['leveraging', 'using'],
  ['in order to', 'to'],
  ['a tapestry of', 'a mix of'],
  ['paramount', 'essential'],
  ['seamlessly', 'smoothly'],
  ['seamless', 'smooth'],
  ['robust', 'solid'],
  ['game-changer', 'breakthrough'],
];

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maskSecretValue(raw: string): string {
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
      matches.push({
        kind: rule.kind,
        label: rule.label,
        start: match.index,
        end: match.index + match[0].length,
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

export function findSlopMatchesWithConfig(
  text: string,
  baseTerms: readonly string[],
  options?: { customTerms?: string[]; disabledTerms?: string[] },
): Array<{ term: string; start: number; end: number }> {
  const disabledSet = new Set(
    (options?.disabledTerms ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
  );
  const terms = new Set<string>();
  for (const t of baseTerms) {
    if (!disabledSet.has(t.toLowerCase())) terms.add(t);
  }
  for (const t of options?.customTerms ?? []) {
    const trimmed = t.trim();
    if (trimmed && !disabledSet.has(trimmed.toLowerCase())) {
      terms.add(trimmed);
    }
  }

  const hits: Array<{ term: string; start: number; end: number }> = [];
  for (const term of terms) {
    const regex = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi');
    for (const match of text.matchAll(regex)) {
      if (typeof match.index === 'number') {
        hits.push({
          term: match[0],
          start: match.index,
          end: match.index + match[0].length,
        });
      }
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

/** Deterministically clean safe slop phrases, em dashes, emojis, and hashtags with zero AI. */
export function applySafeFixesForProfile(
  text: string,
  policy: SafeFixSurfacePolicy,
  disabledSlopTerms?: string[],
): SafeFixResult {
  const disabledSet = new Set(
    (disabledSlopTerms ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
  );
  let current = text;
  let fixesApplied = 0;
  const categories = new Set<string>();

  if (!policy.allowEmDashes) {
    const emRe = /\s*—\s*|\s+--\s+/g;
    const emMatches = current.match(emRe);
    if (emMatches && emMatches.length > 0) {
      current = current.replace(emRe, ', ');
      fixesApplied += emMatches.length;
      categories.add('em_dash');
    }
  }

  for (const [phrase, replacement] of SLOP_SAFE_REPLACEMENTS) {
    if (disabledSet.has(phrase.trim().toLowerCase())) continue;
    const trailingSpace = phrase.endsWith(' ') ? '\\s*' : '';
    const re = new RegExp(`\\b${escapeRegExp(phrase.trimEnd())}\\b${trailingSpace}`, 'gi');
    current = current.replace(re, (matched) => {
      fixesApplied += 1;
      categories.add('slop');
      return preserveMatchedCase(matched, replacement);
    });
  }

  if (!policy.allowHashtags) {
    const tagRe = /(?:^|\s)#[a-zA-Z][a-zA-Z0-9_]{1,}/g;
    const tagMatches = current.match(tagRe);
    if (tagMatches && tagMatches.length > 0) {
      current = current.replace(tagRe, '');
      fixesApplied += tagMatches.length;
      categories.add('hashtag');
    }
  }

  if (!policy.allowEmojis) {
    const emojiMatches = current.match(EMOJI_REGEX);
    if (emojiMatches && emojiMatches.length > 0) {
      current = current.replace(EMOJI_REGEX, '');
      fixesApplied += emojiMatches.length;
      categories.add('emoji');
    }
  }

  if (fixesApplied > 0) {
    current = current.replace(/[ \t]{2,}/g, ' ').trim();
  }

  return {
    text: current,
    fixesApplied,
    categories: [...categories],
  };
}

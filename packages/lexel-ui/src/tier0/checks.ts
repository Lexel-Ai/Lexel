import {
  findSlopMatchesWithConfig,
  ignoredProseRanges,
  overlapsIgnoredRanges,
  parseCustomSlopEntry,
  SLOP_TERMS,
} from './secretsAndFixes';
import type {
  ConsistencyIssue,
  PastedAiAssessment,
  PastedAiThresholds,
  SlopMeterLabel,
  SlopMeterOptions,
  SlopMeterReport,
  SlopMeterSpan,
  WritingGuardHit,
} from './types';

const DEFAULT_FILLER_OPENERS = [
  "in today's",
  'in an era',
  'in the ever-evolving',
  'in the rapidly evolving',
  'it is important to note',
  "it's important to note",
  'it is worth noting',
  "it's worth noting",
  'needless to say',
  'without further ado',
  'i hope this email finds you well',
  'i hope this message finds you well',
  'at the end of the day',
  'in conclusion',
  'to summarize',
  'when it comes to',
  'delving into',
  'certainly!',
  'absolutely!',
  'great question',
] as const;

const US_UK_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['color', 'colour'],
  ['colors', 'colours'],
  ['colored', 'coloured'],
  ['coloring', 'colouring'],
  ['behavior', 'behaviour'],
  ['behaviors', 'behaviours'],
  ['behavioral', 'behavioural'],
  ['favor', 'favour'],
  ['favors', 'favours'],
  ['favorite', 'favourite'],
  ['favorites', 'favourites'],
  ['honor', 'honour'],
  ['honors', 'honours'],
  ['labor', 'labour'],
  ['neighbor', 'neighbour'],
  ['neighbors', 'neighbours'],
  ['flavor', 'flavour'],
  ['flavors', 'flavours'],
  ['humor', 'humour'],
  ['rumor', 'rumour'],
  ['harbor', 'harbour'],
  ['vapor', 'vapour'],
  ['organize', 'organise'],
  ['organizes', 'organises'],
  ['organized', 'organised'],
  ['organizing', 'organising'],
  ['organization', 'organisation'],
  ['organizations', 'organisations'],
  ['optimize', 'optimise'],
  ['optimizes', 'optimises'],
  ['optimized', 'optimised'],
  ['optimizing', 'optimising'],
  ['optimization', 'optimisation'],
  ['analyze', 'analyse'],
  ['analyzes', 'analyses'],
  ['analyzed', 'analysed'],
  ['analyzing', 'analysing'],
  ['realize', 'realise'],
  ['realized', 'realised'],
  ['realizing', 'realising'],
  ['recognize', 'recognise'],
  ['recognized', 'recognised'],
  ['categorize', 'categorise'],
  ['customize', 'customise'],
  ['customized', 'customised'],
  ['initialize', 'initialise'],
  ['initialized', 'initialised'],
  ['initializing', 'initialising'],
  ['serialize', 'serialise'],
  ['serialized', 'serialised'],
  ['synchronize', 'synchronise'],
  ['synchronized', 'synchronised'],
  ['authorize', 'authorise'],
  ['authorized', 'authorised'],
  ['normalize', 'normalise'],
  ['normalized', 'normalised'],
  ['prioritize', 'prioritise'],
  ['prioritized', 'prioritised'],
  ['summarize', 'summarise'],
  ['summarized', 'summarised'],
  ['center', 'centre'],
  ['centers', 'centres'],
  ['centered', 'centred'],
  ['meter', 'metre'],
  ['meters', 'metres'],
  ['fiber', 'fibre'],
  ['theater', 'theatre'],
  ['liter', 'litre'],
  ['defense', 'defence'],
  ['offense', 'offence'],
  ['license', 'licence'],
  ['catalog', 'catalogue'],
  ['dialog', 'dialogue'],
  ['analog', 'analogue'],
  ['canceled', 'cancelled'],
  ['canceling', 'cancelling'],
  ['labeled', 'labelled'],
  ['labeling', 'labelling'],
  ['modeled', 'modelled'],
  ['modeling', 'modelling'],
  ['traveled', 'travelled'],
  ['traveling', 'travelling'],
  ['gray', 'grey'],
  ['artifact', 'artefact'],
  ['artifacts', 'artefacts'],
  ['fulfill', 'fulfil'],
  ['enroll', 'enrol'],
  ['skillful', 'skilful'],
  ['aging', 'ageing'],
  ['judgment', 'judgement'],
  ['acknowledgment', 'acknowledgement'],
];

const HYPHEN_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['e-mail', 'email'],
  ['e-mails', 'emails'],
  ['co-operate', 'cooperate'],
  ['on-boarding', 'onboarding'],
  ['real-time', 'realtime'],
  ['end-point', 'endpoint'],
  ['end-points', 'endpoints'],
  ['web-site', 'website'],
  ['web-sites', 'websites'],
  ['work-flow', 'workflow'],
  ['work-flows', 'workflows'],
  ['code-base', 'codebase'],
  ['data-base', 'database'],
  ['plug-in', 'plugin'],
  ['plug-ins', 'plugins'],
  ['set-up', 'setup'],
  ['sign-up', 'signup'],
  ['back-end', 'backend'],
  ['front-end', 'frontend'],
  ['full-stack', 'fullstack'],
  ['check-out', 'checkout'],
  ['drop-down', 'dropdown'],
  ['run-time', 'runtime'],
  ['time-out', 'timeout'],
  ['time-outs', 'timeouts'],
  ['trade-off', 'tradeoff'],
  ['trade-offs', 'tradeoffs'],
  ['roll-out', 'rollout'],
  ['follow-up', 'followup'],
  ['start-up', 'startup'],
  ['start-ups', 'startups'],
  ['life-cycle', 'lifecycle'],
  ['micro-service', 'microservice'],
  ['micro-services', 'microservices'],
  ['open-source', 'open source'],
  ['use-case', 'use case'],
  ['use-cases', 'use cases'],
];

const CANONICAL_PRODUCTS = [
  'GitHub',
  'GitLab',
  'JavaScript',
  'TypeScript',
  'PostgreSQL',
  'MySQL',
  'SQLite',
  'GraphQL',
  'Next.js',
  'Node.js',
  'macOS',
  'iOS',
  'iPhone',
  'iPad',
  'YouTube',
  'LinkedIn',
  'WordPress',
  'PyTorch',
  'TensorFlow',
  'OpenAI',
  'ChatGPT',
  'Cloudflare',
  'WebAssembly',
  'PowerShell',
  'FastAPI',
  'gRPC',
  'OAuth',
] as const;

const ABRASIVE_RULES: ReadonlyArray<{
  phrase: string;
  message: string;
  suggestion?: string;
}> = [
  {
    phrase: 'as i already said',
    message: 'Sounds impatient. Recap neutrally instead.',
    suggestion: 'To recap',
  },
  {
    phrase: 'as i mentioned before',
    message: 'Sounds curt. Reference the earlier point neutrally.',
    suggestion: 'Following up on the earlier point',
  },
  {
    phrase: "as i've already explained",
    message: 'Can read as dismissive. Restate the key detail directly.',
    suggestion: 'To summarize',
  },
  {
    phrase: 'as previously stated',
    message: 'Stiff and passive-aggressive. State the point plainly.',
    suggestion: 'To recap',
  },
  {
    phrase: 'per my last email',
    message: 'Often reads as passive-aggressive. Point to the decision directly.',
    suggestion: 'Following up on my earlier note',
  },
  {
    phrase: 'per my previous email',
    message: 'Often reads as passive-aggressive. Point to the decision directly.',
    suggestion: 'Following up on my earlier note',
  },
  {
    phrase: "why didn't you",
    message: 'Accusatory phrasing. Ask about the tradeoff or blocker instead.',
    suggestion: 'Could we check whether',
  },
  {
    phrase: 'why did you not',
    message: 'Accusatory phrasing. Ask about the tradeoff or blocker instead.',
    suggestion: 'Could we check whether',
  },
  {
    phrase: "why haven't you",
    message: 'Sounds confrontational. Ask for a status update directly.',
    suggestion: 'What is the status on',
  },
  {
    phrase: 'obviously',
    message: '"Obviously" can sound condescending to readers. Drop it and state the fact.',
    suggestion: '',
  },
  {
    phrase: "you clearly didn't",
    message: 'Reads as an accusation. Describe the missing step neutrally.',
    suggestion: 'It looks like we still need to',
  },
  {
    phrase: 'you failed to',
    message: 'Blame-focused phrasing. State what is missing instead.',
    suggestion: 'This is missing',
  },
  {
    phrase: 'this makes no sense',
    message: 'Dismissive in reviews or chat. Name the specific confusion.',
    suggestion: 'I am having trouble following this part',
  },
  {
    phrase: 'that makes no sense',
    message: 'Dismissive in reviews or chat. Name the specific confusion.',
    suggestion: 'I am having trouble following that',
  },
  {
    phrase: 'did you even read',
    message: 'Abrasive phrasing. Point directly to the section that matters.',
    suggestion: 'Could you take a look at',
  },
  {
    phrase: 'did you even test',
    message: 'Abrasive phrasing in reviews. Ask which test cases ran.',
    suggestion: 'Which test cases did you run for',
  },
  {
    phrase: "it's not that hard",
    message: 'Condescending phrasing. Offer the concrete step instead.',
    suggestion: 'Here is a quick way to handle it',
  },
  {
    phrase: 'it is not that hard',
    message: 'Condescending phrasing. Offer the concrete step instead.',
    suggestion: 'Here is a quick way to handle it',
  },
  {
    phrase: 'please read carefully',
    message: 'Can sound lecturing. Highlight the exact requirement instead.',
    suggestion: 'Please note',
  },
  {
    phrase: 'just read the',
    message: 'Sounds dismissive. Link or quote the relevant section directly.',
    suggestion: 'Check the',
  },
  {
    phrase: 'rtfm',
    message: 'Hostile shorthand. Share the relevant doc link directly.',
    suggestion: 'check the documentation',
  },
];

const ATTACHMENT_PHRASES = [
  'see attached',
  'attached is',
  'attached are',
  'attached please find',
  'please find attached',
  "i've attached",
  'i have attached',
  'i attached',
  'attached the',
  'attached my',
  'in the attachment',
  'attachment below',
  'find the attached',
] as const;

const ASK_SIGNALS = [
  'could you',
  'can you',
  'would you',
  'please review',
  'please approve',
  'please confirm',
  'please send',
  'please share',
  'please let me know',
  'let me know if',
  'need your approval',
  'need your feedback',
  'need your sign-off',
  'looking for feedback',
  'action needed',
  'action required',
] as const;

const US_UK_MAP = new Map<string, { isUs: boolean; us: string; uk: string }>();
for (const [us, uk] of US_UK_PAIRS) {
  US_UK_MAP.set(us, { isUs: true, us, uk });
  US_UK_MAP.set(uk, { isUs: false, us, uk });
}

const PRODUCT_MAP = new Map<string, string>(
  CANONICAL_PRODUCTS.map((name) => [name.toLowerCase(), name]),
);

const METRIC_UNITS = new Set([
  'ms',
  's',
  'sec',
  'secs',
  'min',
  'mins',
  'hr',
  'hrs',
  'kb',
  'mb',
  'gb',
  'tb',
  'px',
  'x',
  'k',
  'm',
  'b',
  'hz',
  'khz',
  'mhz',
  'ghz',
]);

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function preserveCase(matched: string, replacement: string): string {
  if (!replacement) return '';
  const first = matched[0];
  if (first && first >= 'A' && first <= 'Z') {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isOpenerPosition(text: string, start: number): boolean {
  const before = text.slice(0, start);
  const trimmed = before.trimEnd();
  if (trimmed.length === 0) return true;
  const last = trimmed[trimmed.length - 1];
  return (
    last === '.' ||
    last === '!' ||
    last === '?' ||
    last === ':' ||
    before.slice(trimmed.length).includes('\n')
  );
}

function countProseWords(text: string, ignored: ReadonlyArray<readonly [number, number]>): number {
  let count = 0;
  for (const m of text.matchAll(/[A-Za-z0-9][A-Za-z0-9'-]*/g)) {
    if (typeof m.index !== 'number') continue;
    if (!overlapsIgnoredRanges(m.index, m.index + m[0].length, ignored)) {
      count += 1;
    }
  }
  return count;
}

function analyzeSentenceRhythm(
  text: string,
  ignored: ReadonlyArray<readonly [number, number]>,
): { flatness: number; stddev: number; span: [number, number] | null } {
  const sentences: Array<[number, number, number]> = [];
  let segStart = 0;
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i];
    if (i === text.length || ch === '.' || ch === '!' || ch === '?' || ch === '\n') {
      const segEnd = i === text.length ? i : i + 1;
      const slice = text.slice(segStart, segEnd);
      const trimmedStart = slice.trimStart();
      const start = segStart + (slice.length - trimmedStart.length);
      const trimmed = trimmedStart.trimEnd();
      const end = start + trimmed.length;
      if (start < end && !overlapsIgnoredRanges(start, end, ignored)) {
        const words = trimmed.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
        if (words >= 4) {
          sentences.push([start, end, words]);
        }
      }
      segStart = segEnd;
    }
  }

  if (sentences.length < 3) {
    return { flatness: 0, stddev: 0, span: null };
  }

  const mean = sentences.reduce((acc, s) => acc + s[2], 0) / sentences.length;
  if (mean < 6) {
    return { flatness: 0, stddev: 0, span: null };
  }

  const variance = sentences.reduce((acc, s) => acc + (s[2] - mean) ** 2, 0) / sentences.length;
  const stddev = Math.sqrt(variance);
  const cv = stddev / mean;
  const flatness = cv >= 0.32 ? 0 : Math.max(0, Math.min(1, (0.32 - cv) / 0.32));
  return {
    flatness,
    stddev,
    span: [sentences[0][0], sentences[sentences.length - 1][1]],
  };
}

/** Live Human vs. AI-slop meter: scores clichés, em dashes, filler openers, and flat sentence rhythm. */
export function scoreSlopMeter(text: string, options?: SlopMeterOptions): SlopMeterReport {
  if (!text.trim()) {
    return {
      score: 0,
      humanScore: 100,
      label: 'human',
      wordCount: 0,
      clicheCount: 0,
      emDashCount: 0,
      fillerOpenerCount: 0,
      rhythmFlatness: 0,
      breakdown: {
        clichePoints: 0,
        emDashPoints: 0,
        fillerOpenerPoints: 0,
        flatRhythmPoints: 0,
        clicheDensityPer100Words: 0,
        emDashCount: 0,
        fillerOpenerCount: 0,
        sentenceLengthStddev: 0,
      },
      contributors: [],
    };
  }

  const ignored = ignoredProseRanges(text);
  const wordCount = countProseWords(text, ignored);
  const contributors: SlopMeterSpan[] = [];

  const slopHits = findSlopMatchesWithConfig(text, SLOP_TERMS, {
    customTerms: options?.customSlopTerms,
    disabledTerms: options?.disabledSlopTerms,
  });
  for (const hit of slopHits) {
    contributors.push({
      kind: 'cliche',
      label: `AI cliché "${hit.term}"`,
      matchedText: hit.term,
      start: hit.start,
      end: hit.end,
      weight: 12,
    });
  }

  let emDashCount = 0;
  for (const match of text.matchAll(/—|\s--\s/g)) {
    if (typeof match.index !== 'number') continue;
    const start = match.index;
    const end = start + match[0].length;
    if (overlapsIgnoredRanges(start, end, ignored)) continue;
    emDashCount += 1;
    contributors.push({
      kind: 'em_dash',
      label: 'Em dash phrasing',
      matchedText: match[0],
      start,
      end,
      weight: options?.allowEmDashes ? 5 : 10,
    });
  }

  let fillerOpenerCount = 0;
  const lower = text.toLowerCase();
  const openers = [
    ...DEFAULT_FILLER_OPENERS,
    ...(options?.surfaceBannedOpeners ?? []).map((o) => o.trim().toLowerCase()).filter(Boolean),
  ];
  const seenOpeners = new Set<string>();
  for (const opener of openers) {
    if (seenOpeners.has(opener)) continue;
    seenOpeners.add(opener);
    let idx = lower.indexOf(opener);
    while (idx !== -1) {
      const end = idx + opener.length;
      if (
        !overlapsIgnoredRanges(idx, end, ignored) &&
        isOpenerPosition(text, idx) &&
        !isWordChar(text[end]) &&
        !contributors.some((c) => c.kind === 'filler_opener' && idx < c.end && end > c.start)
      ) {
        fillerOpenerCount += 1;
        contributors.push({
          kind: 'filler_opener',
          label: `Filler opener "${text.slice(idx, end)}"`,
          matchedText: text.slice(idx, end),
          start: idx,
          end,
          weight: 10,
        });
      }
      idx = lower.indexOf(opener, end);
    }
  }

  const clicheCount = slopHits.length;
  const effectiveWords = Math.max(wordCount, 10);
  const clicheDensityPer100Words = round1((clicheCount / effectiveWords) * 100);
  const clichePoints =
    clicheCount === 0
      ? 0
      : Math.round(Math.min(45, clicheCount * 12 + clicheDensityPer100Words * 2.5));

  const emDashPoints =
    emDashCount === 0
      ? 0
      : options?.allowEmDashes
        ? emDashCount <= 1
          ? 0
          : Math.round(Math.min(20, (emDashCount - 1) * 6))
        : Math.round(Math.min(25, emDashCount * 10));

  const fillerOpenerPoints = Math.round(Math.min(20, fillerOpenerCount * 10));

  const rhythm = analyzeSentenceRhythm(text, ignored);
  const flatRhythmPoints = rhythm.flatness >= 0.45 ? Math.round(rhythm.flatness * 15) : 0;
  if (flatRhythmPoints > 0 && rhythm.span) {
    const [start, end] = rhythm.span;
    const raw = text.slice(start, end);
    contributors.push({
      kind: 'flat_rhythm',
      label: 'Uniform sentence cadence',
      matchedText: raw.length > 64 ? `${raw.slice(0, 64)}...` : raw,
      start,
      end,
      weight: flatRhythmPoints,
    });
  }

  contributors.sort((a, b) => a.start - b.start || a.end - b.end);

  const score = Math.min(100, clichePoints + emDashPoints + fillerOpenerPoints + flatRhythmPoints);
  const humanScore = Math.max(0, 100 - score);
  const label: SlopMeterLabel =
    score <= 20 ? 'human' : score <= 45 ? 'mild_ai' : score <= 70 ? 'likely_ai' : 'heavy_slop';

  return {
    score,
    humanScore,
    label,
    wordCount,
    clicheCount,
    emDashCount,
    fillerOpenerCount,
    rhythmFlatness: round2(rhythm.flatness),
    breakdown: {
      clichePoints,
      emDashPoints,
      fillerOpenerPoints,
      flatRhythmPoints,
      clicheDensityPer100Words,
      emDashCount,
      fillerOpenerCount,
      sentenceLengthStddev: round2(rhythm.stddev),
    },
    contributors,
  };
}

/** Decide whether pasted text should surface the "Humanize pasted text" pill. */
export function detectPastedAi(
  text: string,
  options?: SlopMeterOptions,
  thresholds?: PastedAiThresholds,
): PastedAiAssessment {
  const minChars = thresholds?.minChars ?? 120;
  const minScore = thresholds?.minScore ?? 35;
  const minSignals = thresholds?.minSignals ?? 2;
  const minDensity = thresholds?.minDensityPer100Words ?? 2.5;

  const meter = scoreSlopMeter(text, options);
  const charCount = text.trim().length;
  const signalCount = meter.clicheCount + meter.emDashCount + meter.fillerOpenerCount;
  const density = meter.wordCount > 0 ? round1((signalCount / meter.wordCount) * 100) : 0;

  const meetsLength = charCount >= minChars;
  const hasExplicitSignal = signalCount > 0;
  const shouldOfferHumanize =
    meetsLength &&
    ((meter.score >= minScore && hasExplicitSignal) ||
      (signalCount >= minSignals && density >= minDensity));

  const reason = shouldOfferHumanize
    ? `${signalCount} ${signalCount === 1 ? 'AI pattern' : 'AI patterns'} detected (slop score ${meter.score}/100)`
    : null;

  return {
    shouldOfferHumanize,
    charCount,
    wordCount: meter.wordCount,
    slopScore: meter.score,
    slopDensityPer100Words: density,
    signalCount,
    reason,
    meter,
  };
}

/** Document-wide consistency checker: US/UK spelling, hyphenation variants, product casing, version formats. */
export function scanConsistencyIssues(text: string, preferredDialect?: number): ConsistencyIssue[] {
  if (!text.trim()) return [];
  const ignored = [...ignoredProseRanges(text)];
  for (const m of text.matchAll(/https?:\/\/[^\s)>\]]+/gi)) {
    if (typeof m.index === 'number') {
      ignored.push([m.index, m.index + m[0].length]);
    }
  }
  const issues: ConsistencyIssue[] = [];

  // 1. Mixed US/UK spelling
  const usHits: Array<{ start: number; end: number; found: string; uk: string }> = [];
  const ukHits: Array<{ start: number; end: number; found: string; us: string }> = [];
  let firstIsUs: boolean | null = null;

  for (const m of text.matchAll(/\b[A-Za-z]+\b/g)) {
    if (typeof m.index !== 'number') continue;
    const start = m.index;
    const end = start + m[0].length;
    if (overlapsIgnoredRanges(start, end, ignored)) continue;
    const entry = US_UK_MAP.get(m[0].toLowerCase());
    if (!entry) continue;
    if (firstIsUs === null) firstIsUs = entry.isUs;
    if (entry.isUs) {
      usHits.push({ start, end, found: m[0], uk: entry.uk });
    } else {
      ukHits.push({ start, end, found: m[0], us: entry.us });
    }
  }

  if (usHits.length > 0 && ukHits.length > 0) {
    const preferUs =
      preferredDialect === 0
        ? true
        : preferredDialect === 1
          ? false
          : usHits.length !== ukHits.length
            ? usHits.length > ukHits.length
            : (firstIsUs ?? true);

    if (preferUs) {
      for (const hit of ukHits) {
        const preferred = preserveCase(hit.found, hit.us);
        issues.push({
          kind: 'spelling_dialect',
          message: `Mixed US and UK spelling: use "${preferred}" to match US spellings in this document.`,
          found: hit.found,
          preferred,
          start: hit.start,
          end: hit.end,
          groupKey: `${hit.us}/${hit.found.toLowerCase()}`,
        });
      }
    } else {
      for (const hit of usHits) {
        const preferred = preserveCase(hit.found, hit.uk);
        issues.push({
          kind: 'spelling_dialect',
          message: `Mixed US and UK spelling: use "${preferred}" to match UK spellings in this document.`,
          found: hit.found,
          preferred,
          start: hit.start,
          end: hit.end,
          groupKey: `${hit.found.toLowerCase()}/${hit.uk}`,
        });
      }
    }
  }

  // 2. Hyphenation consistency (dynamic + curated pairs)
  const buckets = new Map<
    string,
    {
      firstSeen: string;
      variants: Map<string, Array<{ start: number; end: number; found: string }>>;
    }
  >();
  for (const m of text.matchAll(/\b[A-Za-z]+(?:-[A-Za-z]+)*\b/g)) {
    if (typeof m.index !== 'number') continue;
    const start = m.index;
    const end = start + m[0].length;
    if (overlapsIgnoredRanges(start, end, ignored)) continue;
    const lower = m[0].toLowerCase();
    const key = lower.replaceAll('-', '');
    if (key.length < 4) continue;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { firstSeen: lower, variants: new Map() };
      buckets.set(key, bucket);
    }
    const list = bucket.variants.get(lower) ?? [];
    list.push({ start, end, found: m[0] });
    bucket.variants.set(lower, list);
  }

  const lowerText = text.toLowerCase();
  for (const [hyph, other] of HYPHEN_PAIRS) {
    if (!other.includes(' ')) continue;
    const key = other.replaceAll(' ', '');
    const bucket = buckets.get(key);
    if (!bucket?.variants.has(hyph)) continue;
    let idx = lowerText.indexOf(other);
    while (idx !== -1) {
      const end = idx + other.length;
      if (
        !overlapsIgnoredRanges(idx, end, ignored) &&
        !isWordChar(text[idx - 1]) &&
        !isWordChar(text[end])
      ) {
        const list = bucket.variants.get(other) ?? [];
        list.push({ start: idx, end, found: text.slice(idx, end) });
        bucket.variants.set(other, list);
      }
      idx = lowerText.indexOf(other, end);
    }
  }

  for (const [key, bucket] of buckets.entries()) {
    const keys = [...bucket.variants.keys()];
    if (!keys.some((k) => k.includes('-')) || !keys.some((k) => !k.includes('-'))) continue;
    let preferredVariant = bucket.firstSeen;
    let bestCount = -1;
    for (const [variant, list] of bucket.variants.entries()) {
      if (list.length > bestCount || (list.length === bestCount && variant === bucket.firstSeen)) {
        bestCount = list.length;
        preferredVariant = variant;
      }
    }
    for (const [variant, list] of bucket.variants.entries()) {
      if (variant === preferredVariant) continue;
      for (const hit of list) {
        const preferred = preserveCase(hit.found, preferredVariant);
        issues.push({
          kind: 'hyphenation',
          message: `Inconsistent hyphenation: "${hit.found}" appears alongside "${preferred}".`,
          found: hit.found,
          preferred,
          start: hit.start,
          end: hit.end,
          groupKey: key,
        });
      }
    }
  }

  // 3. Product casing
  for (const m of text.matchAll(/[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*/g)) {
    if (typeof m.index !== 'number') continue;
    const start = m.index;
    const end = start + m[0].length;
    if (overlapsIgnoredRanges(start, end, ignored)) continue;
    const prev = text[start - 1];
    const next = text[end];
    if (prev === '@' || prev === '/' || prev === '.' || next === '/') continue;
    const canonical = PRODUCT_MAP.get(m[0].toLowerCase());
    if (canonical && m[0] !== canonical) {
      issues.push({
        kind: 'product_casing',
        message: `Use official product casing "${canonical}" instead of "${m[0]}".`,
        found: m[0],
        preferred: canonical,
        start,
        end,
        groupKey: canonical,
      });
    }
  }

  // 4. Version format consistency
  const withV: Array<{ start: number; end: number; found: string; num: string }> = [];
  const withoutV: Array<{ start: number; end: number; found: string; num: string }> = [];
  let firstHasV: boolean | null = null;
  for (const m of text.matchAll(/\b(v)?(\d+\.\d+(?:\.\d+)?(?:-[0-9a-zA-Z.-]+)?)\b/gi)) {
    if (typeof m.index !== 'number' || !m[2]) continue;
    const start = m.index;
    const end = start + m[0].length;
    if (overlapsIgnoredRanges(start, end, ignored)) continue;
    const prev = text[start - 1];
    const next = text[end];
    if (prev === '$' || prev === '€' || prev === '£' || prev === '.' || prev === '/') continue;
    if (next === '.' || next === '%' || next === '/') continue;
    const unitMatch = /^ ?([A-Za-z]+)/.exec(text.slice(end));
    if (unitMatch && METRIC_UNITS.has(unitMatch[1].toLowerCase())) continue;
    if (m[2].split('.')[0].length === 4) continue;

    const hasV = Boolean(m[1]);
    if (firstHasV === null) firstHasV = hasV;
    if (hasV) {
      withV.push({ start, end, found: m[0], num: m[2] });
    } else {
      withoutV.push({ start, end, found: m[0], num: m[2] });
    }
  }

  if (withV.length > 0 && withoutV.length > 0) {
    const preferV =
      withV.length !== withoutV.length ? withV.length > withoutV.length : (firstHasV ?? true);
    if (preferV) {
      for (const hit of withoutV) {
        const preferred = `v${hit.num}`;
        issues.push({
          kind: 'version_format',
          message: `Mixed version format: use "${preferred}" to match "v"-prefixed versions in this document.`,
          found: hit.found,
          preferred,
          start: hit.start,
          end: hit.end,
          groupKey: 'version_prefix',
        });
      }
    } else {
      for (const hit of withV) {
        issues.push({
          kind: 'version_format',
          message: `Mixed version format: use "${hit.num}" to match bare version numbers in this document.`,
          found: hit.found,
          preferred: hit.num,
          start: hit.start,
          end: hit.end,
          groupKey: 'version_prefix',
        });
      }
    }
  }

  issues.sort((a, b) => a.start - b.start || a.end - b.end);
  return issues;
}

export function isBlufSurface(surfaceId: string): boolean {
  return (
    surfaceId === 'web_email' ||
    surfaceId === 'web_discord_slack' ||
    surfaceId === 'web_github_pr' ||
    surfaceId === 'email' ||
    surfaceId === 'slack' ||
    surfaceId === 'github_pr'
  );
}

/** Flag 6+ line walls of text and buried asks on Email, Chat/Slack, and GitHub PR surfaces. */
export function scanBlufAndWalls(text: string, surfaceId: string): WritingGuardHit[] {
  if (!text.trim() || !isBlufSurface(surfaceId)) return [];
  const ignored = ignoredProseRanges(text);
  const hits: WritingGuardHit[] = [];

  const surfaceLabel =
    surfaceId === 'web_email' || surfaceId === 'email'
      ? 'Email'
      : surfaceId === 'web_discord_slack' || surfaceId === 'slack'
        ? 'Chat'
        : 'GitHub PR';

  // Split into non-empty prose paragraph blocks
  const blocks: Array<[number, number]> = [];
  let blockStart: number | null = null;
  let blockEnd = 0;
  let offset = 0;
  const linesWithNl = text.match(/[^\n]*\n|[^\n]+/g) ?? [];
  for (const line of linesWithNl) {
    const lineEnd = offset + line.length;
    const empty = !line.trim() || overlapsIgnoredRanges(offset, lineEnd, ignored);
    if (empty) {
      if (blockStart !== null) {
        blocks.push([blockStart, blockEnd]);
        blockStart = null;
      }
    } else {
      if (blockStart === null) blockStart = offset;
      blockEnd = lineEnd;
    }
    offset = lineEnd;
  }
  if (blockStart !== null) blocks.push([blockStart, blockEnd]);

  for (const [pStart, pEnd] of blocks) {
    const block = text.slice(pStart, pEnd);
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    const listLines = lines.filter((l) => /^([-*+]|\d+[.)])\s+/.test(l)).length;
    if (listLines * 2 >= lines.length && listLines >= 2) continue;

    const estimatedLines = lines.reduce((sum, l) => sum + Math.max(1, Math.ceil(l.length / 80)), 0);
    const words = block.trim().split(/\s+/).filter(Boolean).length;
    if (estimatedLines >= 6 || (lines.length >= 6 && words >= 55)) {
      const trimmed = block.trim();
      hits.push({
        kind: 'wall_of_text',
        severity: 'warning',
        ruleId: 'wall_of_text',
        message: `Wall of text (about ${estimatedLines} lines) for ${surfaceLabel}. Split into short paragraphs or bullets.`,
        matchedText: trimmed.length > 80 ? `${trimmed.slice(0, 80)}...` : trimmed,
        start: pStart,
        end: pEnd,
        quickAction: 'lead_with_ask',
      });
    }
  }

  // Buried ask detection
  const trimmedAll = text.trim();
  const totalWords = trimmedAll.split(/\s+/).filter(Boolean).length;
  if (trimmedAll.length >= 260 && totalWords >= 45) {
    const asks: Array<[number, number]> = [];
    let segStart = 0;
    for (let i = 0; i <= text.length; i++) {
      const ch = text[i];
      if (i === text.length || ch === '.' || ch === '!' || ch === '?' || ch === '\n') {
        const segEnd = i === text.length ? i : i + 1;
        const slice = text.slice(segStart, segEnd);
        const ts = slice.trimStart();
        const start = segStart + (slice.length - ts.length);
        const trimmed = ts.trimEnd();
        const end = start + trimmed.length;
        if (start < end && !overlapsIgnoredRanges(start, end, ignored)) {
          const lower = trimmed.toLowerCase();
          if (trimmed.endsWith('?') || ASK_SIGNALS.some((sig) => lower.includes(sig))) {
            asks.push([start, end]);
          }
        }
        segStart = segEnd;
      }
    }
    const leadCutoff = text.length * 0.35;
    const lateCutoff = text.length * 0.55;
    const hasEarlyAsk = asks.some(([s]) => s <= leadCutoff);
    const buried = asks.find(([s]) => s >= lateCutoff);
    if (!hasEarlyAsk && buried) {
      hits.push({
        kind: 'buried_ask',
        severity: 'info',
        ruleId: 'buried_ask',
        message: 'Main ask is buried near the end. Move the question or request to the top.',
        matchedText: text.slice(buried[0], buried[1]).trim(),
        start: buried[0],
        end: buried[1],
        quickAction: 'lead_with_ask',
      });
    }
  }

  hits.sort((a, b) => a.start - b.start || a.end - b.end);
  return hits;
}

/** Detect abrasive phrasing and "see attached" promises without an attachment signal. */
export function scanRegretShield(text: string, hasAttachmentSignal = false): WritingGuardHit[] {
  if (!text.trim()) return [];
  const ignored = ignoredProseRanges(text);
  const lower = text.toLowerCase();
  const hits: WritingGuardHit[] = [];

  for (const rule of ABRASIVE_RULES) {
    let idx = lower.indexOf(rule.phrase);
    while (idx !== -1) {
      const end = idx + rule.phrase.length;
      if (
        !overlapsIgnoredRanges(idx, end, ignored) &&
        !isWordChar(text[idx - 1]) &&
        !isWordChar(text[end])
      ) {
        const matched = text.slice(idx, end);
        hits.push({
          kind: 'abrasive_tone',
          severity: 'warning',
          ruleId: 'regret_abrasive',
          message: rule.message,
          matchedText: matched,
          start: idx,
          end,
          suggestion:
            rule.suggestion === undefined
              ? undefined
              : rule.suggestion === ''
                ? ''
                : preserveCase(matched, rule.suggestion),
          quickAction: 'soften_edge',
        });
      }
      idx = lower.indexOf(rule.phrase, end);
    }
  }

  if (!hasAttachmentSignal) {
    for (const phrase of ATTACHMENT_PHRASES) {
      let idx = lower.indexOf(phrase);
      while (idx !== -1) {
        const end = idx + phrase.length;
        if (
          !overlapsIgnoredRanges(idx, end, ignored) &&
          !isWordChar(text[idx - 1]) &&
          !isWordChar(text[end])
        ) {
          hits.push({
            kind: 'missing_attachment',
            severity: 'warning',
            ruleId: 'regret_missing_attachment',
            message: 'Mentions an attachment, but no attached file was detected.',
            matchedText: text.slice(idx, end),
            start: idx,
            end,
          });
        }
        idx = lower.indexOf(phrase, end);
      }
    }
  }

  hits.sort((a, b) => a.start - b.start || a.end - b.end);
  return hits;
}

/** Flag personal crutch words configured in settings (plain words or "word => replacement"). */
export function scanCrutchWords(text: string, crutchWords?: readonly string[]): WritingGuardHit[] {
  if (!text.trim() || !crutchWords || crutchWords.length === 0) return [];
  const ignored = ignoredProseRanges(text);
  const hits: WritingGuardHit[] = [];
  const seen = new Set<string>();

  for (const raw of crutchWords) {
    const parsed = parseCustomSlopEntry(raw);
    if (!parsed.term) continue;
    const key = parsed.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const re = new RegExp(`\\b${escapeRegExp(parsed.term)}\\b`, 'gi');
    for (const m of text.matchAll(re)) {
      if (typeof m.index !== 'number') continue;
      const start = m.index;
      const end = start + m[0].length;
      if (overlapsIgnoredRanges(start, end, ignored)) continue;
      const replacement = parsed.replacement ? preserveCase(m[0], parsed.replacement) : '';
      hits.push({
        kind: 'crutch_word',
        severity: 'info',
        ruleId: 'crutch_word',
        message: parsed.replacement
          ? `Personal crutch word "${m[0]}". Replace with "${parsed.replacement}".`
          : `Personal crutch word "${m[0]}". Cut it for tighter phrasing.`,
        matchedText: m[0],
        start,
        end,
        suggestion: replacement,
        quickAction: 'remove_crutch',
      });
    }
  }

  hits.sort((a, b) => a.start - b.start || a.end - b.end);
  return hits;
}

/** Run all deterministic writing guards (BLUF/wall-of-text, regret shield, personal crutch words). */
export function scanWritingGuards(
  text: string,
  surfaceId: string,
  crutchWords?: readonly string[],
  hasAttachmentSignal = false,
): WritingGuardHit[] {
  const hits = [
    ...scanBlufAndWalls(text, surfaceId),
    ...scanRegretShield(text, hasAttachmentSignal),
    ...scanCrutchWords(text, crutchWords),
  ];
  hits.sort((a, b) => a.start - b.start || a.end - b.end);
  return hits;
}

import {
  applySafeDeterministicFixesShared,
  type AiTaskId as BaseAiTaskId,
  computeReadabilityMetrics,
  getSurfaceGradeTarget,
  hasSecrets,
  normalizeTypography,
  resolveSurfaceProfileShared,
  type StyleGuideRule,
  scanConsistencyIssues,
  scanTier0DiagnosticsShared,
  scanWritingGuards,
  scoreSlopMeter,
  toSentenceCase,
  toTitleCase,
} from 'lexel-ui';

export type ObsidianAiTaskId = BaseAiTaskId | 'direct' | 'softer' | 'bluf' | 'natural_english';

export interface ObsidianLexelSettings {
  daemonEndpoint: string;
  daemonToken: string;
  styleGuide: StyleGuideRule[];
  customSlopTerms?: string[];
  disabledSlopTerms?: string[];
  crutchWords?: string[];
  redactSecrets?: boolean;
  ghostTextEnabled?: boolean;
}

export const DEFAULT_OBSIDIAN_SETTINGS: ObsidianLexelSettings = {
  daemonEndpoint: 'http://127.0.0.1:42424',
  daemonToken: '',
  styleGuide: [],
  customSlopTerms: [],
  disabledSlopTerms: [],
  crutchWords: [],
  redactSecrets: false,
  ghostTextEnabled: false,
};

export interface ObsidianConsistencyHit {
  kind: 'spelling_dialect' | 'hyphenation' | 'product_casing' | 'version_format';
  message: string;
}

export interface ObsidianGuardHit {
  kind: 'wall_of_text' | 'buried_ask' | 'abrasive_tone' | 'missing_attachment' | 'crutch_word';
  message: string;
}

export interface ObsidianNoteReport {
  words: number;
  grade: number;
  targetMinGrade: number;
  targetMaxGrade: number;
  readingTimeSec: number;
  speakingTimeSec: number;
  slopScore: number;
  slopLabel: 'Human' | 'Mixed' | 'High Slop';
  harperCount: number;
  slopCount: number;
  invisibleCount: number;
  structureCount: number;
  secretCount: number;
  styleGuideCount: number;
  consistencyCount: number;
  guardCount: number;
  consistencyHits: ObsidianConsistencyHit[];
  guardHits: ObsidianGuardHit[];
  totalIssues: number;
  engineSource: 'lexel-wasm' | 'tier0-ts';
  statusBarLabel: string;
}

export interface ObsidianWasmTier0Adapter {
  lintMarkdown?: (text: string) => {
    harperCount: number;
    slopScore?: number;
  };
}

let activeWasmAdapter: ObsidianWasmTier0Adapter | null = null;

/** Register an initialized `lexel-wasm` adapter so Obsidian runs Rust Harper + Tier 0 with zero daemon. */
export function registerObsidianWasmAdapter(adapter: ObsidianWasmTier0Adapter | null): void {
  activeWasmAdapter = adapter;
}

/** Verify an endpoint is strictly loopback (127.0.0.1 / localhost / [::1]). */
export function assertLoopbackEndpoint(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid local daemon endpoint URL.');
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
    throw new Error(
      `Privacy block: host "${host}" is not loopback. Lexel only talks to 127.0.0.1 or localhost.`,
    );
  }
  return parsed.toString().replace(/\/+$/, '');
}

/** Run zero-AI Tier 0 diagnostics, slop meter, consistency, and guards over a Markdown note. */
export function analyzeObsidianNote(
  text: string,
  styleGuide: StyleGuideRule[] = [],
  options?: {
    customSlopTerms?: string[];
    disabledSlopTerms?: string[];
    crutchWords?: string[];
  },
): ObsidianNoteReport {
  const profile = resolveSurfaceProfileShared('docs_markdown');
  const metrics = computeReadabilityMetrics(text);
  const target = getSurfaceGradeTarget('docs_markdown');
  const diag = scanTier0DiagnosticsShared(text, profile, {
    styleGuide,
    customSlopTerms: options?.customSlopTerms,
    disabledSlopTerms: options?.disabledSlopTerms,
    crutchWords: options?.crutchWords,
  });

  const consistencyHits: ObsidianConsistencyHit[] = scanConsistencyIssues(text).map((c) => ({
    kind: c.kind,
    message: c.message,
  }));
  const guardHits: ObsidianGuardHit[] = scanWritingGuards(
    text,
    'docs_markdown',
    options?.crutchWords,
    false,
  ).map((g) => ({
    kind: g.kind,
    message: g.message,
  }));
  const slop = scoreSlopMeter(text, {
    allowEmDashes: profile.allowEmDashes,
    customSlopTerms: options?.customSlopTerms,
    disabledSlopTerms: options?.disabledSlopTerms,
  });

  let harperCount = 0;
  let slopScore = slop.score;
  let engineSource: 'lexel-wasm' | 'tier0-ts' = 'tier0-ts';
  if (activeWasmAdapter?.lintMarkdown) {
    try {
      const wasmRes = activeWasmAdapter.lintMarkdown(text);
      harperCount = wasmRes.harperCount;
      if (typeof wasmRes.slopScore === 'number') {
        slopScore = wasmRes.slopScore;
      }
      engineSource = 'lexel-wasm';
    } catch {
      engineSource = 'tier0-ts';
    }
  }

  const slopLabel: ObsidianNoteReport['slopLabel'] =
    slopScore >= 45 ? 'High Slop' : slopScore >= 18 ? 'Mixed' : 'Human';

  const slopCount = diag.slopLints.length;
  const invisibleCount = diag.invisibleLints.length;
  const structureCount = diag.structureLints.length;
  const secretCount = diag.secretLints.length;
  const styleGuideCount = diag.styleGuideLints.length;
  const consistencyCount = consistencyHits.length;
  const guardCount = guardHits.length;
  const totalIssues =
    harperCount +
    slopCount +
    invisibleCount +
    structureCount +
    secretCount +
    styleGuideCount +
    consistencyCount +
    guardCount;

  const statusBarLabel =
    metrics.words === 0
      ? 'Lexel: empty note · 0B sent'
      : `Lexel: ${metrics.words}w · G${metrics.fleschKincaidGrade.toFixed(1)} · Slop ${slopScore} · ${totalIssues} issue${totalIssues === 1 ? '' : 's'}`;

  return {
    words: metrics.words,
    grade: metrics.fleschKincaidGrade,
    targetMinGrade: target.minGrade,
    targetMaxGrade: target.maxGrade,
    readingTimeSec: metrics.readingTimeSec,
    speakingTimeSec: metrics.speakingTimeSec,
    slopScore,
    slopLabel,
    harperCount,
    slopCount,
    invisibleCount,
    structureCount,
    secretCount,
    styleGuideCount,
    consistencyCount,
    guardCount,
    consistencyHits,
    guardHits,
    totalIssues,
    engineSource,
    statusBarLabel,
  };
}

/** Deterministically clean safe slop, em dashes, invisible Unicode, style guide terms, and smart quotes while preserving code blocks. */
export function applyObsidianSafeFix(
  text: string,
  styleGuide: StyleGuideRule[] = [],
  options?: { customSlopTerms?: string[]; disabledSlopTerms?: string[] },
): { text: string; fixesApplied: number; categories: string[] } {
  const profile = resolveSurfaceProfileShared('docs_markdown');
  const det = applySafeDeterministicFixesShared(text, profile, {
    styleGuide,
    customSlopTerms: options?.customSlopTerms,
    disabledSlopTerms: options?.disabledSlopTerms,
  });
  const norm = normalizeTypography(det.text);
  return {
    text: norm.text,
    fixesApplied: det.fixesApplied + norm.fixesApplied,
    categories: [...new Set([...det.categories, ...norm.categories])],
  };
}

export { normalizeTypography, toSentenceCase, toTitleCase };

/** Request a local AI rewrite from `lexel-daemon` after passing Secrets Guard locally. */
export async function requestLocalDaemonRewrite(
  settings: ObsidianLexelSettings,
  text: string,
  task: ObsidianAiTaskId = 'deslop',
): Promise<
  | {
      ok: true;
      suggestion: string;
      fastPath?: boolean;
      retried?: boolean;
      redactedCount?: number;
    }
  | { ok: false; error: string }
> {
  if (!text.trim()) {
    return { ok: false, error: 'Select text before requesting a local AI rewrite.' };
  }
  if (!settings.redactSecrets && hasSecrets(text)) {
    return {
      ok: false,
      error:
        'Secrets Guard blocked this rewrite because credentials or PII were detected. Enable redact-and-restore in Lexel Obsidian settings to mask tokens locally.',
    };
  }
  const token = settings.daemonToken.trim();
  if (!token) {
    return {
      ok: false,
      error: 'Set your local daemon token in Lexel Obsidian settings (`lexel-daemon token`).',
    };
  }
  let endpoint: string;
  try {
    endpoint = assertLoopbackEndpoint(settings.daemonEndpoint);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const resp = await fetch(`${endpoint}/v1/rewrite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      text,
      task,
      surfaceId: 'docs_markdown',
      subcontext: 'obsidian',
      redactSecrets: settings.redactSecrets === true,
    }),
  });
  const body = (await resp.json()) as {
    suggestion?: string;
    fastPath?: boolean;
    retried?: boolean;
    redactedCount?: number;
    error?: string;
  };
  if (!resp.ok || !body.suggestion) {
    return { ok: false, error: body.error ?? `lexel-daemon returned HTTP ${resp.status}` };
  }
  return {
    ok: true,
    suggestion: body.suggestion,
    fastPath: body.fastPath,
    retried: body.retried,
    redactedCount: body.redactedCount,
  };
}

/** Request an opt-in local ghost-text completion from `lexel-daemon` (`POST /v1/complete`). */
export async function requestLocalDaemonComplete(
  settings: ObsidianLexelSettings,
  prefix: string,
  suffix = '',
): Promise<{ ok: true; completion: string; model?: string } | { ok: false; error: string }> {
  if (!settings.ghostTextEnabled) {
    return { ok: false, error: 'Enable Ghost-text completion in Lexel Obsidian settings first.' };
  }
  if (!prefix.trim()) {
    return { ok: false, error: 'Type some text before requesting a local completion.' };
  }
  if (!settings.redactSecrets && hasSecrets(prefix)) {
    return { ok: false, error: 'Secrets Guard blocked local completion.' };
  }
  const token = settings.daemonToken.trim();
  if (!token) {
    return {
      ok: false,
      error: 'Set your local daemon token in Lexel Obsidian settings (`lexel-daemon token`).',
    };
  }
  let endpoint: string;
  try {
    endpoint = assertLoopbackEndpoint(settings.daemonEndpoint);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const resp = await fetch(`${endpoint}/v1/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      prefix: prefix.slice(-400),
      suffix: suffix.slice(0, 120),
      surfaceId: 'docs_markdown',
      subcontext: 'obsidian',
      maxTokens: 24,
    }),
  });
  const body = (await resp.json()) as { completion?: string; model?: string; error?: string };
  if (!resp.ok) {
    return { ok: false, error: body.error ?? `lexel-daemon returned HTTP ${resp.status}` };
  }
  return { ok: true, completion: body.completion ?? '', model: body.model };
}

/** Fetch local daemon doctor/privacy diagnostics (`GET /v1/doctor`). */
export async function requestLocalDaemonDoctor(
  settings: ObsidianLexelSettings,
): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  const token = settings.daemonToken.trim();
  if (!token) {
    return {
      ok: false,
      error: 'Zero-daemon Tier 0 active. Set a daemon token to check local AI runtime.',
    };
  }
  let endpoint: string;
  try {
    endpoint = assertLoopbackEndpoint(settings.daemonEndpoint);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const resp = await fetch(`${endpoint}/v1/doctor`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await resp.json()) as {
    runtime?: { activeBackend?: string };
    tier0LatencyMs?: number;
    measuredTokPerSec?: number | null;
    privacyProof?: { localOnlyVerified?: boolean; totalSecretBlocks?: number };
    error?: string;
  };
  if (!resp.ok) {
    return { ok: false, error: body.error ?? `lexel-daemon returned HTTP ${resp.status}` };
  }
  const backend = body.runtime?.activeBackend ?? 'unknown';
  const t0 =
    typeof body.tier0LatencyMs === 'number' ? `${body.tier0LatencyMs.toFixed(2)}ms` : 'n/a';
  const tps =
    typeof body.measuredTokPerSec === 'number'
      ? `${body.measuredTokPerSec.toFixed(1)} tok/s`
      : 'unmeasured';
  const blocks = body.privacyProof?.totalSecretBlocks ?? 0;
  return {
    ok: true,
    summary: `Lexel local-only (${backend}) · Tier 0 ${t0} · AI ${tps} · ${blocks} secret block(s)`,
  };
}

/** Pull active profile style guide, anti-slop rules, and crutch words from Lexel Desktop / lexel-daemon. */
export async function syncObsidianSettingsFromDesktop(
  settings: ObsidianLexelSettings,
): Promise<
  { ok: true; next: ObsidianLexelSettings; profileName: string } | { ok: false; error: string }
> {
  const token = settings.daemonToken.trim();
  if (!token) {
    return {
      ok: false,
      error: 'Set your local daemon token in Lexel Obsidian settings (`lexel-daemon token`).',
    };
  }
  let endpoint: string;
  try {
    endpoint = assertLoopbackEndpoint(settings.daemonEndpoint);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const resp = await fetch(`${endpoint}/v1/settings`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const body = (await resp.json()) as {
    profile?: { name?: string };
    settings?: {
      styleGuide?: StyleGuideRule[];
      customSlopTerms?: string[];
      disabledSlopTerms?: string[];
      crutchWords?: string[];
      redactSecrets?: boolean;
      ghostTextEnabled?: boolean;
    };
    error?: string;
  };
  if (!resp.ok || !body.settings) {
    return { ok: false, error: body.error ?? `Lexel Desktop returned HTTP ${resp.status}` };
  }
  return {
    ok: true,
    profileName: body.profile?.name ?? 'Default',
    next: {
      ...settings,
      styleGuide: body.settings.styleGuide ?? settings.styleGuide,
      customSlopTerms: body.settings.customSlopTerms ?? settings.customSlopTerms,
      disabledSlopTerms: body.settings.disabledSlopTerms ?? settings.disabledSlopTerms,
      crutchWords: body.settings.crutchWords ?? settings.crutchWords,
      redactSecrets: body.settings.redactSecrets ?? settings.redactSecrets,
      ghostTextEnabled: body.settings.ghostTextEnabled ?? settings.ghostTextEnabled,
    },
  };
}

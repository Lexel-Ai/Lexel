import {
  type AiTaskId,
  applySafeDeterministicFixesShared,
  computeReadabilityMetrics,
  getSurfaceGradeTarget,
  hasSecrets,
  normalizeTypography,
  resolveSurfaceProfileShared,
  type StyleGuideRule,
  scanTier0DiagnosticsShared,
  toSentenceCase,
  toTitleCase,
} from 'lexel-ui';

export interface ObsidianLexelSettings {
  daemonEndpoint: string;
  daemonToken: string;
  styleGuide: StyleGuideRule[];
}

export const DEFAULT_OBSIDIAN_SETTINGS: ObsidianLexelSettings = {
  daemonEndpoint: 'http://127.0.0.1:42424',
  daemonToken: '',
  styleGuide: [],
};

export interface ObsidianNoteReport {
  words: number;
  grade: number;
  targetMinGrade: number;
  targetMaxGrade: number;
  readingTimeSec: number;
  speakingTimeSec: number;
  slopCount: number;
  invisibleCount: number;
  structureCount: number;
  secretCount: number;
  styleGuideCount: number;
  totalIssues: number;
  statusBarLabel: string;
}

/** Run zero-AI Tier 0 diagnostics and readability goals over a Markdown note. */
export function analyzeObsidianNote(
  text: string,
  styleGuide: StyleGuideRule[] = [],
): ObsidianNoteReport {
  const profile = resolveSurfaceProfileShared('docs_markdown');
  const metrics = computeReadabilityMetrics(text);
  const target = getSurfaceGradeTarget('docs_markdown');
  const diag = scanTier0DiagnosticsShared(text, profile, { styleGuide });

  const slopCount = diag.slopLints.length;
  const invisibleCount = diag.invisibleLints.length;
  const structureCount = diag.structureLints.length;
  const secretCount = diag.secretLints.length;
  const styleGuideCount = diag.styleGuideLints.length;
  const totalIssues = slopCount + invisibleCount + structureCount + secretCount + styleGuideCount;

  const statusBarLabel =
    metrics.words === 0
      ? 'Lexel: empty note'
      : `Lexel: ${metrics.words}w · G${metrics.fleschKincaidGrade.toFixed(1)} · ${totalIssues} issue${totalIssues === 1 ? '' : 's'}`;

  return {
    words: metrics.words,
    grade: metrics.fleschKincaidGrade,
    targetMinGrade: target.minGrade,
    targetMaxGrade: target.maxGrade,
    readingTimeSec: metrics.readingTimeSec,
    speakingTimeSec: metrics.speakingTimeSec,
    slopCount,
    invisibleCount,
    structureCount,
    secretCount,
    styleGuideCount,
    totalIssues,
    statusBarLabel,
  };
}

/** Deterministically clean safe slop, em dashes, invisible Unicode, style guide terms, and smart quotes while preserving code blocks. */
export function applyObsidianSafeFix(
  text: string,
  styleGuide: StyleGuideRule[] = [],
): { text: string; fixesApplied: number; categories: string[] } {
  const profile = resolveSurfaceProfileShared('docs_markdown');
  const det = applySafeDeterministicFixesShared(text, profile, { styleGuide });
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
  task: AiTaskId = 'deslop',
): Promise<{ ok: true; suggestion: string } | { ok: false; error: string }> {
  if (!text.trim()) {
    return { ok: false, error: 'Select text before requesting a local AI rewrite.' };
  }
  if (hasSecrets(text)) {
    return {
      ok: false,
      error: 'Secrets Guard blocked this rewrite because credentials or PII were detected.',
    };
  }
  const token = settings.daemonToken.trim();
  if (!token) {
    return {
      ok: false,
      error: 'Set your local daemon token in Lexel Obsidian settings (`lexel-daemon token`).',
    };
  }
  const endpoint = settings.daemonEndpoint.replace(/\/+$/, '');
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
    }),
  });
  const body = (await resp.json()) as { suggestion?: string; error?: string };
  if (!resp.ok || !body.suggestion) {
    return { ok: false, error: body.error ?? `lexel-daemon returned HTTP ${resp.status}` };
  }
  return { ok: true, suggestion: body.suggestion };
}

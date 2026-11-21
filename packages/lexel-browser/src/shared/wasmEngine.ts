import {
  createLexelWasmEngine,
  type LexelWasmEngine,
  type Tier0CheckOptions,
  type Tier0Report,
} from 'lexel-wasm';
import type { UnpackedLint, UnpackedLintGroups } from 'lint-framework';

let wasmEngine: LexelWasmEngine | null = null;
let wasmInitPromise: Promise<LexelWasmEngine | null> | null = null;
let wasmDisabled = false;

/**
 * Lazily initialize the zero-daemon Rust `lexel-wasm` engine inside the extension service worker.
 * Returns `null` if WASM cannot initialize in the current runtime so callers fall back cleanly.
 */
export async function getLexelWasmEngine(): Promise<LexelWasmEngine | null> {
  if (wasmDisabled) return null;
  if (wasmEngine) return wasmEngine;
  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      try {
        const wasmUrl =
          typeof chrome !== 'undefined' && chrome.runtime?.getURL
            ? chrome.runtime.getURL('wasm/lexel_wasm_bg.wasm')
            : undefined;
        const engine = await createLexelWasmEngine(wasmUrl);
        wasmEngine = engine;
        return engine;
      } catch {
        wasmDisabled = true;
        return null;
      }
    })();
  }
  return wasmInitPromise;
}

export function clearLexelWasmCache(): void {
  wasmEngine?.clearCache();
}

function stableHash(key: string): string {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `lw_${(hash >>> 0).toString(16)}`;
}

function escapeHtml(raw: string): string {
  return raw.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Convert a `lexel-wasm` `Tier0Report` into `lint-framework`'s `UnpackedLintGroups`
 * so the content script renders native underlines & popovers identically with zero daemon.
 */
export function tier0ReportToLintGroups(
  text: string,
  report: Tier0Report,
): {
  bySource: UnpackedLintGroups;
  harperCount: number;
  slopCount: number;
  surfaceWarningCount: number;
  slopScore: number;
  guardCount: number;
  consistencyCount: number;
} {
  const bySource: UnpackedLintGroups = {};

  const pushLint = (group: string, lint: UnpackedLint) => {
    bySource[group] ??= [];
    bySource[group].push(lint);
  };

  for (const d of report.harper) {
    pushLint(d.rule || 'Harper', {
      span: { start: d.start, end: d.end },
      message_html: escapeHtml(d.message),
      problem_text: d.problemText || text.slice(d.start, d.end),
      lint_kind: (d.lintKind || 'Miscellaneous') as UnpackedLint['lint_kind'],
      lint_kind_pretty: d.lintKind || d.rule || 'Grammar',
      suggestions: (d.suggestions ?? []).map((s) => ({
        kind: s === '' ? 1 : 0,
        replacement_text: s,
      })),
      context_hash: stableHash(`${d.rule}:${d.start}:${d.problemText}`),
      source: text,
    });
  }

  for (const s of report.secrets) {
    pushLint('LexelSecrets', {
      span: { start: s.start, end: s.end },
      message_html: `Potential secret or PII detected (${escapeHtml(s.label)}).`,
      problem_text: text.slice(s.start, s.end),
      lint_kind: 'Security' as UnpackedLint['lint_kind'],
      lint_kind_pretty: 'Secrets Guard',
      suggestions: [{ kind: 0, replacement_text: '[REDACTED]' }],
      context_hash: stableHash(`sec:${s.start}:${s.kind}`),
      source: text,
    });
  }

  for (const inv of report.invisibleChars) {
    pushLint('LexelInvisibleChars', {
      span: { start: inv.start, end: inv.end },
      message_html: `Hidden Unicode character ${escapeHtml(inv.label)} (<code>${escapeHtml(inv.codepoint)}</code>).`,
      problem_text: text.slice(inv.start, inv.end),
      lint_kind: 'Formatting',
      lint_kind_pretty: 'Hidden Char',
      suggestions: [{ kind: inv.replacement === '' ? 1 : 0, replacement_text: inv.replacement }],
      context_hash: stableHash(`inv:${inv.start}:${inv.codepoint}`),
      source: text,
    });
  }

  for (const st of report.structure) {
    pushLint('LexelStructure', {
      span: { start: st.start, end: st.end },
      message_html: escapeHtml(st.message),
      problem_text: st.problemText || text.slice(st.start, st.end),
      lint_kind: 'Punctuation',
      lint_kind_pretty: 'Structure',
      suggestions:
        st.suggestion !== undefined ? [{ kind: 0, replacement_text: st.suggestion }] : [],
      context_hash: stableHash(`str:${st.start}:${st.kind}`),
      source: text,
    });
  }

  for (const sg of report.styleGuide) {
    const note = sg.note ? ` (${escapeHtml(sg.note)})` : '';
    pushLint('LexelStyleGuide', {
      span: { start: sg.start, end: sg.end },
      message_html: `Style guide prefers <code>${escapeHtml(sg.preferred)}</code> over <code>${escapeHtml(sg.term)}</code>${note}.`,
      problem_text: text.slice(sg.start, sg.end),
      lint_kind: 'Style',
      lint_kind_pretty: 'Style Guide',
      suggestions: [{ kind: 0, replacement_text: sg.preferred }],
      context_hash: stableHash(`sg:${sg.start}:${sg.term}`),
      source: text,
    });
  }

  for (const hit of report.slop) {
    const suggestions =
      hit.suggestion !== undefined
        ? [{ kind: hit.suggestion === '' ? 1 : 0, replacement_text: hit.suggestion }]
        : [];
    pushLint('LexelAntiSlop', {
      span: { start: hit.start, end: hit.end },
      message_html: hit.isEmDash
        ? 'Em dash detected. Replace with a comma, period, or parentheses.'
        : `Common AI phrasing (<code>${escapeHtml(hit.term)}</code>). Use specific, plain wording.`,
      problem_text: text.slice(hit.start, hit.end),
      lint_kind: hit.isEmDash ? 'Punctuation' : 'Style',
      lint_kind_pretty: 'LexelAntiSlop',
      suggestions,
      context_hash: stableHash(`slop:${hit.start}:${hit.term}`),
      source: text,
    });
  }

  for (const surf of report.surface) {
    pushLint('LexelSurface', {
      span: { start: surf.start, end: surf.end },
      message_html: escapeHtml(surf.message),
      problem_text: text.slice(surf.start, surf.end),
      lint_kind: 'Style',
      lint_kind_pretty: 'LexelSurface',
      suggestions: [],
      context_hash: stableHash(`surf:${surf.start}:${surf.kind}`),
      source: text,
    });
  }

  for (const cons of report.consistency) {
    pushLint('LexelConsistency', {
      span: { start: cons.start, end: cons.end },
      message_html: escapeHtml(cons.message),
      problem_text: cons.found || text.slice(cons.start, cons.end),
      lint_kind: 'Style',
      lint_kind_pretty: 'Consistency',
      suggestions: cons.preferred ? [{ kind: 0, replacement_text: cons.preferred }] : [],
      context_hash: stableHash(`cons:${cons.start}:${cons.groupKey}`),
      source: text,
    });
  }

  for (const guard of report.guards) {
    const title =
      guard.kind === 'wall_of_text'
        ? 'Wall of text'
        : guard.kind === 'buried_ask'
          ? 'Buried ask (BLUF)'
          : guard.kind === 'abrasive_tone'
            ? 'Regret Shield'
            : guard.kind === 'missing_attachment'
              ? 'Attachment check'
              : 'Crutch word';
    pushLint('LexelGuard', {
      span: { start: guard.start, end: guard.end },
      message_html: escapeHtml(guard.message),
      problem_text: guard.matchedText || text.slice(guard.start, guard.end),
      lint_kind: guard.severity === 'warning' ? 'Readability' : 'Style',
      lint_kind_pretty: title,
      suggestions:
        guard.suggestion !== undefined
          ? [{ kind: guard.suggestion === '' ? 1 : 0, replacement_text: guard.suggestion }]
          : [],
      context_hash: stableHash(`guard:${guard.start}:${guard.ruleId}`),
      source: text,
    });
  }

  return {
    bySource,
    harperCount: report.harper.length,
    slopCount: report.slop.length,
    surfaceWarningCount: report.surface.length,
    slopScore: report.slopMeter.score,
    guardCount: report.guards.length,
    consistencyCount: report.consistency.length,
  };
}

export async function runLexelWasmCheck(
  text: string,
  options: Tier0CheckOptions,
): Promise<ReturnType<typeof tier0ReportToLintGroups> | null> {
  const engine = await getLexelWasmEngine();
  if (!engine) return null;
  const report = engine.check(text, options);
  return tier0ReportToLintGroups(text, report);
}

import {
  computeReadabilityMetrics,
  RewriteDiffCard,
  SurfaceBadge,
  type AiTaskId,
  type SurfaceProfile,
} from 'lexel-ui';
import React, { useMemo, useState } from 'react';
import { daemonRpc, rewriteWithTask } from '../lib/desktopClient';
import { mergeSurfaceCatalog } from '../lib/surfaces';
import type {
  RewriteResponse,
  Tier0CheckResponse,
  UnifiedDaemonSettings,
} from '../lib/types';

interface StudioPaneProps {
  settings: UnifiedDaemonSettings;
  onRefreshStatus: () => Promise<void>;
}

const TASKS: ReadonlyArray<{ id: AiTaskId; label: string }> = [
  { id: 'deslop', label: 'Deslop & Clean' },
  { id: 'fix_grammar_flow', label: 'Fix Grammar & Flow' },
  { id: 'shorten', label: 'Tighten' },
  { id: 'rewrite_surface', label: 'Match Surface Tone' },
  { id: 'reply_draft', label: 'Draft Reply' },
];

export function StudioPane({ settings, onRefreshStatus }: StudioPaneProps) {
  const { surfaces } = useMemo(
    () => mergeSurfaceCatalog(settings.customSurfaces),
    [settings.customSurfaces],
  );

  const [surfaceId, setSurfaceId] = useState<string>('web_reddit');
  const [subcontext, setSubcontext] = useState('r/rust');
  const [task, setTask] = useState<AiTaskId>('deslop');
  const [text, setText] = useState(
    'In todays fast-paced landscape, we delve into why local AI rewrites should stay fast — and keep latency under 18ms for #42.',
  );
  const [undoText, setUndoText] = useState<string | null>(null);
  const [synonymWord, setSynonymWord] = useState('');
  const [synonyms, setSynonyms] = useState<string[]>([]);
  const [synonymNotice, setSynonymNotice] = useState<string | null>(null);
  const [tier0, setTier0] = useState<Tier0CheckResponse | null>(null);
  const [rewrite, setRewrite] = useState<RewriteResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeSurface: SurfaceProfile =
    surfaces.find((s) => s.id === surfaceId) ?? surfaces[0];
  const metrics = useMemo(() => computeReadabilityMetrics(text), [text]);

  async function runTier0Check() {
    setError(null);
    setNotice(null);
    try {
      const result = await daemonRpc<Tier0CheckResponse>('tier0Check', {
        text,
        surfaceId,
        language: settings.languageMode,
      });
      setTier0(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runSafeFix() {
    setError(null);
    setNotice(null);
    try {
      const fixed = await daemonRpc<{ text: string; fixesApplied: number }>('fixAllSafe', {
        text,
        surfaceId,
        language: settings.languageMode,
      });
      if (fixed.text !== text) {
        setUndoText(text);
        setText(fixed.text);
      }
      setNotice(
        fixed.fixesApplied > 0
          ? `Applied ${fixed.fixesApplied} deterministic fix${fixed.fixesApplied === 1 ? '' : 'es'}.`
          : 'No safe deterministic fixes needed.',
      );
      const next = await daemonRpc<Tier0CheckResponse>('tier0Check', {
        text: fixed.text,
        surfaceId,
        language: settings.languageMode,
      });
      setTier0(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runDeterministicTransform(kind: 'titleCase' | 'sentenceCase' | 'normalizeTypography') {
    if (!text.trim()) return;
    setError(null);
    setNotice(null);
    try {
      const res = await daemonRpc<{ text: string; fixesApplied?: number }>(kind, { text });
      if (res.text && res.text !== text) {
        setUndoText(text);
        setText(res.text);
        setNotice(
          kind === 'titleCase'
            ? 'Converted draft to Chicago Title Case.'
            : kind === 'sentenceCase'
              ? 'Converted draft to Sentence Case.'
              : 'Normalized quotes, ellipses, and spacing.',
        );
      } else {
        setNotice('Draft already matches that format.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSynonymLookup(e: React.FormEvent) {
    e.preventDefault();
    const word = synonymWord.trim();
    if (!word) return;
    setSynonymNotice(null);
    try {
      const res = await daemonRpc<{ synonyms: string[] }>('synonyms', { word });
      setSynonyms(res.synonyms ?? []);
      if (!res.synonyms || res.synonyms.length === 0) {
        setSynonymNotice(`No local thesaurus entries found for "${word}".`);
      }
    } catch (err) {
      setSynonymNotice(err instanceof Error ? err.message : String(err));
    }
  }

  async function runAiRewrite() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await rewriteWithTask({
        text,
        task,
        surfaceId,
        subcontext: subcontext.trim() || null,
      });
      setRewrite(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleAcceptRewrite() {
    if (!rewrite) return;
    setUndoText(text);
    setText(rewrite.suggestion);
    if (settings.saveVoiceMemory) {
      await daemonRpc('saveVoiceExample', {
        example: {
          surfaceId: rewrite.surfaceId,
          subcontext: rewrite.subcontext,
          original: rewrite.original,
          rewritten: rewrite.suggestion,
          action: 'accepted',
        },
      });
      await onRefreshStatus();
    }
    setRewrite(null);
    setNotice('Applied rewrite and saved to local Voice Memory.');
  }

  async function handleCopyRewrite() {
    if (!rewrite) return;
    await navigator.clipboard?.writeText(rewrite.suggestion).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[18px] font-semibold">Quick Rewrite</h1>
          <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
            Draft, check with native Rust Harper + Anti-Slop, and run surface-scoped local AI rewrites.
          </p>
        </div>
        <SurfaceBadge
          label={activeSurface.label}
          subcontext={subcontext.trim() || null}
          charCount={text.length}
          maxChars={activeSurface.maxChars}
        />
      </header>

      <div
        className="grid gap-3 rounded-[8px] border p-3 sm:grid-cols-3"
        style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
      >
        <div>
          <label
            htmlFor="desktop-surface-select"
            className="mb-1 block text-[11px] font-medium"
            style={{ color: 'var(--lx-fg-muted)' }}
          >
            Target Surface
          </label>
          <select
            id="desktop-surface-select"
            value={surfaceId}
            onChange={(e) => {
              setSurfaceId(e.target.value);
              setRewrite(null);
            }}
            className="w-full rounded-[6px] border px-2.5 py-1.5 text-[13px]"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          >
            {surfaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="desktop-task-select"
            className="mb-1 block text-[11px] font-medium"
            style={{ color: 'var(--lx-fg-muted)' }}
          >
            Rewrite Action
          </label>
          <select
            id="desktop-task-select"
            value={task}
            onChange={(e) => setTask(e.target.value as AiTaskId)}
            className="w-full rounded-[6px] border px-2.5 py-1.5 text-[13px]"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          >
            {TASKS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="desktop-subcontext-input"
            className="mb-1 block text-[11px] font-medium"
            style={{ color: 'var(--lx-fg-muted)' }}
          >
            Subcontext (optional)
          </label>
          <input
            id="desktop-subcontext-input"
            type="text"
            value={subcontext}
            onChange={(e) => setSubcontext(e.target.value)}
            placeholder="e.g. r/rust, PR review"
            className="w-full rounded-[6px] border px-2.5 py-1.5 text-[13px]"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          />
        </div>
      </div>

      <div
        className="rounded-[8px] border p-3"
        style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
      >
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] lexel-mono" style={{ color: 'var(--lx-fg-muted)' }}>
          <span>
            Draft ({metrics.words} words, {text.length} chars, grade {metrics.fleschKincaidGrade.toFixed(1)}, ease {metrics.fleschReadingEase.toFixed(0)})
          </span>
          <span>
            Limit: {activeSurface.maxChars ? `${activeSurface.maxChars} chars` : 'unbounded'}
          </span>
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={7}
          aria-label="Draft editor"
          className="w-full rounded-[6px] border p-3 text-[13px] leading-[1.6]"
          style={{
            backgroundColor: 'var(--lx-surface)',
            borderColor: 'var(--lx-border)',
            color: 'var(--lx-fg)',
          }}
        />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={runTier0Check}
            className="rounded-[6px] border px-3 py-1.5 text-[12px] font-medium"
            style={{
              backgroundColor: 'var(--lx-muted)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          >
            Run Tier 0 Check
          </button>
          <button
            type="button"
            onClick={runSafeFix}
            className="rounded-[6px] border px-3 py-1.5 text-[12px] font-medium"
            style={{
              backgroundColor: 'var(--lx-muted)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          >
            Fix Safe Issues (No AI)
          </button>
          <button
            type="button"
            onClick={() => void runDeterministicTransform('titleCase')}
            className="rounded-[6px] border px-2.5 py-1.5 text-[12px]"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          >
            Title Case
          </button>
          <button
            type="button"
            onClick={() => void runDeterministicTransform('sentenceCase')}
            className="rounded-[6px] border px-2.5 py-1.5 text-[12px]"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          >
            Sentence Case
          </button>
          <button
            type="button"
            onClick={() => void runDeterministicTransform('normalizeTypography')}
            className="rounded-[6px] border px-2.5 py-1.5 text-[12px]"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          >
            Clean Quotes
          </button>
          {undoText !== null && (
            <button
              type="button"
              onClick={() => {
                setText(undoText);
                setUndoText(null);
              }}
              className="rounded-[6px] border px-2.5 py-1.5 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-warn-bg)',
                borderColor: 'var(--lx-warn)',
                color: 'var(--lx-warn)',
              }}
            >
              Undo
            </button>
          )}
          <button
            type="button"
            onClick={runAiRewrite}
            disabled={busy || !settings.aiEnabled}
            className="ml-auto rounded-[6px] px-3.5 py-1.5 text-[12px] font-semibold"
            style={{
              backgroundColor: 'var(--lx-accent)',
              color: 'var(--lx-on-accent)',
            }}
          >
            {busy ? 'Rewriting...' : 'Rewrite with Local AI'}
          </button>
        </div>
      </div>

      <section
        className="space-y-2 rounded-[8px] border p-3"
        style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
      >
        <form onSubmit={handleSynonymLookup} className="flex flex-wrap items-center gap-2">
          <label
            htmlFor="desktop-synonym-input"
            className="text-[12px] font-medium"
            style={{ color: 'var(--lx-fg-muted)' }}
          >
            Offline Thesaurus
          </label>
          <input
            id="desktop-synonym-input"
            type="text"
            value={synonymWord}
            onChange={(e) => setSynonymWord(e.target.value)}
            placeholder="Look up plain-English alternatives..."
            className="min-w-[200px] flex-1 rounded-[6px] border px-2.5 py-1 text-[12px]"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          />
          <button
            type="submit"
            className="rounded-[6px] border px-2.5 py-1 text-[12px] font-medium"
            style={{
              backgroundColor: 'var(--lx-muted)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          >
            Find Synonyms
          </button>
        </form>
        {synonymNotice && (
          <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
            {synonymNotice}
          </div>
        )}
        {synonyms.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {synonyms.map((word) => (
              <button
                key={word}
                type="button"
                onClick={() => void navigator.clipboard?.writeText(word)}
                title="Copy synonym"
                className="rounded-[4px] border px-2 py-0.5 text-[11px] lexel-mono"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-signal)',
                }}
              >
                {word}
              </button>
            ))}
          </div>
        )}
      </section>

      {error && (
        <div
          role="alert"
          className="rounded-[6px] border px-3 py-2 text-[12px]"
          style={{
            backgroundColor: 'var(--lx-danger-bg)',
            borderColor: 'var(--lx-danger)',
            color: 'var(--lx-danger)',
          }}
        >
          {error}
        </div>
      )}

      {notice && (
        <div
          className="rounded-[6px] border px-3 py-2 text-[12px]"
          style={{
            backgroundColor: 'var(--lx-signal-bg)',
            borderColor: 'var(--lx-signal)',
            color: 'var(--lx-signal)',
          }}
        >
          {notice}
        </div>
      )}

      {rewrite && (
        <RewriteDiffCard
          original={rewrite.original}
          suggestion={rewrite.suggestion}
          gates={rewrite.gates}
          modelName={rewrite.model}
          latencyMs={rewrite.latencyMs}
          copied={copied}
          onApply={handleAcceptRewrite}
          onCopy={handleCopyRewrite}
          onRetry={runAiRewrite}
          onReject={() => setRewrite(null)}
        />
      )}

      {tier0 && (
        <section
          aria-label="Tier 0 Findings"
          className="space-y-2 rounded-[8px] border p-3"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <h2 className="text-[13px] font-semibold">
            Tier 0 Findings ({tier0.harper.length} grammar, {tier0.slop.length} slop, {tier0.surface.length} surface, {tier0.secrets.length} secrets)
          </h2>

          {tier0.harper.length === 0 &&
            tier0.slop.length === 0 &&
            tier0.surface.length === 0 &&
            tier0.secrets.length === 0 && (
              <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
                No issues found for {activeSurface.label}.
              </p>
            )}

          {tier0.secrets.map((secret, idx) => (
            <div
              key={`secret-${idx}-${secret.start}`}
              role="alert"
              className="flex items-center justify-between gap-2 rounded-[6px] border px-2.5 py-1.5 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-danger-bg)',
                borderColor: 'var(--lx-danger)',
                color: 'var(--lx-danger)',
              }}
            >
              <span>
                <strong>{secret.label}</strong> detected ({secret.maskedPreview}). Remove before AI rewrite.
              </span>
              <span className="lexel-mono text-[11px]">{secret.kind}</span>
            </div>
          ))}

          {tier0.slop.map((hit, idx) => (
            <div
              key={`slop-${idx}-${hit.start}`}
              className="flex items-center justify-between gap-2 rounded-[6px] border px-2.5 py-1.5 text-[12px]"
              style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
            >
              <span>
                <strong className="lexel-mono">{hit.term}</strong> flagged ({hit.isEmDash ? 'em_dash' : 'slop'})
              </span>
              {hit.suggestion && (
                <span className="lexel-mono text-[11px]" style={{ color: 'var(--lx-signal)' }}>
                  suggest: {hit.suggestion}
                </span>
              )}
            </div>
          ))}

          {tier0.surface.map((item, idx) => (
            <div
              key={`surface-${idx}-${item.start}`}
              className="rounded-[6px] border px-2.5 py-1.5 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-warn-bg)',
                borderColor: 'var(--lx-warn)',
                color: 'var(--lx-warn)',
              }}
            >
              {item.message}
            </div>
          ))}

          {tier0.harper.map((item, idx) => (
            <div
              key={`harper-${idx}-${item.start}-${item.end}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] border px-2.5 py-1.5 text-[12px]"
              style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
            >
              <span>
                <span className="lexel-mono font-medium">{item.problemText}</span>: {item.message}
              </span>
              {item.suggestions.length > 0 && (
                <span className="lexel-mono text-[11px]" style={{ color: 'var(--lx-signal)' }}>
                  {item.suggestions.slice(0, 3).join(' | ')}
                </span>
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

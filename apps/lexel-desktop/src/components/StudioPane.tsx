import {
  type AiTaskId,
  computeReadabilityMetrics,
  expandSnippetAtCursor,
  getSurfaceGradeTarget,
  RewriteDiffCard,
  SurfaceBadge,
  type SurfaceProfile,
} from 'lexel-ui';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  daemonRpc,
  polishClipboardSafe,
  readClipboardText,
  rewriteWithTask,
} from '../lib/desktopClient';
import { mergeSurfaceCatalog } from '../lib/surfaces';
import type {
  DraftSnapshot,
  RewriteResponse,
  Tier0CheckResponse,
  UnifiedDaemonSettings,
} from '../lib/types';

interface StudioPaneProps {
  settings: UnifiedDaemonSettings;
  incomingDraft?: { text: string; seq: number } | null;
  onRefreshStatus: () => Promise<void>;
}

const TASKS: ReadonlyArray<{ id: AiTaskId; label: string }> = [
  { id: 'deslop', label: 'Deslop & Clean' },
  { id: 'fix_grammar_flow', label: 'Fix Grammar & Flow' },
  { id: 'shorten', label: 'Tighten' },
  { id: 'rewrite_surface', label: 'Match Surface Tone' },
  { id: 'reply_draft', label: 'Draft Reply' },
];

export function StudioPane({ settings, incomingDraft, onRefreshStatus }: StudioPaneProps) {
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
  const [drafts, setDrafts] = useState<DraftSnapshot[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [synonymWord, setSynonymWord] = useState('');
  const [synonyms, setSynonyms] = useState<string[]>([]);
  const [synonymNotice, setSynonymNotice] = useState<string | null>(null);
  const [tier0, setTier0] = useState<Tier0CheckResponse | null>(null);
  const [rewrite, setRewrite] = useState<RewriteResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshDrafts = useCallback(async () => {
    try {
      const res = await daemonRpc<{ drafts: DraftSnapshot[] }>('listDrafts', {});
      setDrafts(res.drafts ?? []);
    } catch {
      // Non-fatal in preview mode.
    }
  }, []);

  useEffect(() => {
    void refreshDrafts();
  }, [refreshDrafts]);

  useEffect(() => {
    if (!incomingDraft?.text) return;
    setText((prev) => {
      setUndoText(prev);
      return incomingDraft.text;
    });
    setRewrite(null);
    setNotice('Loaded draft from system clipboard (Cmd/Ctrl+Shift+L).');
  }, [incomingDraft]);

  const activeSurface: SurfaceProfile = surfaces.find((s) => s.id === surfaceId) ?? surfaces[0];
  const metrics = useMemo(() => computeReadabilityMetrics(text), [text]);
  const gradeTarget = useMemo(() => getSurfaceGradeTarget(surfaceId), [surfaceId]);
  const gradeInRange =
    metrics.words === 0 ||
    (metrics.fleschKincaidGrade >= gradeTarget.minGrade &&
      metrics.fleschKincaidGrade <= gradeTarget.maxGrade);

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

  async function runDeterministicTransform(
    kind: 'titleCase' | 'sentenceCase' | 'normalizeTypography',
  ) {
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

  async function handlePolishClipboard() {
    setError(null);
    setNotice(null);
    try {
      const report = await polishClipboardSafe(surfaceId);
      setUndoText(text);
      setText(report.polished);
      if (report.secretsBlocked > 0) {
        setError(
          `Secrets Guard blocked clipboard auto-rewrite (${report.secretsBlocked} secret match). Draft loaded for manual inspection.`,
        );
      } else if (report.fixesApplied > 0) {
        setNotice(
          `Polished clipboard with ${report.fixesApplied} safe fix${report.fixesApplied === 1 ? '' : 'es'} and copied clean text back.`,
        );
      } else {
        setNotice('Loaded clipboard text. No deterministic fixes needed.');
      }
      await onRefreshStatus();
    } catch (err) {
      try {
        const raw = await readClipboardText();
        if (raw.trim()) {
          setUndoText(text);
          setText(raw);
          setNotice('Loaded text from clipboard.');
          return;
        }
      } catch {
        // Report original error below.
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSaveSnapshot() {
    if (!text.trim()) return;
    setError(null);
    try {
      await daemonRpc('saveDraft', { draft: { surfaceId, content: text } });
      await refreshDrafts();
      setShowHistory(true);
      setNotice('Saved draft snapshot to local SQLite history.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[18px] font-semibold">Quick Rewrite</h1>
          <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
            Draft, check with native Rust Harper + Anti-Slop, and run surface-scoped local AI
            rewrites.
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
        <div
          className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] lexel-mono"
          style={{ color: 'var(--lx-fg-muted)' }}
        >
          <span>
            Draft ({metrics.words} words, {text.length} chars, grade{' '}
            {metrics.fleschKincaidGrade.toFixed(1)}, ease {metrics.fleschReadingEase.toFixed(0)})
          </span>
          <span>
            Limit: {activeSurface.maxChars ? `${activeSurface.maxChars} chars` : 'unbounded'}
          </span>
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== ' ' && e.key !== 'Tab' && e.key !== 'Enter') return;
            const snippets = settings.snippets ?? [];
            if (snippets.length === 0) return;
            const el = e.currentTarget;
            const start = el.selectionStart ?? text.length;
            const end = el.selectionEnd ?? start;
            if (start !== end) return;
            const expanded = expandSnippetAtCursor(text, start, snippets);
            if (!expanded) return;
            e.preventDefault();
            const suffix = e.key === 'Enter' ? '\n' : ' ';
            const nextText = `${expanded.text.slice(0, expanded.cursor)}${suffix}${expanded.text.slice(expanded.cursor)}`;
            const nextCaret = expanded.cursor + suffix.length;
            setUndoText(text);
            setText(nextText);
            setNotice(`Expanded snippet ${expanded.expandedTrigger}.`);
            requestAnimationFrame(() => {
              el.setSelectionRange(nextCaret, nextCaret);
            });
          }}
          rows={7}
          aria-label="Draft editor"
          className="w-full rounded-[6px] border p-3 text-[13px] leading-[1.6]"
          style={{
            backgroundColor: 'var(--lx-surface)',
            borderColor: 'var(--lx-border)',
            color: 'var(--lx-fg)',
          }}
        />

        <div
          className="mt-2 grid grid-cols-2 gap-2 rounded-[6px] border px-2.5 py-2 text-[11px] lexel-mono sm:grid-cols-5"
          style={{
            backgroundColor: 'var(--lx-surface)',
            borderColor: 'var(--lx-border)',
            color: 'var(--lx-fg-muted)',
          }}
        >
          <div>
            <span className="block text-[10px]">Grade Goal</span>
            <span style={{ color: gradeInRange ? 'var(--lx-signal)' : 'var(--lx-warn)' }}>
              G{metrics.fleschKincaidGrade.toFixed(1)} (target {gradeTarget.minGrade}-
              {gradeTarget.maxGrade})
            </span>
          </div>
          <div>
            <span className="block text-[10px]">Read / Speak</span>
            <span style={{ color: 'var(--lx-fg)' }}>
              {metrics.readingTimeSec}s / {metrics.speakingTimeSec}s
            </span>
          </div>
          <div>
            <span className="block text-[10px]">Passive Hints</span>
            <span
              style={{ color: metrics.passiveHintCount > 2 ? 'var(--lx-warn)' : 'var(--lx-fg)' }}
            >
              {metrics.passiveHintCount}
            </span>
          </div>
          <div>
            <span className="block text-[10px]">Hedging</span>
            <span style={{ color: metrics.hedgingPercent > 4 ? 'var(--lx-warn)' : 'var(--lx-fg)' }}>
              {metrics.hedgingCount} ({metrics.hedgingPercent}%)
            </span>
          </div>
          <div>
            <span className="block text-[10px]">Rhythm Variety</span>
            <span style={{ color: 'var(--lx-fg)' }}>{metrics.sentenceVarietyScore}/100</span>
          </div>
        </div>

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
            Run Grammar &amp; Slop Check
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
          <button
            type="button"
            onClick={() => void handlePolishClipboard()}
            className="rounded-[6px] border px-2.5 py-1.5 text-[12px]"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          >
            Polish Clipboard
          </button>
          <button
            type="button"
            onClick={() => void handleSaveSnapshot()}
            className="rounded-[6px] border px-2.5 py-1.5 text-[12px]"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          >
            Save Snapshot
          </button>
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            className="rounded-[6px] border px-2.5 py-1.5 text-[12px]"
            style={{
              backgroundColor: showHistory ? 'var(--lx-muted)' : 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          >
            History ({drafts.length})
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

      {showHistory && (
        <section
          aria-label="Local Draft History"
          className="space-y-2 rounded-[8px] border p-3"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold">Local Draft Snapshots ({drafts.length})</h2>
            <span className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
              Opt-in local SQLite only (purged by Purge Local Data)
            </span>
          </div>
          {drafts.length === 0 ? (
            <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
              No saved snapshots yet. Click Save Snapshot above to keep a local version.
            </p>
          ) : (
            <div className="max-h-48 space-y-1.5 overflow-y-auto">
              {drafts.map((snap) => (
                <div
                  key={snap.id}
                  className="flex items-center justify-between gap-2 rounded-[6px] border px-2.5 py-1.5 text-[12px]"
                  style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{snap.title}</div>
                    <div className="text-[11px] lexel-mono" style={{ color: 'var(--lx-fg-muted)' }}>
                      {snap.surfaceId} · {snap.wordCount} words
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setUndoText(text);
                        setText(snap.content);
                        setSurfaceId(snap.surfaceId);
                        setNotice(`Restored snapshot "${snap.title}".`);
                      }}
                      className="rounded-[4px] border px-2 py-0.5 text-[11px]"
                      style={{
                        backgroundColor: 'var(--lx-card)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        await daemonRpc('deleteDraft', { id: snap.id });
                        await refreshDrafts();
                      }}
                      className="rounded-[4px] px-1.5 py-0.5 text-[11px]"
                      style={{ color: 'var(--lx-danger)' }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

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
          aria-label="Check Findings"
          className="space-y-2 rounded-[8px] border p-3"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <h2 className="text-[13px] font-semibold">
            Check Findings ({tier0.harper.length} grammar, {tier0.slop.length} slop,{' '}
            {tier0.surface.length} surface, {tier0.secrets.length} secrets,{' '}
            {(tier0.invisibleChars?.length ?? 0) +
              (tier0.structure?.length ?? 0) +
              (tier0.styleGuide?.length ?? 0)}{' '}
            quality)
          </h2>

          {tier0.harper.length === 0 &&
            tier0.slop.length === 0 &&
            tier0.surface.length === 0 &&
            tier0.secrets.length === 0 &&
            (tier0.invisibleChars?.length ?? 0) === 0 &&
            (tier0.structure?.length ?? 0) === 0 &&
            (tier0.styleGuide?.length ?? 0) === 0 && (
              <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
                No issues found for {activeSurface.label}.
              </p>
            )}

          {(tier0.invisibleChars ?? []).map((inv) => (
            <div
              key={`inv-${inv.codepoint}-${inv.start}`}
              className="flex items-center justify-between gap-2 rounded-[6px] border px-2.5 py-1.5 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-warn-bg)',
                borderColor: 'var(--lx-warn)',
                color: 'var(--lx-warn)',
              }}
            >
              <span>
                Hidden Unicode <strong>{inv.label}</strong> ({inv.codepoint})
              </span>
              <span className="lexel-mono text-[11px]">Invisible</span>
            </div>
          ))}

          {(tier0.structure ?? []).map((issue) => (
            <div
              key={`struct-${issue.kind}-${issue.start}-${issue.end}`}
              className="flex items-center justify-between gap-2 rounded-[6px] border px-2.5 py-1.5 text-[12px]"
              style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
            >
              <span>{issue.message}</span>
              <span className="lexel-mono text-[11px]" style={{ color: 'var(--lx-warn)' }}>
                {issue.kind}
              </span>
            </div>
          ))}

          {(tier0.styleGuide ?? []).map((hit) => (
            <div
              key={`style-${hit.term}-${hit.start}`}
              className="flex items-center justify-between gap-2 rounded-[6px] border px-2.5 py-1.5 text-[12px]"
              style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
            >
              <span>
                Style Guide: <strong>{hit.term}</strong> -&gt; <code>{hit.preferred}</code>
                {hit.note ? ` (${hit.note})` : ''}
              </span>
              <span className="lexel-mono text-[11px]" style={{ color: 'var(--lx-signal)' }}>
                Brand
              </span>
            </div>
          ))}

          {tier0.secrets.map((secret) => (
            <div
              key={`secret-${secret.kind}-${secret.start}-${secret.end}`}
              role="alert"
              className="flex items-center justify-between gap-2 rounded-[6px] border px-2.5 py-1.5 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-danger-bg)',
                borderColor: 'var(--lx-danger)',
                color: 'var(--lx-danger)',
              }}
            >
              <span>
                <strong>{secret.label}</strong> detected ({secret.maskedPreview}). Remove before AI
                rewrite.
              </span>
              <span className="lexel-mono text-[11px]">{secret.kind}</span>
            </div>
          ))}

          {tier0.slop.map((hit) => (
            <div
              key={`slop-${hit.term}-${hit.start}-${hit.end}`}
              className="flex items-center justify-between gap-2 rounded-[6px] border px-2.5 py-1.5 text-[12px]"
              style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
            >
              <span>
                <strong className="lexel-mono">{hit.term}</strong> flagged (
                {hit.isEmDash ? 'em_dash' : 'slop'})
              </span>
              {hit.suggestion && (
                <span className="lexel-mono text-[11px]" style={{ color: 'var(--lx-signal)' }}>
                  suggest: {hit.suggestion}
                </span>
              )}
            </div>
          ))}

          {tier0.surface.map((item) => (
            <div
              key={`surface-${item.kind}-${item.start}-${item.end}`}
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

          {tier0.harper.map((item) => (
            <div
              key={`harper-${item.rule}-${item.start}-${item.end}`}
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

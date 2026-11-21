'use client';

import {
  type GuardAlertItem,
  GuardAlerts,
  PrivacyProofBadge,
  SlopMeter,
  StatusPill,
  SurfaceBadge,
  UndoToast,
} from 'lexel-ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PLAYGROUND_PRESETS } from '@/lib/siteData';
import {
  analyzeTier0Client,
  applySafeTier0Fixes,
  applySingleDiagnosticFix,
  type DiagnosticCategory,
  type DialectId,
  getAllSurfaces,
  initTier0Engine,
  type PlaygroundDiagnostic,
} from '@/lib/tier0Engine';

const DIALECTS: readonly DialectId[] = ['American', 'British', 'Canadian', 'Australian'];

const FILTER_TABS: ReadonlyArray<{ id: 'all' | DiagnosticCategory; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'harper', label: 'Grammar' },
  { id: 'slop', label: 'Anti-Slop' },
  { id: 'surface', label: 'Surface' },
  { id: 'consistency', label: 'Consistency' },
  { id: 'guards', label: 'Guards' },
  { id: 'secrets', label: 'Secrets' },
  { id: 'structure', label: 'Structure' },
];

type EngineLoadState =
  | { status: 'loading' }
  | { status: 'ready'; kind: 'wasm' | 'js-fallback'; label: string; note: string }
  | { status: 'error'; message: string };

function mapToGuardAlertKind(item: PlaygroundDiagnostic): GuardAlertItem['kind'] {
  if (item.category === 'secrets') return 'secret';
  if (item.category === 'consistency') return 'consistency';
  if (item.category === 'surface') return 'surface';
  if (item.category === 'structure') return 'invisible';
  if (
    item.ruleLabel.toLowerCase().includes('bluf') ||
    item.ruleLabel.toLowerCase().includes('wall')
  ) {
    return 'bluf';
  }
  if (item.ruleLabel.toLowerCase().includes('crutch')) return 'crutch';
  return 'regret';
}

export function PlaygroundWorkspace() {
  const surfaces = useMemo(() => getAllSurfaces(), []);
  const [engineState, setEngineState] = useState<EngineLoadState>({ status: 'loading' });
  const [text, setText] = useState<string>(PLAYGROUND_PRESETS[0].text);
  const [surfaceId, setSurfaceId] = useState<string>(PLAYGROUND_PRESETS[0].surfaceId);
  const [dialect, setDialect] = useState<DialectId>('American');
  const [crutchWords, setCrutchWords] = useState<string[]>([
    'just',
    'actually',
    'basically',
    'honestly',
  ]);
  const [crutchInput, setCrutchInput] = useState('');
  const [activeCategory, setActiveCategory] = useState<'all' | DiagnosticCategory>('all');
  const [undoSnapshot, setUndoSnapshot] = useState<{ text: string; message: string } | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const loadEngine = useCallback(async () => {
    setEngineState({ status: 'loading' });
    try {
      const info = await initTier0Engine();
      setEngineState({
        status: 'ready',
        kind: info.kind,
        label: info.label,
        note: info.note,
      });
    } catch (err) {
      setEngineState({
        status: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Could not initialize the local Tier 0 engine in this browser.',
      });
    }
  }, []);

  useEffect(() => {
    void loadEngine();
  }, [loadEngine]);

  const analysis = useMemo(() => {
    if (engineState.status !== 'ready') return null;
    return analyzeTier0Client({
      text,
      surfaceId,
      dialect,
      crutchWords,
    });
  }, [engineState.status, text, surfaceId, dialect, crutchWords]);

  const filteredDiagnostics = useMemo(() => {
    if (!analysis) return [];
    if (activeCategory === 'all') return analysis.diagnostics;
    return analysis.diagnostics.filter((item) => item.category === activeCategory);
  }, [analysis, activeCategory]);

  const guardAlertItems: GuardAlertItem[] = useMemo(() => {
    if (!analysis) return [];
    return analysis.diagnostics
      .filter(
        (d) => d.category === 'secrets' || d.category === 'consistency' || d.category === 'guards',
      )
      .slice(0, 6)
      .map((item) => ({
        id: item.id,
        kind: mapToGuardAlertKind(item),
        severity: item.category === 'secrets' ? 'danger' : 'warn',
        title: item.ruleLabel,
        detail: item.message,
        actionLabel:
          item.suggestion !== undefined
            ? item.suggestion === ''
              ? 'Remove'
              : `Use "${item.suggestion}"`
            : undefined,
        onAction:
          item.suggestion !== undefined
            ? () => {
                setUndoSnapshot({
                  text,
                  message: `Applied fix for ${item.ruleLabel}`,
                });
                setText(applySingleDiagnosticFix(text, item));
              }
            : undefined,
      }));
  }, [analysis, text]);

  const handleLoadPreset = (presetId: string) => {
    const preset = PLAYGROUND_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    setText(preset.text);
    setSurfaceId(preset.surfaceId);
    setActiveCategory('all');
    setUndoSnapshot(null);
  };

  const handleApplySafeFixes = () => {
    const fixed = applySafeTier0Fixes(text, surfaceId, dialect);
    if (fixed.fixesApplied > 0) {
      setUndoSnapshot({
        text,
        message: `Applied ${fixed.fixesApplied} deterministic Tier 0 fix${fixed.fixesApplied === 1 ? '' : 'es'}`,
      });
      setText(fixed.text);
    }
  };

  const handleAddCrutchWord = (event: React.FormEvent) => {
    event.preventDefault();
    const cleaned = crutchInput.trim().toLowerCase();
    if (!cleaned || crutchWords.includes(cleaned)) {
      setCrutchInput('');
      return;
    }
    setCrutchWords((prev) => [...prev, cleaned]);
    setCrutchInput('');
  };

  const handleRemoveCrutchWord = (word: string) => {
    setCrutchWords((prev) => prev.filter((item) => item !== word));
  };

  const handleFilterKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
    let nextIdx = idx;
    if (event.key === 'ArrowRight') {
      nextIdx = (idx + 1) % FILTER_TABS.length;
    } else if (event.key === 'ArrowLeft') {
      nextIdx = (idx - 1 + FILTER_TABS.length) % FILTER_TABS.length;
    } else if (event.key === 'Home') {
      nextIdx = 0;
    } else if (event.key === 'End') {
      nextIdx = FILTER_TABS.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    setActiveCategory(FILTER_TABS[nextIdx].id);
    tabRefs.current[nextIdx]?.focus();
  };

  const slopBreakdown = useMemo(() => {
    if (!analysis) return undefined;
    const byLabel = new Map(analysis.slopMeter.factors.map((f) => [f.label, f]));
    return {
      clicheCount: byLabel.get('AI buzzwords')?.count ?? 0,
      emDashCount: byLabel.get('Em dashes')?.count ?? 0,
      fillerOpenerCount: byLabel.get('Weak surface openers')?.count ?? 0,
      flatRhythm: (byLabel.get('Flat sentence rhythm')?.count ?? 0) > 0,
    };
  }, [analysis]);

  const isEmpty = text.trim().length === 0;

  return (
    <div className="space-y-6">
      {/* Status & Privacy Bar */}
      <div
        className="flex flex-wrap items-center justify-between gap-3 rounded-[8px] border px-4 py-3"
        style={{
          backgroundColor: 'var(--lx-surface)',
          borderColor: 'var(--lx-border)',
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill
            state={
              engineState.status === 'ready'
                ? 'ready'
                : engineState.status === 'loading'
                  ? 'loading'
                  : 'error'
            }
            label={
              engineState.status === 'ready'
                ? engineState.label
                : engineState.status === 'loading'
                  ? 'Loading Tier 0 engine...'
                  : 'Engine initialization failed'
            }
          />
          <PrivacyProofBadge localOnly={true} blockedSecretsCount={analysis?.counts.secrets ?? 0} />
        </div>

        {analysis ? (
          <div
            className="flex flex-wrap items-center gap-3 lexel-mono text-xs"
            style={{ color: 'var(--lx-fg-muted)' }}
          >
            <span>Latency: {analysis.elapsedMs} ms</span>
            <span>Words: {analysis.readability.words}</span>
            <span>Grade: {analysis.readability.fleschKincaidGrade.toFixed(1)}</span>
          </div>
        ) : null}
      </div>

      {/* Engine Loading State */}
      {engineState.status === 'loading' ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-[8px] border p-8 text-center"
          style={{
            backgroundColor: 'var(--lx-card)',
            borderColor: 'var(--lx-border)',
          }}
        >
          <p className="m-0 text-sm font-medium" style={{ color: 'var(--lx-fg)' }}>
            Initializing local Tier 0 engine in your browser...
          </p>
          <p className="m-0 mt-1 text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
            No draft text is transmitted to any server.
          </p>
        </div>
      ) : null}

      {/* Engine Error State */}
      {engineState.status === 'error' ? (
        <div
          role="alert"
          className="space-y-3 rounded-[8px] border p-6"
          style={{
            backgroundColor: 'var(--lx-danger-bg)',
            borderColor: 'var(--lx-danger)',
          }}
        >
          <h2 className="m-0 text-base font-semibold" style={{ color: 'var(--lx-fg)' }}>
            Local Tier 0 engine failed to start
          </h2>
          <p className="m-0 text-sm" style={{ color: 'var(--lx-fg)' }}>
            {engineState.message}
          </p>
          <button type="button" onClick={() => void loadEngine()} className="lx-web-btn-primary">
            Retry initialization
          </button>
        </div>
      ) : null}

      {/* Main Workbench */}
      {engineState.status === 'ready' && analysis ? (
        <div className="grid gap-6 lg:grid-cols-[1.25fr_0.95fr] lg:items-start">
          {/* Left Column: Controls + Editor */}
          <div className="min-w-0 space-y-4">
            {/* Presets */}
            <div className="space-y-2">
              <p className="m-0 text-xs font-medium" style={{ color: 'var(--lx-fg-muted)' }}>
                Load a sample draft to test rules
              </p>
              <div className="flex flex-wrap gap-1.5">
                {PLAYGROUND_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => handleLoadPreset(preset.id)}
                    className="lx-web-btn-compact"
                  >
                    {preset.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setText('');
                    setUndoSnapshot(null);
                  }}
                  className="lx-web-btn-compact"
                >
                  Clear editor
                </button>
              </div>
            </div>

            {/* Surface & Dialect Controls */}
            <div
              className="grid gap-3 rounded-[8px] border p-4 sm:grid-cols-2"
              style={{
                backgroundColor: 'var(--lx-card)',
                borderColor: 'var(--lx-border)',
              }}
            >
              <div className="space-y-1.5">
                <label
                  htmlFor="playground-surface"
                  className="block text-xs font-medium"
                  style={{ color: 'var(--lx-fg-muted)' }}
                >
                  Writing surface
                </label>
                <select
                  id="playground-surface"
                  value={surfaceId}
                  onChange={(e) => setSurfaceId(e.target.value)}
                  className="lx-control w-full px-3 text-sm"
                >
                  {surfaces.map((surface) => (
                    <option key={surface.id} value={surface.id}>
                      {surface.label} (max {surface.maxChars} chars)
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="playground-dialect"
                  className="block text-xs font-medium"
                  style={{ color: 'var(--lx-fg-muted)' }}
                >
                  English dialect
                </label>
                <select
                  id="playground-dialect"
                  value={dialect}
                  onChange={(e) => setDialect(e.target.value as DialectId)}
                  className="lx-control w-full px-3 text-sm"
                >
                  {DIALECTS.map((d) => (
                    <option key={d} value={d}>
                      {d} English
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Editor Panel */}
            <div
              className="rounded-[8px] border"
              style={{
                backgroundColor: 'var(--lx-card)',
                borderColor: 'var(--lx-border)',
              }}
            >
              <div
                className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                }}
              >
                <label
                  htmlFor="playground-editor"
                  className="text-xs font-semibold"
                  style={{ color: 'var(--lx-fg)' }}
                >
                  Draft input
                </label>
                <SurfaceBadge
                  label={analysis.surface.label}
                  charCount={text.length}
                  maxChars={analysis.surface.maxChars}
                />
              </div>

              <div className="p-4">
                <textarea
                  id="playground-editor"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={11}
                  placeholder="Paste or type text here to inspect anti-slop terms, em dashes, surface rules, consistency, writing guards, and secrets..."
                  className="w-full resize-y rounded-[6px] border p-3.5 text-sm leading-relaxed"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-control-border)',
                    color: 'var(--lx-fg)',
                  }}
                />

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={handleApplySafeFixes}
                      disabled={isEmpty || analysis.diagnostics.length === 0}
                      className="lx-web-btn-primary text-xs"
                    >
                      Apply safe Tier 0 fixes
                    </button>
                    {undoSnapshot ? (
                      <button
                        type="button"
                        onClick={() => {
                          setText(undoSnapshot.text);
                          setUndoSnapshot(null);
                        }}
                        className="lx-web-btn-secondary text-xs"
                      >
                        Revert last fix
                      </button>
                    ) : null}
                  </div>
                  <span className="lexel-mono text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
                    {analysis.readability.sentences} sentence
                    {analysis.readability.sentences === 1 ? '' : 's'} |{' '}
                    {analysis.readability.readingTimeSec}s read
                  </span>
                </div>
              </div>
            </div>

            {/* Personal Crutch-Word Bans */}
            <div
              className="space-y-3 rounded-[8px] border p-4"
              style={{
                backgroundColor: 'var(--lx-card)',
                borderColor: 'var(--lx-border)',
              }}
            >
              <form onSubmit={handleAddCrutchWord} className="flex flex-wrap items-end gap-2">
                <div className="min-w-[180px] flex-1 space-y-1">
                  <label
                    htmlFor="crutch-word-input"
                    className="block text-xs font-medium"
                    style={{ color: 'var(--lx-fg-muted)' }}
                  >
                    Personal crutch-word bans
                  </label>
                  <input
                    id="crutch-word-input"
                    type="text"
                    value={crutchInput}
                    onChange={(e) => setCrutchInput(e.target.value)}
                    placeholder="Add a word (e.g. literally)"
                    className="lx-control w-full px-3 text-sm"
                  />
                </div>
                <button type="submit" className="lx-web-btn-secondary text-xs">
                  Ban word
                </button>
              </form>

              <div className="flex flex-wrap gap-1.5">
                {crutchWords.length === 0 ? (
                  <p className="m-0 text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
                    No personal crutch words banned. Add a word above to flag it in your draft.
                  </p>
                ) : (
                  crutchWords.map((word) => (
                    <span
                      key={word}
                      className="inline-flex items-center gap-1.5 rounded-[4px] border px-2 py-1 lexel-mono text-xs"
                      style={{
                        backgroundColor: 'var(--lx-surface)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    >
                      <span>{word}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveCrutchWord(word)}
                        aria-label={`Remove crutch word ${word}`}
                        className="inline-flex h-5 w-5 items-center justify-center rounded-[4px] border-0 bg-transparent text-xs"
                        style={{ color: 'var(--lx-fg-muted)' }}
                      >
                        ×
                      </button>
                    </span>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Right Column: Live Slop Meter + Guard Alerts + Diagnostics Inspector */}
          <div className="min-w-0 space-y-4">
            <SlopMeter
              score={analysis.slopMeter.score}
              breakdown={slopBreakdown}
              wordCount={analysis.readability.words}
              onDeSlop={handleApplySafeFixes}
            />

            {!isEmpty && guardAlertItems.length > 0 ? (
              <GuardAlerts items={guardAlertItems} />
            ) : null}

            {/* Diagnostics Inspector */}
            <div
              className="rounded-[8px] border"
              style={{
                backgroundColor: 'var(--lx-card)',
                borderColor: 'var(--lx-border)',
              }}
            >
              <div
                role="tablist"
                aria-label="Diagnostic categories"
                className="lx-tablist px-2 pt-1"
              >
                {FILTER_TABS.map((tab, idx) => {
                  const selected = activeCategory === tab.id;
                  const count =
                    tab.id === 'all' ? analysis.diagnostics.length : analysis.counts[tab.id];
                  return (
                    <button
                      key={tab.id}
                      ref={(el) => {
                        tabRefs.current[idx] = el;
                      }}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      tabIndex={selected ? 0 : -1}
                      onClick={() => setActiveCategory(tab.id)}
                      onKeyDown={(e) => handleFilterKeyDown(e, idx)}
                      className="lx-tab text-xs"
                    >
                      {tab.label} ({count})
                    </button>
                  );
                })}
              </div>

              <div className="p-4">
                {isEmpty ? (
                  <div
                    className="space-y-3 rounded-[6px] border p-5 text-center"
                    style={{
                      backgroundColor: 'var(--lx-surface)',
                      borderColor: 'var(--lx-border)',
                    }}
                  >
                    <p className="m-0 text-sm font-medium" style={{ color: 'var(--lx-fg)' }}>
                      The editor is empty
                    </p>
                    <p className="m-0 text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
                      Paste your own text or load a sample draft to run local Tier 0 checks.
                    </p>
                    <button
                      type="button"
                      onClick={() => handleLoadPreset(PLAYGROUND_PRESETS[0].id)}
                      className="lx-web-btn-secondary text-xs"
                    >
                      Load AI-Slop LinkedIn sample
                    </button>
                  </div>
                ) : filteredDiagnostics.length === 0 ? (
                  <div
                    className="rounded-[6px] border p-4 text-sm"
                    style={{
                      backgroundColor: 'var(--lx-surface)',
                      borderColor: 'var(--lx-border)',
                      color: 'var(--lx-fg-muted)',
                    }}
                  >
                    No issues found in this category for {analysis.surface.label}.
                  </div>
                ) : (
                  <ul className="m-0 flex max-h-[520px] list-none flex-col gap-2.5 overflow-y-auto p-0">
                    {filteredDiagnostics.map((item) => {
                      const severityColor =
                        item.category === 'secrets'
                          ? 'var(--lx-danger)'
                          : item.category === 'slop' || item.category === 'guards'
                            ? 'var(--lx-warn)'
                            : 'var(--lx-signal)';
                      return (
                        <li
                          key={item.id}
                          className="space-y-2 rounded-[6px] border p-3"
                          style={{
                            backgroundColor: 'var(--lx-surface)',
                            borderColor: 'var(--lx-border)',
                          }}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span
                              className="lexel-mono text-xs font-semibold"
                              style={{ color: severityColor }}
                            >
                              {item.ruleLabel}
                            </span>
                            <code className="lx-inline-code max-w-[200px] truncate text-xs">
                              {item.problemText}
                            </code>
                          </div>
                          <p
                            className="m-0 text-xs leading-relaxed"
                            style={{ color: 'var(--lx-fg)' }}
                          >
                            {item.message}
                          </p>
                          {item.suggestion !== undefined ? (
                            <div>
                              <button
                                type="button"
                                onClick={() => {
                                  setUndoSnapshot({
                                    text,
                                    message: `Applied ${item.ruleLabel} fix`,
                                  });
                                  setText(applySingleDiagnosticFix(text, item));
                                }}
                                className="lx-web-btn-compact"
                              >
                                {item.suggestion === ''
                                  ? 'Remove span'
                                  : `Replace with "${item.suggestion}"`}
                              </button>
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>

            <p className="m-0 text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
              {engineState.note}
            </p>
          </div>
        </div>
      ) : null}

      <UndoToast
        open={Boolean(undoSnapshot)}
        message={undoSnapshot?.message ?? ''}
        onUndo={() => {
          if (undoSnapshot) {
            setText(undoSnapshot.text);
          }
          setUndoSnapshot(null);
        }}
        onDismiss={() => setUndoSnapshot(null)}
      />
    </div>
  );
}

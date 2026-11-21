import {
  ClipboardIcon,
  computeReadabilityMetrics,
  DEFAULT_TONE_PILLS,
  EXTENDED_TONE_PILLS,
  expandSnippetAtCursor,
  GuardAlerts,
  getSurfaceGradeTarget,
  MicIcon,
  type RewriteApplyMeta,
  RewriteDiffCard,
  SlopMeter,
  StopIcon,
  StreamingTextView,
  SurfaceBadge,
  type SurfaceProfile,
  type TonePillId,
  TonePills,
  VoiceIcon,
} from 'lexel-ui';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type AudioRecordingSession, startWavRecording } from '../lib/audioRecorder';
import {
  BUILTIN_STARTER_SNIPPETS,
  daemonRpc,
  detectActiveWindowSurface,
  expandContextSnippet,
  polishClipboardSafe,
  readClipboardText,
  rewriteBeforePaste,
  rewriteStreamWithTask,
  setClipboardOverrideSurface,
  transcribeAudio,
  writeClipboardText,
} from '../lib/desktopClient';
import { mergeSurfaceCatalog } from '../lib/surfaces';
import { buildLiveTier0Snapshot } from '../lib/tier0Bridge';
import type {
  ActiveWindowSurface,
  DraftSnapshot,
  RewriteResponse,
  Tier0CheckResponse,
  UnifiedDaemonSettings,
} from '../lib/types';

interface StudioPaneProps {
  settings: UnifiedDaemonSettings;
  incomingDraft?: { text: string; seq: number } | null;
  onPatchSettings: (patch: Partial<UnifiedDaemonSettings>) => Promise<void>;
  onRefreshStatus: () => Promise<void>;
  onTriggerUndoToast: (message: string, onUndo: () => void, undoLabel?: string) => void;
  onOpenVoiceOnboarding: () => void;
}

const SHORT_SURFACE_IDS = new Set(['web_x', 'ide_git_commit', 'web_discord_slack']);

export function StudioPane({
  settings,
  incomingDraft,
  onPatchSettings,
  onRefreshStatus,
  onTriggerUndoToast,
  onOpenVoiceOnboarding,
}: StudioPaneProps) {
  const { surfaces } = useMemo(
    () => mergeSurfaceCatalog(settings.customSurfaces),
    [settings.customSurfaces],
  );

  const [surfaceId, setSurfaceId] = useState<string>('web_reddit');
  const [autoDetectSurface, setAutoDetectSurface] = useState<boolean>(false);
  const [detectedWindow, setDetectedWindow] = useState<ActiveWindowSurface | null>(null);
  const [subcontext, setSubcontext] = useState('r/rust');
  const [task, setTask] = useState<TonePillId>('deslop');
  const [showAllTones, setShowAllTones] = useState(false);
  const [twoTakes, setTwoTakes] = useState(false);
  const [streamEnabled, setStreamEnabled] = useState(true);
  const [text, setText] = useState(
    'In todays fast-paced landscape, we delve into why local AI rewrites should stay fast — and keep latency under 18ms for #42.',
  );

  const [drafts, setDrafts] = useState<DraftSnapshot[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [synonymWord, setSynonymWord] = useState('');
  const [synonyms, setSynonyms] = useState<string[]>([]);
  const [synonymNotice, setSynonymNotice] = useState<string | null>(null);
  const [tier0, setTier0] = useState<Tier0CheckResponse | null>(null);
  const [rewrite, setRewrite] = useState<RewriteResponse | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const recorderRef = useRef<AudioRecordingSession | null>(null);

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
    return () => {
      abortRef.current?.abort();
      recorderRef.current?.cancel();
    };
  }, []);

  useEffect(() => {
    if (!incomingDraft?.text) return;
    const previous = text;
    setText(incomingDraft.text);
    setRewrite(null);
    setNotice('Loaded draft from system clipboard (Cmd/Ctrl+Shift+L).');
    onTriggerUndoToast(
      'Loaded clipboard draft into Studio.',
      () => setText(previous),
      'Restore prior draft',
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingDraft, text, onTriggerUndoToast]);

  const activeSurface: SurfaceProfile = surfaces.find((s) => s.id === surfaceId) ?? surfaces[0];
  const metrics = useMemo(() => computeReadabilityMetrics(text), [text]);
  const gradeTarget = useMemo(() => getSurfaceGradeTarget(surfaceId), [surfaceId]);
  const gradeInRange =
    metrics.words === 0 ||
    (metrics.fleschKincaidGrade >= gradeTarget.minGrade &&
      metrics.fleschKincaidGrade <= gradeTarget.maxGrade);

  const mergedSnippets = useMemo(() => {
    const user = settings.snippets ?? [];
    const seen = new Set(user.map((s) => s.trigger));
    return [...user, ...BUILTIN_STARTER_SNIPPETS.filter((b) => !seen.has(b.trigger))];
  }, [settings.snippets]);

  async function handleDetectActiveWindow() {
    setError(null);
    try {
      const detected = await detectActiveWindowSurface();
      setDetectedWindow(detected);
      if (detected.supported && detected.detectedSurfaceId) {
        setSurfaceId(detected.detectedSurfaceId);
        setAutoDetectSurface(true);
        await setClipboardOverrideSurface(null);
        setNotice(`Detected ${detected.appName ?? 'active app'} -> ${detected.detectedSurfaceId}.`);
      } else {
        setNotice(detected.note);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

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
      await onRefreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const runSafeFix = useCallback(async () => {
    setError(null);
    setNotice(null);
    try {
      const fixed = await daemonRpc<{ text: string; fixesApplied: number }>('fixAllSafe', {
        text,
        surfaceId,
        language: settings.languageMode,
      });
      if (fixed.text !== text) {
        const previous = text;
        setText(fixed.text);
        onTriggerUndoToast(
          `Applied ${fixed.fixesApplied} deterministic fix${fixed.fixesApplied === 1 ? '' : 'es'}.`,
          () => setText(previous),
        );
      } else {
        setNotice('No safe deterministic fixes needed.');
      }
      const next = await daemonRpc<Tier0CheckResponse>('tier0Check', {
        text: fixed.text,
        surfaceId,
        language: settings.languageMode,
      });
      setTier0(next);
      await onRefreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [text, surfaceId, settings.languageMode, onRefreshStatus, onTriggerUndoToast]);

  const runAiRewrite = useCallback(
    async (overrideTask?: TonePillId) => {
      const activeTask = overrideTask ?? task;
      if (overrideTask) {
        setTask(overrideTask);
      }
      if (!text.trim()) {
        setError('Enter or paste text before running a rewrite.');
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setBusy(true);
      setError(null);
      setNotice(null);
      setStreamingText('');
      setRewrite(null);

      const wantTwoTakes = twoTakes || (SHORT_SURFACE_IDS.has(surfaceId) && twoTakes);

      try {
        const res = await rewriteStreamWithTask(
          {
            text,
            task: activeTask,
            surfaceId,
            subcontext: subcontext.trim() || null,
            candidates: wantTwoTakes ? 2 : 1,
            redactSecrets: settings.redactSecrets ?? false,
          },
          {
            signal: controller.signal,
            onChunk: (_delta, accumulated) => {
              if (streamEnabled) {
                setStreamingText(accumulated);
              }
            },
          },
        );
        setStreamingText('');
        setRewrite(res);
      } catch (err) {
        setStreamingText('');
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [task, text, twoTakes, surfaceId, subcontext, settings.redactSecrets, streamEnabled],
  );

  const handleBanCrutchWord = useCallback(
    async (word: string) => {
      const currentCrutch = settings.crutchWords ?? [];
      const currentSlop = settings.customSlopTerms ?? [];
      const nextCrutch = currentCrutch.some((w) => w.toLowerCase() === word.toLowerCase())
        ? currentCrutch
        : [...currentCrutch, word];
      const nextSlop = currentSlop.some((s) => s.toLowerCase() === word.toLowerCase())
        ? currentSlop
        : [...currentSlop, word];
      await onPatchSettings({
        crutchWords: nextCrutch,
        customSlopTerms: nextSlop,
      });
      setNotice(`Banned personal crutch word "${word}" across all surfaces.`);
    },
    [settings.crutchWords, settings.customSlopTerms, onPatchSettings],
  );

  const liveTier0 = useMemo(
    () =>
      buildLiveTier0Snapshot({
        text,
        profile: activeSurface,
        dialect: settings.dialect,
        customSlopTerms: settings.customSlopTerms,
        disabledSlopTerms: settings.disabledSlopTerms,
        crutchWords: settings.crutchWords ?? [],
        tier0Response: tier0,
        redactSecrets: Boolean(settings.redactSecrets),
        onTriggerTone: (toneId) => void runAiRewrite(toneId),
        onBanCrutchWord: (word) => void handleBanCrutchWord(word),
        onRunSafeFix: () => void runSafeFix(),
      }),
    [
      text,
      activeSurface,
      settings.dialect,
      settings.customSlopTerms,
      settings.disabledSlopTerms,
      settings.crutchWords,
      settings.redactSecrets,
      tier0,
      runAiRewrite,
      handleBanCrutchWord,
      runSafeFix,
    ],
  );

  async function runDeterministicTransform(
    kind: 'titleCase' | 'sentenceCase' | 'normalizeTypography',
  ) {
    if (!text.trim()) return;
    setError(null);
    setNotice(null);
    try {
      const res = await daemonRpc<{ text: string; fixesApplied?: number }>(kind, { text });
      if (res.text && res.text !== text) {
        const previous = text;
        setText(res.text);
        onTriggerUndoToast(
          kind === 'titleCase'
            ? 'Converted draft to Title Case.'
            : kind === 'sentenceCase'
              ? 'Converted draft to Sentence Case.'
              : 'Normalized quotes, ellipses, and spacing.',
          () => setText(previous),
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

  async function handleApplyComposed(composedText: string, meta: RewriteApplyMeta) {
    if (!rewrite) return;
    const previous = text;
    setText(composedText);
    if (settings.saveVoiceMemory) {
      await daemonRpc('saveVoiceExample', {
        example: {
          surfaceId: rewrite.surfaceId,
          subcontext: rewrite.subcontext,
          original: rewrite.original,
          rewritten: composedText,
          action: meta.partial ? 'edited' : 'accepted',
        },
      });
      await onRefreshStatus();
    }
    setRewrite(null);
    const label = meta.partial
      ? `Applied ${meta.acceptedHunks}/${meta.totalHunks} edits and saved to Voice Memory.`
      : 'Applied rewrite and saved to Voice Memory.';
    onTriggerUndoToast(label, () => setText(previous));
  }

  async function handleCopyComposed(composedText: string) {
    await writeClipboardText(composedText).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  async function handleToggleRecording() {
    setError(null);
    setNotice(null);
    if (recording && recorderRef.current) {
      setRecording(false);
      setTranscribing(true);
      try {
        const { audioBase64 } = await recorderRef.current.stop();
        recorderRef.current = null;
        const result = await transcribeAudio({
          audioBase64,
          audioFormat: 'wav',
          language: 'en',
          surfaceId,
          subcontext: subcontext.trim() || null,
          rewriteTask: settings.aiEnabled ? 'deslop' : null,
        });
        const finalText =
          result.rewritten?.suggestion ?? result.cleanedText ?? result.rawTranscript;
        const previous = text;
        setText(finalText);
        if (result.rewritten) {
          setRewrite(result.rewritten);
        }
        onTriggerUndoToast(
          `Transcribed offline via ${result.whisperModel} (${result.latencyMs}ms).`,
          () => setText(previous),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setTranscribing(false);
      }
      return;
    }

    try {
      recorderRef.current = await startWavRecording();
      setRecording(true);
      setNotice('Recording offline audio... click Stop & Transcribe when done.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRewriteBeforePasteClick() {
    setError(null);
    setNotice(null);
    try {
      const report = await rewriteBeforePaste({
        surfaceId: autoDetectSurface ? null : surfaceId,
        useAi: settings.aiEnabled,
      });
      if (report.secretsBlocked > 0) {
        setError(
          `Secrets Guard blocked Rewrite Before Paste (${report.secretsBlocked} secret match).`,
        );
        return;
      }
      setText(report.rewritten);
      onTriggerUndoToast(
        `${report.note}`,
        () => {
          void writeClipboardText(report.original);
          setText(report.original);
        },
        'Restore clipboard',
      );
      await onRefreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handlePolishClipboard() {
    setError(null);
    setNotice(null);
    try {
      const report = await polishClipboardSafe(surfaceId);
      const previous = text;
      setText(report.polished);
      if (report.secretsBlocked > 0) {
        setError(
          `Secrets Guard blocked clipboard auto-rewrite (${report.secretsBlocked} secret match). Draft loaded for manual inspection.`,
        );
      } else if (report.fixesApplied > 0) {
        onTriggerUndoToast(
          `Polished clipboard with ${report.fixesApplied} safe fix${report.fixesApplied === 1 ? '' : 'es'}.`,
          () => {
            setText(previous);
            void writeClipboardText(report.original);
          },
        );
      } else {
        setNotice('Loaded clipboard text. No deterministic fixes needed.');
      }
      await onRefreshStatus();
    } catch (err) {
      try {
        const raw = await readClipboardText();
        if (raw.trim()) {
          const previous = text;
          setText(raw);
          onTriggerUndoToast('Loaded text from clipboard.', () => setText(previous));
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

  async function handleEditorKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== ' ' && e.key !== 'Tab' && e.key !== 'Enter') return;
    if (mergedSnippets.length === 0) return;
    const el = e.currentTarget;
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? start;
    if (start !== end) return;

    // Check slash trigger right before caret first (e.g. /standup, /lgtm, /decline)
    const beforeCaret = text.slice(0, start);
    const slashMatch = /(?:^|\s)(\/[a-zA-Z0-9_-]{2,})$/.exec(beforeCaret);
    if (slashMatch) {
      const trigger = slashMatch[1];
      const snippet = mergedSnippets.find((s) => s.trigger === trigger);
      if (snippet) {
        e.preventDefault();
        const suffix = e.key === 'Enter' ? '\n' : ' ';
        const previous = text;
        try {
          const res = await expandContextSnippet({
            trigger,
            surfaceId,
            subcontext: subcontext.trim() || null,
            adaptWithAi: false,
          });
          const replaceStart = start - trigger.length;
          const nextText = `${text.slice(0, replaceStart)}${res.expandedText}${suffix}${text.slice(start)}`;
          const nextCaret = replaceStart + res.expandedText.length + suffix.length;
          setText(nextText);
          onTriggerUndoToast(`Expanded snippet ${trigger} for ${activeSurface.label}.`, () =>
            setText(previous),
          );
          requestAnimationFrame(() => el.setSelectionRange(nextCaret, nextCaret));
        } catch {
          // Fall back to plain trigger expansion below.
        }
        return;
      }
    }

    const expanded = expandSnippetAtCursor(text, start, mergedSnippets);
    if (!expanded) return;
    e.preventDefault();
    const suffix = e.key === 'Enter' ? '\n' : ' ';
    const previous = text;
    const nextText = `${expanded.text.slice(0, expanded.cursor)}${suffix}${expanded.text.slice(expanded.cursor)}`;
    const nextCaret = expanded.cursor + suffix.length;
    setText(nextText);
    onTriggerUndoToast(`Expanded snippet ${expanded.expandedTrigger}.`, () => setText(previous));
    requestAnimationFrame(() => {
      el.setSelectionRange(nextCaret, nextCaret);
    });
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.02em]">Writing Studio</h1>
          <p className="mt-0.5 text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
            Draft, inspect live Tier 0 signals, and run surface-scoped local rewrites with
            hunk-level diff control.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SurfaceBadge
            label={activeSurface.label}
            subcontext={subcontext.trim() || null}
            charCount={text.length}
            maxChars={activeSurface.maxChars}
            autoDetected={autoDetectSurface}
          />
          <button
            type="button"
            onClick={onOpenVoiceOnboarding}
            className="lx-pressable lx-btn-secondary inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium"
          >
            <VoiceIcon className="h-3.5 w-3.5" />
            <span>Clone My Voice</span>
          </button>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Left: Primary Writing Canvas & Diff Output */}
        <div className="space-y-4 min-w-0">
          <div
            className="grid gap-3 rounded-[8px] border p-3 sm:grid-cols-[1fr_1fr_auto]"
            style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
          >
            <div>
              <label
                htmlFor="desktop-surface-select"
                className="mb-1 block text-[11px] font-medium"
                style={{ color: 'var(--lx-fg-muted)' }}
              >
                Target Surface {autoDetectSurface ? '(auto-detected)' : '(manual)'}
              </label>
              <select
                id="desktop-surface-select"
                value={surfaceId}
                onChange={(e) => {
                  const nextSurface = e.target.value;
                  setSurfaceId(nextSurface);
                  setAutoDetectSurface(false);
                  void setClipboardOverrideSurface(nextSurface);
                  setRewrite(null);
                  if (SHORT_SURFACE_IDS.has(nextSurface)) {
                    setTwoTakes(true);
                  }
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

            <div className="flex items-end">
              <button
                type="button"
                onClick={() => void handleDetectActiveWindow()}
                title={
                  detectedWindow?.note ??
                  'Detect the frontmost desktop app and select its matching Lexel surface'
                }
                className="lx-pressable lx-btn-secondary w-full px-2.5 py-1.5 text-[12px] font-medium sm:w-auto"
              >
                Detect Active App
              </button>
            </div>
          </div>

          <section
            aria-label="Draft workspace"
            className="rounded-[8px] border p-3.5"
            style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
          >
            <div
              className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] lexel-mono lx-tab-nums"
              style={{ color: 'var(--lx-fg-muted)' }}
            >
              <span>
                {metrics.words} words · {text.length} chars · Grade{' '}
                {metrics.fleschKincaidGrade.toFixed(1)} · {metrics.readingTimeSec}s read
              </span>
              <span>
                Snippets: type <code className="lexel-mono">/standup</code>,{' '}
                <code className="lexel-mono">/lgtm</code>, or{' '}
                <code className="lexel-mono">/decline</code> + Space
              </span>
            </div>

            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => void handleEditorKeyDown(e)}
              rows={7}
              aria-label="Draft editor"
              placeholder="Write or paste a draft, or press Cmd/Ctrl+Shift+L from any desktop app..."
              className="w-full rounded-[6px] border p-3 text-[14px] leading-[1.65]"
              style={{
                backgroundColor: 'var(--lx-bg)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            />

            {/* 1-Click Tone & Length Pills */}
            <div
              className="mt-3 space-y-2.5 border-t pt-3"
              style={{ borderColor: 'var(--lx-border)' }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] font-medium" style={{ color: 'var(--lx-fg-muted)' }}>
                  1-Click Tone &amp; Length
                </span>
                <div className="flex flex-wrap items-center gap-3 text-[11px]">
                  <label className="inline-flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={twoTakes}
                      onChange={(e) => setTwoTakes(e.target.checked)}
                    />
                    <span>2 takes (Direct + Ultra-Short)</span>
                  </label>
                  <label className="inline-flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={streamEnabled}
                      onChange={(e) => setStreamEnabled(e.target.checked)}
                    />
                    <span>Stream tokens</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => setShowAllTones((v) => !v)}
                    className="lx-pressable text-[11px] underline"
                    style={{ color: 'var(--lx-fg-muted)' }}
                  >
                    {showAllTones ? 'Core 5 pills' : 'More modes'}
                  </button>
                </div>
              </div>

              <TonePills
                value={task}
                pills={showAllTones ? EXTENDED_TONE_PILLS : DEFAULT_TONE_PILLS}
                disabled={busy || !settings.aiEnabled}
                onSelect={(pillId) => void runAiRewrite(pillId)}
              />
            </div>

            {/* Primary & Utility Actions */}
            <div
              className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3"
              style={{ borderColor: 'var(--lx-border)' }}
            >
              <button
                type="button"
                onClick={() => void runAiRewrite()}
                disabled={busy || !settings.aiEnabled}
                className="lx-pressable lx-btn-primary px-3.5 py-1.5 text-[12px] font-semibold"
              >
                {busy ? 'Rewriting...' : 'Rewrite with Local AI'}
              </button>

              <button
                type="button"
                onClick={() => void handleToggleRecording()}
                disabled={transcribing}
                className="lx-pressable inline-flex items-center gap-1.5 rounded-[6px] border px-3 py-1.5 text-[12px] font-medium"
                style={{
                  backgroundColor: recording ? 'var(--lx-danger-bg)' : 'var(--lx-muted)',
                  borderColor: recording ? 'var(--lx-danger)' : 'var(--lx-border)',
                  color: recording ? 'var(--lx-danger)' : 'var(--lx-fg)',
                }}
              >
                {recording ? (
                  <StopIcon className="h-3.5 w-3.5" />
                ) : (
                  <MicIcon className="h-3.5 w-3.5" />
                )}
                <span>
                  {transcribing
                    ? 'Transcribing...'
                    : recording
                      ? 'Stop & Transcribe'
                      : 'Voice Dictate'}
                </span>
              </button>

              <button
                type="button"
                onClick={() => void handleRewriteBeforePasteClick()}
                className="lx-pressable lx-btn-secondary inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-medium"
                title="Read clipboard, rewrite for active surface, and paste back (Cmd/Ctrl+Alt+V)"
              >
                <ClipboardIcon className="h-3.5 w-3.5" />
                <span>Rewrite Before Paste</span>
              </button>

              <button
                type="button"
                onClick={() => void handlePolishClipboard()}
                className="lx-pressable lx-btn-secondary px-2.5 py-1.5 text-[12px]"
              >
                Polish Clipboard
              </button>

              <div className="ml-auto flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void handleSaveSnapshot()}
                  className="lx-pressable lx-btn-secondary px-2.5 py-1.5 text-[12px]"
                >
                  Save Snapshot
                </button>
                <button
                  type="button"
                  onClick={() => setShowHistory((v) => !v)}
                  className="lx-pressable rounded-[6px] border px-2.5 py-1.5 text-[12px] lx-tab-nums"
                  style={{
                    backgroundColor: showHistory ? 'var(--lx-muted)' : 'var(--lx-surface)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                >
                  History ({drafts.length})
                </button>
              </div>
            </div>
          </section>

          {error ? (
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
          ) : null}

          {notice ? (
            <div
              role="status"
              className="rounded-[6px] border px-3 py-2 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-signal-bg)',
                borderColor: 'var(--lx-signal)',
                color: 'var(--lx-signal)',
              }}
            >
              {notice}
            </div>
          ) : null}

          <StreamingTextView
            text={streamingText}
            active={busy}
            statusLabel={`Streaming ${task.replaceAll('_', ' ')} (${activeSurface.label})`}
            onCancel={() => abortRef.current?.abort()}
          />

          {rewrite ? (
            <RewriteDiffCard
              original={rewrite.original}
              suggestion={rewrite.suggestion}
              gates={rewrite.gates}
              modelName={rewrite.model}
              latencyMs={rewrite.latencyMs}
              fastPath={rewrite.fastPath}
              retried={rewrite.retried}
              failedConstraints={rewrite.failedConstraints}
              redactedCount={rewrite.redactedCount}
              restoredCleanly={rewrite.restoredCleanly}
              candidates={rewrite.candidates}
              copied={copied}
              onApplyComposed={(composed, meta) => void handleApplyComposed(composed, meta)}
              onCopy={() => void handleCopyComposed(rewrite.suggestion)}
              onCopyComposed={(composed) => void handleCopyComposed(composed)}
              onRetry={() => void runAiRewrite()}
              onReject={() => {
                if (settings.saveVoiceMemory) {
                  void daemonRpc('saveVoiceExample', {
                    example: {
                      surfaceId: rewrite.surfaceId,
                      subcontext: rewrite.subcontext,
                      original: rewrite.original,
                      rewritten: rewrite.suggestion,
                      action: 'rejected',
                    },
                  });
                }
                setRewrite(null);
              }}
            />
          ) : null}

          {showHistory ? (
            <section
              aria-label="Local Draft History"
              className="space-y-2 rounded-[8px] border p-3"
              style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
            >
              <div className="flex items-center justify-between">
                <h2 className="text-[13px] font-semibold">
                  Local Draft Snapshots ({drafts.length})
                </h2>
                <span className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                  Stored in local SQLite only
                </span>
              </div>
              {drafts.length === 0 ? (
                <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
                  No saved snapshots yet. Click Save Snapshot to store a local version.
                </p>
              ) : (
                <div className="max-h-48 space-y-1.5 overflow-y-auto">
                  {drafts.map((snap) => (
                    <div
                      key={snap.id}
                      className="flex items-center justify-between gap-2 rounded-[6px] border px-2.5 py-1.5 text-[12px]"
                      style={{
                        backgroundColor: 'var(--lx-surface)',
                        borderColor: 'var(--lx-border)',
                      }}
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium">{snap.title}</div>
                        <div
                          className="text-[11px] lexel-mono lx-tab-nums"
                          style={{ color: 'var(--lx-fg-muted)' }}
                        >
                          {snap.surfaceId} · {snap.wordCount} words
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            const previous = text;
                            setText(snap.content);
                            setSurfaceId(snap.surfaceId);
                            onTriggerUndoToast(`Restored snapshot "${snap.title}".`, () =>
                              setText(previous),
                            );
                          }}
                          className="lx-pressable lx-btn-secondary px-2 py-0.5 text-[11px]"
                        >
                          Restore
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            await daemonRpc('deleteDraft', { id: snap.id });
                            await refreshDrafts();
                          }}
                          className="lx-pressable rounded-[4px] px-1.5 py-0.5 text-[11px]"
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
          ) : null}

          {tier0 ? (
            <section
              aria-label="Detailed Tier 0 Findings"
              className="space-y-2 rounded-[8px] border p-3"
              style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
            >
              <h2 className="text-[13px] font-semibold">
                Tier 0 Inspection ({tier0.harper.length} grammar, {tier0.slop.length} slop,{' '}
                {tier0.surface.length} surface, {tier0.secrets.length} secrets)
              </h2>

              {tier0.harper.length === 0 &&
              tier0.slop.length === 0 &&
              tier0.surface.length === 0 &&
              tier0.secrets.length === 0 &&
              (tier0.styleGuide?.length ?? 0) === 0 ? (
                <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
                  No issues found for {activeSurface.label}.
                </p>
              ) : null}

              {tier0.slop.map((hit) => (
                <div
                  key={`slop-${hit.term}-${hit.start}-${hit.end}`}
                  className="flex items-center justify-between gap-2 rounded-[6px] border px-2.5 py-1.5 text-[12px]"
                  style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
                >
                  <span>
                    <strong className="lexel-mono">{hit.term}</strong> (
                    {hit.isEmDash ? 'em_dash' : 'slop'})
                  </span>
                  {hit.suggestion ? (
                    <span className="lexel-mono text-[11px]" style={{ color: 'var(--lx-signal)' }}>
                      suggest: {hit.suggestion}
                    </span>
                  ) : null}
                </div>
              ))}

              {tier0.harper.map((item) => (
                <div
                  key={`harper-${item.rule}-${item.start}-${item.end}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] border px-2.5 py-1.5 text-[12px]"
                  style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
                >
                  <span>
                    <span className="lexel-mono font-medium">{item.problemText}</span>:{' '}
                    {item.message}
                  </span>
                  {item.suggestions.length > 0 ? (
                    <span className="lexel-mono text-[11px]" style={{ color: 'var(--lx-signal)' }}>
                      {item.suggestions.slice(0, 3).join(' | ')}
                    </span>
                  ) : null}
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
            </section>
          ) : null}
        </div>

        {/* Right: Calm Editorial Inspector (Slop Meter, Guards, Metrics, Deterministic Tools) */}
        <aside className="space-y-3" aria-label="Draft inspector">
          <SlopMeter
            score={liveTier0.slopScore}
            label={liveTier0.slopLabel}
            breakdown={liveTier0.slopBreakdown}
            wordCount={metrics.words}
            busy={busy}
            onDeSlop={
              settings.aiEnabled ? () => void runAiRewrite('deslop') : () => void runSafeFix()
            }
          />

          <section
            aria-label="Live Writing Guards"
            className="space-y-2 rounded-[8px] border p-3"
            style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-[12px] font-semibold">Writing Guards (Tier 0)</h2>
              <button
                type="button"
                onClick={() => void runTier0Check()}
                className="lx-pressable lx-btn-secondary px-2 py-0.5 text-[11px] font-medium"
              >
                Full Harper Check
              </button>
            </div>
            <GuardAlerts
              items={liveTier0.alerts}
              emptyMessage={`Clean on ${activeSurface.label}: no secrets, slop, consistency, or tone edge warnings.`}
              compact
            />
          </section>

          <section
            aria-label="Readability and deterministic tools"
            className="space-y-2.5 rounded-[8px] border p-3"
            style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
          >
            <h2 className="text-[12px] font-semibold">Readability &amp; Safe Fixes</h2>
            <div
              className="grid grid-cols-2 gap-2 rounded-[6px] border p-2.5 text-[11px] lexel-mono lx-tab-nums"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg-muted)',
              }}
            >
              <div>
                <span className="block text-[10px]">Grade Goal</span>
                <span style={{ color: gradeInRange ? 'var(--lx-ok)' : 'var(--lx-warn)' }}>
                  G{metrics.fleschKincaidGrade.toFixed(1)} ({gradeTarget.minGrade}-
                  {gradeTarget.maxGrade})
                </span>
              </div>
              <div>
                <span className="block text-[10px]">Rhythm Variety</span>
                <span style={{ color: 'var(--lx-fg)' }}>{metrics.sentenceVarietyScore}/100</span>
              </div>
              <div>
                <span className="block text-[10px]">Passive Hints</span>
                <span
                  style={{
                    color: metrics.passiveHintCount > 2 ? 'var(--lx-warn)' : 'var(--lx-fg)',
                  }}
                >
                  {metrics.passiveHintCount}
                </span>
              </div>
              <div>
                <span className="block text-[10px]">Hedging</span>
                <span
                  style={{ color: metrics.hedgingPercent > 4 ? 'var(--lx-warn)' : 'var(--lx-fg)' }}
                >
                  {metrics.hedgingCount} ({metrics.hedgingPercent}%)
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => void runSafeFix()}
                className="lx-pressable lx-btn-secondary col-span-2 px-2.5 py-1.5 text-[12px] font-medium"
              >
                Fix Safe Issues (No AI)
              </button>
              <button
                type="button"
                onClick={() => void runDeterministicTransform('titleCase')}
                className="lx-pressable lx-btn-secondary px-2 py-1 text-[11px]"
              >
                Title Case
              </button>
              <button
                type="button"
                onClick={() => void runDeterministicTransform('sentenceCase')}
                className="lx-pressable lx-btn-secondary px-2 py-1 text-[11px]"
              >
                Sentence Case
              </button>
              <button
                type="button"
                onClick={() => void runDeterministicTransform('normalizeTypography')}
                className="lx-pressable lx-btn-secondary col-span-2 px-2 py-1 text-[11px]"
              >
                Clean Quotes &amp; Spaces
              </button>
            </div>
          </section>

          <section
            aria-label="Offline Thesaurus"
            className="space-y-2 rounded-[8px] border p-3"
            style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
          >
            <h2 className="text-[12px] font-semibold">Offline Thesaurus</h2>
            <form onSubmit={handleSynonymLookup} className="flex gap-1.5">
              <input
                id="desktop-synonym-input"
                type="text"
                value={synonymWord}
                onChange={(e) => setSynonymWord(e.target.value)}
                placeholder="Plain-English word..."
                aria-label="Look up plain-English synonyms"
                className="min-w-0 flex-1 rounded-[6px] border px-2 py-1 text-[12px]"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
              <button
                type="submit"
                className="lx-pressable lx-btn-secondary px-2.5 py-1 text-[12px] font-medium"
              >
                Find
              </button>
            </form>
            {synonymNotice ? (
              <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                {synonymNotice}
              </div>
            ) : null}
            {synonyms.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {synonyms.map((word) => (
                  <button
                    key={word}
                    type="button"
                    onClick={() => {
                      void writeClipboardText(word);
                      setNotice(`Copied "${word}" to clipboard.`);
                    }}
                    title="Copy synonym"
                    className="lx-pressable rounded-[4px] border px-2 py-0.5 text-[11px] lexel-mono"
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
            ) : null}
          </section>
        </aside>
      </div>
    </div>
  );
}

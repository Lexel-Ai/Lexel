import {
  CloseIcon,
  DEFAULT_TONE_PILLS,
  type GuardAlertItem,
  GuardAlerts,
  NibIcon,
  PanelIcon,
  PrivacyProofBadge,
  type RewriteApplyMeta,
  RewriteDiffCard,
  SlidersIcon,
  SlopMeter,
  StatusPill,
  StreamingTextView,
  SurfaceBadge,
  type TonePillDef,
  type TonePillId,
  TonePills,
  UndoToast,
} from 'lexel-ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LocalAiHealth } from '../shared/localAiClient';
import { getSurfaceProfile } from '../shared/surfaceDetector';
import { analyzeFullTier0 } from '../shared/tier0Engine';
import type {
  AiTaskId,
  DetectedSurfaceContext,
  RewriteResult,
  SurfaceId,
  SurfaceProfile,
} from '../shared/types';
import { hasSecrets } from '../shared/verifier';
import ProtocolClient from './ProtocolClient';

export interface ActiveFieldHandle {
  element: HTMLElement;
  readText: () => string;
  writeText: (nextText: string) => void;
  readThreadContext: () => { rawContext: string; sourceHint: string };
}

export interface AiFloatingPillProps {
  field: ActiveFieldHandle | null;
  context: DetectedSurfaceContext;
  theme: 'dark' | 'light';
  aiEnabled: boolean;
  openSignal: number;
  requestedTask?: { id: AiTaskId; seq: number } | null;
  customSurfaces?: SurfaceProfile[];
  customSlopTerms?: string[];
  disabledSlopTerms?: string[];
  crutchWords?: string[];
  redactSecrets?: boolean;
  localSecretBlocks?: number;
  externalUndo?: { previousText: string; message: string; seq: number } | null;
}

const SHORT_TWO_TAKE_SURFACES = new Set<SurfaceId>([
  'web_x',
  'ide_git_commit',
  'web_discord_slack',
]);

const SECONDARY_WORKFLOW_PILLS: readonly TonePillDef[] = [
  { id: 'rewrite_surface', label: 'Match surface', hint: 'Adapt register to this site' },
  { id: 'bluf', label: 'Lead with ask', hint: 'Move the core question or decision first' },
  { id: 'natural_english', label: 'Natural English', hint: 'Smooth rough wording cleanly' },
  { id: 'reply_draft', label: 'Draft reply', hint: 'Extract parent context and draft a reply' },
];

export function AiFloatingPill({
  field,
  context,
  theme,
  aiEnabled,
  openSignal,
  requestedTask,
  customSurfaces,
  customSlopTerms,
  disabledSlopTerms,
  crutchWords,
  redactSecrets = false,
  localSecretBlocks = 0,
  externalUndo,
}: AiFloatingPillProps) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [undoEntry, setUndoEntry] = useState<{ previousText: string; message: string } | null>(
    null,
  );
  const [result, setResult] = useState<RewriteResult | null>(null);
  const [lastTask, setLastTask] = useState<AiTaskId>('rewrite_surface');
  const [twoTakes, setTwoTakes] = useState(() => SHORT_TWO_TAKE_SURFACES.has(context.surfaceId));
  const [copied, setCopied] = useState(false);
  const [contextHint, setContextHint] = useState<string | null>(null);
  const [health, setHealth] = useState<LocalAiHealth | null>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [textVersion, setTextVersion] = useState(0);
  const [coords, setCoords] = useState<{ top: number; left: number; visible: boolean }>({
    top: 0,
    left: 0,
    visible: false,
  });

  const abortRef = useRef<AbortController | null>(null);
  const profile = getSurfaceProfile(context.surfaceId, customSurfaces);

  useEffect(() => {
    setTwoTakes(SHORT_TWO_TAKE_SURFACES.has(context.surfaceId));
  }, [context.surfaceId]);

  useEffect(() => {
    if (externalUndo && externalUndo.seq > 0) {
      setUndoEntry({ previousText: externalUndo.previousText, message: externalUndo.message });
    }
  }, [externalUndo]);

  const refreshHealth = useCallback(async () => {
    if (!aiEnabled) {
      setHealth({ ok: false, models: [], error: 'Local AI is turned off in Settings.' });
      return;
    }
    setCheckingHealth(true);
    try {
      const next = await ProtocolClient.getAiHealth();
      setHealth(next);
    } catch (err) {
      setHealth({ ok: false, models: [], error: (err as Error).message });
    } finally {
      setCheckingHealth(false);
    }
  }, [aiEnabled]);

  useEffect(() => {
    if (openSignal > 0 && field && !context.isBlocked) {
      setExpanded(true);
    }
  }, [openSignal, field, context.isBlocked]);

  useEffect(() => {
    if (expanded) {
      void refreshHealth();
    }
  }, [expanded, refreshHealth]);

  const activeElement = field?.element ?? null;
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (activeElement !== undefined) {
      setResult(null);
      setError(null);
      setStreamingText('');
      setContextHint(null);
    }
    if (!activeElement) return;
    const onInput = () => setTextVersion((v) => v + 1);
    activeElement.addEventListener('input', onInput);
    return () => activeElement.removeEventListener('input', onInput);
  }, [activeElement]);

  useEffect(() => {
    if (!field || context.isBlocked) {
      setCoords((prev) => ({ ...prev, visible: false }));
      return;
    }

    const updatePosition = () => {
      const rect = field.element.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 14) {
        setCoords((prev) => ({ ...prev, visible: false }));
        return;
      }
      const panelWidth = expanded ? 396 : 218;
      const left = Math.max(
        12,
        Math.min(window.innerWidth - panelWidth - 12, rect.right - panelWidth),
      );
      const top = Math.max(
        12,
        Math.min(window.innerHeight - (expanded ? 420 : 44), rect.bottom + 6),
      );
      setCoords({ top, left, visible: true });
    };

    updatePosition();
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [field, expanded, context.isBlocked]);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        abortRef.current?.abort();
        setExpanded(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [expanded]);

  const runTask = useCallback(
    async (task: AiTaskId) => {
      if (!field) return;
      const source = field.readText().trim();
      if (!source) {
        setError('Type a few words or rough notes in the field first.');
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLastTask(task);
      setLoading(true);
      setStreamingText('');
      setResult(null);
      setError(null);
      setCopied(false);

      let threadContext: string | undefined;
      if (task === 'reply_draft') {
        const extracted = field.readThreadContext();
        if (extracted.rawContext) {
          threadContext = extracted.rawContext;
          setContextHint(`${extracted.sourceHint} (${extracted.rawContext.length} chars)`);
        } else {
          setContextHint(null);
        }
      } else {
        setContextHint(null);
      }

      const res = await ProtocolClient.aiRewriteStream(
        {
          text: source,
          task,
          surfaceId: context.surfaceId,
          subcontext: context.subcontext,
          threadContext,
          domain: context.domain,
          candidates: twoTakes ? 2 : 1,
          redactSecrets,
        },
        (chunk) => {
          setStreamingText(chunk.accumulated);
        },
        controller.signal,
      );

      if (controller.signal.aborted) {
        setLoading(false);
        return;
      }

      setLoading(false);
      setStreamingText('');
      if (!res.ok) {
        setError(res.error);
        void refreshHealth();
        return;
      }
      setResult(res.result);
    },
    [
      field,
      context.surfaceId,
      context.subcontext,
      context.domain,
      twoTakes,
      redactSecrets,
      refreshHealth,
    ],
  );

  useEffect(() => {
    if (!requestedTask || !field || context.isBlocked) return;
    setExpanded(true);
    if (aiEnabled) {
      void runTask(requestedTask.id);
    }
  }, [requestedTask, field, context.isBlocked, aiEnabled, runTask]);

  const currentText = useMemo(() => {
    void textVersion;
    return field ? field.readText() : '';
  }, [field, textVersion]);

  const containsSecrets = useMemo(() => hasSecrets(currentText), [currentText]);

  const tier0 = useMemo(
    () =>
      analyzeFullTier0(currentText, context.surfaceId, {
        customSlopTerms,
        disabledSlopTerms,
        crutchWords,
      }),
    [currentText, context.surfaceId, customSlopTerms, disabledSlopTerms, crutchWords],
  );

  const handleFixSafe = useCallback(async () => {
    if (!field) return;
    const text = field.readText();
    if (!text.trim()) return;
    const res = await ProtocolClient.fixSafeIssues(text, context.surfaceId);
    if (res.fixesApplied > 0 && res.text !== text) {
      setUndoEntry({
        previousText: text,
        message: `Applied ${res.fixesApplied} deterministic fix${res.fixesApplied === 1 ? '' : 'es'}.`,
      });
      field.writeText(res.text);
      setTextVersion((v) => v + 1);
      setError(null);
    } else {
      setError('No deterministic slop, em dash, emoji, or hashtag fixes needed.');
    }
  }, [field, context.surfaceId]);

  const handleFixAllSafe = useCallback(async () => {
    if (!field) return;
    const text = field.readText();
    if (!text.trim()) return;
    const res = await ProtocolClient.fixAllSafe(text, context.surfaceId);
    if (res.fixesApplied > 0 && res.text !== text) {
      setUndoEntry({
        previousText: text,
        message: `Applied ${res.fixesApplied} safe grammar and slop fix${res.fixesApplied === 1 ? '' : 'es'}.`,
      });
      field.writeText(res.text);
      setTextVersion((v) => v + 1);
      setError(null);
    } else {
      setError('No deterministic slop or unambiguous grammar fixes needed.');
    }
  }, [field, context.surfaceId]);

  const guardAlertItems: GuardAlertItem[] = useMemo(() => {
    const items: GuardAlertItem[] = [];
    if (containsSecrets) {
      items.push({
        id: 'secret-guard',
        kind: 'secret',
        severity: 'danger',
        title: redactSecrets ? 'Secret will be redacted locally' : 'Secrets Guard active',
        detail: redactSecrets
          ? 'Detected credentials will swap to [LEXEL_REDACTED_n] before local AI and restore after.'
          : 'Sensitive credentials or PII detected. Local AI is blocked unless you enable redact-and-restore.',
        actionLabel: redactSecrets ? undefined : 'Enable Redact',
        onAction: redactSecrets
          ? undefined
          : () => {
              void ProtocolClient.setRedactSecrets(true);
            },
      });
    }
    for (const w of tier0.guardWarnings.slice(0, 3)) {
      const taskForGuard = w.suggestedTask;
      items.push({
        id: `${w.kind}-${w.start}`,
        kind:
          w.kind === 'bluf_wall_of_text' || w.kind === 'bluf_buried_ask'
            ? 'bluf'
            : w.kind === 'crutch_word'
              ? 'crutch'
              : 'regret',
        severity: w.severity === 'warn' ? 'warn' : 'info',
        title: w.title,
        detail: w.message,
        actionLabel: aiEnabled && taskForGuard ? w.actionLabel : undefined,
        onAction: aiEnabled && taskForGuard ? () => void runTask(taskForGuard) : undefined,
      });
    }
    for (const c of tier0.consistencyWarnings.slice(0, 2)) {
      items.push({
        id: `${c.kind}-${c.start}`,
        kind: 'consistency',
        severity: 'info',
        title: 'Consistency',
        detail: c.message,
      });
    }
    return items;
  }, [
    containsSecrets,
    redactSecrets,
    tier0.guardWarnings,
    tier0.consistencyWarnings,
    aiEnabled,
    runTask,
  ]);

  async function handleApplyComposed(composedText: string, meta: RewriteApplyMeta) {
    if (!field || !result) return;
    const previous = field.readText();
    field.writeText(composedText);
    setTextVersion((v) => v + 1);
    setUndoEntry({
      previousText: previous,
      message: meta.partial
        ? `Applied ${meta.acceptedHunks} of ${meta.totalHunks} edits.`
        : meta.candidateLabel
          ? `Applied "${meta.candidateLabel}" rewrite.`
          : 'Applied local AI rewrite.',
    });
    await ProtocolClient.saveVoiceExample({
      surfaceId: context.surfaceId,
      subcontext: context.subcontext,
      original: result.original,
      rewritten: composedText,
      action: meta.partial ? 'edited' : 'accepted',
    });
    setResult(null);
    setExpanded(false);
  }

  async function handleCopyComposed(composedText: string) {
    try {
      await navigator.clipboard.writeText(composedText);
      setCopied(true);
    } catch {
      setError('Clipboard write failed in this page context.');
    }
  }

  async function handleTitleCase() {
    if (!field) return;
    const text = field.readText();
    if (!text.trim()) return;
    const next = await ProtocolClient.toTitleCase(text);
    if (next !== text) {
      setUndoEntry({ previousText: text, message: 'Converted to Title Case.' });
      field.writeText(next);
      setTextVersion((v) => v + 1);
    }
    setError(null);
  }

  async function handleSentenceCase() {
    if (!field) return;
    const text = field.readText();
    if (!text.trim()) return;
    const next = await ProtocolClient.toSentenceCase(text);
    if (next !== text) {
      setUndoEntry({ previousText: text, message: 'Converted to Sentence Case.' });
      field.writeText(next);
      setTextVersion((v) => v + 1);
    }
    setError(null);
  }

  async function handleSendToSidePanel() {
    if (!field) return;
    await ProtocolClient.setActiveDraft({
      text: field.readText(),
      surfaceId: context.surfaceId,
      subcontext: context.subcontext,
    });
    await ProtocolClient.openSidePanel();
  }

  const healthState = !aiEnabled
    ? 'offline'
    : checkingHealth
      ? 'loading'
      : health?.ok && health.modelAvailable !== false
        ? 'ready'
        : health
          ? 'error'
          : 'loading';
  const healthLabel = !aiEnabled
    ? 'AI Off'
    : checkingHealth
      ? 'Checking...'
      : health?.ok && health.modelAvailable !== false
        ? 'Local AI Ready'
        : 'Grammar Only';

  const warningCount = tier0.guardWarnings.length + tier0.consistencyWarnings.length;

  return (
    <>
      {field && coords.visible && !context.isBlocked ? (
        <div
          data-theme={theme}
          className="lexel-root"
          style={{
            position: 'fixed',
            top: `${coords.top}px`,
            left: `${coords.left}px`,
            zIndex: 2147483646,
            pointerEvents: 'auto',
          }}
        >
          {!expanded ? (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setExpanded(true)}
              title="Open Lexel writing tools (Alt+L)"
              className="lx-pressable lx-elevated"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '5px 10px',
                borderRadius: '6px',
                border: '1px solid var(--lx-border)',
                backgroundColor: 'var(--lx-card)',
                color: 'var(--lx-fg)',
                fontSize: '12px',
                fontWeight: 500,
              }}
            >
              <NibIcon className="w-3.5 h-3.5" />
              <span>Lexel</span>
              <span
                className="lexel-mono"
                style={{ color: 'var(--lx-fg-muted)', fontSize: '11px' }}
              >
                {context.label}
                {context.subcontext ? ` · ${context.subcontext}` : ''}
              </span>
              {tier0.slopMeter.score >= 18 ? (
                <span
                  className="lexel-mono lx-tab-nums rounded-[4px] border px-1 py-0.5 text-[10px]"
                  style={{
                    backgroundColor:
                      tier0.slopMeter.score >= 45 ? 'var(--lx-danger-bg)' : 'var(--lx-warn-bg)',
                    borderColor:
                      tier0.slopMeter.score >= 45 ? 'var(--lx-danger)' : 'var(--lx-warn)',
                    color: tier0.slopMeter.score >= 45 ? 'var(--lx-danger)' : 'var(--lx-warn)',
                  }}
                >
                  Slop {tier0.slopMeter.score}
                </span>
              ) : null}
              {warningCount > 0 ? (
                <span
                  className="lexel-mono lx-tab-nums text-[10px] font-semibold"
                  style={{ color: 'var(--lx-warn)' }}
                >
                  {warningCount} guard{warningCount === 1 ? '' : 's'}
                </span>
              ) : null}
              {containsSecrets ? (
                <span
                  className="lexel-mono text-[10px] font-semibold"
                  style={{ color: 'var(--lx-danger)' }}
                >
                  Secret
                </span>
              ) : null}
            </button>
          ) : (
            <div
              role="dialog"
              aria-label="Lexel Local Writing Assistant"
              className="lx-surface-enter lx-elevated"
              style={{
                width: '396px',
                maxWidth: 'calc(100vw - 24px)',
                maxHeight: 'min(78vh, 620px)',
                overflowY: 'auto',
                borderRadius: '8px',
                border: '1px solid var(--lx-border)',
                backgroundColor: 'var(--lx-bg)',
                color: 'var(--lx-fg)',
                padding: '12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                  <NibIcon className="w-4 h-4 shrink-0" />
                  <SurfaceBadge
                    label={context.label}
                    subcontext={context.subcontext}
                    charCount={currentText.length}
                    maxChars={profile.maxChars}
                  />
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <StatusPill state={healthState} label={healthLabel} />
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void handleSendToSidePanel()}
                    aria-label="Open in Side Panel"
                    title="Open in Side Panel"
                    className="lx-pressable lx-btn-secondary inline-flex h-7 w-7 items-center justify-center"
                  >
                    <PanelIcon className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void ProtocolClient.openOptions()}
                    aria-label="Open Lexel Settings"
                    title="Open Lexel Settings"
                    className="lx-pressable lx-btn-secondary inline-flex h-7 w-7 items-center justify-center"
                  >
                    <SlidersIcon className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      abortRef.current?.abort();
                      setExpanded(false);
                    }}
                    aria-label="Close Lexel assistant"
                    className="lx-pressable lx-btn-ghost inline-flex h-7 w-7 items-center justify-center"
                  >
                    <CloseIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <PrivacyProofBadge
                  localOnly={true}
                  blockedSecretsCount={localSecretBlocks}
                  redactEnabled={redactSecrets}
                  compact
                />
                {aiEnabled ? (
                  <label
                    className="inline-flex items-center gap-1.5 text-[11px] lexel-mono"
                    style={{ color: 'var(--lx-fg-muted)' }}
                    title="Generate Direct and Ultra-Short options side by side"
                  >
                    <input
                      type="checkbox"
                      checked={twoTakes}
                      onChange={(e) => setTwoTakes(e.target.checked)}
                    />
                    <span>2 takes</span>
                  </label>
                ) : null}
              </div>

              {currentText.trim().length > 0 ? (
                <SlopMeter
                  score={tier0.slopMeter.score}
                  breakdown={{
                    clicheCount: tier0.slopMeter.clicheCount,
                    emDashCount: tier0.slopMeter.emDashCount,
                    fillerOpenerCount: tier0.slopMeter.fillerOpenerCount,
                    flatRhythm: tier0.slopMeter.rhythmFlatness >= 75,
                  }}
                  wordCount={currentText.trim().split(/\s+/).length}
                  onDeSlop={
                    aiEnabled && healthState === 'ready'
                      ? () => void runTask('deslop')
                      : () => void handleFixSafe()
                  }
                  busy={loading}
                  compact
                />
              ) : null}

              {guardAlertItems.length > 0 ? <GuardAlerts items={guardAlertItems} compact /> : null}

              {aiEnabled ? (
                <div className="flex flex-col gap-2">
                  <TonePills
                    value={loading ? (lastTask as TonePillId) : undefined}
                    pills={DEFAULT_TONE_PILLS}
                    onSelect={(id) => void runTask(id as AiTaskId)}
                    disabled={loading}
                    compact
                    ariaLabel="Tone and length rewrite pills"
                  />
                  <div className="flex flex-wrap items-center gap-1.5">
                    {SECONDARY_WORKFLOW_PILLS.map((pill) => (
                      <button
                        key={pill.id}
                        type="button"
                        disabled={loading}
                        title={pill.hint}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => void runTask(pill.id as AiTaskId)}
                        className="lx-pressable lx-btn-secondary px-2 py-1 text-[11px] font-medium"
                      >
                        {pill.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div
                  className="rounded-[6px] border px-2.5 py-2 text-[12px] flex items-center justify-between gap-2"
                  style={{
                    backgroundColor: 'var(--lx-card)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg-muted)',
                  }}
                >
                  <span>Local AI is off. Zero-AI grammar and anti-slop checks stay active.</span>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void ProtocolClient.setAiEnabled(true)}
                    className="lx-pressable lx-btn-primary px-2.5 py-1 text-[11px] font-semibold shrink-0"
                  >
                    Turn AI On
                  </button>
                </div>
              )}

              <div
                role="toolbar"
                aria-label="Deterministic zero-AI transforms"
                className="flex flex-wrap items-center gap-1.5 pt-1 border-t"
                style={{ borderColor: 'var(--lx-border)' }}
              >
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void handleFixSafe()}
                  className="lx-pressable rounded-[6px] border px-2 py-1 text-[11px] font-semibold"
                  style={{
                    backgroundColor: 'var(--lx-card)',
                    borderColor: 'var(--lx-signal)',
                    color: 'var(--lx-signal)',
                  }}
                >
                  Fix Safe
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void handleFixAllSafe()}
                  className="lx-pressable lx-btn-secondary px-2 py-1 text-[11px] font-medium"
                >
                  Fix All Safe
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void handleTitleCase()}
                  className="lx-pressable lx-btn-secondary px-2 py-1 text-[11px] font-medium"
                >
                  Title Case
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void handleSentenceCase()}
                  className="lx-pressable lx-btn-secondary px-2 py-1 text-[11px] font-medium"
                >
                  Sentence Case
                </button>
              </div>

              {contextHint ? (
                <div
                  className="rounded-[6px] border px-2.5 py-1.5 text-[11px] lexel-mono"
                  style={{
                    backgroundColor: 'var(--lx-surface)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg-muted)',
                  }}
                >
                  Scoped context: {contextHint}
                </div>
              ) : null}

              {health && aiEnabled && (!health.ok || health.modelAvailable === false) ? (
                <div
                  className="rounded-[6px] border p-2 text-[11px] flex flex-col gap-1.5"
                  style={{
                    backgroundColor: 'var(--lx-warn-bg)',
                    borderColor: 'var(--lx-warn)',
                    color: 'var(--lx-warn)',
                  }}
                >
                  <span className="break-words">{health.error}</span>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => void refreshHealth()}
                      className="lx-pressable lx-btn-secondary px-2 py-0.5 text-[11px]"
                    >
                      Retry
                    </button>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => void ProtocolClient.openOptions()}
                      className="lx-pressable lx-btn-secondary px-2 py-0.5 text-[11px]"
                    >
                      Bridge Settings
                    </button>
                  </div>
                </div>
              ) : null}

              {loading ? (
                <StreamingTextView
                  text={streamingText}
                  active={loading}
                  statusLabel={`Streaming ${context.label} rewrite`}
                  onCancel={() => {
                    abortRef.current?.abort();
                    setLoading(false);
                    setStreamingText('');
                  }}
                />
              ) : null}

              {error ? (
                <div
                  role="alert"
                  className="rounded-[6px] border px-2.5 py-2 text-[12px] break-words"
                  style={{
                    backgroundColor: 'var(--lx-danger-bg)',
                    borderColor: 'var(--lx-danger)',
                    color: 'var(--lx-danger)',
                  }}
                >
                  {error}
                </div>
              ) : null}

              {result && !loading ? (
                <RewriteDiffCard
                  original={result.original}
                  suggestion={result.suggestion}
                  gates={result.gates}
                  modelName={result.model}
                  latencyMs={result.latencyMs}
                  fastPath={result.fastPath}
                  retried={result.retried}
                  failedConstraints={result.failedConstraints}
                  redactedCount={result.redactedCount}
                  restoredCleanly={result.restoredCleanly}
                  candidates={result.candidates}
                  enableHunkDiff
                  compact
                  onApplyComposed={(composed, meta) => void handleApplyComposed(composed, meta)}
                  onCopy={() => void handleCopyComposed(result.suggestion)}
                  onCopyComposed={(composed) => void handleCopyComposed(composed)}
                  onRetry={() => void runTask(lastTask)}
                  onReject={() => setResult(null)}
                  copied={copied}
                />
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      <div
        data-theme={theme}
        className="lexel-root"
        style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 2147483647 }}
      >
        <div style={{ pointerEvents: 'auto' }}>
          <UndoToast
            open={undoEntry != null}
            message={undoEntry?.message ?? ''}
            durationMs={10_000}
            undoLabel="Revert to original"
            onUndo={() => {
              if (field && undoEntry) {
                field.writeText(undoEntry.previousText);
                setTextVersion((v) => v + 1);
              }
              setUndoEntry(null);
            }}
            onDismiss={() => setUndoEntry(null)}
          />
        </div>
      </div>
    </>
  );
}

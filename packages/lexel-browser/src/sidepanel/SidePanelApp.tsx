import {
  type AiHealthState,
  computeReadabilityMetrics,
  DEFAULT_TONE_PILLS,
  type GuardAlertItem,
  GuardAlerts,
  getSurfaceGradeTarget,
  LexelLogo,
  PrivacyProofBadge,
  type RewriteApplyMeta,
  RewriteDiffCard,
  SlidersIcon,
  SlopMeter,
  StatusPill,
  StreamingTextView,
  SurfaceBadge,
  ThemeToggle,
  type TonePillDef,
  type TonePillId,
  TonePills,
  UndoToast,
} from 'lexel-ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ProtocolClient from '../contentScript/ProtocolClient';
import { LEXEL_LOGO_SRC } from '../shared/brand';
import type { LocalAiHealth } from '../shared/localAiClient';
import { getSurfaceProfile, listSurfaceProfiles } from '../shared/surfaceDetector';
import { scopeThreadContextLocally } from '../shared/threadContext';
import { analyzeFullTier0 } from '../shared/tier0Engine';
import type {
  AiSettings,
  AiTaskId,
  RewriteResult,
  SurfaceId,
  SurfaceProfile,
} from '../shared/types';
import { scanTier0Diagnostics } from '../shared/verifier';

const SHORT_TWO_TAKE_SURFACES = new Set<SurfaceId>([
  'web_x',
  'ide_git_commit',
  'web_discord_slack',
]);

const WORKFLOW_PILLS: readonly TonePillDef[] = [
  { id: 'rewrite_surface', label: 'Match surface', hint: 'Adapt to target surface norms' },
  { id: 'bluf', label: 'Lead with ask', hint: 'Put the question or decision first' },
  { id: 'natural_english', label: 'Natural English', hint: 'Smooth wording into natural prose' },
  { id: 'reply_draft', label: 'Draft reply', hint: 'Use scoped thread context to draft a reply' },
];

export function SidePanelApp() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [text, setText] = useState('');
  const [threadContext, setThreadContext] = useState('');
  const [threadSourceHint, setThreadSourceHint] = useState<string | null>(null);
  const [surfaceId, setSurfaceId] = useState<SurfaceId>('general');
  const [subcontext, setSubcontext] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<AiTaskId>('deslop');
  const [twoTakes, setTwoTakes] = useState(false);
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [undoEntry, setUndoEntry] = useState<{ previousText: string; message: string } | null>(
    null,
  );
  const [synonymWord, setSynonymWord] = useState('');
  const [synonyms, setSynonyms] = useState<string[]>([]);
  const [synonymStatus, setSynonymStatus] = useState<string | null>(null);
  const [result, setResult] = useState<RewriteResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [aiHealth, setAiHealth] = useState<LocalAiHealth | null>(null);
  const [customSurfaces, setCustomSurfaces] = useState<SurfaceProfile[]>([]);
  const [crutchWords, setCrutchWords] = useState<string[]>([]);
  const [redactSecrets, setRedactSecrets] = useState(false);
  const [secretBlocks, setSecretBlocks] = useState(0);
  const [slopConfig, setSlopConfig] = useState<{ customTerms: string[]; disabledTerms: string[] }>({
    customTerms: [],
    disabledTerms: [],
  });

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setTwoTakes(SHORT_TWO_TAKE_SURFACES.has(surfaceId));
  }, [surfaceId]);

  const hydrate = useCallback(async () => {
    const [themeRes, draftRes, aiRes, healthRes, surfacesRes, slopRes, crutchRes, privacyRes] =
      await Promise.all([
        chrome.runtime.sendMessage({ kind: 'getTheme' }) as Promise<{ theme: 'dark' | 'light' }>,
        chrome.runtime.sendMessage({ kind: 'getActiveDraft' }) as Promise<{
          draft: { text: string; surfaceId: SurfaceId; subcontext: string | null } | null;
        }>,
        chrome.runtime.sendMessage({ kind: 'getAiSettings' }) as Promise<{ settings: AiSettings }>,
        chrome.runtime.sendMessage({ kind: 'aiHealth' }) as Promise<LocalAiHealth>,
        chrome.runtime.sendMessage({ kind: 'getCustomSurfaces' }) as Promise<{
          surfaces?: SurfaceProfile[];
        }>,
        chrome.runtime.sendMessage({ kind: 'getCustomSlopConfig' }) as Promise<{
          customTerms?: string[];
          disabledTerms?: string[];
        }>,
        chrome.runtime.sendMessage({ kind: 'getCrutchWords' }) as Promise<{ words?: string[] }>,
        chrome.runtime.sendMessage({ kind: 'getPrivacyStats' }) as Promise<{
          localSecretBlocks?: number;
          redactSecrets?: boolean;
        }>,
      ]);

    setTheme(themeRes?.theme === 'light' ? 'light' : 'dark');
    setAiSettings(aiRes?.settings ?? null);
    setAiHealth(healthRes ?? null);
    setCustomSurfaces(surfacesRes?.surfaces ?? []);
    setSlopConfig({
      customTerms: slopRes?.customTerms ?? [],
      disabledTerms: slopRes?.disabledTerms ?? [],
    });
    setCrutchWords(crutchRes?.words ?? []);
    setRedactSecrets(privacyRes?.redactSecrets === true);
    setSecretBlocks(privacyRes?.localSecretBlocks ?? 0);
    if (draftRes?.draft) {
      setText(draftRes.draft.text);
      setSurfaceId(draftRes.draft.surfaceId);
      setSubcontext(draftRes.draft.subcontext);
    }
  }, []);

  useEffect(() => {
    void hydrate().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    return () => {
      abortRef.current?.abort();
    };
  }, [hydrate]);

  const allSurfaces = listSurfaceProfiles(customSurfaces);
  const profile = getSurfaceProfile(surfaceId, customSurfaces);

  const tier0 = useMemo(
    () =>
      text.trim()
        ? scanTier0Diagnostics(text, surfaceId, {
            customSlopTerms: slopConfig.customTerms,
            disabledSlopTerms: slopConfig.disabledTerms,
            customSurfaces,
          })
        : {
            slopLints: [],
            surfaceLints: [],
            secretLints: [],
            invisibleLints: [],
            structureLints: [],
            styleGuideLints: [],
            secrets: [],
          },
    [text, surfaceId, slopConfig, customSurfaces],
  );

  const fullTier0 = useMemo(
    () =>
      analyzeFullTier0(text, surfaceId, {
        customSlopTerms: slopConfig.customTerms,
        disabledSlopTerms: slopConfig.disabledTerms,
        crutchWords,
      }),
    [text, surfaceId, slopConfig, crutchWords],
  );

  const scopedPreview = useMemo(
    () => (threadContext.trim() ? scopeThreadContextLocally(text, threadContext, 300) : null),
    [text, threadContext],
  );

  async function handleRefreshHealth() {
    setError(null);
    await chrome.runtime.sendMessage({ kind: 'syncFromDaemon' });
    await hydrate();
  }

  async function handleThemeToggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    await chrome.runtime.sendMessage({ kind: 'setTheme', theme: next });
  }

  async function handlePullFromPage() {
    setError(null);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id == null) {
        setError('No active browser tab found.');
        return;
      }
      const draft = (await chrome.tabs.sendMessage(tab.id, { kind: 'getFocusedDraft' })) as {
        text: string;
        surfaceId: SurfaceId;
        subcontext: string | null;
      } | null;
      if (!draft || !draft.text) {
        setError('Click inside a text box on the page first, then pull again.');
        return;
      }
      setText(draft.text);
      setSurfaceId(draft.surfaceId);
      setSubcontext(draft.subcontext);
      setResult(null);
    } catch {
      setError('Cannot read text from this tab. Reload the tab or paste your draft below.');
    }
  }

  async function handleExtractSmartContext() {
    setError(null);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id == null) {
        setError('No active browser tab found.');
        return;
      }
      const extracted = (await chrome.tabs.sendMessage(tab.id, {
        kind: 'getSmartThreadContext',
      })) as { rawContext: string; sourceHint: string } | null;
      if (!extracted?.rawContext) {
        setError('No parent comment or PR diff hunk found near the active field.');
        return;
      }
      const scoped = await ProtocolClient.scopeThreadContext(text, extracted.rawContext, 300);
      setThreadContext(scoped.scopedText);
      setThreadSourceHint(`${extracted.sourceHint} (~${scoped.estimatedTokens} tokens)`);
      setActiveTask('reply_draft');
    } catch {
      setError('Cannot read thread context from this tab. Paste the parent text manually.');
    }
  }

  const runRewrite = useCallback(
    async (taskToRun: AiTaskId) => {
      if (!text.trim()) {
        setError('Write or pull text before running a rewrite.');
        return;
      }
      if (!redactSecrets && tier0.secrets.length > 0) {
        setError(
          'Secrets Guard blocked AI rewrite because credentials or PII were detected. Enable redact-and-restore in Settings to mask them automatically.',
        );
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setActiveTask(taskToRun);
      setLoading(true);
      setStreamingText('');
      setResult(null);
      setError(null);
      setCopied(false);

      const res = await ProtocolClient.aiRewriteStream(
        {
          text,
          task: taskToRun,
          surfaceId,
          subcontext,
          threadContext:
            taskToRun === 'reply_draft' || threadContext.trim()
              ? (scopedPreview?.scopedText ?? threadContext)
              : undefined,
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
        return;
      }
      setResult(res.result);
    },
    [
      text,
      redactSecrets,
      tier0.secrets.length,
      surfaceId,
      subcontext,
      threadContext,
      scopedPreview,
      twoTakes,
    ],
  );

  async function handleApplyComposed(composedText: string, meta: RewriteApplyMeta) {
    if (!result) return;
    const previous = text;
    setText(composedText);
    setUndoEntry({
      previousText: previous,
      message: meta.partial
        ? `Applied ${meta.acceptedHunks} of ${meta.totalHunks} edits.`
        : meta.candidateLabel
          ? `Applied "${meta.candidateLabel}" take.`
          : 'Applied local AI rewrite.',
    });
    await chrome.runtime.sendMessage({
      kind: 'saveVoiceExample',
      example: {
        surfaceId,
        subcontext,
        original: result.original,
        rewritten: composedText,
        action: meta.partial ? 'edited' : 'accepted',
      },
    });
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id != null) {
        await chrome.tabs.sendMessage(tab.id, {
          kind: 'applyDraftToFocused',
          text: composedText,
        });
      }
    } catch {
      // Tab may not have a focused target; text is still updated in workbench.
    }
    setResult(null);
  }

  async function handleFixSafeSlop() {
    if (!text.trim()) return;
    const res = (await chrome.runtime.sendMessage({
      kind: 'fixSafeIssues',
      text,
      surfaceId,
    })) as { result?: { text: string; fixesApplied: number } };
    if (res?.result && res.result.fixesApplied > 0 && res.result.text !== text) {
      setUndoEntry({
        previousText: text,
        message: `Cleaned ${res.result.fixesApplied} deterministic slop/format issue${res.result.fixesApplied === 1 ? '' : 's'}.`,
      });
      setText(res.result.text);
      setError(null);
    } else {
      setError('No safe deterministic slop, em dash, emoji, or hashtag fixes needed.');
    }
  }

  async function handleFixAllSafe() {
    if (!text.trim()) return;
    const res = (await chrome.runtime.sendMessage({
      kind: 'fixAllSafe',
      text,
      surfaceId,
    })) as { result?: { text: string; fixesApplied: number } };
    if (res?.result && res.result.fixesApplied > 0 && res.result.text !== text) {
      setUndoEntry({
        previousText: text,
        message: `Applied ${res.result.fixesApplied} safe grammar and slop fix${res.result.fixesApplied === 1 ? '' : 'es'}.`,
      });
      setText(res.result.text);
      setError(null);
    } else {
      setError('No deterministic slop, typography, or safe grammar fixes needed.');
    }
  }

  const connected = Boolean(aiHealth?.daemonConnected);
  const aiReady = Boolean(
    connected && aiSettings?.enabled && aiHealth?.ok && aiHealth.modelAvailable !== false,
  );
  const aiState: AiHealthState = !connected
    ? 'offline'
    : !aiSettings?.enabled
      ? 'offline'
      : aiHealth?.ok && aiHealth.modelAvailable !== false
        ? 'ready'
        : 'error';

  const aiLabel = !connected
    ? 'Tier 0 Local'
    : !aiSettings?.enabled
      ? 'AI Off'
      : aiHealth?.ok && aiHealth.modelAvailable !== false
        ? aiSettings.model
        : aiHealth?.ok
          ? 'Model Missing'
          : 'AI Offline';

  const guardItems: GuardAlertItem[] = useMemo(() => {
    const items: GuardAlertItem[] = [];
    if (tier0.secrets.length > 0) {
      items.push({
        id: 'secrets-guard',
        kind: 'secret',
        severity: 'danger',
        title: redactSecrets ? 'Secrets will redact locally' : 'Secrets Guard blocked AI',
        detail: `${tier0.secrets.length} credential or PII span${tier0.secrets.length === 1 ? '' : 's'} detected in draft.`,
        actionLabel: redactSecrets ? undefined : 'Enable redact',
        onAction: redactSecrets
          ? undefined
          : () => {
              setRedactSecrets(true);
              void chrome.runtime.sendMessage({ kind: 'setRedactSecrets', enabled: true });
            },
      });
    }
    for (const w of fullTier0.guardWarnings) {
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
        actionLabel: taskForGuard && aiReady ? w.actionLabel : undefined,
        onAction: taskForGuard && aiReady ? () => void runRewrite(taskForGuard) : undefined,
      });
    }
    for (const c of fullTier0.consistencyWarnings) {
      items.push({
        id: `${c.kind}-${c.start}`,
        kind: 'consistency',
        severity: 'info',
        title: 'Document consistency',
        detail: c.message,
      });
    }
    for (const s of tier0.surfaceLints.slice(0, 3)) {
      items.push({
        id: `surface-${s.span.start}-${s.problem_text}`,
        kind: 'surface',
        severity: 'warn',
        title: profile.label,
        detail: s.message_html.replace(/<[^>]+>/g, ''),
      });
    }
    return items;
  }, [
    tier0.secrets.length,
    tier0.surfaceLints,
    redactSecrets,
    fullTier0.guardWarnings,
    fullTier0.consistencyWarnings,
    aiReady,
    profile.label,
    runRewrite,
  ]);

  const readability = useMemo(() => (text.trim() ? computeReadabilityMetrics(text) : null), [text]);
  const gradeTarget = getSurfaceGradeTarget(surfaceId);

  return (
    <div data-theme={theme} className="lexel-root min-h-screen p-4 flex flex-col gap-3">
      <header
        className="flex items-center justify-between gap-2 pb-2.5 border-b"
        style={{ borderColor: 'var(--lx-border)' }}
      >
        <div className="flex items-center gap-2">
          <LexelLogo className="h-6 w-auto" src={LEXEL_LOGO_SRC} />
          <h1 className="text-[14px] font-semibold tracking-tight m-0">Lexel Workbench</h1>
        </div>
        <div className="flex items-center gap-1.5">
          <StatusPill state={aiState} label={aiLabel} />
          <button
            type="button"
            onClick={() => void chrome.runtime.openOptionsPage()}
            aria-label="Open Lexel settings and diagnostics"
            className="lx-pressable lx-btn-secondary inline-flex h-8 w-8 items-center justify-center"
          >
            <SlidersIcon className="w-4 h-4" />
          </button>
          <ThemeToggle theme={theme} onToggle={() => void handleThemeToggle()} />
        </div>
      </header>

      <main className="flex flex-col gap-3 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <PrivacyProofBadge
            localOnly={true}
            blockedSecretsCount={secretBlocks}
            redactEnabled={redactSecrets}
            compact
          />
          <label
            className="inline-flex items-center gap-1.5 text-[11px] lexel-mono"
            style={{ color: 'var(--lx-fg-muted)' }}
            title="Compare Direct and Ultra-Short rewrites side by side"
          >
            <input
              type="checkbox"
              checked={twoTakes}
              onChange={(e) => setTwoTakes(e.target.checked)}
            />
            <span>2 takes</span>
          </label>
        </div>

        {!connected ? (
          <div
            className="rounded-[8px] border p-3 flex flex-col gap-2 text-xs"
            style={{
              backgroundColor: 'var(--lx-card)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg-muted)',
            }}
          >
            <div className="leading-snug">
              <strong style={{ color: 'var(--lx-fg)' }}>Tier 0 checks are running locally.</strong>{' '}
              Connect <strong>Lexel Desktop</strong> to stream local AI rewrites and sync profiles.
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void handleRefreshHealth()}
                className="lx-pressable lx-btn-primary px-2.5 py-1 text-[11px] font-semibold"
              >
                Connect Desktop
              </button>
              <button
                type="button"
                onClick={() => void chrome.runtime.openOptionsPage()}
                className="lx-pressable lx-btn-secondary px-2.5 py-1 text-[11px] font-medium"
              >
                Install Bridge
              </button>
            </div>
          </div>
        ) : aiHealth && (!aiHealth.ok || aiHealth.modelAvailable === false) ? (
          <div
            className="rounded-[8px] border p-2.5 flex flex-col gap-2 text-xs"
            style={{
              backgroundColor: 'var(--lx-warn-bg)',
              borderColor: 'var(--lx-warn)',
              color: 'var(--lx-warn)',
            }}
          >
            <div className="leading-snug break-words">
              {aiHealth.error ?? 'Download a local GGUF model in Lexel Desktop.'}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleRefreshHealth()}
                className="lx-pressable lx-btn-secondary px-2.5 py-1 text-[11px] font-medium"
              >
                Sync Now
              </button>
              <button
                type="button"
                onClick={() => void chrome.runtime.openOptionsPage()}
                className="lx-pressable lx-btn-secondary px-2.5 py-1 text-[11px] font-medium"
              >
                Run Doctor
              </button>
            </div>
          </div>
        ) : null}

        <section
          aria-label="Draft editor"
          className="rounded-[8px] border p-3 flex flex-col gap-2.5"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SurfaceBadge
              label={profile.label}
              subcontext={subcontext}
              charCount={text.length}
              maxChars={profile.maxChars}
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => void handlePullFromPage()}
                className="lx-pressable lx-btn-secondary px-2 py-1 text-[11px] font-medium"
              >
                Pull box
              </button>
              <button
                type="button"
                onClick={() => void handleExtractSmartContext()}
                className="lx-pressable lx-btn-secondary px-2 py-1 text-[11px] font-medium"
                title="Read only the parent comment or PR diff hunk on this tab"
              >
                Extract context
              </button>
              {text ? (
                <button
                  type="button"
                  onClick={() => {
                    setText('');
                    setResult(null);
                    setError(null);
                  }}
                  className="lx-pressable lx-btn-ghost px-2 py-1 text-[11px]"
                >
                  Clear
                </button>
              ) : null}
            </div>
          </div>

          <label
            className="flex flex-col gap-1 text-[11px]"
            style={{ color: 'var(--lx-fg-muted)' }}
          >
            <span>Target surface</span>
            <select
              value={surfaceId}
              onChange={(e) => setSurfaceId(e.target.value as SurfaceId)}
              className="rounded-[6px] border px-2.5 py-1.5 text-xs"
              style={{
                backgroundColor: 'var(--lx-bg)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              {allSurfaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
              Draft text
            </span>
            <textarea
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Write or pull text from the active tab to inspect slop, guards, and local rewrites..."
              className="w-full rounded-[6px] border p-2.5 text-[13px] leading-relaxed resize-y"
              style={{
                backgroundColor: 'var(--lx-bg)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            />
          </label>

          {threadContext || activeTask === 'reply_draft' ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <label htmlFor="lexel-thread-context" style={{ color: 'var(--lx-fg-muted)' }}>
                  {threadSourceHint
                    ? `Scoped context: ${threadSourceHint}`
                    : 'Parent comment or PR diff hunk (optional, capped at ~300 tokens)'}
                </label>
                {threadContext ? (
                  <button
                    type="button"
                    onClick={() => {
                      setThreadContext('');
                      setThreadSourceHint(null);
                    }}
                    className="lx-pressable lx-btn-ghost px-1.5 py-0.5 text-[11px]"
                  >
                    Clear context
                  </button>
                ) : null}
              </div>
              <textarea
                id="lexel-thread-context"
                rows={3}
                value={threadContext}
                onChange={(e) => setThreadContext(e.target.value)}
                placeholder="Click Extract context above or paste the parent comment/PR hunk..."
                className="w-full rounded-[6px] border p-2 text-xs leading-relaxed resize-y"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
            </div>
          ) : null}
        </section>

        <SlopMeter
          score={fullTier0.slopMeter.score}
          breakdown={{
            clicheCount: fullTier0.slopMeter.clicheCount,
            emDashCount: fullTier0.slopMeter.emDashCount,
            fillerOpenerCount: fullTier0.slopMeter.fillerOpenerCount,
            flatRhythm: fullTier0.slopMeter.rhythmFlatness >= 75,
          }}
          wordCount={readability?.words ?? 0}
          onDeSlop={aiReady ? () => void runRewrite('deslop') : () => void handleFixSafeSlop()}
          busy={loading}
          compact
        />

        {text.trim() ? (
          <GuardAlerts
            items={guardItems}
            emptyMessage="No BLUF, Regret Shield, consistency, or secret warnings."
            compact
          />
        ) : null}

        <section
          aria-label="Local AI rewrite controls"
          className="rounded-[8px] border p-3 flex flex-col gap-2.5"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xs font-semibold m-0">Tone &amp; Rewrite</h2>
            <span className="text-[11px] lexel-mono" style={{ color: 'var(--lx-fg-muted)' }}>
              1-click local stream
            </span>
          </div>

          <TonePills
            value={activeTask as TonePillId}
            pills={DEFAULT_TONE_PILLS}
            onSelect={(id) => void runRewrite(id as AiTaskId)}
            disabled={loading}
            compact
          />

          <div className="flex flex-wrap gap-1.5">
            {WORKFLOW_PILLS.map((pill) => (
              <button
                key={pill.id}
                type="button"
                disabled={loading}
                title={pill.hint}
                onClick={() => void runRewrite(pill.id as AiTaskId)}
                className="lx-pressable lx-btn-secondary px-2 py-1 text-[11px] font-medium"
              >
                {pill.label}
              </button>
            ))}
          </div>

          <div
            role="toolbar"
            aria-label="Zero-AI deterministic fixes"
            className="flex flex-wrap gap-1.5 pt-2 border-t"
            style={{ borderColor: 'var(--lx-border)' }}
          >
            <button
              type="button"
              onClick={() => void handleFixSafeSlop()}
              className="lx-pressable rounded-[6px] border px-2 py-1 text-[11px] font-semibold"
              style={{
                backgroundColor: 'var(--lx-bg)',
                borderColor: 'var(--lx-signal)',
                color: 'var(--lx-signal)',
              }}
            >
              Fix Safe Slop
            </button>
            <button
              type="button"
              onClick={() => void handleFixAllSafe()}
              className="lx-pressable lx-btn-secondary px-2 py-1 text-[11px] font-medium"
            >
              Fix All Safe
            </button>
            <button
              type="button"
              onClick={async () => {
                if (!text.trim()) return;
                const res = (await chrome.runtime.sendMessage({ kind: 'toTitleCase', text })) as {
                  text?: string;
                };
                if (res?.text && res.text !== text) {
                  setUndoEntry({ previousText: text, message: 'Converted to Title Case.' });
                  setText(res.text);
                }
              }}
              className="lx-pressable lx-btn-secondary px-2 py-1 text-[11px] font-medium"
            >
              Title Case
            </button>
            <button
              type="button"
              onClick={async () => {
                if (!text.trim()) return;
                const res = (await chrome.runtime.sendMessage({
                  kind: 'toSentenceCase',
                  text,
                })) as { text?: string };
                if (res?.text && res.text !== text) {
                  setUndoEntry({ previousText: text, message: 'Converted to Sentence Case.' });
                  setText(res.text);
                }
              }}
              className="lx-pressable lx-btn-secondary px-2 py-1 text-[11px] font-medium"
            >
              Sentence Case
            </button>
            <button
              type="button"
              onClick={async () => {
                if (!text.trim()) return;
                const res = (await chrome.runtime.sendMessage({
                  kind: 'normalizeTypography',
                  text,
                })) as { result?: { text: string; fixesApplied: number } };
                if (res?.result && res.result.text !== text) {
                  setUndoEntry({ previousText: text, message: 'Normalized quotes and spacing.' });
                  setText(res.result.text);
                  setError(null);
                } else {
                  setError('Quotes and spacing are already clean.');
                }
              }}
              className="lx-pressable lx-btn-secondary px-2 py-1 text-[11px] font-medium"
            >
              Clean Quotes
            </button>
          </div>
        </section>

        {loading ? (
          <StreamingTextView
            text={streamingText}
            active={loading}
            statusLabel={`Streaming ${profile.label} rewrite`}
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
            className="rounded-[6px] border p-2.5 text-xs"
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
            onCopy={() => {
              void navigator.clipboard.writeText(result.suggestion);
              setCopied(true);
            }}
            onCopyComposed={(composed) => {
              void navigator.clipboard.writeText(composed);
              setCopied(true);
            }}
            onRetry={() => void runRewrite(activeTask)}
            onReject={() => setResult(null)}
            copied={copied}
          />
        ) : null}

        <details
          className="rounded-[8px] border p-3 text-xs"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <summary className="font-semibold">Readability &amp; Offline Thesaurus</summary>
          <div className="mt-3 flex flex-col gap-3">
            {readability ? (
              <div
                className="grid grid-cols-3 gap-2 text-[11px] lexel-mono lx-tab-nums"
                style={{ color: 'var(--lx-fg-muted)' }}
              >
                <div>
                  <div className="text-[10px] uppercase">Words</div>
                  <div className="text-xs font-semibold" style={{ color: 'var(--lx-fg)' }}>
                    {readability.words}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase">Grade Goal</div>
                  <div
                    className="text-xs font-semibold"
                    style={{
                      color:
                        readability.fleschKincaidGrade >= gradeTarget.minGrade &&
                        readability.fleschKincaidGrade <= gradeTarget.maxGrade
                          ? 'var(--lx-signal)'
                          : 'var(--lx-warn)',
                    }}
                  >
                    G{readability.fleschKincaidGrade.toFixed(1)} ({gradeTarget.minGrade}-
                    {gradeTarget.maxGrade})
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase">Read / Speak</div>
                  <div className="text-xs font-semibold" style={{ color: 'var(--lx-fg)' }}>
                    {readability.readingTimeSec}s / {readability.speakingTimeSec}s
                  </div>
                </div>
              </div>
            ) : (
              <p className="m-0 text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                Enter draft text above to inspect readability and pacing.
              </p>
            )}

            <form
              className="flex gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                const q = synonymWord.trim();
                if (!q) return;
                setSynonymStatus('Searching local dictionary...');
                void chrome.runtime
                  .sendMessage({ kind: 'lookupSynonyms', word: q })
                  .then((res: unknown) => {
                    const payload = res as { ok?: boolean; synonyms?: string[]; error?: string };
                    if (payload?.ok) {
                      const list = payload.synonyms ?? [];
                      setSynonyms(list);
                      setSynonymStatus(list.length === 0 ? `No synonyms found for "${q}".` : null);
                    } else {
                      setSynonyms([]);
                      setSynonymStatus(payload?.error ?? 'Start Lexel Desktop for synonyms.');
                    }
                  });
              }}
            >
              <input
                type="text"
                value={synonymWord}
                onChange={(e) => setSynonymWord(e.target.value)}
                placeholder="Offline thesaurus lookup..."
                aria-label="Look up word synonyms"
                className="flex-1 rounded-[6px] border px-2.5 py-1 text-xs"
                style={{
                  backgroundColor: 'var(--lx-bg)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
              <button type="submit" className="lx-pressable lx-btn-secondary px-2.5 py-1 text-xs">
                Synonyms
              </button>
            </form>
            {synonymStatus ? (
              <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                {synonymStatus}
              </div>
            ) : null}
            {synonyms.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {synonyms.map((syn) => (
                  <button
                    key={syn}
                    type="button"
                    onClick={() => void navigator.clipboard.writeText(syn)}
                    className="lx-pressable rounded-[4px] border px-2 py-0.5 text-[11px] lexel-mono"
                    style={{
                      backgroundColor: 'var(--lx-bg)',
                      borderColor: 'var(--lx-border)',
                      color: 'var(--lx-signal)',
                    }}
                    title="Copy synonym"
                  >
                    {syn}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </details>
      </main>

      <UndoToast
        open={undoEntry != null}
        message={undoEntry?.message ?? ''}
        durationMs={10_000}
        undoLabel="Revert to original"
        onUndo={() => {
          if (undoEntry) {
            setText(undoEntry.previousText);
          }
          setUndoEntry(null);
        }}
        onDismiss={() => setUndoEntry(null)}
      />
    </div>
  );
}

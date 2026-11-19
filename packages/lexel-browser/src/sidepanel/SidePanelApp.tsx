import {
  NibIcon,
  RewriteDiffCard,
  SlidersIcon,
  StatusPill,
  SurfaceBadge,
  ThemeToggle,
  computeReadabilityMetrics,
  type AiHealthState,
} from 'lexel-ui';
import React, { useEffect, useState } from 'react';
import type { LocalAiHealth } from '../shared/localAiClient';
import { MODEL_MANIFEST_SPECS } from '../shared/models';
import { getSurfaceProfile, listSurfaceProfiles } from '../shared/surfaceDetector';
import type {
  AiSettings,
  AiTaskId,
  RewriteResult,
  SurfaceId,
  SurfaceProfile,
} from '../shared/types';
import { scanTier0Diagnostics } from '../shared/verifier';

const TASK_OPTIONS: Array<{ id: AiTaskId; label: string }> = [
  { id: 'rewrite_surface', label: 'Match surface style' },
  { id: 'deslop', label: 'Remove AI slop' },
  { id: 'fix_grammar_flow', label: 'Fix grammar & flow' },
  { id: 'shorten', label: 'Shorten concisely' },
  { id: 'reply_draft', label: 'Draft reply' },
];

export function SidePanelApp() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [text, setText] = useState('');
  const [threadContext, setThreadContext] = useState('');
  const [surfaceId, setSurfaceId] = useState<SurfaceId>('general');
  const [subcontext, setSubcontext] = useState<string | null>(null);
  const [task, setTask] = useState<AiTaskId>('rewrite_surface');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undoText, setUndoText] = useState<string | null>(null);
  const [synonymWord, setSynonymWord] = useState('');
  const [synonyms, setSynonyms] = useState<string[]>([]);
  const [synonymStatus, setSynonymStatus] = useState<string | null>(null);
  const [result, setResult] = useState<RewriteResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [aiHealth, setAiHealth] = useState<LocalAiHealth | null>(null);
  const [customSurfaces, setCustomSurfaces] = useState<SurfaceProfile[]>([]);
  const [slopConfig, setSlopConfig] = useState<{ customTerms: string[]; disabledTerms: string[] }>({
    customTerms: [],
    disabledTerms: [],
  });

  useEffect(() => {
    (async () => {
      const [themeRes, draftRes, aiRes, healthRes, surfacesRes, slopRes] = await Promise.all([
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
      ]);
      setTheme(themeRes.theme);
      setAiSettings(aiRes.settings);
      setAiHealth(healthRes);
      setCustomSurfaces(surfacesRes?.surfaces ?? []);
      setSlopConfig({
        customTerms: slopRes?.customTerms ?? [],
        disabledTerms: slopRes?.disabledTerms ?? [],
      });
      if (draftRes.draft) {
        setText(draftRes.draft.text);
        setSurfaceId(draftRes.draft.surfaceId);
        setSubcontext(draftRes.draft.subcontext);
      }
    })();
  }, []);

  const allSurfaces = listSurfaceProfiles(customSurfaces);
  const profile = getSurfaceProfile(surfaceId, customSurfaces);
  const tier0 = text.trim()
    ? scanTier0Diagnostics(text, surfaceId, {
        customSlopTerms: slopConfig.customTerms,
        disabledSlopTerms: slopConfig.disabledTerms,
        customSurfaces,
      })
    : { slopLints: [], surfaceLints: [], secretLints: [], secrets: [] };

  async function handleRefreshHealth() {
    const health = (await chrome.runtime.sendMessage({ kind: 'aiHealth' })) as LocalAiHealth;
    setAiHealth(health);
  }

  async function handleEnableAi() {
    if (!aiSettings) return;
    setAiSettings({ ...aiSettings, enabled: true });
    const res = (await chrome.runtime.sendMessage({
      kind: 'toggleAi',
      enabled: true,
    })) as { health?: LocalAiHealth; activationError?: string | null };
    if (res.health) {
      setAiHealth({
        ...res.health,
        error: res.activationError ?? res.health.error,
      });
    } else {
      await handleRefreshHealth();
    }
  }

  async function handleModelChange(model: string) {
    if (!aiSettings) return;
    const res = (await chrome.runtime.sendMessage({
      kind: 'setMainModel',
      model,
    })) as { health?: LocalAiHealth };
    const nextAi = (await chrome.runtime.sendMessage({
      kind: 'getAiSettings',
    })) as { settings: AiSettings };
    setAiSettings(nextAi.settings);
    if (res.health) {
      setAiHealth(res.health);
    } else {
      await handleRefreshHealth();
    }
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
      setError('Cannot read text from this tab (try reloading the page after installing Lexel).');
    }
  }

  async function handleRewrite() {
    if (!text.trim()) {
      setError('Enter or pull text before running a rewrite.');
      return;
    }
    if (tier0.secrets.length > 0) {
      setError('Secrets Guard blocked AI rewrite because sensitive credentials or PII were detected.');
      return;
    }
    setLoading(true);
    setError(null);
    setCopied(false);
    const res = (await chrome.runtime.sendMessage({
      kind: 'aiRewrite',
      text,
      task,
      surfaceId,
      subcontext,
      threadContext: task === 'reply_draft' ? threadContext : undefined,
    })) as { ok: true; result: RewriteResult } | { ok: false; error: string };

    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setResult(res.result);
  }

  async function handleApplyToPage() {
    if (!result) return;
    setText(result.suggestion);
    await chrome.runtime.sendMessage({
      kind: 'saveVoiceExample',
      example: {
        surfaceId,
        subcontext,
        original: result.original,
        rewritten: result.suggestion,
        action: 'accepted',
      },
    });
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id != null) {
        await chrome.tabs.sendMessage(tab.id, {
          kind: 'applyDraftToFocused',
          text: result.suggestion,
        });
      }
    } catch {
      // Tab may not have a focused target; text is still updated in workbench.
    }
    setResult(null);
  }

  const aiState: AiHealthState = !aiSettings?.enabled
    ? 'offline'
    : aiHealth?.ok && aiHealth.modelAvailable !== false
      ? 'ready'
      : 'error';

  const aiLabel = !aiSettings?.enabled
    ? 'AI Off'
    : aiHealth?.ok && aiHealth.modelAvailable !== false
      ? aiSettings.model
      : aiHealth?.ok
        ? 'Model Missing'
        : 'AI Offline';

  const modelValue =
    aiSettings?.mainModelTier === 'lexel-0.5b'
      ? 'lexel-0.5b'
      : aiSettings?.mainModelTier === 'lexel-1.5b'
        ? 'lexel-1.5b'
        : aiSettings?.model ?? 'lexel-1.5b';

  return (
    <div data-theme={theme} className="lexel-root min-h-screen p-4 flex flex-col gap-3">
      <header
        className="flex items-center justify-between gap-2 pb-2 border-b"
        style={{ borderColor: 'var(--lx-border)' }}
      >
        <div className="flex items-center gap-2">
          <NibIcon className="w-5 h-5" />
          <h1 className="text-sm font-semibold m-0">Lexel Workbench</h1>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill state={aiState} label={aiLabel} />
          <button
            type="button"
            onClick={() => void chrome.runtime.openOptionsPage()}
            aria-label="Open Lexel settings"
            className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] border"
            style={{
              backgroundColor: 'var(--lx-muted)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          >
            <SlidersIcon className="w-4 h-4" />
          </button>
          <ThemeToggle theme={theme} onToggle={() => void handleThemeToggle()} />
        </div>
      </header>

      {aiSettings && !aiSettings.enabled ? (
        <div
          className="rounded-[8px] border p-2.5 flex items-center justify-between gap-2 text-xs"
          style={{
            backgroundColor: 'var(--lx-card)',
            borderColor: 'var(--lx-border)',
            color: 'var(--lx-fg-muted)',
          }}
        >
          <span>Local AI is off. Grammar checks remain active.</span>
          <button
            type="button"
            onClick={() => void handleEnableAi()}
            className="rounded-[6px] px-2.5 py-1 text-xs font-semibold shrink-0"
            style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
          >
            Turn AI On
          </button>
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
          <div className="leading-snug break-words">{aiHealth.error}</div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handleRefreshHealth()}
              className="rounded-[6px] border px-2 py-1 text-[11px] font-medium"
              style={{
                backgroundColor: 'var(--lx-muted)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              Retry connection
            </button>
            {aiHealth.nativeHostCommand ? (
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(aiHealth.nativeHostCommand!)}
                className="rounded-[6px] border px-2 py-1 text-[11px]"
                style={{
                  backgroundColor: 'var(--lx-bg)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg-muted)',
                }}
              >
                Copy host command
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void chrome.runtime.openOptionsPage()}
              className="rounded-[6px] border px-2 py-1 text-[11px]"
              style={{
                backgroundColor: 'var(--lx-bg)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg-muted)',
              }}
            >
              Settings
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <SurfaceBadge
          label={profile.label}
          subcontext={subcontext}
          charCount={text.length}
          maxChars={profile.maxChars}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handlePullFromPage()}
            className="rounded-[6px] border px-2.5 py-1 text-xs font-medium"
            style={{
              backgroundColor: 'var(--lx-muted)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          >
            Pull from active box
          </button>
          <button
            type="button"
            onClick={() => {
              setText('');
              setResult(null);
              setError(null);
            }}
            className="rounded-[6px] px-2 py-1 text-xs"
            style={{ color: 'var(--lx-fg-muted)' }}
          >
            Clear
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
          <span>Surface</span>
          <select
            value={surfaceId}
            onChange={(e) => setSurfaceId(e.target.value as SurfaceId)}
            className="rounded-[6px] border px-2 py-1.5 text-xs"
            style={{
              backgroundColor: 'var(--lx-card)',
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

        <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
          <span>Action</span>
          <select
            value={task}
            onChange={(e) => setTask(e.target.value as AiTaskId)}
            className="rounded-[6px] border px-2 py-1.5 text-xs"
            style={{
              backgroundColor: 'var(--lx-card)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          >
            {TASK_OPTIONS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
          <span>Model</span>
          <select
            value={modelValue}
            onChange={(e) => void handleModelChange(e.target.value)}
            className="rounded-[6px] border px-2 py-1.5 text-xs"
            style={{
              backgroundColor: 'var(--lx-card)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          >
            {MODEL_MANIFEST_SPECS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            {aiSettings?.mainModelTier === 'custom' ? (
              <option value={aiSettings.model}>{aiSettings.model}</option>
            ) : null}
          </select>
        </label>
      </div>

      <label className="flex flex-col gap-1 text-xs">
        <span className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
          Draft text
        </span>
        <textarea
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Write or paste text to check and rewrite locally..."
          className="w-full rounded-[8px] border p-2.5 text-xs leading-relaxed resize-y"
          style={{
            backgroundColor: 'var(--lx-card)',
            borderColor: 'var(--lx-border)',
            color: 'var(--lx-fg)',
          }}
        />
      </label>

      {task === 'reply_draft' ? (
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
            Parent post or comment context (optional)
          </span>
          <textarea
            rows={3}
            value={threadContext}
            onChange={(e) => setThreadContext(e.target.value)}
            placeholder="Paste the post or comment you are replying to..."
            className="w-full rounded-[8px] border p-2 text-xs resize-y"
            style={{
              backgroundColor: 'var(--lx-card)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          />
        </label>
      ) : null}

      {tier0.secretLints.length > 0 || tier0.slopLints.length > 0 || tier0.surfaceLints.length > 0 ? (
        <div
          className="rounded-[8px] border p-2.5 flex flex-col gap-1.5 text-xs"
          style={{
            backgroundColor: tier0.secretLints.length > 0 ? 'var(--lx-danger-bg)' : 'var(--lx-warn-bg)',
            borderColor: tier0.secretLints.length > 0 ? 'var(--lx-danger)' : 'var(--lx-warn)',
          }}
        >
          <div
            className="font-semibold"
            style={{ color: tier0.secretLints.length > 0 ? 'var(--lx-danger)' : 'var(--lx-warn)' }}
          >
            Tier 0 Checks ({tier0.secretLints.length + tier0.slopLints.length + tier0.surfaceLints.length})
          </div>
          {[...tier0.secretLints, ...tier0.slopLints, ...tier0.surfaceLints].map((lint, i) => (
            <div key={i} className="text-[11px]" style={{ color: 'var(--lx-fg)' }}>
              <span className="lexel-mono font-medium">[{lint.lint_kind_pretty}]</span>{' '}
              {lint.message_html}
            </div>
          ))}
        </div>
      ) : null}

      {text.trim() ? (
        (() => {
          const stats = computeReadabilityMetrics(text);
          return (
            <div
              className="rounded-[8px] border p-2.5 grid grid-cols-4 gap-2 text-[11px] lexel-mono"
              style={{
                backgroundColor: 'var(--lx-card)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg-muted)',
              }}
            >
              <div>
                <div className="text-[10px] uppercase">Words</div>
                <div className="text-xs font-semibold" style={{ color: 'var(--lx-fg)' }}>
                  {stats.words}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase">Grade</div>
                <div className="text-xs font-semibold" style={{ color: 'var(--lx-fg)' }}>
                  {stats.fleschKincaidGrade.toFixed(1)}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase">Ease</div>
                <div className="text-xs font-semibold" style={{ color: 'var(--lx-fg)' }}>
                  {stats.fleschReadingEase.toFixed(0)}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase">Long Sent.</div>
                <div
                  className="text-xs font-semibold"
                  style={{ color: stats.longSentences > 0 ? 'var(--lx-warn)' : 'var(--lx-fg)' }}
                >
                  {stats.longSentences}
                </div>
              </div>
            </div>
          );
        })()
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={async () => {
            if (!text.trim()) return;
            const res = (await chrome.runtime.sendMessage({
              kind: 'fixSafeIssues',
              text,
              surfaceId,
            })) as { result?: { text: string; fixesApplied: number } };
            if (res.result && res.result.fixesApplied > 0) {
              setUndoText(text);
              setText(res.result.text);
              setError(null);
            } else {
              setError('No safe deterministic slop, em dash, emoji, or hashtag fixes needed.');
            }
          }}
          className="rounded-[6px] border px-2.5 py-1.5 text-xs font-medium"
          style={{
            backgroundColor: 'var(--lx-card)',
            borderColor: 'var(--lx-signal)',
            color: 'var(--lx-signal)',
          }}
        >
          Fix Safe Slop
        </button>
        <button
          type="button"
          onClick={async () => {
            if (!text.trim()) return;
            const res = (await chrome.runtime.sendMessage({
              kind: 'fixAllSafe',
              text,
              surfaceId,
            })) as { result?: { text: string; fixesApplied: number } };
            if (res.result && res.result.fixesApplied > 0 && res.result.text !== text) {
              setUndoText(text);
              setText(res.result.text);
              setError(null);
            } else {
              setError('No deterministic slop, typography, or safe grammar fixes needed.');
            }
          }}
          className="rounded-[6px] border px-2.5 py-1.5 text-xs font-semibold"
          style={{
            backgroundColor: 'var(--lx-muted)',
            borderColor: 'var(--lx-border)',
            color: 'var(--lx-fg)',
          }}
        >
          Fix All Safe
        </button>
        <button
          type="button"
          onClick={async () => {
            if (!text.trim()) return;
            const res = (await chrome.runtime.sendMessage({
              kind: 'toTitleCase',
              text,
            })) as { text?: string };
            if (res.text && res.text !== text) {
              setUndoText(text);
              setText(res.text);
            }
          }}
          className="rounded-[6px] border px-2.5 py-1.5 text-xs font-medium"
          style={{
            backgroundColor: 'var(--lx-muted)',
            borderColor: 'var(--lx-border)',
            color: 'var(--lx-fg)',
          }}
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
            if (res.text && res.text !== text) {
              setUndoText(text);
              setText(res.text);
            }
          }}
          className="rounded-[6px] border px-2.5 py-1.5 text-xs font-medium"
          style={{
            backgroundColor: 'var(--lx-muted)',
            borderColor: 'var(--lx-border)',
            color: 'var(--lx-fg)',
          }}
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
            if (res.result && res.result.text !== text) {
              setUndoText(text);
              setText(res.result.text);
              setError(null);
            } else {
              setError('Quotes and spacing are already normalized.');
            }
          }}
          className="rounded-[6px] border px-2.5 py-1.5 text-xs font-medium"
          style={{
            backgroundColor: 'var(--lx-muted)',
            borderColor: 'var(--lx-border)',
            color: 'var(--lx-fg)',
          }}
        >
          Clean Quotes
        </button>
        {undoText != null ? (
          <button
            type="button"
            onClick={() => {
              setText(undoText);
              setUndoText(null);
            }}
            className="rounded-[6px] border px-2.5 py-1.5 text-xs font-medium"
            style={{
              backgroundColor: 'var(--lx-warn-bg)',
              borderColor: 'var(--lx-warn)',
              color: 'var(--lx-warn)',
            }}
          >
            Undo
          </button>
        ) : null}
      </div>

      <div
        className="rounded-[8px] border p-2.5 flex flex-col gap-2"
        style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
      >
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const q = synonymWord.trim();
            if (!q) return;
            setSynonymStatus('Searching...');
            void chrome.runtime
              .sendMessage({ kind: 'lookupSynonyms', word: q })
              .then((res: unknown) => {
                const payload = res as { ok?: boolean; synonyms?: string[]; error?: string };
                if (payload.ok) {
                  const list = payload.synonyms ?? [];
                  setSynonyms(list);
                  setSynonymStatus(list.length === 0 ? `No synonyms found for "${q}".` : null);
                } else {
                  setSynonyms([]);
                  setSynonymStatus(payload.error ?? 'Daemon offline.');
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
          <button
            type="submit"
            className="rounded-[6px] border px-2.5 py-1 text-xs font-medium"
            style={{
              backgroundColor: 'var(--lx-muted)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          >
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
                className="rounded-[4px] border px-2 py-0.5 text-[11px] lexel-mono"
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

      <button
        type="button"
        disabled={loading}
        onClick={() => void handleRewrite()}
        className="w-full rounded-[6px] px-3 py-2 text-xs font-semibold"
        style={{
          backgroundColor: 'var(--lx-accent)',
          color: 'var(--lx-on-accent)',
        }}
      >
        {loading ? 'Generating locally...' : 'Rewrite with Local AI'}
      </button>

      {error ? (
        <div
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

      {result ? (
        <RewriteDiffCard
          original={result.original}
          suggestion={result.suggestion}
          gates={result.gates}
          modelName={result.model}
          latencyMs={result.latencyMs}
          onApply={() => void handleApplyToPage()}
          onCopy={() => {
            void navigator.clipboard.writeText(result.suggestion);
            setCopied(true);
          }}
          onRetry={() => void handleRewrite()}
          onReject={() => setResult(null)}
          copied={copied}
        />
      ) : null}
    </div>
  );
}

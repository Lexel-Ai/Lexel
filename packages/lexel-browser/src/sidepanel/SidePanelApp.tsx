import {
  NibIcon,
  RewriteDiffCard,
  SlidersIcon,
  StatusPill,
  SurfaceBadge,
  ThemeToggle,
  type AiHealthState,
} from 'lexel-ui';
import React, { useEffect, useState } from 'react';
import type { LocalAiHealth } from '../shared/localAiClient';
import { getSurfaceProfile, SURFACE_PROFILES } from '../shared/surfaceDetector';
import type { AiSettings, AiTaskId, RewriteResult, SurfaceId } from '../shared/types';
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
  const [result, setResult] = useState<RewriteResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [aiHealth, setAiHealth] = useState<LocalAiHealth | null>(null);

  useEffect(() => {
    (async () => {
      const [themeRes, draftRes, aiRes, healthRes] = await Promise.all([
        chrome.runtime.sendMessage({ kind: 'getTheme' }) as Promise<{ theme: 'dark' | 'light' }>,
        chrome.runtime.sendMessage({ kind: 'getActiveDraft' }) as Promise<{
          draft: { text: string; surfaceId: SurfaceId; subcontext: string | null } | null;
        }>,
        chrome.runtime.sendMessage({ kind: 'getAiSettings' }) as Promise<{ settings: AiSettings }>,
        chrome.runtime.sendMessage({ kind: 'aiHealth' }) as Promise<LocalAiHealth>,
      ]);
      setTheme(themeRes.theme);
      setAiSettings(aiRes.settings);
      setAiHealth(healthRes);
      if (draftRes.draft) {
        setText(draftRes.draft.text);
        setSurfaceId(draftRes.draft.surfaceId);
        setSubcontext(draftRes.draft.subcontext);
      }
    })();
  }, []);

  const profile = getSurfaceProfile(surfaceId);
  const tier0 = text.trim() ? scanTier0Diagnostics(text, surfaceId) : { slopLints: [], surfaceLints: [] };

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
    : aiHealth?.ok
      ? 'ready'
      : 'error';

  return (
    <div data-theme={theme} className="lexel-root min-h-screen p-4 flex flex-col gap-3">
      <header className="flex items-center justify-between gap-2 pb-2 border-b" style={{ borderColor: 'var(--lx-border)' }}>
        <div className="flex items-center gap-2">
          <NibIcon className="w-5 h-5" />
          <h1 className="text-sm font-semibold m-0">Lexel Workbench</h1>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill state={aiState} label={aiHealth?.ok ? aiSettings?.model ?? 'Ready' : 'AI Offline'} />
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

      <div className="grid grid-cols-2 gap-2">
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
            {SURFACE_PROFILES.map((s) => (
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

      {(tier0.slopLints.length > 0 || tier0.surfaceLints.length > 0) ? (
        <div
          className="rounded-[8px] border p-2.5 flex flex-col gap-1.5 text-xs"
          style={{ backgroundColor: 'var(--lx-warn-bg)', borderColor: 'var(--lx-warn)' }}
        >
          <div className="font-semibold" style={{ color: 'var(--lx-warn)' }}>
            Tier 0 Checks ({tier0.slopLints.length + tier0.surfaceLints.length})
          </div>
          {[...tier0.slopLints, ...tier0.surfaceLints].map((lint, i) => (
            <div key={i} className="text-[11px]" style={{ color: 'var(--lx-fg)' }}>
              <span className="lexel-mono font-medium">[{lint.lint_kind_pretty}]</span>{' '}
              {lint.message_html}
            </div>
          ))}
        </div>
      ) : null}

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

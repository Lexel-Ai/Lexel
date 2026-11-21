import {
  BUILTIN_SURFACES,
  GitBranchIcon,
  PrivacyProofBadge,
  RefreshIcon,
  VoiceIcon,
} from 'lexel-ui';
import type React from 'react';
import { useMemo, useState } from 'react';
import {
  daemonRpc,
  importGitLogVoice,
  importVoiceSamples,
  isTauriRuntime,
} from '../lib/desktopClient';
import type {
  UnifiedDaemonSettings,
  VoiceExample,
  WeeklyInsightsReport,
  WritingStatsSummary,
} from '../lib/types';

interface InsightsVoicePaneProps {
  settings: UnifiedDaemonSettings;
  insights: WeeklyInsightsReport | null;
  writingStats: WritingStatsSummary | null;
  voiceExamples: VoiceExample[];
  onPatchSettings: (patch: Partial<UnifiedDaemonSettings>) => Promise<void>;
  onRefreshAll: () => Promise<void>;
  onRefreshInsights: (days: number) => Promise<void>;
  onOpenStudio: () => void;
}

function splitPastedSamples(raw: string): string[] {
  const byDivider = raw.includes('\n---') ? raw.split(/\n---+\n/g) : raw.split(/\n\s*\n/g);
  return byDivider.map((s) => s.trim()).filter((s) => s.length >= 12);
}

export function InsightsVoicePane({
  settings,
  insights,
  writingStats,
  voiceExamples,
  onPatchSettings,
  onRefreshAll,
  onRefreshInsights,
  onOpenStudio,
}: InsightsVoicePaneProps) {
  const [periodDays, setPeriodDays] = useState<7 | 30>(7);
  const [onboardingTab, setOnboardingTab] = useState<'paste' | 'git'>('paste');
  const [sampleSurfaceId, setSampleSurfaceId] = useState('web_email');
  const [sampleDraft, setSampleDraft] = useState('');
  const [gitRepoPath, setGitRepoPath] = useState('');
  const [gitAuthor, setGitAuthor] = useState('');
  const [gitLimit, setGitLimit] = useState(25);
  const [voiceFilterSurface, setVoiceFilterSurface] = useState('all');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsedSamples = useMemo(() => splitPastedSamples(sampleDraft), [sampleDraft]);

  const filteredVoiceExamples = useMemo(() => {
    if (voiceFilterSurface === 'all') return voiceExamples;
    return voiceExamples.filter((e) => e.surfaceId === voiceFilterSurface);
  }, [voiceExamples, voiceFilterSurface]);

  const bannedCrutchSet = useMemo(
    () => new Set((settings.crutchWords ?? []).map((w) => w.toLowerCase())),
    [settings.crutchWords],
  );

  const maxBucketChecks = useMemo(() => {
    const buckets = insights?.dailyBuckets ?? [];
    return Math.max(1, ...buckets.map((b) => b.checks));
  }, [insights]);

  async function handlePeriodChange(days: 7 | 30) {
    setPeriodDays(days);
    await onRefreshInsights(days);
  }

  async function handleToggleCrutchBan(word: string) {
    setError(null);
    const lower = word.toLowerCase();
    const currentCrutch = settings.crutchWords ?? [];
    const currentSlop = settings.customSlopTerms ?? [];
    const isBanned = bannedCrutchSet.has(lower);

    const nextCrutch = isBanned
      ? currentCrutch.filter((w) => w.toLowerCase() !== lower)
      : [...currentCrutch, word];
    const nextSlop = isBanned
      ? currentSlop.filter((t) => t.toLowerCase() !== lower)
      : currentSlop.some((t) => t.toLowerCase() === lower)
        ? currentSlop
        : [...currentSlop, word];

    await onPatchSettings({ crutchWords: nextCrutch, customSlopTerms: nextSlop });
    await onRefreshInsights(periodDays);
    setNotice(
      isBanned
        ? `Removed "${word}" from your personal crutch-word ban list.`
        : `Banned "${word}" across all surfaces.`,
    );
  }

  async function handleImportPastedSamples(e: React.FormEvent) {
    e.preventDefault();
    if (parsedSamples.length === 0) {
      setError(
        'Paste at least one writing sample (12+ characters, separated by blank lines or ---).',
      );
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const report = await importVoiceSamples(
        parsedSamples.map((text) => ({ surfaceId: sampleSurfaceId, text })),
        'paste',
      );
      setSampleDraft('');
      await onRefreshAll();
      setNotice(
        `Imported ${report.importedCount} voice sample${report.importedCount === 1 ? '' : 's'} into local Voice Memory${
          report.skippedSecretsCount > 0
            ? ` (${report.skippedSecretsCount} skipped due to detected secrets)`
            : ''
        }.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleImportGitLog(e: React.FormEvent) {
    e.preventDefault();
    const repoPath = gitRepoPath.trim();
    if (!repoPath) {
      setError('Enter the local path to a Git repository.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const report = await importGitLogVoice({
        repoPath,
        author: gitAuthor.trim() || undefined,
        limit: gitLimit,
      });
      await onRefreshAll();
      setNotice(
        `Imported ${report.importedCount} commit sample${report.importedCount === 1 ? '' : 's'} from ${report.repoPath}${
          report.skippedSecretsCount > 0
            ? ` (${report.skippedSecretsCount} skipped by Secrets Guard)`
            : ''
        }.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleExportSimpo() {
    setError(null);
    setNotice(null);
    try {
      const res = await daemonRpc<{ pairs?: unknown[] }>('exportSimpo', {});
      const pairs = Array.isArray(res) ? res : (res.pairs ?? []);
      if (pairs.length === 0) {
        setNotice(
          'No edited or rejected rewrites available yet. Use Hunk Diff edits in Studio to build personal preference pairs.',
        );
        return;
      }
      const jsonl = pairs.map((row) => JSON.stringify(row)).join('\n');
      const blob = new Blob([`${jsonl}\n`], { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'lexel-personal-simpo.jsonl';
      link.click();
      URL.revokeObjectURL(url);
      setNotice(`Exported ${pairs.length} PII-scrubbed SimPO preference pair(s).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const totalChecks = insights?.checksInPeriod ?? writingStats?.totalChecks ?? 0;
  const totalWords = insights?.wordsInPeriod ?? writingStats?.totalWordsChecked ?? 0;
  const totalSlop = insights?.slopCaughtInPeriod ?? writingStats?.totalSlopHits ?? 0;
  const totalFixes = insights?.fixesAppliedInPeriod ?? writingStats?.totalFixesApplied ?? 0;
  const totalSecrets = insights?.secretsBlockedInPeriod ?? writingStats?.totalSecretBlocks ?? 0;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.02em]">
            Voice Memory &amp; Private Weekly Insights
          </h1>
          <p className="mt-0.5 text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
            Seed your writing style locally and review private counters stored only in SQLite on
            this machine.
          </p>
        </div>
        <PrivacyProofBadge
          localOnly={isTauriRuntime()}
          blockedSecretsCount={writingStats?.totalSecretBlocks ?? totalSecrets}
          redactEnabled={Boolean(settings.redactSecrets)}
        />
      </header>

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

      {/* Section 1: Private Weekly Insights */}
      <section
        aria-label="Private Weekly Insights"
        className="space-y-4 rounded-[8px] border p-4"
        style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-[14px] font-semibold">Private Weekly Insights</h2>
            <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
              Counts only. Raw drafts are never logged or transmitted off-device.
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            {([7, 30] as const).map((days) => (
              <button
                key={days}
                type="button"
                aria-pressed={periodDays === days}
                onClick={() => void handlePeriodChange(days)}
                className="lx-pressable rounded-[6px] border px-2.5 py-1 text-[11px] font-medium lexel-mono"
                style={{
                  backgroundColor: periodDays === days ? 'var(--lx-accent)' : 'var(--lx-surface)',
                  borderColor: periodDays === days ? 'var(--lx-accent)' : 'var(--lx-border)',
                  color: periodDays === days ? 'var(--lx-on-accent)' : 'var(--lx-fg)',
                }}
              >
                {days}d
              </button>
            ))}
            <button
              type="button"
              onClick={() => void onRefreshInsights(periodDays)}
              aria-label="Refresh weekly insights"
              className="lx-pressable lx-btn-secondary inline-flex h-7 w-7 items-center justify-center"
            >
              <RefreshIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {totalChecks === 0 ? (
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-[6px] border p-4"
            style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
          >
            <div className="space-y-0.5">
              <div className="text-[13px] font-medium">
                No checks recorded in the last {periodDays} days
              </div>
              <p className="m-0 text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
                Run a grammar or slop check in Studio to populate your local writing counters and
                crutch-word breakdown.
              </p>
            </div>
            <button
              type="button"
              onClick={onOpenStudio}
              className="lx-pressable lx-btn-primary px-3 py-1.5 text-[12px] font-semibold"
            >
              Open Studio
            </button>
          </div>
        ) : (
          <>
            <div className="grid gap-2.5 sm:grid-cols-4 lexel-mono lx-tab-nums">
              <div
                className="rounded-[6px] border p-3"
                style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
              >
                <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                  Words checked
                </div>
                <div className="mt-1 text-[18px] font-semibold">{totalWords.toLocaleString()}</div>
                <div className="text-[10px]" style={{ color: 'var(--lx-fg-muted)' }}>
                  {totalChecks} checks run
                </div>
              </div>

              <div
                className="rounded-[6px] border p-3"
                style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
              >
                <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                  AI slop caught
                </div>
                <div className="mt-1 text-[18px] font-semibold" style={{ color: 'var(--lx-warn)' }}>
                  {totalSlop}
                </div>
                <div className="text-[10px]" style={{ color: 'var(--lx-fg-muted)' }}>
                  {insights?.grammarHitsInPeriod ?? writingStats?.totalGrammarHits ?? 0} grammar
                  hits
                </div>
              </div>

              <div
                className="rounded-[6px] border p-3"
                style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
              >
                <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                  Safe fixes applied
                </div>
                <div className="mt-1 text-[18px] font-semibold" style={{ color: 'var(--lx-ok)' }}>
                  {totalFixes}
                </div>
                <div className="text-[10px]" style={{ color: 'var(--lx-fg-muted)' }}>
                  {insights?.clarityScore !== null && insights?.clarityScore !== undefined
                    ? `Clarity ${insights.clarityScore.toFixed(0)}/100`
                    : 'Tier 0 + verified edits'}
                </div>
              </div>

              <div
                className="rounded-[6px] border p-3"
                style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
              >
                <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                  Secrets blocked
                </div>
                <div
                  className="mt-1 text-[18px] font-semibold"
                  style={{ color: 'var(--lx-signal)' }}
                >
                  {totalSecrets}
                </div>
                <div className="text-[10px]" style={{ color: 'var(--lx-fg-muted)' }}>
                  0 bytes sent off-device
                </div>
              </div>
            </div>

            {(insights?.dailyBuckets ?? []).length > 0 ? (
              <div
                className="rounded-[6px] border p-3"
                style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
              >
                <div className="mb-2 text-[12px] font-medium">
                  Checks and fixes per day, last {periodDays} days
                </div>
                <div className="space-y-1.5 lexel-mono lx-tab-nums text-[11px]">
                  {(insights?.dailyBuckets ?? []).map((b) => {
                    const widthPct = Math.max(4, Math.round((b.checks / maxBucketChecks) * 100));
                    return (
                      <div
                        key={b.day}
                        className="grid grid-cols-[88px_1fr_110px] items-center gap-2"
                      >
                        <span style={{ color: 'var(--lx-fg-muted)' }}>{b.day}</span>
                        <div
                          className="h-2 overflow-hidden rounded-[4px]"
                          style={{ backgroundColor: 'var(--lx-muted)' }}
                        >
                          <div
                            className="h-full"
                            style={{
                              width: `${widthPct}%`,
                              backgroundColor: 'var(--lx-signal)',
                            }}
                          />
                        </div>
                        <span className="text-right" style={{ color: 'var(--lx-fg-muted)' }}>
                          {b.checks} chk · {b.fixesApplied} fix
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="grid gap-3 md:grid-cols-2">
              <div
                className="space-y-2 rounded-[6px] border p-3"
                style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
              >
                <div className="text-[12px] font-semibold">Top Crutch Words</div>
                {(insights?.topCrutchWords ?? []).length === 0 ? (
                  <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
                    No repeated crutch words recorded in this period yet.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {(insights?.topCrutchWords ?? []).slice(0, 5).map((item) => {
                      const banned = item.banned || bannedCrutchSet.has(item.word.toLowerCase());
                      return (
                        <div
                          key={item.word}
                          className="flex items-center justify-between gap-2 rounded-[4px] border px-2.5 py-1.5 text-[12px]"
                          style={{
                            backgroundColor: 'var(--lx-card)',
                            borderColor: 'var(--lx-border)',
                          }}
                        >
                          <span className="lexel-mono lx-tab-nums">
                            <strong>{item.word}</strong>{' '}
                            <span style={{ color: 'var(--lx-fg-muted)' }}>({item.count}x)</span>
                          </span>
                          <button
                            type="button"
                            onClick={() => void handleToggleCrutchBan(item.word)}
                            className="lx-pressable rounded-[4px] border px-2 py-0.5 text-[11px] font-medium"
                            style={{
                              backgroundColor: banned ? 'var(--lx-warn-bg)' : 'var(--lx-muted)',
                              borderColor: banned ? 'var(--lx-warn)' : 'var(--lx-border)',
                              color: banned ? 'var(--lx-warn)' : 'var(--lx-fg)',
                            }}
                          >
                            {banned ? 'Banned (Undo)' : 'Ban word'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div
                className="space-y-2 rounded-[6px] border p-3"
                style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
              >
                <div className="text-[12px] font-semibold">Top Slop Patterns Caught</div>
                {(insights?.topSlopPatterns ?? []).length === 0 ? (
                  <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
                    No AI slop terms flagged in this window yet.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {(insights?.topSlopPatterns ?? []).map((pat) => (
                      <span
                        key={pat.term}
                        className="rounded-[4px] border px-2 py-1 text-[11px] lexel-mono lx-tab-nums"
                        style={{
                          backgroundColor: 'var(--lx-card)',
                          borderColor: 'var(--lx-border)',
                          color: 'var(--lx-fg)',
                        }}
                      >
                        {pat.term} · {pat.count}x
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </section>

      {/* Section 2: Clone My Voice Onboarding */}
      <section
        aria-label="Clone My Voice onboarding"
        className="space-y-3 rounded-[8px] border p-4"
        style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-[14px] font-semibold">Clone My Voice</h2>
            <p className="mt-0.5 text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
              Seed local Voice Memory in 10 seconds with 3 to 10 past messages or your own local Git
              commit history. Secrets are filtered out automatically.
            </p>
          </div>
          <div role="tablist" aria-label="Voice import method" className="flex gap-1.5">
            <button
              type="button"
              role="tab"
              aria-selected={onboardingTab === 'paste'}
              onClick={() => setOnboardingTab('paste')}
              className="lx-pressable inline-flex items-center gap-1.5 rounded-[6px] border px-2.5 py-1 text-[12px] font-medium"
              style={{
                backgroundColor:
                  onboardingTab === 'paste' ? 'var(--lx-accent)' : 'var(--lx-surface)',
                borderColor: onboardingTab === 'paste' ? 'var(--lx-accent)' : 'var(--lx-border)',
                color: onboardingTab === 'paste' ? 'var(--lx-on-accent)' : 'var(--lx-fg)',
              }}
            >
              <VoiceIcon className="h-3.5 w-3.5" />
              <span>Paste Samples</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={onboardingTab === 'git'}
              onClick={() => setOnboardingTab('git')}
              className="lx-pressable inline-flex items-center gap-1.5 rounded-[6px] border px-2.5 py-1 text-[12px] font-medium"
              style={{
                backgroundColor: onboardingTab === 'git' ? 'var(--lx-accent)' : 'var(--lx-surface)',
                borderColor: onboardingTab === 'git' ? 'var(--lx-accent)' : 'var(--lx-border)',
                color: onboardingTab === 'git' ? 'var(--lx-on-accent)' : 'var(--lx-fg)',
              }}
            >
              <GitBranchIcon className="h-3.5 w-3.5" />
              <span>Import Git Log</span>
            </button>
          </div>
        </div>

        {onboardingTab === 'paste' ? (
          <form onSubmit={handleImportPastedSamples} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[240px_1fr]">
              <div>
                <label
                  htmlFor="voice-sample-surface"
                  className="mb-1 block text-[11px] font-medium"
                  style={{ color: 'var(--lx-fg-muted)' }}
                >
                  Surface for these samples
                </label>
                <select
                  id="voice-sample-surface"
                  value={sampleSurfaceId}
                  onChange={(e) => setSampleSurfaceId(e.target.value)}
                  className="w-full rounded-[6px] border px-2.5 py-1.5 text-[12px]"
                  style={{
                    backgroundColor: 'var(--lx-surface)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                >
                  {BUILTIN_SURFACES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
              <div
                className="flex items-end text-[11px] lexel-mono lx-tab-nums"
                style={{ color: 'var(--lx-fg-muted)' }}
              >
                Detected {parsedSamples.length} sample{parsedSamples.length === 1 ? '' : 's'} ready
                to import (separate entries with a blank line or ---)
              </div>
            </div>

            <div>
              <label
                htmlFor="voice-samples-textarea"
                className="mb-1 block text-[11px] font-medium"
                style={{ color: 'var(--lx-fg-muted)' }}
              >
                Your writing samples
              </label>
              <textarea
                id="voice-samples-textarea"
                rows={5}
                value={sampleDraft}
                onChange={(e) => setSampleDraft(e.target.value)}
                placeholder={
                  'Paste 3 to 10 past emails, Slack messages, or PR comments separated by blank lines...'
                }
                className="w-full rounded-[6px] border p-3 text-[13px] leading-relaxed"
                style={{
                  backgroundColor: 'var(--lx-bg)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                Used as local few-shot voice retrieval for {sampleSurfaceId} rewrites.
              </span>
              <button
                type="submit"
                disabled={busy || parsedSamples.length === 0}
                className="lx-pressable lx-btn-primary px-3.5 py-1.5 text-[12px] font-semibold"
              >
                {busy
                  ? 'Importing...'
                  : `Import ${parsedSamples.length || ''} Sample${parsedSamples.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleImportGitLog} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label
                  htmlFor="git-repo-path"
                  className="mb-1 block text-[11px] font-medium"
                  style={{ color: 'var(--lx-fg-muted)' }}
                >
                  Local Git repository path
                </label>
                <input
                  id="git-repo-path"
                  type="text"
                  value={gitRepoPath}
                  onChange={(e) => setGitRepoPath(e.target.value)}
                  placeholder="/path/to/your/repository"
                  className="w-full rounded-[6px] border px-2.5 py-1.5 text-[12px] lexel-mono"
                  style={{
                    backgroundColor: 'var(--lx-surface)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
              </div>
              <div>
                <label
                  htmlFor="git-author-filter"
                  className="mb-1 block text-[11px] font-medium"
                  style={{ color: 'var(--lx-fg-muted)' }}
                >
                  Author filter (optional)
                </label>
                <input
                  id="git-author-filter"
                  type="text"
                  value={gitAuthor}
                  onChange={(e) => setGitAuthor(e.target.value)}
                  placeholder="your.email@domain.com"
                  className="w-full rounded-[6px] border px-2.5 py-1.5 text-[12px]"
                  style={{
                    backgroundColor: 'var(--lx-surface)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="inline-flex items-center gap-2 text-[12px]">
                <span style={{ color: 'var(--lx-fg-muted)' }}>Max commits</span>
                <input
                  type="number"
                  min={5}
                  max={100}
                  value={gitLimit}
                  onChange={(e) =>
                    setGitLimit(
                      Math.max(5, Math.min(100, Number.parseInt(e.target.value || '25', 10))),
                    )
                  }
                  className="w-20 rounded-[6px] border px-2 py-1 text-[12px] lexel-mono"
                  style={{
                    backgroundColor: 'var(--lx-surface)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
              </label>
              <button
                type="submit"
                disabled={busy || !gitRepoPath.trim()}
                className="lx-pressable lx-btn-primary px-3.5 py-1.5 text-[12px] font-semibold"
              >
                {busy ? 'Reading git log...' : 'Import Commits into Voice Memory'}
              </button>
            </div>
          </form>
        )}
      </section>

      {/* Section 3: Saved Voice Memory + SimPO Export */}
      <section
        aria-label="Saved Voice Memory"
        className="space-y-3 rounded-[8px] border p-4"
        style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-[14px] font-semibold">
              Saved Voice Memory ({filteredVoiceExamples.length})
            </h2>
            <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
              Kept rewrites, hunk edits, and imported samples stored locally in lexel.db.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Filter voice memory by surface"
              value={voiceFilterSurface}
              onChange={(e) => setVoiceFilterSurface(e.target.value)}
              className="rounded-[6px] border px-2 py-1 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              <option value="all">All surfaces</option>
              {BUILTIN_SURFACES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void handleExportSimpo()}
              className="lx-pressable lx-btn-secondary px-2.5 py-1 text-[12px] font-medium"
            >
              Export SimPO JSONL
            </button>
          </div>
        </div>

        {filteredVoiceExamples.length === 0 ? (
          <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
            No saved voice examples for this filter yet. Paste samples above or apply a rewrite in
            Studio to start building local voice memory.
          </p>
        ) : (
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {filteredVoiceExamples.map((ex) => (
              <div
                key={ex.id}
                className="flex items-start justify-between gap-3 rounded-[6px] border p-2.5 text-[12px]"
                style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] lexel-mono">
                    <span style={{ color: 'var(--lx-signal)' }}>{ex.surfaceId}</span>
                    {ex.subcontext ? (
                      <span style={{ color: 'var(--lx-fg-muted)' }}>/ {ex.subcontext}</span>
                    ) : null}
                    <span
                      className="rounded-[4px] border px-1.5 py-0.2 text-[10px]"
                      style={{ borderColor: 'var(--lx-border)', color: 'var(--lx-fg-muted)' }}
                    >
                      {ex.action}
                    </span>
                  </div>
                  <div className="whitespace-pre-wrap leading-snug">{ex.rewritten}</div>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    await daemonRpc('deleteVoiceExample', { id: ex.id });
                    await onRefreshAll();
                  }}
                  className="lx-pressable shrink-0 rounded-[4px] border px-2 py-0.5 text-[11px]"
                  style={{
                    backgroundColor: 'var(--lx-card)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-danger)',
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

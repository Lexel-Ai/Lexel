import {
  type AiHealthState,
  InsightsIcon,
  LexelLogo,
  PrivacyProofBadge,
  ShieldIcon,
  SlidersIcon,
  StatusPill,
  SurfacesIcon,
  SystemIcon,
  ThemeToggle,
  UndoToast,
} from 'lexel-ui';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { InsightsVoicePane } from './components/InsightsVoicePane';
import { RulesPane } from './components/RulesPane';
import { StudioPane } from './components/StudioPane';
import { SurfacesPane } from './components/SurfacesPane';
import { SystemSyncPane } from './components/SystemSyncPane';
import {
  daemonRpc,
  getDesktopEnvInfo,
  getDoctorReport,
  getNativeHostStatus,
  getOsOverlayCapabilities,
  getWeeklyInsights,
  isTauriRuntime,
  subscribeToClipboardDraft,
  subscribeToRewriteBeforePaste,
  subscribeToStateChanges,
  writeClipboardText,
} from './lib/desktopClient';
import type {
  DaemonStatusPayload,
  DesktopEnvInfo,
  DesktopTabId,
  DoctorReportData,
  HarperRulesPayload,
  NativeHostStatusReport,
  OsOverlayCapabilities,
  UnifiedDaemonSettings,
  VoiceExample,
  WeeklyInsightsReport,
  WritingStatsSummary,
} from './lib/types';

interface UndoToastState {
  open: boolean;
  message: string;
  undoLabel: string;
  onUndo: () => void;
}

export function App() {
  const [tab, setTab] = useState<DesktopTabId>('studio');
  const [status, setStatus] = useState<DaemonStatusPayload | null>(null);
  const [harperRules, setHarperRules] = useState<HarperRulesPayload | null>(null);
  const [envInfo, setEnvInfo] = useState<DesktopEnvInfo | null>(null);
  const [nativeStatus, setNativeStatus] = useState<NativeHostStatusReport | null>(null);
  const [osOverlay, setOsOverlay] = useState<OsOverlayCapabilities | null>(null);
  const [writingStats, setWritingStats] = useState<WritingStatsSummary | null>(null);
  const [weeklyInsights, setWeeklyInsights] = useState<WeeklyInsightsReport | null>(null);
  const [doctorReport, setDoctorReport] = useState<DoctorReportData | null>(null);
  const [doctorLoading, setDoctorLoading] = useState(false);
  const [doctorError, setDoctorError] = useState<string | null>(null);
  const [incomingDraft, setIncomingDraft] = useState<{ text: string; seq: number } | null>(null);
  const [voiceExamples, setVoiceExamples] = useState<VoiceExample[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [undoToast, setUndoToast] = useState<UndoToastState | null>(null);

  const triggerUndoToast = useCallback(
    (message: string, onUndo: () => void, undoLabel = 'Revert to original') => {
      setUndoToast({ open: true, message, onUndo, undoLabel });
    },
    [],
  );

  const dismissUndoToast = useCallback(() => {
    setUndoToast((prev) => (prev ? { ...prev, open: false } : null));
  }, []);

  const refreshRules = useCallback(async () => {
    const [nextStatus, nextRules] = await Promise.all([
      daemonRpc<DaemonStatusPayload>('status'),
      daemonRpc<HarperRulesPayload>('harperRules'),
    ]);
    setStatus(nextStatus);
    setHarperRules(nextRules);
  }, []);

  const runDoctorCheck = useCallback(async (bench = false) => {
    setDoctorLoading(true);
    setDoctorError(null);
    try {
      const report = await getDoctorReport(bench);
      setDoctorReport(report);
    } catch (err) {
      setDoctorError(err instanceof Error ? err.message : String(err));
    } finally {
      setDoctorLoading(false);
    }
  }, []);

  const refreshInsights = useCallback(async (days = 7) => {
    try {
      const next = await getWeeklyInsights(days);
      setWeeklyInsights(next);
    } catch {
      // Non-fatal; fallback stays null until next refresh.
    }
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      const [
        nextStatus,
        nextRules,
        nextEnv,
        nextNative,
        nextVoice,
        nextStats,
        nextOverlay,
        nextInsights,
      ] = await Promise.all([
        daemonRpc<DaemonStatusPayload>('status'),
        daemonRpc<HarperRulesPayload>('harperRules'),
        getDesktopEnvInfo(),
        getNativeHostStatus(),
        daemonRpc<{ examples: VoiceExample[] }>('listVoiceExamples', {}),
        daemonRpc<WritingStatsSummary>('writingStats', {}),
        getOsOverlayCapabilities(),
        getWeeklyInsights(7),
      ]);
      setStatus(nextStatus);
      setHarperRules(nextRules);
      setEnvInfo(nextEnv);
      setNativeStatus(nextNative);
      setVoiceExamples(nextVoice.examples);
      setWritingStats(nextStats);
      setOsOverlay(nextOverlay);
      setWeeklyInsights(nextInsights);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshAll();
    void runDoctorCheck(false);
  }, [refreshAll, runDoctorCheck]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    let unlistenClipboard: (() => void) | null = null;
    let unlistenRewritePaste: (() => void) | null = null;

    void subscribeToStateChanges(() => {
      if (active) {
        void refreshAll();
      }
    }).then((fn) => {
      if (active) unlisten = fn;
      else fn();
    });

    void subscribeToClipboardDraft((text) => {
      if (active && text.trim()) {
        setTab('studio');
        setIncomingDraft({ text, seq: Date.now() });
      }
    }).then((fn) => {
      if (active) unlistenClipboard = fn;
      else fn();
    });

    void subscribeToRewriteBeforePaste((report) => {
      if (!active) return;
      if (report.secretsBlocked > 0) {
        triggerUndoToast(
          `Rewrite Before Paste blocked (${report.secretsBlocked} secret match).`,
          () => {
            setTab('studio');
            setIncomingDraft({ text: report.original, seq: Date.now() });
            dismissUndoToast();
          },
          'Inspect in Studio',
        );
      } else if (report.rewritten && report.rewritten !== report.original) {
        const appLabel = report.detectedApp ? ` for ${report.detectedApp}` : '';
        triggerUndoToast(
          `Rewrote clipboard (${report.surfaceId}${appLabel})${report.pastedAutomatically ? ' and pasted' : ''}.`,
          () => {
            void writeClipboardText(report.original);
            dismissUndoToast();
          },
          'Restore clipboard',
        );
      }
      void refreshAll();
    }).then((fn) => {
      if (active) unlistenRewritePaste = fn;
      else fn();
    });

    const onFocus = () => {
      void refreshAll();
    };
    window.addEventListener('focus', onFocus);

    return () => {
      active = false;
      window.removeEventListener('focus', onFocus);
      unlisten?.();
      unlistenClipboard?.();
      unlistenRewritePaste?.();
    };
  }, [refreshAll, triggerUndoToast, dismissUndoToast]);

  const theme = status?.activeProfile.settings.theme ?? 'dark';

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  async function handlePatchSettings(patch: Partial<UnifiedDaemonSettings>) {
    try {
      await daemonRpc('patchSettings', { patch });
      await refreshAll();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSwitchProfile(profileId: string) {
    try {
      await daemonRpc('switchProfile', { profileId });
      await refreshAll();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  const aiState: AiHealthState = !status
    ? 'loading'
    : !status.activeProfile.settings.aiEnabled
      ? 'offline'
      : status.runtime.modelLoaded ||
          status.runtime.ollamaRunning ||
          status.runtime.llamaServerAvailable ||
          !isTauriRuntime()
        ? 'ready'
        : 'offline';

  const aiLabel = !status
    ? 'Loading...'
    : !status.activeProfile.settings.aiEnabled
      ? 'AI Disabled'
      : status.runtime.loadedModel
        ? `AI Ready (${status.runtime.loadedModel})`
        : isTauriRuntime()
          ? `AI Idle (${status.activeProfile.settings.mainModelTier})`
          : 'Browser Preview';

  const navItems: ReadonlyArray<{ id: DesktopTabId; label: string; icon: React.ReactNode }> = [
    { id: 'studio', label: 'Studio', icon: <SlidersIcon className="h-4 w-4 shrink-0" /> },
    {
      id: 'insights',
      label: 'Voice & Insights',
      icon: <InsightsIcon className="h-4 w-4 shrink-0" />,
    },
    {
      id: 'surfaces',
      label: 'Surfaces & Snippets',
      icon: <SurfacesIcon className="h-4 w-4 shrink-0" />,
    },
    { id: 'rules', label: 'Rules & Privacy', icon: <ShieldIcon className="h-4 w-4 shrink-0" /> },
    { id: 'system', label: 'System & Doctor', icon: <SystemIcon className="h-4 w-4 shrink-0" /> },
  ];

  return (
    <div className="lexel-root flex min-h-screen flex-col">
      <header
        className="sticky top-0 z-30 flex min-h-12 flex-wrap items-center justify-between gap-2 border-b px-4 py-1.5"
        style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
      >
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-2">
            <LexelLogo className="h-6 w-auto" />
            <span className="text-[14px] font-semibold tracking-[-0.015em]">Lexel</span>
          </div>
          <StatusPill state={aiState} label={aiLabel} />
          <PrivacyProofBadge
            localOnly={isTauriRuntime() || Boolean(doctorReport?.privacyProof.localOnlyVerified)}
            blockedSecretsCount={writingStats?.totalSecretBlocks}
            redactEnabled={Boolean(status?.activeProfile.settings.redactSecrets)}
            compact
          />
        </div>

        <div className="flex items-center gap-2">
          {status ? (
            <select
              aria-label="Active profile"
              value={status.activeProfile.id}
              onChange={(e) => void handleSwitchProfile(e.target.value)}
              className="rounded-[6px] border px-2 py-1 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-card)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              {status.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  Profile: {profile.name}
                </option>
              ))}
            </select>
          ) : null}
          <ThemeToggle
            theme={theme}
            onToggle={() =>
              void handlePatchSettings({ theme: theme === 'dark' ? 'light' : 'dark' })
            }
          />
        </div>
      </header>

      <div className="flex flex-1 flex-col md:flex-row">
        <aside
          className="flex w-full shrink-0 flex-row gap-1 overflow-x-auto border-b p-2 md:sticky md:top-12 md:h-[calc(100vh-3rem)] md:w-56 md:flex-col md:overflow-x-visible md:border-r md:border-b-0 md:p-3"
          style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
        >
          <nav aria-label="Desktop sections" className="flex flex-1 flex-row gap-1 md:flex-col">
            {navItems.map((item) => {
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setTab(item.id)}
                  className="lx-pressable flex min-h-[44px] shrink-0 items-center gap-2.5 rounded-[6px] px-3 py-2 text-left text-[13px] font-medium md:min-h-0 md:py-2"
                  style={{
                    backgroundColor: active ? 'var(--lx-accent)' : 'transparent',
                    color: active ? 'var(--lx-on-accent)' : 'var(--lx-fg)',
                  }}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>

          {envInfo ? (
            <div
              className="hidden space-y-1 border-t pt-3 text-[11px] lexel-mono lx-tab-nums md:block"
              style={{ borderColor: 'var(--lx-border)', color: 'var(--lx-fg-muted)' }}
            >
              <div className="flex items-center justify-between">
                <span>Runtime</span>
                <span style={{ color: 'var(--lx-fg)' }}>
                  {envInfo.platform}/{envInfo.arch}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>Grammar rules</span>
                <span style={{ color: 'var(--lx-fg)' }}>{harperRules?.rules.length ?? 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Voice samples</span>
                <span style={{ color: 'var(--lx-fg)' }}>{voiceExamples.length}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Tier 0</span>
                <span style={{ color: 'var(--lx-ok)' }}>
                  {doctorReport?.tier0LatencyMs !== null &&
                  doctorReport?.tier0LatencyMs !== undefined
                    ? `${doctorReport.tier0LatencyMs.toFixed(2)}ms`
                    : '<5ms'}
                </span>
              </div>
            </div>
          ) : null}
        </aside>

        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          <div className="mx-auto max-w-6xl">
            {loadError ? (
              <div
                role="alert"
                className="rounded-[8px] border p-4 text-[13px]"
                style={{
                  backgroundColor: 'var(--lx-danger-bg)',
                  borderColor: 'var(--lx-danger)',
                  color: 'var(--lx-danger)',
                }}
              >
                <div className="font-semibold">Failed to load Lexel local profile</div>
                <div className="mt-1">{loadError}</div>
                <button
                  type="button"
                  onClick={() => void refreshAll()}
                  className="lx-pressable lx-btn-secondary mt-3 px-3 py-1 text-[12px]"
                >
                  Retry
                </button>
              </div>
            ) : !status ? (
              <p className="text-[13px]" style={{ color: 'var(--lx-fg-muted)' }}>
                Loading Lexel Desktop workspace...
              </p>
            ) : tab === 'studio' ? (
              <StudioPane
                settings={status.activeProfile.settings}
                incomingDraft={incomingDraft}
                onPatchSettings={handlePatchSettings}
                onRefreshStatus={refreshAll}
                onTriggerUndoToast={triggerUndoToast}
                onOpenVoiceOnboarding={() => setTab('insights')}
              />
            ) : tab === 'insights' ? (
              <InsightsVoicePane
                settings={status.activeProfile.settings}
                insights={weeklyInsights}
                writingStats={writingStats}
                voiceExamples={voiceExamples}
                onPatchSettings={handlePatchSettings}
                onRefreshAll={refreshAll}
                onRefreshInsights={refreshInsights}
                onOpenStudio={() => setTab('studio')}
              />
            ) : tab === 'surfaces' ? (
              <SurfacesPane
                settings={status.activeProfile.settings}
                onPatchSettings={handlePatchSettings}
              />
            ) : tab === 'rules' ? (
              <RulesPane
                settings={status.activeProfile.settings}
                harperRules={harperRules}
                onPatchSettings={handlePatchSettings}
                onRefreshRules={refreshRules}
              />
            ) : (
              <SystemSyncPane
                status={status}
                envInfo={envInfo}
                nativeStatus={nativeStatus}
                osOverlay={osOverlay}
                writingStats={writingStats}
                doctorReport={doctorReport}
                doctorLoading={doctorLoading}
                doctorError={doctorError}
                onRunDoctor={runDoctorCheck}
                onPatchSettings={handlePatchSettings}
                onRefreshAll={refreshAll}
              />
            )}
          </div>
        </main>
      </div>

      {undoToast ? (
        <UndoToast
          open={undoToast.open}
          message={undoToast.message}
          undoLabel={undoToast.undoLabel}
          onUndo={() => {
            undoToast.onUndo();
            dismissUndoToast();
          }}
          onDismiss={dismissUndoToast}
        />
      ) : null}
    </div>
  );
}

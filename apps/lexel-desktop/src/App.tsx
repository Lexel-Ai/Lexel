import { NibIcon, StatusPill, ThemeToggle, type AiHealthState } from 'lexel-ui';
import { Globe, Layers, ShieldCheck, Sliders } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { RulesPane } from './components/RulesPane';
import { StudioPane } from './components/StudioPane';
import { SurfacesPane } from './components/SurfacesPane';
import { SystemSyncPane } from './components/SystemSyncPane';
import {
  daemonRpc,
  getDesktopEnvInfo,
  getNativeHostStatus,
  isTauriRuntime,
  subscribeToStateChanges,
} from './lib/desktopClient';
import type {
  DaemonStatusPayload,
  DesktopEnvInfo,
  DesktopTabId,
  HarperRulesPayload,
  NativeHostStatusReport,
  UnifiedDaemonSettings,
  VoiceExample,
} from './lib/types';

export function App() {
  const [tab, setTab] = useState<DesktopTabId>('studio');
  const [status, setStatus] = useState<DaemonStatusPayload | null>(null);
  const [harperRules, setHarperRules] = useState<HarperRulesPayload | null>(null);
  const [envInfo, setEnvInfo] = useState<DesktopEnvInfo | null>(null);
  const [nativeStatus, setNativeStatus] = useState<NativeHostStatusReport | null>(null);
  const [voiceExamples, setVoiceExamples] = useState<VoiceExample[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refreshRules = useCallback(async () => {
    const [nextStatus, nextRules] = await Promise.all([
      daemonRpc<DaemonStatusPayload>('status'),
      daemonRpc<HarperRulesPayload>('harperRules'),
    ]);
    setStatus(nextStatus);
    setHarperRules(nextRules);
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      const [nextStatus, nextRules, nextEnv, nextNative, nextVoice] = await Promise.all([
        daemonRpc<DaemonStatusPayload>('status'),
        daemonRpc<HarperRulesPayload>('harperRules'),
        getDesktopEnvInfo(),
        getNativeHostStatus(),
        daemonRpc<{ examples: VoiceExample[] }>('listVoiceExamples', {}),
      ]);
      setStatus(nextStatus);
      setHarperRules(nextRules);
      setEnvInfo(nextEnv);
      setNativeStatus(nextNative);
      setVoiceExamples(nextVoice.examples);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    void subscribeToStateChanges(() => {
      if (active) {
        void refreshAll();
      }
    }).then((fn) => {
      if (active) {
        unlisten = fn;
      } else {
        fn();
      }
    });

    const onFocus = () => {
      void refreshAll();
    };
    window.addEventListener('focus', onFocus);

    return () => {
      active = false;
      window.removeEventListener('focus', onFocus);
      unlisten?.();
    };
  }, [refreshAll]);

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
    { id: 'studio', label: 'Quick Rewrite', icon: <Sliders className="h-4 w-4" /> },
    { id: 'surfaces', label: 'Surfaces & Prompts', icon: <Globe className="h-4 w-4" /> },
    { id: 'rules', label: 'Grammar & Slop', icon: <ShieldCheck className="h-4 w-4" /> },
    { id: 'system', label: 'AI & Extension Sync', icon: <Layers className="h-4 w-4" /> },
  ];

  return (
    <div className="lexel-root flex min-h-screen flex-col">
      <header
        className="flex h-12 items-center justify-between border-b px-4"
        style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
      >
        <div className="flex items-center gap-2.5">
          <NibIcon />
          <span className="text-[14px] font-semibold tracking-[-0.01em]">Lexel Desktop</span>
          <StatusPill state={aiState} label={aiLabel} />
        </div>

        <div className="flex items-center gap-2">
          {status && (
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
          )}
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
          className="flex w-full shrink-0 flex-row gap-1 border-b p-2 md:w-56 md:flex-col md:border-r md:border-b-0 md:p-3"
          style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
        >
          <nav aria-label="Desktop sections" className="flex flex-1 flex-row gap-1 md:flex-col">
            {navItems.map((item) => {
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className="flex items-center gap-2 rounded-[6px] px-2.5 py-2 text-left text-[13px] font-medium transition-colors"
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

          {envInfo && (
            <div
              className="hidden border-t pt-2.5 text-[11px] lexel-mono md:block"
              style={{ borderColor: 'var(--lx-border)', color: 'var(--lx-fg-muted)' }}
            >
              <div>OS: {envInfo.platform}/{envInfo.arch}</div>
              <div>Rules: {harperRules?.rules.length ?? 0}</div>
              <div>Voice: {voiceExamples.length}</div>
            </div>
          )}
        </aside>

        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          <div className="mx-auto max-w-5xl">
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
                  className="mt-3 rounded-[6px] border px-3 py-1 text-[12px]"
                  style={{
                    backgroundColor: 'var(--lx-card)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                >
                  Retry
                </button>
              </div>
            ) : !status ? (
              <p className="text-[13px]" style={{ color: 'var(--lx-fg-muted)' }}>
                Loading Lexel Desktop...
              </p>
            ) : tab === 'studio' ? (
              <StudioPane
                settings={status.activeProfile.settings}
                onRefreshStatus={refreshAll}
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
                voiceExamples={voiceExamples}
                onPatchSettings={handlePatchSettings}
                onRefreshAll={refreshAll}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

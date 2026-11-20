import type { Dialect } from 'harper.js';
import {
  type AiHealthState,
  NibIcon,
  PanelIcon,
  SlidersIcon,
  StatusPill,
  SurfaceBadge,
  ThemeToggle,
} from 'lexel-ui';
import { useCallback, useEffect, useState } from 'react';
import type { LocalAiHealth } from '../shared/localAiClient';
import { detectSurfaceFromLocation } from '../shared/surfaceDetector';
import type {
  AiSettings,
  DetectedSurfaceContext,
  PageLintSummary,
  SurfaceId,
  SurfaceProfile,
} from '../shared/types';

const DIALECT_LABELS: Record<number, string> = {
  0: 'American',
  1: 'British',
  2: 'Australian',
  3: 'Canadian',
  4: 'Indian',
};

export function PopupApp() {
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [tabId, setTabId] = useState<number | null>(null);
  const [windowId, setWindowId] = useState<number | undefined>(undefined);
  const [surfaceCtx, setSurfaceCtx] = useState<DetectedSurfaceContext | null>(null);
  const [domainEnabled, setDomainEnabled] = useState(true);
  const [dialect, setDialect] = useState<Dialect>(0);
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [aiHealth, setAiHealth] = useState<LocalAiHealth | null>(null);
  const [summary, setSummary] = useState<PageLintSummary | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshAll = useCallback(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url ?? '';
    const domain = url.startsWith('http') ? new URL(url).hostname : 'general';

    const [
      themeRes,
      domainRes,
      overrideRes,
      blocklistRes,
      dialectRes,
      aiRes,
      healthRes,
      summaryRes,
      customSurfacesRes,
    ] = await Promise.all([
      chrome.runtime.sendMessage({ kind: 'getTheme' }) as Promise<{ theme: 'dark' | 'light' }>,
      chrome.runtime.sendMessage({ kind: 'getDomainStatus', domain }) as Promise<{
        enabled: boolean;
      }>,
      chrome.runtime.sendMessage({ kind: 'getSurfaceOverride', domain }) as Promise<{
        surfaceId: SurfaceId | null;
      }>,
      chrome.runtime.sendMessage({ kind: 'getPrivacyBlocklist' }) as Promise<{
        domains: string[];
      }>,
      chrome.runtime.sendMessage({ kind: 'getDialect' }) as Promise<{ dialect: Dialect }>,
      chrome.runtime.sendMessage({ kind: 'getAiSettings' }) as Promise<{
        settings: AiSettings;
      }>,
      chrome.runtime.sendMessage({ kind: 'aiHealth' }) as Promise<LocalAiHealth>,
      tab?.id != null
        ? (chrome.runtime.sendMessage({
            kind: 'getPageSummary',
            tabId: tab.id,
          }) as Promise<{ summary: PageLintSummary | null }>)
        : Promise.resolve({ summary: null }),
      chrome.runtime.sendMessage({ kind: 'getCustomSurfaces' }) as Promise<{
        surfaces?: SurfaceProfile[];
      }>,
    ]);

    const loadedCustomSurfaces = customSurfacesRes?.surfaces ?? [];
    setTabId(tab?.id ?? null);
    setWindowId(tab?.windowId);
    setTheme(themeRes.theme);
    setDomainEnabled(domainRes.enabled);
    setSurfaceCtx(
      detectSurfaceFromLocation(url || domain, {
        blocklist: blocklistRes.domains,
        overrideSurface: overrideRes.surfaceId,
        customSurfaces: loadedCustomSurfaces,
      }),
    );
    setDialect(dialectRes.dialect);
    setAiSettings(aiRes.settings);
    setAiHealth(healthRes);
    setSummary(summaryRes.summary);
  }, []);

  useEffect(() => {
    refreshAll()
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [refreshAll]);

  async function handleThemeToggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    await chrome.runtime.sendMessage({ kind: 'setTheme', theme: next });
  }

  async function handleDomainToggle() {
    if (!surfaceCtx) return;
    const next = !domainEnabled;
    setDomainEnabled(next);
    await chrome.runtime.sendMessage({
      kind: 'setDomainStatus',
      domain: surfaceCtx.domain,
      enabled: next,
      overrideValue: true,
    });
  }

  async function handleSyncDesktop() {
    setSyncing(true);
    try {
      await chrome.runtime.sendMessage({ kind: 'syncFromDaemon' });
      await refreshAll();
    } finally {
      setSyncing(false);
    }
  }

  async function handleOpenSidePanel() {
    if (tabId != null) {
      try {
        const draft = (await chrome.tabs.sendMessage(tabId, { kind: 'getFocusedDraft' })) as {
          text: string;
          surfaceId: SurfaceId;
          subcontext: string | null;
        } | null;
        if (draft?.text) {
          await chrome.runtime.sendMessage({ kind: 'setActiveDraft', draft });
        }
      } catch {
        // Page has no active content script (e.g. chrome:// page).
      }
    }
    if (windowId != null && chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ windowId });
      window.close();
      return;
    }
    await chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html') });
    window.close();
  }

  const connected = Boolean(aiHealth?.daemonConnected);
  const aiState: AiHealthState = !connected
    ? 'offline'
    : !aiSettings?.enabled
      ? 'offline'
      : aiHealth?.ok && aiHealth.modelAvailable !== false
        ? 'ready'
        : aiHealth
          ? 'error'
          : 'loading';

  const aiLabel = !connected
    ? 'Grammar Only'
    : !aiSettings?.enabled
      ? 'AI Off'
      : aiHealth?.ok && aiHealth.modelAvailable !== false
        ? `${aiSettings.model} Ready`
        : aiHealth?.ok
          ? 'Model Missing'
          : 'AI Offline';

  return (
    <div data-theme={theme} className="lexel-root w-[370px] min-h-[380px] p-4 flex flex-col gap-3">
      <header
        className="flex items-center justify-between gap-2 pb-2 border-b"
        style={{ borderColor: 'var(--lx-border)' }}
      >
        <div className="flex items-center gap-2">
          <NibIcon className="w-5 h-5" />
          <h1 className="text-base font-semibold tracking-tight m-0">Lexel</h1>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill state={aiState} label={aiLabel} />
          <ThemeToggle theme={theme} onToggle={() => void handleThemeToggle()} />
        </div>
      </header>

      {loading ? (
        <div className="text-xs py-6 text-center" style={{ color: 'var(--lx-fg-muted)' }}>
          Loading workspace status...
        </div>
      ) : error ? (
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
      ) : surfaceCtx ? (
        <>
          <section
            className="rounded-[8px] border p-3 flex flex-col gap-2"
            style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-medium truncate">
                  {surfaceCtx.domain || 'Browser tab'}
                </div>
                <div className="mt-1">
                  <SurfaceBadge label={surfaceCtx.label} subcontext={surfaceCtx.subcontext} />
                </div>
              </div>
              <button
                type="button"
                onClick={() => void handleDomainToggle()}
                disabled={surfaceCtx.isBlocked}
                className="rounded-[6px] border px-2.5 py-1 text-xs font-semibold"
                style={{
                  backgroundColor:
                    domainEnabled && !surfaceCtx.isBlocked ? 'var(--lx-accent)' : 'var(--lx-muted)',
                  borderColor: 'var(--lx-border)',
                  color:
                    domainEnabled && !surfaceCtx.isBlocked ? 'var(--lx-on-accent)' : 'var(--lx-fg)',
                }}
              >
                {surfaceCtx.isBlocked ? 'Blocked' : domainEnabled ? 'Site On' : 'Site Paused'}
              </button>
            </div>

            {surfaceCtx.isBlocked ? (
              <p className="text-[11px] m-0" style={{ color: 'var(--lx-warn)' }}>
                {surfaceCtx.blockReason}
              </p>
            ) : null}
          </section>

          <section
            className="rounded-[8px] border p-3 grid grid-cols-3 gap-2 text-center"
            style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
          >
            <div>
              <div className="text-base font-semibold lexel-mono">{summary?.harperCount ?? 0}</div>
              <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                Grammar
              </div>
            </div>
            <div>
              <div className="text-base font-semibold lexel-mono">{summary?.slopCount ?? 0}</div>
              <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                AI Slop
              </div>
            </div>
            <div>
              <div className="text-base font-semibold lexel-mono">
                {summary?.surfaceWarningCount ?? 0}
              </div>
              <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                Platform
              </div>
            </div>
          </section>

          <section
            className="rounded-[8px] border p-3 flex flex-col gap-2"
            style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
          >
            {connected ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold">Synced with Lexel Desktop</div>
                    <div
                      className="text-[11px] lexel-mono mt-0.5"
                      style={{ color: 'var(--lx-fg-muted)' }}
                    >
                      Profile: {aiHealth?.activeProfile?.name ?? 'Default'} ·{' '}
                      {DIALECT_LABELS[dialect] ?? 'American'}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={syncing}
                    onClick={() => void handleSyncDesktop()}
                    className="rounded-[6px] border px-2 py-1 text-[11px] font-medium shrink-0"
                    style={{
                      backgroundColor: 'var(--lx-muted)',
                      borderColor: 'var(--lx-border)',
                      color: 'var(--lx-fg)',
                    }}
                  >
                    {syncing ? 'Syncing...' : 'Sync Now'}
                  </button>
                </div>
                <p className="text-[11px] m-0" style={{ color: 'var(--lx-fg-muted)' }}>
                  Manage grammar rules, personal dictionary, surface prompts, and local AI models in{' '}
                  <strong>Lexel Desktop</strong>.
                </p>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold">Grammar &amp; Anti-Slop Active</span>
                  <button
                    type="button"
                    disabled={syncing}
                    onClick={() => void handleSyncDesktop()}
                    className="rounded-[6px] border px-2 py-1 text-[11px] font-medium shrink-0"
                    style={{
                      backgroundColor: 'var(--lx-muted)',
                      borderColor: 'var(--lx-border)',
                      color: 'var(--lx-fg)',
                    }}
                  >
                    {syncing ? 'Linking...' : 'Connect Desktop'}
                  </button>
                </div>
                <p className="text-[11px] m-0 leading-snug" style={{ color: 'var(--lx-fg-muted)' }}>
                  Grammar, spelling, and anti-slop checks work out of the box. Install{' '}
                  <strong>Lexel Desktop</strong> to configure settings and download the local AI
                  model.
                </p>
              </>
            )}
          </section>

          <footer className="flex items-center gap-2 pt-1 mt-auto">
            <button
              type="button"
              onClick={() => void handleOpenSidePanel()}
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-[6px] px-3 py-2 text-xs font-semibold"
              style={{
                backgroundColor: 'var(--lx-accent)',
                color: 'var(--lx-on-accent)',
              }}
            >
              <PanelIcon className="w-3.5 h-3.5" />
              <span>AI Workbench</span>
            </button>
            <button
              type="button"
              onClick={() => void chrome.runtime.openOptionsPage()}
              className="inline-flex items-center justify-center gap-1.5 rounded-[6px] border px-3 py-2 text-xs font-medium"
              style={{
                backgroundColor: 'var(--lx-muted)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              <SlidersIcon className="w-3.5 h-3.5" />
              <span>{connected ? 'Desktop Sync' : 'Get Desktop App'}</span>
            </button>
          </footer>
        </>
      ) : null}
    </div>
  );
}

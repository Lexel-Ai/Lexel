import type { Dialect } from 'harper.js';
import {
  type AiHealthState,
  NibIcon,
  PanelIcon,
  PrivacyProofBadge,
  RefreshIcon,
  SlidersIcon,
  SlopMeter,
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
  const [ghostTextEnabled, setGhostTextEnabled] = useState(false);
  const [redactSecrets, setRedactSecrets] = useState(false);
  const [secretBlocks, setSecretBlocks] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshAll = useCallback(async () => {
    setError(null);
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
      ghostRes,
      privacyRes,
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
      chrome.runtime.sendMessage({ kind: 'getGhostTextEnabled' }) as Promise<{
        enabled?: boolean;
      }>,
      chrome.runtime.sendMessage({ kind: 'getPrivacyStats' }) as Promise<{
        localSecretBlocks?: number;
        redactSecrets?: boolean;
      }>,
    ]);

    const loadedCustomSurfaces = customSurfacesRes?.surfaces ?? [];
    setTabId(tab?.id ?? null);
    setWindowId(tab?.windowId);
    setTheme(themeRes?.theme === 'light' ? 'light' : 'dark');
    setDomainEnabled(domainRes?.enabled !== false);
    setSurfaceCtx(
      detectSurfaceFromLocation(url || domain, {
        blocklist: blocklistRes?.domains ?? [],
        overrideSurface: overrideRes?.surfaceId ?? null,
        customSurfaces: loadedCustomSurfaces,
      }),
    );
    setDialect(dialectRes?.dialect ?? 0);
    setAiSettings(aiRes?.settings ?? null);
    setAiHealth(healthRes ?? null);
    setSummary(summaryRes?.summary ?? null);
    setGhostTextEnabled(ghostRes?.enabled === true);
    setRedactSecrets(privacyRes?.redactSecrets === true);
    setSecretBlocks(privacyRes?.localSecretBlocks ?? 0);
  }, []);

  useEffect(() => {
    refreshAll()
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
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

  async function handleToggleGhostText() {
    const next = !ghostTextEnabled;
    setGhostTextEnabled(next);
    await chrome.runtime.sendMessage({ kind: 'setGhostTextEnabled', enabled: next });
  }

  async function handleToggleRedactSecrets() {
    const next = !redactSecrets;
    setRedactSecrets(next);
    await chrome.runtime.sendMessage({ kind: 'setRedactSecrets', enabled: next });
  }

  async function handleSyncDesktop() {
    setSyncing(true);
    try {
      await chrome.runtime.sendMessage({ kind: 'syncFromDaemon' });
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    ? 'Tier 0 Local'
    : !aiSettings?.enabled
      ? 'AI Off'
      : aiHealth?.ok && aiHealth.modelAvailable !== false
        ? `${aiSettings.model}`
        : aiHealth?.ok
          ? 'Model Missing'
          : 'AI Offline';

  return (
    <div data-theme={theme} className="lexel-root w-[380px] min-h-[430px] p-4 flex flex-col gap-3">
      <header
        className="flex items-center justify-between gap-2 pb-2.5 border-b"
        style={{ borderColor: 'var(--lx-border)' }}
      >
        <div className="flex items-center gap-2">
          <NibIcon className="w-5 h-5" />
          <h1 className="text-[15px] font-semibold tracking-tight m-0">Lexel</h1>
        </div>
        <div className="flex items-center gap-1.5">
          <StatusPill state={aiState} label={aiLabel} />
          <ThemeToggle theme={theme} onToggle={() => void handleThemeToggle()} />
        </div>
      </header>

      <main className="flex flex-col gap-3 flex-1">
        {loading ? (
          <div
            role="status"
            className="rounded-[8px] border p-4 text-xs text-center"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg-muted)',
            }}
          >
            Checking active tab and local engine status...
          </div>
        ) : error ? (
          <div
            role="alert"
            className="rounded-[6px] border p-3 text-xs flex flex-col gap-2"
            style={{
              backgroundColor: 'var(--lx-danger-bg)',
              borderColor: 'var(--lx-danger)',
              color: 'var(--lx-danger)',
            }}
          >
            <span>{error}</span>
            <button
              type="button"
              onClick={() => void refreshAll()}
              className="lx-pressable lx-btn-secondary self-start px-2.5 py-1 text-[11px] font-medium"
            >
              Retry
            </button>
          </div>
        ) : surfaceCtx ? (
          <>
            <section
              aria-label="Current site status"
              className="rounded-[8px] border p-3 flex flex-col gap-2"
              style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-semibold truncate">
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
                  aria-pressed={domainEnabled && !surfaceCtx.isBlocked}
                  className={`lx-pressable px-2.5 py-1.5 text-xs font-semibold ${
                    domainEnabled && !surfaceCtx.isBlocked ? 'lx-btn-primary' : 'lx-btn-secondary'
                  }`}
                >
                  {surfaceCtx.isBlocked ? 'Blocked' : domainEnabled ? 'Active' : 'Paused'}
                </button>
              </div>

              {surfaceCtx.isBlocked ? (
                <p className="text-[11px] m-0" style={{ color: 'var(--lx-warn)' }}>
                  {surfaceCtx.blockReason}
                </p>
              ) : null}
            </section>

            <section
              aria-label="Page writing diagnostics"
              className="rounded-[8px] border p-3 flex flex-col gap-2.5"
              style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
            >
              <div className="grid grid-cols-3 gap-2 text-center">
                <div
                  className="rounded-[6px] border py-2 px-1"
                  style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
                >
                  <div className="text-base font-semibold lexel-mono lx-tab-nums">
                    {summary?.harperCount ?? 0}
                  </div>
                  <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                    Grammar
                  </div>
                </div>
                <div
                  className="rounded-[6px] border py-2 px-1"
                  style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
                >
                  <div className="text-base font-semibold lexel-mono lx-tab-nums">
                    {summary?.slopCount ?? 0}
                  </div>
                  <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                    AI Slop
                  </div>
                </div>
                <div
                  className="rounded-[6px] border py-2 px-1"
                  style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
                >
                  <div className="text-base font-semibold lexel-mono lx-tab-nums">
                    {(summary?.surfaceWarningCount ?? 0) +
                      (summary?.guardCount ?? 0) +
                      (summary?.consistencyCount ?? 0)}
                  </div>
                  <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                    Guards
                  </div>
                </div>
              </div>

              {typeof summary?.slopScore === 'number' ? (
                <SlopMeter score={summary.slopScore} compact />
              ) : (
                <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                  Focus a text field on this tab to inspect live slop density and writing guards.
                </div>
              )}
            </section>

            <section
              aria-label="Quick local controls"
              className="rounded-[8px] border p-3 flex flex-col gap-2"
              style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
            >
              <div className="flex items-center justify-between gap-2 text-xs">
                <div>
                  <div className="font-medium">Ghost-text autocomplete</div>
                  <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                    Opt-in local Tab completion
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={ghostTextEnabled}
                  onClick={() => void handleToggleGhostText()}
                  className={`lx-pressable px-2.5 py-1 text-[11px] font-semibold lexel-mono ${
                    ghostTextEnabled ? 'lx-btn-primary' : 'lx-btn-secondary'
                  }`}
                >
                  {ghostTextEnabled ? 'On' : 'Off'}
                </button>
              </div>
              <div
                className="flex items-center justify-between gap-2 pt-2 border-t text-xs"
                style={{ borderColor: 'var(--lx-border)' }}
              >
                <div>
                  <div className="font-medium">Secret redact-and-restore</div>
                  <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                    Swap tokens locally before AI
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={redactSecrets}
                  onClick={() => void handleToggleRedactSecrets()}
                  className={`lx-pressable px-2.5 py-1 text-[11px] font-semibold lexel-mono ${
                    redactSecrets ? 'lx-btn-primary' : 'lx-btn-secondary'
                  }`}
                >
                  {redactSecrets ? 'On' : 'Strict'}
                </button>
              </div>
            </section>

            <section
              aria-label="Local privacy and desktop bridge"
              className="rounded-[8px] border p-3 flex flex-col gap-2"
              style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
            >
              <PrivacyProofBadge
                localOnly={true}
                blockedSecretsCount={secretBlocks}
                redactEnabled={redactSecrets}
                compact
              />

              <div className="flex items-center justify-between gap-2 pt-1">
                <div className="min-w-0">
                  <div className="text-xs font-semibold">
                    {connected ? 'Synced with Lexel Desktop' : 'Zero-Daemon Tier 0 Active'}
                  </div>
                  <div
                    className="text-[11px] lexel-mono truncate"
                    style={{ color: 'var(--lx-fg-muted)' }}
                  >
                    {connected
                      ? `${aiHealth?.activeProfile?.name ?? 'Default'} · ${DIALECT_LABELS[dialect] ?? 'American'}`
                      : `${DIALECT_LABELS[dialect] ?? 'American'} · 0 MB AI RAM`}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={syncing}
                  onClick={() => void handleSyncDesktop()}
                  className="lx-pressable lx-btn-secondary inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium shrink-0"
                >
                  <RefreshIcon className="w-3 h-3" />
                  <span>{syncing ? 'Syncing...' : connected ? 'Sync' : 'Connect'}</span>
                </button>
              </div>
            </section>
          </>
        ) : null}
      </main>

      <footer className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => void handleOpenSidePanel()}
          className="lx-pressable lx-btn-primary flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold"
        >
          <PanelIcon className="w-3.5 h-3.5" />
          <span>Open Workbench</span>
        </button>
        <button
          type="button"
          onClick={() => void chrome.runtime.openOptionsPage()}
          className="lx-pressable lx-btn-secondary inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium"
        >
          <SlidersIcon className="w-3.5 h-3.5" />
          <span>Settings</span>
        </button>
      </footer>
    </div>
  );
}

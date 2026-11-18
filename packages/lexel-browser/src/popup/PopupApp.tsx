import type { Dialect } from 'harper.js';
import {
  NibIcon,
  PanelIcon,
  SlidersIcon,
  StatusPill,
  SurfaceBadge,
  ThemeToggle,
  type AiHealthState,
} from 'lexel-ui';
import React, { useEffect, useState } from 'react';
import type { LocalAiHealth } from '../shared/localAiClient';
import { detectSurfaceFromLocation, SURFACE_PROFILES } from '../shared/surfaceDetector';
import type { AiSettings, DetectedSurfaceContext, PageLintSummary, SurfaceId } from '../shared/types';

export function PopupApp() {
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [tabId, setTabId] = useState<number | null>(null);
  const [windowId, setWindowId] = useState<number | undefined>(undefined);
  const [tabUrl, setTabUrl] = useState('');
  const [domainEnabled, setDomainEnabled] = useState(true);
  const [surfaceCtx, setSurfaceCtx] = useState<DetectedSurfaceContext | null>(null);
  const [surfaceOverride, setSurfaceOverride] = useState<SurfaceId | null>(null);
  const [dialect, setDialect] = useState<Dialect>(0);
  const [hoverFixes, setHoverFixes] = useState(true);
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [aiHealth, setAiHealth] = useState<LocalAiHealth | null>(null);
  const [summary, setSummary] = useState<PageLintSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const url = tab?.url ?? '';
        const domain = url.startsWith('http') ? new URL(url).hostname : 'general';

        const [
          themeRes,
          domainRes,
          overrideRes,
          blocklistRes,
          dialectRes,
          hoverRes,
          aiRes,
          healthRes,
          summaryRes,
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
          chrome.runtime.sendMessage({ kind: 'getOpenSuggestionsOnHover' }) as Promise<{
            enabled: boolean;
          }>,
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
        ]);

        setTabId(tab?.id ?? null);
        setWindowId(tab?.windowId);
        setTabUrl(url);
        setTheme(themeRes.theme);
        setDomainEnabled(domainRes.enabled);
        setSurfaceOverride(overrideRes.surfaceId);
        setSurfaceCtx(
          detectSurfaceFromLocation(url || domain, {
            blocklist: blocklistRes.domains,
            overrideSurface: overrideRes.surfaceId,
          }),
        );
        setDialect(dialectRes.dialect);
        setHoverFixes(hoverRes.enabled);
        setAiSettings(aiRes.settings);
        setAiHealth(healthRes);
        setSummary(summaryRes.summary);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

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

  async function handleSurfaceOverrideChange(value: string) {
    if (!surfaceCtx) return;
    const next = value === 'auto' ? null : (value as SurfaceId);
    setSurfaceOverride(next);
    await chrome.runtime.sendMessage({
      kind: 'setSurfaceOverride',
      domain: surfaceCtx.domain,
      surfaceId: next,
    });
    const blocklistRes = (await chrome.runtime.sendMessage({
      kind: 'getPrivacyBlocklist',
    })) as { domains: string[] };
    setSurfaceCtx(
      detectSurfaceFromLocation(tabUrl || surfaceCtx.domain, {
        blocklist: blocklistRes.domains,
        overrideSurface: next,
      }),
    );
  }

  async function handleDialectChange(nextDialect: number) {
    setDialect(nextDialect as Dialect);
    await chrome.runtime.sendMessage({ kind: 'setDialect', dialect: nextDialect });
  }

  async function handleHoverFixesToggle() {
    const next = !hoverFixes;
    setHoverFixes(next);
    await chrome.runtime.sendMessage({ kind: 'setOpenSuggestionsOnHover', enabled: next });
  }

  async function handleModelChange(model: string) {
    if (!aiSettings) return;
    const next = { ...aiSettings, model };
    setAiSettings(next);
    await chrome.runtime.sendMessage({ kind: 'setAiSettings', settings: next });
    const health = (await chrome.runtime.sendMessage({ kind: 'aiHealth' })) as LocalAiHealth;
    setAiHealth(health);
  }

  async function handleToggleAiEnabled() {
    if (!aiSettings) return;
    const next = { ...aiSettings, enabled: !aiSettings.enabled };
    setAiSettings(next);
    await chrome.runtime.sendMessage({ kind: 'setAiSettings', settings: next });
    if (next.enabled) {
      const health = (await chrome.runtime.sendMessage({ kind: 'aiHealth' })) as LocalAiHealth;
      setAiHealth(health);
    } else {
      setAiHealth({ ok: false, models: [], error: 'Local AI is turned off.' });
    }
  }

  async function handleRetryAiHealth() {
    const health = (await chrome.runtime.sendMessage({ kind: 'aiHealth' })) as LocalAiHealth;
    setAiHealth(health);
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

  const aiState: AiHealthState = !aiSettings?.enabled
    ? 'offline'
    : aiHealth?.ok && aiHealth.modelAvailable !== false
      ? 'ready'
      : aiHealth
        ? 'error'
        : 'loading';

  const aiLabel = !aiSettings?.enabled
    ? 'AI Off'
    : aiHealth?.ok && aiHealth.modelAvailable !== false
      ? `${aiSettings.model} Ready`
      : aiHealth?.ok
        ? 'Model Missing'
        : 'Local AI Offline';

  const modelChoices = Array.from(
    new Set([aiSettings?.model ?? 'qwen2.5:1.5b', 'qwen2.5:1.5b', 'qwen2.5:0.5b', ...(aiHealth?.models ?? [])]),
  );

  return (
    <div data-theme={theme} className="lexel-root w-[360px] min-h-[420px] p-4 flex flex-col gap-3">
      <header className="flex items-center justify-between gap-2 pb-2 border-b" style={{ borderColor: 'var(--lx-border)' }}>
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
            className="rounded-[8px] border p-3 flex flex-col gap-2.5"
            style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-medium truncate">{surfaceCtx.domain || 'Browser tab'}</div>
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
                  backgroundColor: domainEnabled && !surfaceCtx.isBlocked ? 'var(--lx-accent)' : 'var(--lx-muted)',
                  borderColor: 'var(--lx-border)',
                  color: domainEnabled && !surfaceCtx.isBlocked ? 'var(--lx-on-accent)' : 'var(--lx-fg)',
                }}
              >
                {surfaceCtx.isBlocked ? 'Blocked' : domainEnabled ? 'Active' : 'Paused'}
              </button>
            </div>

            {surfaceCtx.isBlocked ? (
              <p className="text-[11px] m-0" style={{ color: 'var(--lx-warn)' }}>
                {surfaceCtx.blockReason}
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2 pt-1">
                <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                  <span>Surface Style</span>
                  <select
                    value={surfaceOverride ?? 'auto'}
                    onChange={(e) => void handleSurfaceOverrideChange(e.target.value)}
                    className="rounded-[6px] border px-2 py-1 text-xs"
                    style={{
                      backgroundColor: 'var(--lx-muted)',
                      borderColor: 'var(--lx-border)',
                      color: 'var(--lx-fg)',
                    }}
                  >
                    <option value="auto">Auto ({surfaceCtx.label})</option>
                    {SURFACE_PROFILES.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                  <span>English Dialect</span>
                  <select
                    value={dialect}
                    onChange={(e) => void handleDialectChange(Number(e.target.value))}
                    className="rounded-[6px] border px-2 py-1 text-xs"
                    style={{
                      backgroundColor: 'var(--lx-muted)',
                      borderColor: 'var(--lx-border)',
                      color: 'var(--lx-fg)',
                    }}
                  >
                    <option value={0}>American</option>
                    <option value={1}>British</option>
                    <option value={2}>Australian</option>
                    <option value={3}>Canadian</option>
                  </select>
                </label>
              </div>
            )}

            {!surfaceCtx.isBlocked ? (
              <label className="flex items-center justify-between gap-2 pt-1 text-xs">
                <span style={{ color: 'var(--lx-fg-muted)' }}>Hover underline to fix</span>
                <input
                  type="checkbox"
                  checked={hoverFixes}
                  onChange={() => void handleHoverFixesToggle()}
                />
              </label>
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
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">Local AI Rewrites (Tier 1)</span>
              <button
                type="button"
                onClick={() => void handleToggleAiEnabled()}
                className="rounded-[6px] border px-2.5 py-1 text-xs font-semibold"
                style={{
                  backgroundColor: aiSettings?.enabled ? 'var(--lx-accent)' : 'var(--lx-muted)',
                  borderColor: 'var(--lx-border)',
                  color: aiSettings?.enabled ? 'var(--lx-on-accent)' : 'var(--lx-fg)',
                }}
              >
                {aiSettings?.enabled ? 'AI: ON' : 'AI: OFF'}
              </button>
            </div>

            {aiSettings?.enabled ? (
              <>
                <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                  <span>Model</span>
                  <select
                    value={aiSettings.model}
                    onChange={(e) => void handleModelChange(e.target.value)}
                    className="rounded-[6px] border px-2 py-1.5 text-xs lexel-mono"
                    style={{
                      backgroundColor: 'var(--lx-muted)',
                      borderColor: 'var(--lx-border)',
                      color: 'var(--lx-fg)',
                    }}
                  >
                    {modelChoices.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>

                {aiHealth && (!aiHealth.ok || aiHealth.modelAvailable === false) ? (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-[11px] m-0 leading-snug" style={{ color: 'var(--lx-warn)' }}>
                      {aiHealth.error}
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleRetryAiHealth()}
                        className="rounded-[6px] border px-2 py-1 text-[11px] font-medium"
                        style={{
                          backgroundColor: 'var(--lx-muted)',
                          borderColor: 'var(--lx-border)',
                          color: 'var(--lx-fg)',
                        }}
                      >
                        Retry connection
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void navigator.clipboard.writeText(
                            'OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*" ollama serve',
                          )
                        }
                        className="rounded-[6px] border px-2 py-1 text-[11px]"
                        style={{
                          backgroundColor: 'var(--lx-bg)',
                          borderColor: 'var(--lx-border)',
                          color: 'var(--lx-fg-muted)',
                        }}
                      >
                        Copy Ollama cmd
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-[11px] m-0" style={{ color: 'var(--lx-fg-muted)' }}>
                AI is shut down (0 MB LLM RAM). Harper grammar and anti-slop checks stay active.
              </p>
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
              <span>Settings</span>
            </button>
          </footer>
        </>
      ) : null}
    </div>
  );
}

import type { Dialect } from 'harper.js';
import { type AiHealthState, NibIcon, StatusPill, ThemeToggle } from 'lexel-ui';
import { useCallback, useEffect, useState } from 'react';
import type { LocalAiHealth } from '../shared/localAiClient';
import type { AiSettings, SurfaceProfile } from '../shared/types';

const DIALECT_LABELS: Record<number, string> = {
  0: 'American English',
  1: 'British English',
  2: 'Australian English',
  3: 'Canadian English',
  4: 'Indian English',
};

const INSTALL_CMD =
  'curl -fsSL https://raw.githubusercontent.com/Lexel-Ai/Lexel/main/scripts/install.sh | bash';
const RELEASES_URL = 'https://github.com/Lexel-Ai/Lexel/releases';

export function OptionsApp() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [aiHealth, setAiHealth] = useState<LocalAiHealth | null>(null);
  const [dialect, setDialect] = useState<Dialect>(0);
  const [dictCount, setDictCount] = useState(0);
  const [blocklistCount, setBlocklistCount] = useState(0);
  const [customSlopCount, setCustomSlopCount] = useState(0);
  const [customSurfaces, setCustomSurfaces] = useState<SurfaceProfile[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [copiedInstall, setCopiedInstall] = useState(false);
  const [copiedExtId, setCopiedExtId] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const extensionId = typeof chrome !== 'undefined' ? (chrome.runtime?.id ?? '') : '';

  const loadAll = useCallback(async () => {
    const [themeRes, aiRes, healthRes, dialectRes, dictRes, blockRes, slopRes, surfacesRes] =
      await Promise.all([
        chrome.runtime.sendMessage({ kind: 'getTheme' }) as Promise<{ theme: 'dark' | 'light' }>,
        chrome.runtime.sendMessage({ kind: 'getAiSettings' }) as Promise<{ settings: AiSettings }>,
        chrome.runtime.sendMessage({ kind: 'aiHealth' }) as Promise<LocalAiHealth>,
        chrome.runtime.sendMessage({ kind: 'getDialect' }) as Promise<{ dialect: Dialect }>,
        chrome.runtime.sendMessage({ kind: 'getUserDictionary' }) as Promise<{ words: string[] }>,
        chrome.runtime.sendMessage({ kind: 'getPrivacyBlocklist' }) as Promise<{
          domains: string[];
        }>,
        chrome.runtime.sendMessage({ kind: 'getCustomSlopConfig' }) as Promise<{
          customTerms?: string[];
        }>,
        chrome.runtime.sendMessage({ kind: 'getCustomSurfaces' }) as Promise<{
          surfaces?: SurfaceProfile[];
        }>,
      ]);

    setTheme(themeRes.theme);
    setAiSettings(aiRes.settings);
    setAiHealth(healthRes);
    setDialect(dialectRes.dialect);
    setDictCount(dictRes.words.length);
    setBlocklistCount(blockRes.domains.length);
    setCustomSlopCount(slopRes?.customTerms?.length ?? 0);
    setCustomSurfaces(surfacesRes?.surfaces ?? []);
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  async function handleThemeToggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    await chrome.runtime.sendMessage({ kind: 'setTheme', theme: next });
  }

  async function handleConnectAndSync() {
    setSyncing(true);
    setErrorMsg(null);
    setNotice(null);
    try {
      const res = (await chrome.runtime.sendMessage({ kind: 'syncFromDaemon' })) as {
        synced?: boolean;
      };
      await loadAll();
      if (res?.synced) {
        setNotice('Connected and synced all settings, rules, and AI state from Lexel Desktop.');
      } else {
        setErrorMsg(
          'Lexel Desktop was not detected on 127.0.0.1:42424. Install or launch Lexel Desktop first, then click Connect again.',
        );
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }

  async function handleProfileSwitch(profileId: string) {
    setSyncing(true);
    setErrorMsg(null);
    try {
      await chrome.runtime.sendMessage({ kind: 'switchProfile', profileId });
      await loadAll();
      setNotice('Switched active Lexel Desktop profile.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }

  const connected = Boolean(aiHealth?.daemonConnected);
  const aiState: AiHealthState = !connected
    ? 'offline'
    : !aiSettings?.enabled
      ? 'offline'
      : aiHealth?.ok && aiHealth.modelAvailable !== false
        ? 'ready'
        : 'error';

  const statusLabel = connected
    ? `Connected to Lexel Desktop (${aiHealth?.activeProfile?.name ?? 'Default'})`
    : 'Standalone Mode (Desktop App Not Connected)';

  return (
    <div data-theme={theme} className="lexel-root min-h-screen">
      <div className="mx-auto max-w-3xl px-6 py-8 flex flex-col gap-6">
        <header
          className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b"
          style={{ borderColor: 'var(--lx-border)' }}
        >
          <div className="flex items-center gap-3">
            <NibIcon className="w-6 h-6" />
            <div>
              <h1 className="text-lg font-semibold tracking-tight m-0">
                Lexel Browser Extension Bridge
              </h1>
              <p className="text-xs m-0" style={{ color: 'var(--lx-fg-muted)' }}>
                Settings, rules, dictionaries, and local AI models are managed in Lexel Desktop.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <StatusPill state={aiState} label={statusLabel} />
            <ThemeToggle theme={theme} onToggle={() => void handleThemeToggle()} />
          </div>
        </header>

        {notice ? (
          <div
            className="rounded-[6px] border px-3.5 py-2.5 text-xs"
            style={{
              backgroundColor: 'var(--lx-signal-bg)',
              borderColor: 'var(--lx-signal)',
              color: 'var(--lx-signal)',
            }}
          >
            {notice}
          </div>
        ) : null}

        {errorMsg ? (
          <div
            role="alert"
            className="rounded-[6px] border px-3.5 py-2.5 text-xs"
            style={{
              backgroundColor: 'var(--lx-danger-bg)',
              borderColor: 'var(--lx-danger)',
              color: 'var(--lx-danger)',
            }}
          >
            {errorMsg}
          </div>
        ) : null}

        {connected ? (
          <section
            className="rounded-[8px] border p-5 flex flex-col gap-4"
            style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold m-0">Synced with Lexel Desktop</h2>
                <p className="text-xs m-0 mt-1" style={{ color: 'var(--lx-fg-muted)' }}>
                  Your browser extension automatically pulls grammar rules, surface prompts, and
                  local AI settings from <code className="lexel-mono">lexel.db</code>.
                </p>
              </div>
              <button
                type="button"
                disabled={syncing}
                onClick={() => void handleConnectAndSync()}
                className="rounded-[6px] px-3.5 py-1.5 text-xs font-semibold"
                style={{
                  backgroundColor: 'var(--lx-accent)',
                  color: 'var(--lx-on-accent)',
                }}
              >
                {syncing ? 'Syncing...' : 'Sync from Desktop Now'}
              </button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div
                className="rounded-[6px] border p-3 text-xs"
                style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
              >
                <div style={{ color: 'var(--lx-fg-muted)' }}>Active Desktop Profile</div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="font-semibold lexel-mono">
                    {aiHealth?.activeProfile?.name ?? 'Default'}
                  </span>
                  {aiHealth?.profiles && aiHealth.profiles.length > 1 ? (
                    <select
                      aria-label="Switch Desktop Profile"
                      value={aiHealth.activeProfile?.id ?? ''}
                      onChange={(e) => void handleProfileSwitch(e.target.value)}
                      className="rounded-[4px] border px-2 py-0.5 text-xs"
                      style={{
                        backgroundColor: 'var(--lx-card)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    >
                      {aiHealth.profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>
              </div>

              <div
                className="rounded-[6px] border p-3 text-xs"
                style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
              >
                <div style={{ color: 'var(--lx-fg-muted)' }}>Local AI Engine</div>
                <div className="mt-1 font-semibold lexel-mono">
                  {!aiSettings?.enabled
                    ? 'Disabled in Desktop (0 MB RAM)'
                    : aiHealth?.loadedModel
                      ? `${aiHealth.loadedModel} (Loaded via ${aiHealth.runtimeBackend ?? 'daemon'})`
                      : aiHealth?.ok && aiHealth.modelAvailable !== false
                        ? `${aiSettings.model} (Ready on demand)`
                        : 'Download GGUF model in Lexel Desktop'}
                </div>
              </div>

              <div
                className="rounded-[6px] border p-3 text-xs"
                style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
              >
                <div style={{ color: 'var(--lx-fg-muted)' }}>English Dialect</div>
                <div className="mt-1 font-semibold">
                  {DIALECT_LABELS[dialect] ?? 'American English'}
                </div>
              </div>

              <div
                className="rounded-[6px] border p-3 text-xs"
                style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
              >
                <div style={{ color: 'var(--lx-fg-muted)' }}>Synced Custom Rules</div>
                <div className="mt-1 lexel-mono">
                  {dictCount} dict · {customSlopCount} slop · {customSurfaces.length} surfaces ·{' '}
                  {blocklistCount} blocked
                </div>
              </div>
            </div>

            <p className="text-xs m-0" style={{ color: 'var(--lx-fg-muted)' }}>
              Open <strong>Lexel Desktop</strong> on your computer to edit grammar rules, manage
              your personal dictionary, customize platform surface prompts, or download local AI
              models.
            </p>
          </section>
        ) : (
          <section
            className="rounded-[8px] border p-5 flex flex-col gap-3"
            style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold m-0">
                  Grammar &amp; Anti-Slop Check Is Active
                </h2>
                <p className="text-xs m-0 mt-1" style={{ color: 'var(--lx-fg-muted)' }}>
                  Harper grammar, spelling, anti-slop, platform rules, and Secrets Guard work right
                  now in your browser with 0 MB AI RAM.
                </p>
              </div>
              <button
                type="button"
                disabled={syncing}
                onClick={() => void handleConnectAndSync()}
                className="rounded-[6px] px-3.5 py-1.5 text-xs font-semibold"
                style={{
                  backgroundColor: 'var(--lx-accent)',
                  color: 'var(--lx-on-accent)',
                }}
              >
                {syncing ? 'Connecting...' : 'Connect to Lexel Desktop'}
              </button>
            </div>

            <div
              className="rounded-[6px] border p-3 text-xs leading-relaxed"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              <strong>Want to customize settings or use the Local AI model?</strong>
              <p className="m-0 mt-1" style={{ color: 'var(--lx-fg-muted)' }}>
                Lexel centralizes all settings, dictionaries, rule presets, surface prompts, and
                1-click GGUF model downloads (<code className="lexel-mono">Qwen2.5-1.5B</code> /{' '}
                <code className="lexel-mono">0.5B</code>) inside <strong>Lexel Desktop</strong>. If
                you choose not to install Lexel Desktop, you can continue using the browser
                extension for instant zero-AI grammar and anti-slop checks.
              </p>
            </div>
          </section>
        )}

        <section
          className="rounded-[8px] border p-5 flex flex-col gap-3"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <div>
            <h2 className="text-sm font-semibold m-0">
              Install Lexel Desktop in One Command (Linux &amp; macOS)
            </h2>
            <p className="text-xs m-0 mt-1" style={{ color: 'var(--lx-fg-muted)' }}>
              Run this command in your terminal to install Lexel Desktop, the local daemon, and
              Native Messaging bridge, or download the installer package directly.
            </p>
          </div>

          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] border px-3 py-2 text-xs lexel-mono"
            style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
          >
            <code className="break-all">{INSTALL_CMD}</code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(INSTALL_CMD);
                setCopiedInstall(true);
                window.setTimeout(() => setCopiedInstall(false), 1500);
              }}
              className="shrink-0 rounded-[4px] border px-2.5 py-1 text-[11px] font-medium"
              style={{
                backgroundColor: 'var(--lx-card)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              {copiedInstall ? 'Copied' : 'Copy Command'}
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <a
              href={RELEASES_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center rounded-[6px] border px-3 py-1.5 text-xs font-medium no-underline"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              Download Desktop Installer (.AppImage / .deb / .dmg / .msi)
            </a>

            {extensionId ? (
              <div className="flex items-center gap-2 text-xs">
                <span style={{ color: 'var(--lx-fg-muted)' }}>Extension ID:</span>
                <code
                  className="rounded-[4px] border px-2 py-0.5 lexel-mono text-[11px]"
                  style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
                >
                  {extensionId}
                </code>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(extensionId);
                    setCopiedExtId(true);
                    window.setTimeout(() => setCopiedExtId(false), 1500);
                  }}
                  className="rounded-[4px] border px-2 py-0.5 text-[11px]"
                  style={{
                    backgroundColor: 'var(--lx-surface)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                >
                  {copiedExtId ? 'Copied' : 'Copy ID'}
                </button>
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

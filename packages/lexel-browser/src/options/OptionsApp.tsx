import type { Dialect } from 'harper.js';
import {
  type AiHealthState,
  CloseIcon,
  DoctorHealthCard,
  type DoctorReportData,
  LexelLogo,
  PrivacyProofBadge,
  RefreshIcon,
  StatusPill,
  ThemeToggle,
} from 'lexel-ui';
import { useCallback, useEffect, useState } from 'react';
import { LEXEL_LOGO_SRC } from '../shared/brand';
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
  const [ghostTextEnabled, setGhostTextEnabled] = useState(false);
  const [redactSecrets, setRedactSecrets] = useState(false);
  const [secretBlocks, setSecretBlocks] = useState(0);
  const [crutchWords, setCrutchWords] = useState<string[]>([]);
  const [crutchInput, setCrutchInput] = useState('');
  const [doctorReport, setDoctorReport] = useState<DoctorReportData | null>(null);
  const [doctorLoading, setDoctorLoading] = useState(false);
  const [doctorError, setDoctorError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [copiedInstall, setCopiedInstall] = useState(false);
  const [copiedExtId, setCopiedExtId] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const extensionId = typeof chrome !== 'undefined' ? (chrome.runtime?.id ?? '') : '';

  const loadAll = useCallback(async () => {
    const [
      themeRes,
      aiRes,
      healthRes,
      dialectRes,
      dictRes,
      blockRes,
      slopRes,
      surfacesRes,
      ghostRes,
      privacyRes,
      crutchRes,
    ] = await Promise.all([
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
      chrome.runtime.sendMessage({ kind: 'getGhostTextEnabled' }) as Promise<{ enabled?: boolean }>,
      chrome.runtime.sendMessage({ kind: 'getPrivacyStats' }) as Promise<{
        localSecretBlocks?: number;
        redactSecrets?: boolean;
      }>,
      chrome.runtime.sendMessage({ kind: 'getCrutchWords' }) as Promise<{ words?: string[] }>,
    ]);

    setTheme(themeRes?.theme === 'light' ? 'light' : 'dark');
    setAiSettings(aiRes?.settings ?? null);
    setAiHealth(healthRes ?? null);
    setDialect(dialectRes?.dialect ?? 0);
    setDictCount(dictRes?.words?.length ?? 0);
    setBlocklistCount(blockRes?.domains?.length ?? 0);
    setCustomSlopCount(slopRes?.customTerms?.length ?? 0);
    setCustomSurfaces(surfacesRes?.surfaces ?? []);
    setGhostTextEnabled(ghostRes?.enabled === true);
    setRedactSecrets(privacyRes?.redactSecrets === true);
    setSecretBlocks(privacyRes?.localSecretBlocks ?? 0);
    setCrutchWords(crutchRes?.words ?? []);
  }, []);

  useEffect(() => {
    void loadAll().catch((err) => setErrorMsg(err instanceof Error ? err.message : String(err)));
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
        setNotice('Connected and synced settings, rules, and local AI state from Lexel Desktop.');
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

  async function handleToggleGhostText() {
    const next = !ghostTextEnabled;
    setGhostTextEnabled(next);
    await chrome.runtime.sendMessage({ kind: 'setGhostTextEnabled', enabled: next });
    setNotice(
      next
        ? 'Ghost-text autocomplete enabled. Press Tab to accept local completions, Esc to dismiss.'
        : 'Ghost-text autocomplete turned off.',
    );
  }

  async function handleToggleRedactSecrets() {
    const next = !redactSecrets;
    setRedactSecrets(next);
    await chrome.runtime.sendMessage({ kind: 'setRedactSecrets', enabled: next });
    setNotice(
      next
        ? 'Redact-and-restore enabled. Secrets swap to [LEXEL_REDACTED_n] before local AI.'
        : 'Strict Secrets Guard restored. Rewrites block whenever secrets are detected.',
    );
  }

  async function handleAddCrutchWord(e: React.FormEvent) {
    e.preventDefault();
    const cleaned = crutchInput.trim().toLowerCase();
    if (!cleaned) return;
    if (crutchWords.includes(cleaned)) {
      setCrutchInput('');
      return;
    }
    const next = [...crutchWords, cleaned];
    setCrutchWords(next);
    setCrutchInput('');
    await chrome.runtime.sendMessage({ kind: 'setCrutchWords', words: next });
  }

  async function handleRemoveCrutchWord(word: string) {
    const next = crutchWords.filter((w) => w !== word);
    setCrutchWords(next);
    await chrome.runtime.sendMessage({ kind: 'setCrutchWords', words: next });
  }

  async function handleRunDoctor(bench = false) {
    setDoctorLoading(true);
    setDoctorError(null);
    try {
      const res = (await chrome.runtime.sendMessage({ kind: 'getDoctorReport', bench })) as
        | { ok: true; report: DoctorReportData }
        | { ok: false; error: string };
      if (res?.ok && res.report) {
        setDoctorReport(res.report);
      } else {
        setDoctorError(res && !res.ok ? res.error : 'Could not reach lexel-daemon diagnostics.');
      }
    } catch (err) {
      setDoctorError(err instanceof Error ? err.message : String(err));
    } finally {
      setDoctorLoading(false);
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
    ? `Synced (${aiHealth?.activeProfile?.name ?? 'Default'})`
    : 'Standalone Tier 0';

  return (
    <div data-theme={theme} className="lexel-root min-h-screen">
      <div className="mx-auto max-w-3xl px-6 py-8 flex flex-col gap-6">
        <header
          className="flex flex-wrap sm:flex-nowrap items-start sm:items-center justify-between gap-4 pb-4 border-b"
          style={{ borderColor: 'var(--lx-border)' }}
        >
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <LexelLogo className="h-8 w-auto shrink-0" src={LEXEL_LOGO_SRC} />
            <div className="min-w-0">
              <h1 className="text-lg font-semibold tracking-tight m-0">
                Lexel Browser Bridge &amp; Local Controls
              </h1>
              <p className="text-xs m-0 mt-0.5" style={{ color: 'var(--lx-fg-muted)' }}>
                Zero-daemon Tier 0 runs locally. Sync profiles, rules, and AI models via Lexel
                Desktop.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <StatusPill state={aiState} label={statusLabel} />
            <ThemeToggle theme={theme} onToggle={() => void handleThemeToggle()} />
          </div>
        </header>

        <main className="flex flex-col gap-6">
          {notice ? (
            <div
              role="status"
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

          <section
            aria-label="Privacy and writing controls"
            className="rounded-[8px] border p-5 flex flex-col gap-4"
            style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold m-0">Local Privacy &amp; Inline Writing</h2>
                <p className="text-xs m-0 mt-0.5" style={{ color: 'var(--lx-fg-muted)' }}>
                  CSP restricts network access strictly to loopback 127.0.0.1 and localhost.
                </p>
              </div>
              <PrivacyProofBadge
                localOnly={true}
                blockedSecretsCount={secretBlocks}
                redactEnabled={redactSecrets}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div
                className="rounded-[6px] border p-3.5 flex items-start justify-between gap-3"
                style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
              >
                <div>
                  <div className="text-xs font-semibold">Ghost-text autocomplete</div>
                  <p
                    className="text-[11px] m-0 mt-1 leading-snug"
                    style={{ color: 'var(--lx-fg-muted)' }}
                  >
                    Opt-in local continuation (max 24 tokens). Press Tab to accept, Esc to dismiss.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={ghostTextEnabled}
                  onClick={() => void handleToggleGhostText()}
                  className={`lx-pressable px-3 py-1 text-xs font-semibold lexel-mono shrink-0 ${
                    ghostTextEnabled ? 'lx-btn-primary' : 'lx-btn-secondary'
                  }`}
                >
                  {ghostTextEnabled ? 'On' : 'Off'}
                </button>
              </div>

              <div
                className="rounded-[6px] border p-3.5 flex items-start justify-between gap-3"
                style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
              >
                <div>
                  <div className="text-xs font-semibold">Secret redact-and-restore</div>
                  <p
                    className="text-[11px] m-0 mt-1 leading-snug"
                    style={{ color: 'var(--lx-fg-muted)' }}
                  >
                    Mask detected API keys and PII locally before AI instead of hard-blocking.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={redactSecrets}
                  onClick={() => void handleToggleRedactSecrets()}
                  className={`lx-pressable px-3 py-1 text-xs font-semibold lexel-mono shrink-0 ${
                    redactSecrets ? 'lx-btn-primary' : 'lx-btn-secondary'
                  }`}
                >
                  {redactSecrets ? 'On' : 'Strict'}
                </button>
              </div>
            </div>

            <div
              className="rounded-[6px] border p-3.5 flex flex-col gap-2.5"
              style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
            >
              <div>
                <div className="text-xs font-semibold">Personal crutch-word bans</div>
                <p className="text-[11px] m-0 mt-0.5" style={{ color: 'var(--lx-fg-muted)' }}>
                  Flag overused filler words (e.g. just, actually, basically, honestly) across every
                  surface.
                </p>
              </div>
              <form className="flex gap-2" onSubmit={(e) => void handleAddCrutchWord(e)}>
                <label htmlFor="lexel-crutch-input" className="sr-only">
                  Add crutch word to ban
                </label>
                <input
                  id="lexel-crutch-input"
                  type="text"
                  value={crutchInput}
                  onChange={(e) => setCrutchInput(e.target.value)}
                  placeholder="Add word (e.g. actually)"
                  className="flex-1 rounded-[6px] border px-2.5 py-1.5 text-xs"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
                <button
                  type="submit"
                  className="lx-pressable lx-btn-primary px-3 py-1.5 text-xs font-semibold"
                >
                  Ban word
                </button>
              </form>
              {crutchWords.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {crutchWords.map((word) => (
                    <span
                      key={word}
                      className="inline-flex items-center gap-1 rounded-[4px] border px-2 py-0.5 text-[11px] lexel-mono"
                      style={{
                        backgroundColor: 'var(--lx-card)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    >
                      <span>{word}</span>
                      <button
                        type="button"
                        onClick={() => void handleRemoveCrutchWord(word)}
                        aria-label={`Remove ${word} from crutch words`}
                        className="lx-btn-ghost inline-flex h-4 w-4 items-center justify-center"
                      >
                        <CloseIcon className="w-2.5 h-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] m-0" style={{ color: 'var(--lx-fg-muted)' }}>
                  No personal crutch words banned yet. Add one above to flag it while typing.
                </p>
              )}
            </div>
          </section>

          <section
            aria-label="Desktop bridge connection"
            className="rounded-[8px] border p-5 flex flex-col gap-4"
            style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
          >
            <div className="flex flex-wrap sm:flex-nowrap items-start sm:items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold m-0">
                  {connected ? 'Synced with Lexel Desktop' : 'Standalone Tier 0 Active'}
                </h2>
                <p className="text-xs m-0 mt-1" style={{ color: 'var(--lx-fg-muted)' }}>
                  {connected
                    ? 'Grammar rules, personal dictionary, surface prompts, and local AI settings sync from lexel.db.'
                    : 'Harper grammar, anti-slop, consistency, BLUF, Regret Shield, and Secrets Guard work with 0 MB AI RAM.'}
                </p>
              </div>
              <button
                type="button"
                disabled={syncing}
                onClick={() => void handleConnectAndSync()}
                className="lx-pressable lx-btn-primary inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold shrink-0"
              >
                <RefreshIcon className="w-3.5 h-3.5" />
                <span>
                  {syncing
                    ? 'Syncing...'
                    : connected
                      ? 'Sync from Desktop'
                      : 'Connect to Lexel Desktop'}
                </span>
              </button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div
                className="rounded-[6px] border p-3 text-xs"
                style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
              >
                <div style={{ color: 'var(--lx-fg-muted)' }}>Active Profile</div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="font-semibold lexel-mono">
                    {aiHealth?.activeProfile?.name ?? 'Local Browser'}
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
                <div style={{ color: 'var(--lx-fg-muted)' }}>Local AI Runtime</div>
                <div className="mt-1 font-semibold lexel-mono">
                  {!connected
                    ? 'Desktop offline (Tier 0 only)'
                    : !aiSettings?.enabled
                      ? 'Disabled in Desktop (0 MB RAM)'
                      : aiHealth?.loadedModel
                        ? `${aiHealth.loadedModel} (${aiHealth.runtimeBackend ?? 'daemon'})`
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
                <div className="mt-1 lexel-mono lx-tab-nums">
                  {dictCount} dict · {customSlopCount} slop · {customSurfaces.length} surfaces ·{' '}
                  {blocklistCount} blocked
                </div>
              </div>
            </div>
          </section>

          <DoctorHealthCard
            report={doctorReport}
            loading={doctorLoading}
            error={doctorError}
            onRunCheck={(bench) => void handleRunDoctor(Boolean(bench))}
          />

          <section
            aria-label="Install Lexel Desktop"
            className="rounded-[8px] border p-5 flex flex-col gap-3"
            style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
          >
            <div>
              <h2 className="text-sm font-semibold m-0">
                Install Lexel Desktop &amp; Native Messaging Bridge
              </h2>
              <p className="text-xs m-0 mt-1" style={{ color: 'var(--lx-fg-muted)' }}>
                Install the local daemon and Native Messaging host on Linux or macOS, or grab a
                release package directly.
              </p>
            </div>

            <div
              className="flex items-center justify-between gap-3 rounded-[6px] border px-3 py-2 text-xs lexel-mono"
              style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
            >
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap">
                {INSTALL_CMD}
              </code>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(INSTALL_CMD);
                  setCopiedInstall(true);
                  window.setTimeout(() => setCopiedInstall(false), 1500);
                }}
                className="lx-pressable lx-btn-secondary shrink-0 px-2.5 py-1 text-[11px] font-medium"
              >
                {copiedInstall ? 'Copied' : 'Copy Command'}
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <a
                href={RELEASES_URL}
                target="_blank"
                rel="noreferrer"
                className="lx-pressable lx-btn-secondary inline-flex items-center px-3 py-1.5 text-xs font-medium no-underline"
              >
                Download Desktop Installer (.AppImage / .deb / .dmg / .msi)
              </a>

              {extensionId ? (
                <div className="flex items-center gap-2 text-xs">
                  <span style={{ color: 'var(--lx-fg-muted)' }}>Extension ID:</span>
                  <code
                    className="rounded-[4px] border px-2 py-0.5 lexel-mono text-[11px]"
                    style={{
                      backgroundColor: 'var(--lx-surface)',
                      borderColor: 'var(--lx-border)',
                    }}
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
                    className="lx-pressable lx-btn-secondary px-2 py-0.5 text-[11px]"
                  >
                    {copiedExtId ? 'Copied' : 'Copy ID'}
                  </button>
                </div>
              ) : null}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

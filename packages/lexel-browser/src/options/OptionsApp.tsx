import type { Dialect } from 'harper.js';
import { NibIcon, StatusPill, ThemeToggle } from 'lexel-ui';
import React, { useEffect, useState } from 'react';
import type { LocalAiHealth } from '../shared/localAiClient';
import { SURFACE_PROFILES } from '../shared/surfaceDetector';
import type { ActivationKey, AiSettings, VoiceExample } from '../shared/types';

type TabId = 'ai' | 'rules' | 'privacy';

export function OptionsApp() {
  const [tab, setTab] = useState<TabId>('ai');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [aiHealth, setAiHealth] = useState<LocalAiHealth | null>(null);
  const [dialect, setDialect] = useState<Dialect>(0);
  const [isolateEnglish, setIsolateEnglish] = useState(false);
  const [hoverPopup, setHoverPopup] = useState(true);
  const [activationKey, setActivationKey] = useState<ActivationKey>('off');
  const [delayMs, setDelayMs] = useState(0);
  const [dictionaryText, setDictionaryText] = useState('');
  const [blocklistText, setBlocklistText] = useState('');
  const [voiceExamples, setVoiceExamples] = useState<VoiceExample[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  async function loadAll() {
    const [
      themeRes,
      aiRes,
      healthRes,
      dialectRes,
      isoRes,
      hoverRes,
      actRes,
      delayRes,
      dictRes,
      blockRes,
      voiceRes,
    ] = await Promise.all([
      chrome.runtime.sendMessage({ kind: 'getTheme' }) as Promise<{ theme: 'dark' | 'light' }>,
      chrome.runtime.sendMessage({ kind: 'getAiSettings' }) as Promise<{ settings: AiSettings }>,
      chrome.runtime.sendMessage({ kind: 'aiHealth' }) as Promise<LocalAiHealth>,
      chrome.runtime.sendMessage({ kind: 'getDialect' }) as Promise<{ dialect: Dialect }>,
      chrome.runtime.sendMessage({ kind: 'getIsolateEnglish' }) as Promise<{
        isolateEnglish: boolean;
      }>,
      chrome.runtime.sendMessage({ kind: 'getOpenSuggestionsOnHover' }) as Promise<{
        enabled: boolean;
      }>,
      chrome.runtime.sendMessage({ kind: 'getActivationKey' }) as Promise<{ key: ActivationKey }>,
      chrome.runtime.sendMessage({ kind: 'getDelay' }) as Promise<{ delay: number }>,
      chrome.runtime.sendMessage({ kind: 'getUserDictionary' }) as Promise<{ words: string[] }>,
      chrome.runtime.sendMessage({ kind: 'getPrivacyBlocklist' }) as Promise<{
        domains: string[];
      }>,
      chrome.runtime.sendMessage({ kind: 'getVoiceExamples' }) as Promise<{
        examples: VoiceExample[];
      }>,
    ]);

    setTheme(themeRes.theme);
    setAiSettings(aiRes.settings);
    setAiHealth(healthRes);
    setDialect(dialectRes.dialect);
    setIsolateEnglish(isoRes.isolateEnglish);
    setHoverPopup(hoverRes.enabled);
    setActivationKey(actRes.key);
    setDelayMs(delayRes.delay);
    setDictionaryText(dictRes.words.join('\n'));
    setBlocklistText(blockRes.domains.join('\n'));
    setVoiceExamples(voiceRes.examples);
  }

  useEffect(() => {
    void loadAll();
  }, []);

  async function saveAi(next: AiSettings) {
    setAiSettings(next);
    await chrome.runtime.sendMessage({ kind: 'setAiSettings', settings: next });
    const health = (await chrome.runtime.sendMessage({ kind: 'aiHealth' })) as LocalAiHealth;
    setAiHealth(health);
    setNotice('Local AI settings saved.');
  }

  async function saveGeneralRules() {
    await Promise.all([
      chrome.runtime.sendMessage({ kind: 'setDialect', dialect }),
      chrome.runtime.sendMessage({ kind: 'setIsolateEnglish', isolateEnglish }),
      chrome.runtime.sendMessage({ kind: 'setOpenSuggestionsOnHover', enabled: hoverPopup }),
      chrome.runtime.sendMessage({ kind: 'setActivationKey', key: activationKey }),
      chrome.runtime.sendMessage({ kind: 'setDelay', delay: delayMs }),
    ]);
    setNotice('Grammar and editor rules saved.');
  }

  async function savePrivacyAndDict() {
    const words = dictionaryText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const domains = blocklistText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    await Promise.all([
      chrome.runtime.sendMessage({ kind: 'setUserDictionary', words }),
      chrome.runtime.sendMessage({ kind: 'setPrivacyBlocklist', domains }),
    ]);
    setNotice('Dictionary and privacy blocklist saved.');
  }

  async function handleExport() {
    const res = (await chrome.runtime.sendMessage({ kind: 'exportAllData' })) as { data: unknown };
    const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lexel-local-backup.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handlePurge() {
    await chrome.runtime.sendMessage({ kind: 'purgeAllData' });
    await loadAll();
    setNotice('All local Lexel settings and voice memory purged.');
  }

  return (
    <div data-theme={theme} className="lexel-root min-h-screen p-6">
      <div className="max-w-3xl mx-auto flex flex-col gap-5">
        <header className="flex items-center justify-between gap-3 pb-3 border-b" style={{ borderColor: 'var(--lx-border)' }}>
          <div className="flex items-center gap-2.5">
            <NibIcon className="w-5 h-5" />
            <div>
              <h1 className="text-lg font-semibold m-0">Lexel Settings</h1>
              <p className="text-xs m-0" style={{ color: 'var(--lx-fg-muted)' }}>
                100% local grammar engine and private AI assistant
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <StatusPill
              state={
                !aiSettings?.enabled
                  ? 'offline'
                  : aiHealth?.ok && aiHealth.modelAvailable !== false
                    ? 'ready'
                    : 'error'
              }
              label={
                !aiSettings?.enabled
                  ? 'AI Off'
                  : aiHealth?.ok && aiHealth.modelAvailable !== false
                    ? 'Local AI Connected'
                    : aiHealth?.ok
                      ? 'Model Missing'
                      : 'Local AI Offline'
              }
            />
            <ThemeToggle
              theme={theme}
              onToggle={async () => {
                const next = theme === 'dark' ? 'light' : 'dark';
                setTheme(next);
                await chrome.runtime.sendMessage({ kind: 'setTheme', theme: next });
              }}
            />
          </div>
        </header>

        <nav className="flex gap-2" aria-label="Settings sections">
          {(
            [
              { id: 'ai', label: 'Local AI' },
              { id: 'rules', label: 'Surfaces & Grammar' },
              { id: 'privacy', label: 'Voice Memory & Privacy' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className="rounded-[6px] border px-3 py-1.5 text-xs font-medium"
              style={{
                backgroundColor: tab === item.id ? 'var(--lx-accent)' : 'var(--lx-card)',
                borderColor: 'var(--lx-border)',
                color: tab === item.id ? 'var(--lx-on-accent)' : 'var(--lx-fg)',
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {notice ? (
          <div
            className="rounded-[6px] border px-3 py-2 text-xs"
            style={{
              backgroundColor: 'var(--lx-card)',
              borderColor: 'var(--lx-accent)',
              color: 'var(--lx-accent)',
            }}
          >
            {notice}
          </div>
        ) : null}

        {tab === 'ai' && aiSettings ? (
          <section
            className="rounded-[8px] border p-4 flex flex-col gap-3"
            style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Enable Local AI Rewrites</span>
              <input
                type="checkbox"
                checked={aiSettings.enabled}
                onChange={(e) => void saveAi({ ...aiSettings, enabled: e.target.checked })}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-xs">
                <span>Provider</span>
                <select
                  value={aiSettings.provider}
                  onChange={(e) =>
                    setAiSettings({
                      ...aiSettings,
                      provider: e.target.value as AiSettings['provider'],
                      endpoint:
                        e.target.value === 'ollama'
                          ? 'http://127.0.0.1:11434'
                          : 'http://127.0.0.1:8080',
                    })
                  }
                  className="rounded-[6px] border px-2.5 py-1.5 text-xs"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                >
                  <option value="ollama">Ollama (127.0.0.1:11434)</option>
                  <option value="openai_compat">Local OpenAI-Compat (llama-server / lexel-daemon)</option>
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span>Localhost Endpoint</span>
                <input
                  type="text"
                  value={aiSettings.endpoint}
                  onChange={(e) => setAiSettings({ ...aiSettings, endpoint: e.target.value })}
                  className="rounded-[6px] border px-2.5 py-1.5 text-xs lexel-mono"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span>Model Name</span>
                <input
                  type="text"
                  value={aiSettings.model}
                  onChange={(e) => setAiSettings({ ...aiSettings, model: e.target.value })}
                  className="rounded-[6px] border px-2.5 py-1.5 text-xs lexel-mono"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span>Temperature ({aiSettings.temperature})</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={aiSettings.temperature}
                  onChange={(e) =>
                    setAiSettings({ ...aiSettings, temperature: Number.parseFloat(e.target.value) })
                  }
                />
              </label>
            </div>

            {aiHealth?.error ? (
              <div
                className="rounded-[6px] border p-2.5 text-xs"
                style={{
                  backgroundColor: 'var(--lx-warn-bg)',
                  borderColor: 'var(--lx-warn)',
                  color: 'var(--lx-warn)',
                }}
              >
                {aiHealth.error}
              </div>
            ) : null}

            {aiHealth?.models.length ? (
              <div className="text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
                Detected local models: <span className="lexel-mono">{aiHealth.models.join(', ')}</span>
              </div>
            ) : (
              <div
                className="rounded-[6px] border p-2.5 text-xs space-y-1 lexel-mono"
                style={{
                  backgroundColor: 'var(--lx-bg)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg-muted)',
                }}
              >
                <div>Quick start with base Qwen2.5-1.5B (Ollama):</div>
                <div>OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*" ollama serve</div>
                <div>ollama pull qwen2.5:1.5b</div>
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => void saveAi(aiSettings)}
                className="rounded-[6px] px-3 py-1.5 text-xs font-semibold"
                style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
              >
                Save & Test Connection
              </button>
            </div>
          </section>
        ) : null}

        {tab === 'rules' ? (
          <section
            className="rounded-[8px] border p-4 flex flex-col gap-4"
            style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-xs">
                <span>English Dialect</span>
                <select
                  value={dialect}
                  onChange={(e) => setDialect(Number(e.target.value) as Dialect)}
                  className="rounded-[6px] border px-2.5 py-1.5 text-xs"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
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

              <label className="flex flex-col gap-1 text-xs">
                <span>Activation Key Guard</span>
                <select
                  value={activationKey}
                  onChange={(e) => setActivationKey(e.target.value as ActivationKey)}
                  className="rounded-[6px] border px-2.5 py-1.5 text-xs"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                >
                  <option value="off">Off (always lint)</option>
                  <option value="shift">Hold Shift</option>
                  <option value="control">Hold Control</option>
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span>Lint Delay (ms)</span>
                <input
                  type="number"
                  min={0}
                  max={2000}
                  value={delayMs}
                  onChange={(e) => setDelayMs(Number.parseInt(e.target.value || '0', 10))}
                  className="rounded-[6px] border px-2.5 py-1.5 text-xs lexel-mono"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
              </label>

              <div className="flex flex-col justify-end gap-2 text-xs">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={isolateEnglish}
                    onChange={(e) => setIsolateEnglish(e.target.checked)}
                  />
                  <span>Isolate English in mixed-language text</span>
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={hoverPopup}
                    onChange={(e) => setHoverPopup(e.target.checked)}
                  />
                  <span>Open underline suggestions on hover</span>
                </label>
              </div>
            </div>

            <button
              type="button"
              onClick={() => void saveGeneralRules()}
              className="self-start rounded-[6px] px-3 py-1.5 text-xs font-semibold"
              style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
            >
              Save Grammar Settings
            </button>

            <div className="border-t pt-3" style={{ borderColor: 'var(--lx-border)' }}>
              <h2 className="text-sm font-semibold m-0 mb-2">Built-in Surface Profiles</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {SURFACE_PROFILES.map((p) => (
                  <div
                    key={p.id}
                    className="rounded-[6px] border p-2.5 text-xs space-y-1"
                    style={{ backgroundColor: 'var(--lx-bg)', borderColor: 'var(--lx-border)' }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">{p.label}</span>
                      <span className="lexel-mono text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                        max {p.maxChars} chars
                      </span>
                    </div>
                    <p className="m-0 text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                      {p.promptDirective}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        {tab === 'privacy' ? (
          <section
            className="rounded-[8px] border p-4 flex flex-col gap-4"
            style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-xs">
                <span>Custom User Dictionary (one word per line)</span>
                <textarea
                  rows={6}
                  value={dictionaryText}
                  onChange={(e) => setDictionaryText(e.target.value)}
                  className="rounded-[6px] border p-2 text-xs lexel-mono"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span>Privacy Blocklist Domains (one per line)</span>
                <textarea
                  rows={6}
                  value={blocklistText}
                  onChange={(e) => setBlocklistText(e.target.value)}
                  className="rounded-[6px] border p-2 text-xs lexel-mono"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
              </label>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void savePrivacyAndDict()}
                className="rounded-[6px] px-3 py-1.5 text-xs font-semibold"
                style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
              >
                Save Dictionary & Blocklist
              </button>
              <button
                type="button"
                onClick={() => void handleExport()}
                className="rounded-[6px] border px-3 py-1.5 text-xs font-medium"
                style={{
                  backgroundColor: 'var(--lx-muted)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              >
                Export Local JSON
              </button>
              <button
                type="button"
                onClick={() => void handlePurge()}
                className="ml-auto rounded-[6px] border px-3 py-1.5 text-xs font-medium"
                style={{
                  backgroundColor: 'var(--lx-danger-bg)',
                  borderColor: 'var(--lx-danger)',
                  color: 'var(--lx-danger)',
                }}
              >
                Purge All Local Data
              </button>
            </div>

            <div className="border-t pt-3" style={{ borderColor: 'var(--lx-border)' }}>
              <h2 className="text-sm font-semibold m-0 mb-2">
                Local Voice Memory ({voiceExamples.length})
              </h2>
              {voiceExamples.length === 0 ? (
                <p className="text-xs m-0" style={{ color: 'var(--lx-fg-muted)' }}>
                  No accepted rewrites stored yet. Accepting a local AI rewrite saves a few-shot style example here on your device.
                </p>
              ) : (
                <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
                  {voiceExamples.map((ex) => (
                    <div
                      key={ex.id}
                      className="rounded-[6px] border p-2.5 text-xs flex items-start justify-between gap-2"
                      style={{ backgroundColor: 'var(--lx-bg)', borderColor: 'var(--lx-border)' }}
                    >
                      <div className="space-y-1">
                        <div className="lexel-mono text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                          {ex.surfaceId}
                          {ex.subcontext ? ` / ${ex.subcontext}` : ''}
                        </div>
                        <div>{ex.rewritten}</div>
                      </div>
                      <button
                        type="button"
                        onClick={async () => {
                          await chrome.runtime.sendMessage({ kind: 'deleteVoiceExample', id: ex.id });
                          setVoiceExamples((prev) => prev.filter((item) => item.id !== ex.id));
                        }}
                        className="text-[11px]"
                        style={{ color: 'var(--lx-danger)' }}
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

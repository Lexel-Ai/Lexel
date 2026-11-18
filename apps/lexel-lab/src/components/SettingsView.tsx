import type { Dialect, LintConfig } from 'harper.js';
import { StatusPill } from 'lexel-ui';
import React, { useMemo, useRef, useState } from 'react';
import type { LocalAiHealth } from '../lib/localAi';
import { SURFACE_PROFILES } from '../lib/surfaces';
import type { ActivationKey, AiSettings, LabSettingsState } from '../lib/types';
import { SLOP_TERMS } from '../lib/verifier';

type SettingsTab = 'grammar' | 'ai' | 'data';

function stripHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export interface SettingsViewProps {
  state: LabSettingsState;
  aiHealth: LocalAiHealth | null;
  ruleConfig: LintConfig;
  defaultRuleConfig: LintConfig;
  ruleDescriptions: Record<string, string>;
  onUpdateState: (updater: (prev: LabSettingsState) => LabSettingsState) => void;
  onTestAi: (settings: AiSettings) => Promise<void>;
  onRuleChange: (ruleId: string, value: boolean | null) => Promise<void>;
  onResetAllRules: () => Promise<void>;
  onClearIgnoredLints: () => Promise<void>;
  onExportJson: () => void;
  onImportJson: (text: string) => void;
  onPurgeAll: () => void;
  onBackToEditor: () => void;
}

export function SettingsView({
  state,
  aiHealth,
  ruleConfig,
  defaultRuleConfig,
  ruleDescriptions,
  onUpdateState,
  onTestAi,
  onRuleChange,
  onResetAllRules,
  onClearIgnoredLints,
  onExportJson,
  onImportJson,
  onPurgeAll,
  onBackToEditor,
}: SettingsViewProps) {
  const [tab, setTab] = useState<SettingsTab>('grammar');
  const [ruleSearch, setRuleSearch] = useState('');
  const [dictDraft, setDictDraft] = useState(() => state.userDictionary.join('\n'));
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const ruleEntries = useMemo(() => {
    const q = ruleSearch.trim().toLowerCase();
    return Object.keys(defaultRuleConfig)
      .sort()
      .filter((id) => {
        if (!q) return true;
        const desc = ruleDescriptions[id] ? stripHtml(ruleDescriptions[id]).toLowerCase() : '';
        return id.toLowerCase().includes(q) || desc.includes(q);
      })
      .map((id) => {
        const currentVal = ruleConfig[id] !== undefined ? ruleConfig[id] : defaultRuleConfig[id];
        const effectiveEnabled = currentVal !== false;
        const desc = ruleDescriptions[id] ? stripHtml(ruleDescriptions[id]) : 'Harper grammar rule.';
        return { id, effectiveEnabled, rawValue: ruleConfig[id], desc };
      });
  }, [ruleConfig, defaultRuleConfig, ruleDescriptions, ruleSearch]);

  const aiState = !state.aiSettings.enabled
    ? 'offline'
    : aiHealth?.ok && aiHealth.modelAvailable !== false
      ? 'ready'
      : aiHealth
        ? 'error'
        : 'loading';

  const aiLabel = !state.aiSettings.enabled
    ? 'AI Off'
    : aiHealth?.ok && aiHealth.modelAvailable !== false
      ? `${state.aiSettings.model} Ready`
      : aiHealth?.ok
        ? 'Model Missing'
        : 'Local AI Offline';

  return (
    <div className="max-w-5xl mx-auto flex flex-col gap-4 w-full">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Lab settings tabs">
          {(
            [
              { id: 'grammar', label: 'Grammar, Rules & Surfaces' },
              { id: 'ai', label: 'Local AI Engine' },
              { id: 'data', label: 'Dictionary, Voice Memory & Backup' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
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
        </div>
        <button
          type="button"
          onClick={onBackToEditor}
          className="rounded-[6px] border px-3 py-1.5 text-xs font-medium"
          style={{
            backgroundColor: 'var(--lx-muted)',
            borderColor: 'var(--lx-border)',
            color: 'var(--lx-fg)',
          }}
        >
          Back to Lab Editor
        </button>
      </div>

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

      {tab === 'grammar' ? (
        <div className="flex flex-col gap-4">
          <section
            className="rounded-[8px] border p-4 grid grid-cols-1 md:grid-cols-3 gap-3"
            style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
          >
            <label className="flex flex-col gap-1 text-xs">
              <span style={{ color: 'var(--lx-fg-muted)' }}>English Dialect</span>
              <select
                value={state.dialect}
                onChange={(e) => {
                  const next = Number(e.target.value) as Dialect;
                  onUpdateState((prev) => ({ ...prev, dialect: next }));
                }}
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
              <span style={{ color: 'var(--lx-fg-muted)' }}>Activation Key Guard (double-tap)</span>
              <select
                value={state.activationKey}
                onChange={(e) => {
                  const next = e.target.value as ActivationKey;
                  onUpdateState((prev) => ({ ...prev, activationKey: next }));
                }}
                className="rounded-[6px] border px-2.5 py-1.5 text-xs"
                style={{
                  backgroundColor: 'var(--lx-bg)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              >
                <option value="off">Off (click or hover)</option>
                <option value="shift">Hold Shift (double-tap)</option>
                <option value="control">Hold Control (double-tap)</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs">
              <span style={{ color: 'var(--lx-fg-muted)' }}>Lint Delay (ms)</span>
              <input
                type="number"
                min={0}
                max={2000}
                step={25}
                value={state.delayMs}
                onChange={(e) => {
                  const val = Math.max(0, Math.min(2000, Number.parseInt(e.target.value || '0', 10)));
                  onUpdateState((prev) => ({ ...prev, delayMs: Number.isNaN(val) ? 0 : val }));
                }}
                className="rounded-[6px] border px-2.5 py-1.5 text-xs lexel-mono"
                style={{
                  backgroundColor: 'var(--lx-bg)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
            </label>

            <label className="inline-flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={state.openSuggestionsOnHover}
                onChange={(e) =>
                  onUpdateState((prev) => ({ ...prev, openSuggestionsOnHover: e.target.checked }))
                }
              />
              <span>Open underline suggestions on hover</span>
            </label>

            <label className="inline-flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={state.isolateEnglish}
                onChange={(e) =>
                  onUpdateState((prev) => ({ ...prev, isolateEnglish: e.target.checked }))
                }
              />
              <span>Isolate English in mixed-language text</span>
            </label>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  void onClearIgnoredLints().then(() => setNotice('Cleared ignored lints.'));
                }}
                className="rounded-[6px] border px-2.5 py-1 text-xs"
                style={{
                  backgroundColor: 'var(--lx-muted)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              >
                Clear ignored lints
              </button>
            </div>
          </section>

          <section
            className="rounded-[8px] border p-4 flex flex-col gap-3"
            style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold m-0">
                  Harper Grammar Rules ({ruleEntries.length})
                </h2>
                <p className="text-xs m-0" style={{ color: 'var(--lx-fg-muted)' }}>
                  Toggle individual deterministic rules live inside the Lab.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="search"
                  value={ruleSearch}
                  onChange={(e) => setRuleSearch(e.target.value)}
                  placeholder="Filter rules..."
                  aria-label="Filter grammar rules"
                  className="rounded-[6px] border px-2.5 py-1 text-xs"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    void onResetAllRules().then(() => setNotice('Reset all grammar rules to defaults.'));
                  }}
                  className="rounded-[6px] border px-2.5 py-1 text-xs"
                  style={{
                    backgroundColor: 'var(--lx-muted)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                >
                  Reset defaults
                </button>
              </div>
            </div>

            {ruleEntries.length === 0 ? (
              <div className="text-xs py-4" style={{ color: 'var(--lx-fg-muted)' }}>
                {Object.keys(defaultRuleConfig).length === 0
                  ? 'Loading Harper rule catalog...'
                  : 'No grammar rules match your filter.'}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-96 overflow-y-auto pr-1">
                {ruleEntries.map((rule) => (
                  <label
                    key={rule.id}
                    className="rounded-[6px] border p-2.5 flex items-start justify-between gap-2 text-xs"
                    style={{ backgroundColor: 'var(--lx-bg)', borderColor: 'var(--lx-border)' }}
                  >
                    <div className="min-w-0">
                      <div className="font-semibold lexel-mono truncate">{rule.id}</div>
                      <div className="text-[11px] leading-snug mt-0.5" style={{ color: 'var(--lx-fg-muted)' }}>
                        {rule.desc}
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={rule.effectiveEnabled}
                      onChange={(e) => void onRuleChange(rule.id, e.target.checked)}
                    />
                  </label>
                ))}
              </div>
            )}
          </section>

          <section
            className="rounded-[8px] border p-4 flex flex-col gap-3"
            style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
          >
            <h2 className="text-sm font-semibold m-0">
              Lexel Anti-Slop Lexicon ({SLOP_TERMS.length} terms) &amp; Surface Profiles ({SURFACE_PROFILES.length})
            </h2>
            <div className="flex flex-wrap gap-1.5">
              {SLOP_TERMS.map((term) => (
                <span
                  key={term}
                  className="rounded-[4px] border px-2 py-0.5 text-[11px] lexel-mono"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg-muted)',
                  }}
                >
                  {term}
                </span>
              ))}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {SURFACE_PROFILES.map((p) => (
                <div
                  key={p.id}
                  className="rounded-[6px] border p-2.5 text-xs space-y-1"
                  style={{ backgroundColor: 'var(--lx-bg)', borderColor: 'var(--lx-border)' }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{p.label}</span>
                    <span className="lexel-mono text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                      {p.minChars}-{p.maxChars} chars
                    </span>
                  </div>
                  <div className="text-[11px] lexel-mono" style={{ color: 'var(--lx-fg-muted)' }}>
                    links:{p.allowLinks ? 'yes' : 'no'} · emojis:{p.allowEmojis ? 'yes' : 'no'} ·
                    hashtags:{p.allowHashtags ? 'yes' : 'no'} · em-dash:{p.allowEmDashes ? 'yes' : 'no'}
                  </div>
                  <p className="m-0 text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                    {p.promptDirective}
                  </p>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      {tab === 'ai' ? (
        <section
          className="rounded-[8px] border p-4 flex flex-col gap-3"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Enable Local AI Rewrites</span>
              <StatusPill state={aiState} label={aiLabel} />
            </div>
            <input
              type="checkbox"
              checked={state.aiSettings.enabled}
              onChange={(e) => {
                const nextAi = { ...state.aiSettings, enabled: e.target.checked };
                onUpdateState((prev) => ({ ...prev, aiSettings: nextAi }));
                void onTestAi(nextAi);
              }}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <span>Provider</span>
              <select
                value={state.aiSettings.provider}
                onChange={(e) => {
                  const provider = e.target.value as AiSettings['provider'];
                  const endpoint =
                    provider === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:8080';
                  onUpdateState((prev) => ({
                    ...prev,
                    aiSettings: { ...prev.aiSettings, provider, endpoint },
                  }));
                }}
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
                value={state.aiSettings.endpoint}
                onChange={(e) =>
                  onUpdateState((prev) => ({
                    ...prev,
                    aiSettings: { ...prev.aiSettings, endpoint: e.target.value },
                  }))
                }
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
                value={state.aiSettings.model}
                onChange={(e) =>
                  onUpdateState((prev) => ({
                    ...prev,
                    aiSettings: { ...prev.aiSettings, model: e.target.value },
                  }))
                }
                className="rounded-[6px] border px-2.5 py-1.5 text-xs lexel-mono"
                style={{
                  backgroundColor: 'var(--lx-bg)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
            </label>

            <label className="flex flex-col gap-1 text-xs">
              <span>Max Tokens ({state.aiSettings.maxTokens})</span>
              <input
                type="number"
                min={64}
                max={1024}
                step={32}
                value={state.aiSettings.maxTokens}
                onChange={(e) =>
                  onUpdateState((prev) => ({
                    ...prev,
                    aiSettings: {
                      ...prev.aiSettings,
                      maxTokens: Math.max(64, Number.parseInt(e.target.value || '280', 10)),
                    },
                  }))
                }
                className="rounded-[6px] border px-2.5 py-1.5 text-xs lexel-mono"
                style={{
                  backgroundColor: 'var(--lx-bg)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
            </label>

            <label className="flex flex-col gap-1 text-xs">
              <span>Temperature ({state.aiSettings.temperature})</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={state.aiSettings.temperature}
                onChange={(e) =>
                  onUpdateState((prev) => ({
                    ...prev,
                    aiSettings: {
                      ...prev.aiSettings,
                      temperature: Number.parseFloat(e.target.value),
                    },
                  }))
                }
              />
            </label>

            <label className="inline-flex items-center gap-2 text-xs self-end pb-1">
              <input
                type="checkbox"
                checked={state.aiSettings.saveVoiceMemory}
                onChange={(e) =>
                  onUpdateState((prev) => ({
                    ...prev,
                    aiSettings: { ...prev.aiSettings, saveVoiceMemory: e.target.checked },
                  }))
                }
              />
              <span>Save accepted rewrites to local Voice Memory</span>
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
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span style={{ color: 'var(--lx-fg-muted)' }}>Detected models:</span>
              {aiHealth.models.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    const nextAi = { ...state.aiSettings, model: m };
                    onUpdateState((prev) => ({ ...prev, aiSettings: nextAi }));
                    void onTestAi(nextAi);
                  }}
                  className="rounded-[4px] border px-2 py-0.5 text-[11px] lexel-mono"
                  style={{
                    backgroundColor:
                      state.aiSettings.model === m ? 'var(--lx-accent)' : 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: state.aiSettings.model === m ? 'var(--lx-on-accent)' : 'var(--lx-fg)',
                  }}
                >
                  {m}
                </button>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                void onTestAi(state.aiSettings).then(() => setNotice('Tested local AI connection.'));
              }}
              className="rounded-[6px] px-3 py-1.5 text-xs font-semibold"
              style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
            >
              Save &amp; Test Connection
            </button>
          </div>
        </section>
      ) : null}

      {tab === 'data' ? (
        <section
          className="rounded-[8px] border p-4 flex flex-col gap-4"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium">Custom User Dictionary (one word per line)</span>
              <textarea
                rows={5}
                value={dictDraft}
                onChange={(e) => setDictDraft(e.target.value)}
                placeholder="Weirpack&#10;Lexel&#10;Ollama"
                className="rounded-[6px] border p-2 text-xs lexel-mono"
                style={{
                  backgroundColor: 'var(--lx-bg)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  const words = [
                    ...new Set(
                      dictDraft
                        .split('\n')
                        .map((w) => w.trim())
                        .filter(Boolean),
                    ),
                  ];
                  onUpdateState((prev) => ({ ...prev, userDictionary: words }));
                  setNotice(`Saved ${words.length} custom dictionary word(s).`);
                }}
                className="rounded-[6px] px-3 py-1.5 text-xs font-semibold"
                style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
              >
                Save Dictionary
              </button>
              <button
                type="button"
                onClick={onExportJson}
                className="rounded-[6px] border px-3 py-1.5 text-xs font-medium"
                style={{
                  backgroundColor: 'var(--lx-muted)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              >
                Export Backup (.json)
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="rounded-[6px] border px-3 py-1.5 text-xs font-medium"
                style={{
                  backgroundColor: 'var(--lx-muted)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              >
                Import Backup (.json)
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  void file.text().then((txt) => {
                    onImportJson(txt);
                    setNotice('Imported Lab settings backup.');
                  });
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => {
                  onPurgeAll();
                  setDictDraft('');
                  setNotice('Purged all local Lab settings and Voice Memory.');
                }}
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
          </div>

          <div className="border-t pt-3" style={{ borderColor: 'var(--lx-border)' }}>
            <h2 className="text-sm font-semibold m-0 mb-2">
              Local Voice Memory ({state.voiceExamples.length})
            </h2>
            {state.voiceExamples.length === 0 ? (
              <p className="text-xs m-0" style={{ color: 'var(--lx-fg-muted)' }}>
                No accepted rewrites saved yet. Apply a Local AI rewrite in the Lab to store a few-shot style example on this device.
              </p>
            ) : (
              <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
                {state.voiceExamples.map((ex) => (
                  <div
                    key={ex.id}
                    className="rounded-[6px] border p-2.5 text-xs flex items-start justify-between gap-2"
                    style={{ backgroundColor: 'var(--lx-bg)', borderColor: 'var(--lx-border)' }}
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="lexel-mono text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                        {ex.surfaceId}
                        {ex.subcontext ? ` / ${ex.subcontext}` : ''}
                      </div>
                      <div className="break-words">{ex.rewritten}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateState((prev) => ({
                          ...prev,
                          voiceExamples: prev.voiceExamples.filter((item) => item.id !== ex.id),
                        }))
                      }
                      className="text-[11px] shrink-0"
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
  );
}

import type { Dialect } from 'harper.js';
import { StatusPill } from 'lexel-ui';
import { Activity, Download, Save, Trash2, Upload } from 'lucide-react';
import React, { useRef, useState } from 'react';
import type { LocalAiHealth } from '../lib/localAi';
import type { ActivationKey, AiSettings, LabSettingsState } from '../lib/types';

export interface SettingsViewProps {
  state: LabSettingsState;
  aiHealth: LocalAiHealth | null;
  onUpdateState: (updater: (prev: LabSettingsState) => LabSettingsState) => void;
  onTestAi: (settings: AiSettings) => Promise<void>;
  onClearIgnoredLints: () => Promise<void>;
  onExportJson: () => void;
  onImportJson: (text: string) => void;
  onPurgeAll: () => void;
}

export function SettingsView({
  state,
  aiHealth,
  onUpdateState,
  onTestAi,
  onClearIgnoredLints,
  onExportJson,
  onImportJson,
  onPurgeAll,
}: SettingsViewProps) {
  const [dictDraft, setDictDraft] = useState(() => state.userDictionary.join('\n'));
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto flex flex-col gap-6">
        <div className="pb-4 border-b" style={{ borderColor: 'var(--lx-border)' }}>
          <h2 className="text-lg font-semibold tracking-tight m-0">System &amp; AI Settings</h2>
          <p className="text-xs m-0 mt-1" style={{ color: 'var(--lx-fg-muted)' }}>
            Configure local inference, editor behavior, custom vocabulary, and device-only backups.
          </p>
        </div>

        {notice ? (
          <div
            className="rounded-[6px] border px-3 py-2 text-xs"
            style={{
              backgroundColor: 'var(--lx-signal-bg)',
              borderColor: 'var(--lx-signal)',
              color: 'var(--lx-signal)',
            }}
          >
            {notice}
          </div>
        ) : null}

        <section
          className="rounded-[8px] border p-5 flex flex-col gap-4"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <div className="flex items-center justify-between gap-2 pb-3 border-b" style={{ borderColor: 'var(--lx-border)' }}>
            <div className="flex items-center gap-2.5">
              <h3 className="text-sm font-semibold m-0">Local AI Engine</h3>
              <StatusPill state={aiState} label={aiLabel} />
            </div>
            <label className="inline-flex items-center gap-2 text-xs font-medium">
              <input
                type="checkbox"
                checked={state.aiSettings.enabled}
                onChange={(e) => {
                  const nextAi = { ...state.aiSettings, enabled: e.target.checked };
                  onUpdateState((prev) => ({ ...prev, aiSettings: nextAi }));
                  void onTestAi(nextAi);
                }}
              />
              <span>Enabled</span>
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <span style={{ color: 'var(--lx-fg-muted)' }}>Provider</span>
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
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              >
                <option value="ollama">Ollama (127.0.0.1:11434)</option>
                <option value="openai_compat">Local OpenAI-Compat (llama-server / lexel-daemon)</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs">
              <span style={{ color: 'var(--lx-fg-muted)' }}>Loopback Endpoint</span>
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
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
            </label>

            <label className="flex flex-col gap-1 text-xs">
              <span style={{ color: 'var(--lx-fg-muted)' }}>Model Name</span>
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
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
            </label>

            <label className="flex flex-col gap-1 text-xs">
              <span style={{ color: 'var(--lx-fg-muted)' }}>Max Output Tokens</span>
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
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
            </label>

            <label className="flex flex-col gap-1 text-xs">
              <span style={{ color: 'var(--lx-fg-muted)' }}>
                Temperature ({state.aiSettings.temperature})
              </span>
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
              <span>Save accepted rewrites to Voice Memory</span>
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
                      state.aiSettings.model === m ? 'var(--lx-accent)' : 'var(--lx-surface)',
                    borderColor:
                      state.aiSettings.model === m ? 'var(--lx-accent)' : 'var(--lx-border)',
                    color: state.aiSettings.model === m ? 'var(--lx-on-accent)' : 'var(--lx-fg)',
                  }}
                >
                  {m}
                </button>
              ))}
            </div>
          ) : null}

          <div>
            <button
              type="button"
              onClick={() => {
                void onTestAi(state.aiSettings).then(() => setNotice('Tested local AI connection.'));
              }}
              className="inline-flex items-center gap-1.5 rounded-[6px] px-3.5 py-1.5 text-xs font-semibold"
              style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
            >
              <Activity className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
              <span>Save &amp; Test Connection</span>
            </button>
          </div>
        </section>

        <section
          className="rounded-[8px] border p-5 flex flex-col gap-4"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <h3 className="text-sm font-semibold m-0 pb-3 border-b" style={{ borderColor: 'var(--lx-border)' }}>
            Editor &amp; Grammar Behavior
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
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
                  backgroundColor: 'var(--lx-surface)',
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
              <span style={{ color: 'var(--lx-fg-muted)' }}>Activation Key Guard</span>
              <select
                value={state.activationKey}
                onChange={(e) => {
                  const next = e.target.value as ActivationKey;
                  onUpdateState((prev) => ({ ...prev, activationKey: next }));
                }}
                className="rounded-[6px] border px-2.5 py-1.5 text-xs"
                style={{
                  backgroundColor: 'var(--lx-surface)',
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
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex flex-wrap gap-4 text-xs">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={state.openSuggestionsOnHover}
                  onChange={(e) =>
                    onUpdateState((prev) => ({ ...prev, openSuggestionsOnHover: e.target.checked }))
                  }
                />
                <span>Open underline suggestions on hover</span>
              </label>

              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={state.isolateEnglish}
                  onChange={(e) =>
                    onUpdateState((prev) => ({ ...prev, isolateEnglish: e.target.checked }))
                  }
                />
                <span>Isolate English in mixed-language text</span>
              </label>
            </div>

            <button
              type="button"
              onClick={() => {
                void onClearIgnoredLints().then(() => setNotice('Cleared ignored lints.'));
              }}
              className="rounded-[6px] border px-2.5 py-1 text-xs"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              Clear ignored lints
            </button>
          </div>
        </section>

        <section
          className="rounded-[8px] border p-5 flex flex-col gap-4"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <h3 className="text-sm font-semibold m-0 pb-3 border-b" style={{ borderColor: 'var(--lx-border)' }}>
            Dictionary, Voice Memory &amp; Backup
          </h3>

          <label className="flex flex-col gap-1.5 text-xs">
            <span style={{ color: 'var(--lx-fg-muted)' }}>Custom User Dictionary (one word per line)</span>
            <textarea
              rows={4}
              value={dictDraft}
              onChange={(e) => setDictDraft(e.target.value)}
              placeholder="Weirpack&#10;Lexel&#10;Ollama"
              className="rounded-[6px] border p-2.5 text-xs lexel-mono"
              style={{
                backgroundColor: 'var(--lx-surface)',
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
                setNotice(`Saved ${words.length} dictionary word(s).`);
              }}
              className="inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-xs font-semibold"
              style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
            >
              <Save className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
              <span>Save Dictionary</span>
            </button>
            <button
              type="button"
              onClick={onExportJson}
              className="inline-flex items-center gap-1.5 rounded-[6px] border px-3 py-1.5 text-xs font-medium"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              <Download className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
              <span>Export Backup (.json)</span>
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-[6px] border px-3 py-1.5 text-xs font-medium"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              <Upload className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
              <span>Import Backup (.json)</span>
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
              className="ml-auto inline-flex items-center gap-1.5 rounded-[6px] border px-3 py-1.5 text-xs font-medium"
              style={{
                backgroundColor: 'var(--lx-danger-bg)',
                borderColor: 'var(--lx-danger)',
                color: 'var(--lx-danger)',
              }}
            >
              <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
              <span>Purge All Local Data</span>
            </button>
          </div>

          <div className="border-t pt-4" style={{ borderColor: 'var(--lx-border)' }}>
            <h4 className="text-xs font-semibold m-0 mb-2">
              Local Voice Memory ({state.voiceExamples.length})
            </h4>
            {state.voiceExamples.length === 0 ? (
              <p className="text-xs m-0" style={{ color: 'var(--lx-fg-muted)' }}>
                No accepted rewrites stored yet. Apply a Local AI rewrite in Write &amp; Check to save a few-shot style example here.
              </p>
            ) : (
              <div
                className="rounded-[6px] border divide-y max-h-60 overflow-y-auto"
                style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-surface)' }}
              >
                {state.voiceExamples.map((ex) => (
                  <div
                    key={ex.id}
                    className="p-2.5 text-xs flex items-start justify-between gap-2"
                    style={{ borderColor: 'var(--lx-border)' }}
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="lexel-mono text-[11px]" style={{ color: 'var(--lx-signal)' }}>
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
      </div>
    </div>
  );
}

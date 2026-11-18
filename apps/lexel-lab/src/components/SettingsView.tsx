import type { Dialect } from 'harper.js';
import { StatusPill } from 'lexel-ui';
import { Activity, Download, Link2, Plus, Save, Trash2, Upload } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { LocalAiHealth } from '../lib/localAi';
import { MODEL_MANIFEST_SPECS, resolveModelNameForTier } from '../lib/models';
import { SURFACE_PROFILES } from '../lib/surfaces';
import type {
  ActivationKey,
  AiSettings,
  DaemonConnectionConfig,
  LabSettingsState,
  LintLanguage,
  MainModelTier,
  RuntimeKind,
  SurfaceId,
} from '../lib/types';

export interface SettingsViewProps {
  state: LabSettingsState;
  aiHealth: LocalAiHealth | null;
  onUpdateState: (updater: (prev: LabSettingsState) => LabSettingsState) => void;
  onTestAi: (settings: AiSettings, conn?: DaemonConnectionConfig) => Promise<void>;
  onToggleAi: (enabled: boolean) => Promise<void>;
  onSelectMainModel: (modelSpec: string) => Promise<void>;
  onUnloadModel: () => Promise<void>;
  onSyncDaemon: (conn: DaemonConnectionConfig) => Promise<void>;
  onCreateProfile: (name: string) => Promise<void>;
  onSwitchProfile: (profileId: string) => Promise<void>;
  onDeleteProfile: (profileId: string) => Promise<void>;
  onDeleteVoiceExample: (id: string) => Promise<void>;
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
  onToggleAi,
  onSelectMainModel,
  onUnloadModel,
  onSyncDaemon,
  onCreateProfile,
  onSwitchProfile,
  onDeleteProfile,
  onDeleteVoiceExample,
  onClearIgnoredLints,
  onExportJson,
  onImportJson,
  onPurgeAll,
}: SettingsViewProps) {
  const [dictDraft, setDictDraft] = useState(() => state.userDictionary.join('\n'));
  const [blocklistDraft, setBlocklistDraft] = useState(() => state.privacyBlocklist.join('\n'));
  const [newProfileName, setNewProfileName] = useState('');
  const [newSiteDomain, setNewSiteDomain] = useState('');
  const [newSiteEnabled, setNewSiteEnabled] = useState(true);
  const [newSiteSurface, setNewSiteSurface] = useState('auto');
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDictDraft(state.userDictionary.join('\n'));
    setBlocklistDraft(state.privacyBlocklist.join('\n'));
  }, [state.userDictionary, state.privacyBlocklist]);

  const managedDomains = useMemo(() => {
    const keys = new Set([
      ...Object.keys(state.domainStatuses),
      ...Object.keys(state.surfaceOverrides),
    ]);
    return Array.from(keys).sort();
  }, [state.domainStatuses, state.surfaceOverrides]);

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
          <h2 className="text-lg font-semibold tracking-tight m-0">System, Account &amp; AI Settings</h2>
          <p className="text-xs m-0 mt-1" style={{ color: 'var(--lx-fg-muted)' }}>
            Link your local account with lexel-daemon, choose your main model (0.5B or 1.5B), and control extension, grammar, and privacy rules.
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
          <div
            className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b"
            style={{ borderColor: 'var(--lx-border)' }}
          >
            <div>
              <h3 className="text-sm font-semibold m-0">Synced Local Account (`lexel-daemon`)</h3>
              <p className="text-[11px] m-0 mt-0.5" style={{ color: 'var(--lx-fg-muted)' }}>
                Pair with lexel-daemon so Browser Extension, Lexel Lab, Desktop, and IDE share one profile and SQLite voice memory.
              </p>
            </div>
            <StatusPill
              state={aiHealth?.daemonConnected ? 'ready' : aiHealth?.daemonAuthRequired ? 'loading' : 'offline'}
              label={
                aiHealth?.daemonConnected
                  ? `Synced: ${aiHealth.activeProfile?.name ?? 'Default'}`
                  : aiHealth?.daemonAuthRequired
                    ? 'Token Required'
                    : 'Standalone Mode'
              }
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <span style={{ color: 'var(--lx-fg-muted)' }}>Daemon Loopback Endpoint</span>
              <input
                type="text"
                value={state.daemonConnection.endpoint}
                onChange={(e) =>
                  onUpdateState((prev) => ({
                    ...prev,
                    daemonConnection: { ...prev.daemonConnection, endpoint: e.target.value },
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
                Bearer Token (from <span className="lexel-mono">lexel-daemon token</span>)
              </span>
              <input
                type="password"
                value={state.daemonConnection.token}
                onChange={(e) =>
                  onUpdateState((prev) => ({
                    ...prev,
                    daemonConnection: { ...prev.daemonConnection, token: e.target.value },
                  }))
                }
                placeholder="Paste token from ~/.local/share/lexel/daemon.token"
                className="rounded-[6px] border px-2.5 py-1.5 text-xs lexel-mono"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const nextConn = { ...state.daemonConnection, enabled: true };
                onUpdateState((prev) => ({ ...prev, daemonConnection: nextConn }));
                void onSyncDaemon(nextConn).then(() => setNotice('Synced active profile with lexel-daemon.'));
              }}
              className="inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-xs font-semibold"
              style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
            >
              <Link2 className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
              <span>Connect &amp; Sync Profile</span>
            </button>
            <span className="text-[11px] lexel-mono" style={{ color: 'var(--lx-fg-muted)' }}>
              Start daemon: make daemon
            </span>
          </div>

          {aiHealth?.daemonConnected && aiHealth.profiles ? (
            <div className="border-t pt-3 flex flex-col gap-3" style={{ borderColor: 'var(--lx-border)' }}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium">Switch Profile</span>
                  {aiHealth.profiles.map((p) => (
                    <div
                      key={p.id}
                      className="rounded-[6px] border px-3 py-2 flex items-center justify-between gap-2 text-xs"
                      style={{
                        backgroundColor: 'var(--lx-surface)',
                        borderColor: p.isActive ? 'var(--lx-signal)' : 'var(--lx-border)',
                      }}
                    >
                      <div className="min-w-0">
                        <div className="font-medium truncate">{p.name}</div>
                        <div className="text-[11px] lexel-mono" style={{ color: 'var(--lx-fg-muted)' }}>
                          {p.settings.mainModelTier} · AI {p.settings.aiEnabled ? 'ON' : 'OFF'}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {!p.isActive ? (
                          <button
                            type="button"
                            onClick={() => void onSwitchProfile(p.id)}
                            className="rounded-[6px] px-2.5 py-1 text-[11px] font-semibold"
                            style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
                          >
                            Use
                          </button>
                        ) : (
                          <span className="text-[11px] lexel-mono" style={{ color: 'var(--lx-signal)' }}>
                            Active
                          </span>
                        )}
                        {aiHealth.profiles && aiHealth.profiles.length > 1 ? (
                          <button
                            type="button"
                            onClick={() => void onDeleteProfile(p.id)}
                            className="rounded-[6px] border px-2 py-1 text-[11px]"
                            style={{ borderColor: 'var(--lx-border)', color: 'var(--lx-danger)' }}
                          >
                            Delete
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>

                <label className="flex flex-col gap-1.5 text-xs">
                  <span>Create New Local Profile</span>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newProfileName}
                      onChange={(e) => setNewProfileName(e.target.value)}
                      placeholder="Work, Personal, Open Source..."
                      className="flex-1 rounded-[6px] border px-2.5 py-1.5 text-xs"
                      style={{
                        backgroundColor: 'var(--lx-surface)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (!newProfileName.trim()) return;
                        void onCreateProfile(newProfileName.trim()).then(() => {
                          setNewProfileName('');
                          setNotice('Created and activated profile.');
                        });
                      }}
                      className="inline-flex items-center gap-1 rounded-[6px] px-3 py-1.5 text-xs font-semibold shrink-0"
                      style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
                    >
                      <Plus className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
                      <span>Create</span>
                    </button>
                  </div>
                </label>
              </div>
            </div>
          ) : null}
        </section>

        <section
          className="rounded-[8px] border p-5 flex flex-col gap-4"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <div
            className="flex items-center justify-between gap-2 pb-3 border-b"
            style={{ borderColor: 'var(--lx-border)' }}
          >
            <div className="flex items-center gap-2.5">
              <h3 className="text-sm font-semibold m-0">Local AI Engine (0.5B &amp; 1.5B)</h3>
              <StatusPill state={aiState} label={aiLabel} />
            </div>
            <label className="inline-flex items-center gap-2 text-xs font-medium">
              <input
                type="checkbox"
                checked={state.aiSettings.enabled}
                onChange={(e) => void onToggleAi(e.target.checked)}
              />
              <span>Enabled</span>
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {MODEL_MANIFEST_SPECS.map((spec) => {
              const diskStatus = aiHealth?.installedModels?.find((m) => m.id === spec.id);
              const isSelected = state.aiSettings.mainModelTier === spec.id;
              return (
                <div
                  key={spec.id}
                  className="rounded-[6px] border p-3 flex flex-col justify-between gap-2 text-xs"
                  style={{
                    backgroundColor: 'var(--lx-surface)',
                    borderColor: isSelected ? 'var(--lx-signal)' : 'var(--lx-border)',
                  }}
                >
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">{spec.label}</span>
                      <span className="lexel-mono text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                        ~{spec.approxRamMb} MB RAM
                      </span>
                    </div>
                    <p className="m-0 text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                      {spec.description}
                    </p>
                    {diskStatus ? (
                      <div className="lexel-mono text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                        GGUF: {diskStatus.ggufInstalled ? 'Installed' : 'Run make setup'} · Ollama:{' '}
                        {diskStatus.ollamaInstalled ? 'Ready' : 'Auto-imports'}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => void onSelectMainModel(spec.id)}
                    className="self-start rounded-[6px] border px-2.5 py-1 text-xs font-semibold"
                    style={{
                      backgroundColor: isSelected ? 'var(--lx-accent)' : 'var(--lx-bg)',
                      borderColor: 'var(--lx-border)',
                      color: isSelected ? 'var(--lx-on-accent)' : 'var(--lx-fg)',
                    }}
                  >
                    {isSelected
                      ? 'Selected Main Model'
                      : `Set ${spec.id === 'lexel-0.5b' ? '0.5B' : '1.5B'} as Main`}
                  </button>
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <span style={{ color: 'var(--lx-fg-muted)' }}>Main Model Tier</span>
              <select
                value={state.aiSettings.mainModelTier}
                onChange={(e) => {
                  const tier = e.target.value as MainModelTier;
                  if (tier === 'custom') {
                    onUpdateState((prev) => ({
                      ...prev,
                      aiSettings: { ...prev.aiSettings, mainModelTier: 'custom' },
                    }));
                  } else {
                    void onSelectMainModel(tier);
                  }
                }}
                className="rounded-[6px] border px-2.5 py-1.5 text-xs"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              >
                <option value="lexel-1.5b">Lexel 1.5B (Standard)</option>
                <option value="lexel-0.5b">Lexel 0.5B (Lite)</option>
                <option value="custom">Custom Model / GGUF</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs">
              <span style={{ color: 'var(--lx-fg-muted)' }}>Runtime Strategy</span>
              <select
                value={state.aiSettings.runtime}
                onChange={(e) => {
                  const runtime = e.target.value as RuntimeKind;
                  const provider = runtime === 'openai_compat' ? 'openai_compat' : 'ollama';
                  const endpoint =
                    provider === 'ollama'
                      ? 'http://127.0.0.1:11434'
                      : state.aiSettings.openAiCompatEndpoint;
                  onUpdateState((prev) => ({
                    ...prev,
                    aiSettings: { ...prev.aiSettings, runtime, provider, endpoint },
                  }));
                }}
                className="rounded-[6px] border px-2.5 py-1.5 text-xs"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              >
                <option value="auto">Auto (llama-server or Ollama)</option>
                <option value="llama_server">Managed llama-server (GGUF)</option>
                <option value="ollama">Ollama (127.0.0.1:11434)</option>
                <option value="openai_compat">Local OpenAI-Compat</option>
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
              <span style={{ color: 'var(--lx-fg-muted)' }}>
                {state.aiSettings.mainModelTier === 'custom'
                  ? 'Custom Model Name / GGUF Path'
                  : 'Effective Model Tag'}
              </span>
              <input
                type="text"
                value={
                  state.aiSettings.mainModelTier === 'custom'
                    ? state.aiSettings.model
                    : resolveModelNameForTier(state.aiSettings.mainModelTier, state.aiSettings.model)
                }
                disabled={state.aiSettings.mainModelTier !== 'custom'}
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
              <span style={{ color: 'var(--lx-fg-muted)' }}>Idle Auto-Unload (seconds)</span>
              <input
                type="number"
                min={0}
                max={3600}
                step={30}
                value={state.aiSettings.idleUnloadSecs}
                onChange={(e) =>
                  onUpdateState((prev) => ({
                    ...prev,
                    aiSettings: {
                      ...prev.aiSettings,
                      idleUnloadSecs: Math.max(0, Number.parseInt(e.target.value || '180', 10)),
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

            <div className="flex flex-col justify-end gap-2 text-xs pb-1">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={state.aiSettings.keepWarm}
                  onChange={(e) =>
                    onUpdateState((prev) => ({
                      ...prev,
                      aiSettings: { ...prev.aiSettings, keepWarm: e.target.checked },
                    }))
                  }
                />
                <span>Keep model warm in RAM</span>
              </label>
              <label className="inline-flex items-center gap-2">
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

          <div className="flex flex-wrap gap-2">
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
            {aiHealth?.daemonConnected && aiHealth.modelLoaded ? (
              <button
                type="button"
                onClick={() =>
                  void onUnloadModel().then(() => setNotice('Unloaded model weights from RAM.'))
                }
                className="rounded-[6px] border px-3 py-1.5 text-xs font-medium"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              >
                Unload Model from RAM ({aiHealth.loadedModel})
              </button>
            ) : null}
          </div>
        </section>

        <section
          className="rounded-[8px] border p-5 flex flex-col gap-4"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <h3 className="text-sm font-semibold m-0 pb-3 border-b" style={{ borderColor: 'var(--lx-border)' }}>
            Extension Usage, Sites &amp; Harper Behavior
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
                <option value={4}>Indian</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs">
              <span style={{ color: 'var(--lx-fg-muted)' }}>Document Parser Mode</span>
              <select
                value={state.languageMode}
                onChange={(e) => {
                  const next = e.target.value as LintLanguage;
                  onUpdateState((prev) => ({ ...prev, languageMode: next }));
                }}
                className="rounded-[6px] border px-2.5 py-1.5 text-xs"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              >
                <option value="plaintext">Plaintext</option>
                <option value="markdown">Markdown</option>
                <option value="typst">Typst</option>
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
                  checked={state.defaultEnable}
                  onChange={(e) =>
                    onUpdateState((prev) => ({ ...prev, defaultEnable: e.target.checked }))
                  }
                />
                <span>Enable extension on all sites by default</span>
              </label>

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

          <div className="border-t pt-3 flex flex-col gap-2.5" style={{ borderColor: 'var(--lx-border)' }}>
            <h4 className="text-xs font-semibold m-0">Per-Site Extension Overrides</h4>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
              <input
                type="text"
                value={newSiteDomain}
                onChange={(e) => setNewSiteDomain(e.target.value)}
                placeholder="Domain (e.g. reddit.com)"
                aria-label="Site domain"
                className="md:col-span-2 rounded-[6px] border px-2.5 py-1.5 text-xs lexel-mono"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
              <select
                aria-label="Site extension state"
                value={newSiteEnabled ? 'active' : 'paused'}
                onChange={(e) => setNewSiteEnabled(e.target.value === 'active')}
                className="rounded-[6px] border px-2 py-1.5 text-xs"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              >
                <option value="active">Active</option>
                <option value="paused">Paused</option>
              </select>
              <div className="flex gap-2">
                <select
                  aria-label="Site surface style"
                  value={newSiteSurface}
                  onChange={(e) => setNewSiteSurface(e.target.value)}
                  className="flex-1 rounded-[6px] border px-2 py-1.5 text-xs"
                  style={{
                    backgroundColor: 'var(--lx-surface)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                >
                  <option value="auto">Auto Surface</option>
                  {SURFACE_PROFILES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => {
                    const dom = newSiteDomain.trim().toLowerCase();
                    if (!dom) return;
                    onUpdateState((prev) => {
                      const nextOverrides = { ...prev.surfaceOverrides };
                      if (newSiteSurface === 'auto') delete nextOverrides[dom];
                      else nextOverrides[dom] = newSiteSurface as SurfaceId;
                      return {
                        ...prev,
                        domainStatuses: { ...prev.domainStatuses, [dom]: newSiteEnabled },
                        surfaceOverrides: nextOverrides,
                      };
                    });
                    setNewSiteDomain('');
                    setNotice(`Saved site rule for ${dom}.`);
                  }}
                  className="rounded-[6px] px-3 py-1.5 text-xs font-semibold shrink-0"
                  style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
                >
                  Add
                </button>
              </div>
            </div>

            {managedDomains.length > 0 ? (
              <div
                className="rounded-[6px] border divide-y"
                style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-surface)' }}
              >
                {managedDomains.map((dom) => (
                  <div
                    key={dom}
                    className="px-3 py-2 flex items-center justify-between gap-2 text-xs"
                    style={{ borderColor: 'var(--lx-border)' }}
                  >
                    <span className="lexel-mono">
                      {dom} · {state.domainStatuses[dom] === false ? 'Paused' : 'Active'}
                      {state.surfaceOverrides[dom] ? ` · ${state.surfaceOverrides[dom]}` : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateState((prev) => {
                          const nextDom = { ...prev.domainStatuses };
                          const nextSur = { ...prev.surfaceOverrides };
                          delete nextDom[dom];
                          delete nextSur[dom];
                          return { ...prev, domainStatuses: nextDom, surfaceOverrides: nextSur };
                        })
                      }
                      className="text-[11px]"
                      style={{ color: 'var(--lx-danger)' }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </section>

        <section
          className="rounded-[8px] border p-5 flex flex-col gap-4"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <h3 className="text-sm font-semibold m-0 pb-3 border-b" style={{ borderColor: 'var(--lx-border)' }}>
            Dictionary, Blocklist, Voice Memory &amp; Backup
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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

            <label className="flex flex-col gap-1.5 text-xs">
              <span style={{ color: 'var(--lx-fg-muted)' }}>Privacy Blocklist Domains (one per line)</span>
              <textarea
                rows={4}
                value={blocklistDraft}
                onChange={(e) => setBlocklistDraft(e.target.value)}
                placeholder="1password.com&#10;bitwarden.com&#10;*.chase.com"
                className="rounded-[6px] border p-2.5 text-xs lexel-mono"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
            </label>
          </div>

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
                const domains = [
                  ...new Set(
                    blocklistDraft
                      .split('\n')
                      .map((d) => d.trim().toLowerCase())
                      .filter(Boolean),
                  ),
                ];
                onUpdateState((prev) => ({
                  ...prev,
                  userDictionary: words,
                  privacyBlocklist: domains,
                }));
                setNotice(`Saved ${words.length} dictionary word(s) and ${domains.length} blocked domain(s).`);
              }}
              className="inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-xs font-semibold"
              style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
            >
              <Save className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
              <span>Save Dictionary &amp; Blocklist</span>
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
                      onClick={() => void onDeleteVoiceExample(ex.id)}
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

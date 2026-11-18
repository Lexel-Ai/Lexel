import React, { useState } from 'react';
import {
  daemonRpc,
  installNativeMessaging,
  isTauriRuntime,
  MODEL_SPECS,
} from '../lib/desktopClient';
import type {
  DaemonStatusPayload,
  DesktopEnvInfo,
  MainModelTier,
  NativeHostStatusReport,
  RuntimeKind,
  UnifiedDaemonSettings,
  VoiceExample,
} from '../lib/types';

interface SystemSyncPaneProps {
  status: DaemonStatusPayload;
  envInfo: DesktopEnvInfo | null;
  nativeStatus: NativeHostStatusReport | null;
  voiceExamples: VoiceExample[];
  onPatchSettings: (patch: Partial<UnifiedDaemonSettings>) => Promise<void>;
  onRefreshAll: () => Promise<void>;
}

export function SystemSyncPane({
  status,
  envInfo,
  nativeStatus,
  voiceExamples,
  onPatchSettings,
  onRefreshAll,
}: SystemSyncPaneProps) {
  const settings = status.activeProfile.settings;
  const [extensionIdsInput, setExtensionIdsInput] = useState('');
  const [newProfileName, setNewProfileName] = useState('');
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleInstallNativeMessaging() {
    setActionError(null);
    setActionMessage(null);
    try {
      const ids = extensionIdsInput
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const report = await installNativeMessaging(ids);
      await onRefreshAll();
      setActionMessage(
        `Registered Native Messaging host (${report.writtenManifests.length} manifests written).`,
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleToggleAi(enabled: boolean) {
    setActionError(null);
    await daemonRpc('toggleAi', { enabled });
    await onRefreshAll();
  }

  async function handleModelTier(tier: MainModelTier) {
    setActionError(null);
    if (tier === 'custom') {
      await daemonRpc('setMainModel', { model: settings.customModel || 'qwen2.5:1.5b' });
    } else {
      await daemonRpc('setMainModel', { model: tier });
    }
    await onRefreshAll();
  }

  async function handleUnloadAi() {
    await daemonRpc('unloadAi', {});
    await onRefreshAll();
    setActionMessage('Unloaded local AI model from RAM.');
  }

  async function handleCreateProfile(e: React.FormEvent) {
    e.preventDefault();
    const name = newProfileName.trim();
    if (!name) return;
    await daemonRpc('createProfile', { name, cloneFromActive: true, activate: true });
    setNewProfileName('');
    await onRefreshAll();
  }

  async function handleExportBackup() {
    const backup = await daemonRpc<unknown>('exportBackup', {});
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'lexel-desktop-backup.json';
    link.click();
    URL.revokeObjectURL(url);
  }

  async function handleImportBackup(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      await daemonRpc('importBackup', { backup: parsed });
      await onRefreshAll();
      setActionMessage('Imported database backup into lexel.db.');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
    e.target.value = '';
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[18px] font-semibold">Local AI, Extension Sync &amp; Profiles</h1>
        <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
          Connect your Chrome/Firefox extension to this desktop database and manage local GGUF inference.
        </p>
      </header>

      {actionMessage && (
        <div
          className="rounded-[6px] border px-3 py-2 text-[12px]"
          style={{
            backgroundColor: 'var(--lx-signal-bg)',
            borderColor: 'var(--lx-signal)',
            color: 'var(--lx-signal)',
          }}
        >
          {actionMessage}
        </div>
      )}

      {actionError && (
        <div
          role="alert"
          className="rounded-[6px] border px-3 py-2 text-[12px]"
          style={{
            backgroundColor: 'var(--lx-danger-bg)',
            borderColor: 'var(--lx-danger)',
            color: 'var(--lx-danger)',
          }}
        >
          {actionError}
        </div>
      )}

      <section
        className="space-y-3 rounded-[8px] border p-3"
        style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-[14px] font-semibold">Browser Extension Bridge (Native Messaging)</h2>
            <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
              Writes <code className="lexel-mono">com.lexel.daemon.json</code> so the browser extension syncs rules, prompts, and local AI from <code className="lexel-mono">{envInfo?.dbPath ?? 'lexel.db'}</code>.
            </p>
          </div>
          <span className="text-[11px] lexel-mono" style={{ color: 'var(--lx-fg-muted)' }}>
            {isTauriRuntime() ? 'Tauri Rust IPC' : 'Browser Preview'}
          </span>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {(nativeStatus?.targets ?? []).map((target) => (
            <div
              key={target.browser}
              className="flex items-center justify-between rounded-[6px] border px-2.5 py-2 text-[12px]"
              style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
            >
              <div>
                <div className="font-medium">{target.browser}</div>
                <div className="truncate max-w-[260px] text-[11px] lexel-mono" style={{ color: 'var(--lx-fg-muted)' }}>
                  {target.manifestPath}
                </div>
              </div>
              <span
                className="rounded-[4px] px-1.5 py-0.5 text-[11px] lexel-mono"
                style={{
                  backgroundColor: target.installed ? 'var(--lx-signal-bg)' : 'var(--lx-muted)',
                  color: target.installed ? 'var(--lx-signal)' : 'var(--lx-fg-muted)',
                }}
              >
                {target.installed ? 'linked' : 'not linked'}
              </span>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[260px] flex-1">
            <label
              htmlFor="chrome-ext-ids"
              className="mb-1 block text-[11px] font-medium"
              style={{ color: 'var(--lx-fg-muted)' }}
            >
              Optional Chrome/Chromium Unpacked Extension ID(s)
            </label>
            <input
              id="chrome-ext-ids"
              type="text"
              value={extensionIdsInput}
              onChange={(e) => setExtensionIdsInput(e.target.value)}
              placeholder="Paste Chrome extension ID if testing unpacked build..."
              className="w-full rounded-[6px] border px-2.5 py-1.5 text-[12px] lexel-mono"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            />
          </div>
          <button
            type="button"
            onClick={handleInstallNativeMessaging}
            className="rounded-[6px] px-3.5 py-1.5 text-[12px] font-semibold"
            style={{
              backgroundColor: 'var(--lx-accent)',
              color: 'var(--lx-on-accent)',
            }}
          >
            Register Browser Bridge
          </button>
        </div>
      </section>

      <section
        className="space-y-3 rounded-[8px] border p-3"
        style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-[14px] font-semibold">Local AI Engine (Tier 1)</h2>
            <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
              Backend: <span className="lexel-mono">{status.runtime.activeBackend}</span>
              {status.runtime.loadedModel ? ` (${status.runtime.loadedModel} loaded)` : ' (idle)'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[12px]">
              <input
                type="checkbox"
                checked={settings.aiEnabled}
                onChange={(e) => void handleToggleAi(e.target.checked)}
              />
              Enable Local AI
            </label>
            <button
              type="button"
              onClick={handleUnloadAi}
              className="rounded-[6px] border px-2.5 py-1 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-muted)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              Unload RAM
            </button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label
              htmlFor="ai-model-tier"
              className="mb-1 block text-[11px] font-medium"
              style={{ color: 'var(--lx-fg-muted)' }}
            >
              Main Model Tier
            </label>
            <select
              id="ai-model-tier"
              value={settings.mainModelTier}
              onChange={(e) => void handleModelTier(e.target.value as MainModelTier)}
              className="w-full rounded-[6px] border px-2.5 py-1.5 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              {MODEL_SPECS.map((spec) => (
                <option key={spec.id} value={spec.id}>
                  {spec.label} (~{spec.approxRamMb} MB RAM)
                </option>
              ))}
              <option value="custom">Custom Model</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="ai-runtime-kind"
              className="mb-1 block text-[11px] font-medium"
              style={{ color: 'var(--lx-fg-muted)' }}
            >
              Inference Runtime
            </label>
            <select
              id="ai-runtime-kind"
              value={settings.runtime}
              onChange={(e) =>
                void onPatchSettings({ runtime: e.target.value as RuntimeKind })
              }
              className="w-full rounded-[6px] border px-2.5 py-1.5 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              <option value="auto">Auto (llama-server -&gt; Ollama)</option>
              <option value="llama_server">Bundled llama-server (GGUF)</option>
              <option value="ollama">Ollama (127.0.0.1)</option>
              <option value="openai_compat">Local OpenAI-compatible (127.0.0.1)</option>
            </select>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {status.models.map((m) => (
            <div
              key={m.id}
              className="rounded-[6px] border px-2.5 py-2 text-[12px]"
              style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
            >
              <div className="flex items-center justify-between font-medium">
                <span>{m.label}</span>
                <span className="text-[11px] lexel-mono" style={{ color: 'var(--lx-fg-muted)' }}>
                  {m.ggufInstalled ? 'GGUF ready' : m.ollamaInstalled ? 'Ollama ready' : 'Not downloaded'}
                </span>
              </div>
              <div className="mt-0.5 text-[11px] lexel-mono" style={{ color: 'var(--lx-fg-muted)' }}>
                {m.ggufFilename}
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section
          className="space-y-2 rounded-[8px] border p-3"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <h2 className="text-[13px] font-semibold">Profiles &amp; Backups</h2>
          <form onSubmit={handleCreateProfile} className="flex gap-2">
            <input
              type="text"
              value={newProfileName}
              onChange={(e) => setNewProfileName(e.target.value)}
              placeholder="New profile (e.g. Work, OSS)"
              aria-label="New profile name"
              className="min-w-0 flex-1 rounded-[6px] border px-2.5 py-1 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            />
            <button
              type="submit"
              className="rounded-[6px] border px-2.5 py-1 text-[12px] font-medium"
              style={{
                backgroundColor: 'var(--lx-muted)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              Create
            </button>
          </form>

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={handleExportBackup}
              className="rounded-[6px] border px-2.5 py-1 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              Export JSON Backup
            </button>
            <label
              className="cursor-pointer rounded-[6px] border px-2.5 py-1 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              Import Backup
              <input
                type="file"
                accept="application/json"
                onChange={handleImportBackup}
                className="hidden"
              />
            </label>
          </div>
        </section>

        <section
          className="space-y-2 rounded-[8px] border p-3"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <h2 className="text-[13px] font-semibold">Voice Memory ({voiceExamples.length})</h2>
          <div className="max-h-40 space-y-1.5 overflow-y-auto">
            {voiceExamples.length === 0 ? (
              <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
                No saved style pairs yet. Accept a rewrite to store an example.
              </p>
            ) : (
              voiceExamples.map((ex) => (
                <div
                  key={ex.id}
                  className="flex items-start justify-between gap-2 rounded-[6px] border p-2 text-[11px]"
                  style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
                >
                  <div className="min-w-0">
                    <div className="lexel-mono" style={{ color: 'var(--lx-fg-muted)' }}>
                      {ex.surfaceId}{ex.subcontext ? ` (${ex.subcontext})` : ''}
                    </div>
                    <div className="truncate">{ex.rewritten}</div>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      await daemonRpc('deleteVoiceExample', { id: ex.id });
                      await onRefreshAll();
                    }}
                    className="shrink-0 rounded px-1.5 py-0.5 text-[11px]"
                    style={{ color: 'var(--lx-danger)' }}
                  >
                    Remove
                  </button>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

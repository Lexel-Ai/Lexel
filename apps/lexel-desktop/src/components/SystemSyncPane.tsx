import type React from 'react';
import { useEffect, useState } from 'react';
import {
  daemonRpc,
  deleteModel,
  downloadModel,
  installNativeMessaging,
  isTauriRuntime,
  MODEL_SPECS,
  subscribeToModelProgress,
} from '../lib/desktopClient';
import type {
  DaemonStatusPayload,
  DesktopEnvInfo,
  DownloadProgress,
  MainModelTier,
  NativeHostStatusReport,
  OsOverlayCapabilities,
  RuntimeKind,
  ToggleAiResponse,
  UnifiedDaemonSettings,
  VoiceExample,
  WritingStatsSummary,
} from '../lib/types';

interface SystemSyncPaneProps {
  status: DaemonStatusPayload;
  envInfo: DesktopEnvInfo | null;
  nativeStatus: NativeHostStatusReport | null;
  osOverlay: OsOverlayCapabilities | null;
  writingStats: WritingStatsSummary | null;
  voiceExamples: VoiceExample[];
  onPatchSettings: (patch: Partial<UnifiedDaemonSettings>) => Promise<void>;
  onRefreshAll: () => Promise<void>;
}

export function SystemSyncPane({
  status,
  envInfo,
  nativeStatus,
  osOverlay,
  writingStats,
  voiceExamples,
  onPatchSettings,
  onRefreshAll,
}: SystemSyncPaneProps) {
  const settings = status.activeProfile.settings;
  const [extensionIdsInput, setExtensionIdsInput] = useState('');
  const [newProfileName, setNewProfileName] = useState('');
  const [renameDraft, setRenameDraft] = useState(status.activeProfile.name);
  const [downloadingModelId, setDownloadingModelId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setRenameDraft(status.activeProfile.name);
  }, [status.activeProfile.name]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    void subscribeToModelProgress((progress) => {
      if (active) {
        setDownloadProgress(progress);
      }
    }).then((fn) => {
      if (active) {
        unlisten = fn;
      } else {
        fn();
      }
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const hasAnyRuntime =
    status.runtime.llamaServerAvailable ||
    status.runtime.ollamaBinaryAvailable ||
    status.runtime.ollamaRunning;
  const hasAnyModel = status.models.some(
    (m) => (m.ggufInstalled && m.ggufSizeValid) || m.ollamaInstalled,
  );

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
        `Registered Native Messaging host (${report.writtenManifests.length} manifest(s) written using ${report.daemonBin}).`,
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleToggleAi(enabled: boolean) {
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await daemonRpc<ToggleAiResponse>('toggleAi', { enabled });
      await onRefreshAll();
      if (res.activationError) {
        setActionError(res.activationError);
      } else if (enabled) {
        setActionMessage(`Local AI enabled (${res.runtime.activeBackend}).`);
      } else {
        setActionMessage('Local AI disabled and unloaded from RAM.');
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleModelTier(tier: MainModelTier) {
    setActionError(null);
    setActionMessage(null);
    try {
      const target = tier === 'custom' ? settings.customModel || 'qwen2.5:1.5b' : tier;
      const res = await daemonRpc<ToggleAiResponse>('setMainModel', { model: target });
      await onRefreshAll();
      if (res.activationError) {
        setActionError(res.activationError);
      } else {
        setActionMessage(`Active model switched to ${target}.`);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleUnloadAi() {
    setActionError(null);
    await daemonRpc('unloadAi', {});
    await onRefreshAll();
    setActionMessage('Unloaded local AI model from RAM.');
  }

  async function handleDownloadModel(modelId: string) {
    setActionError(null);
    setActionMessage(null);
    setDownloadingModelId(modelId);
    setDownloadProgress({ modelId, bytesDownloaded: 0, totalBytes: 0, percent: 0 });
    try {
      const report = await downloadModel(modelId);
      await onRefreshAll();
      const mb = Math.round(report.bytesDownloaded / (1024 * 1024));
      setActionMessage(
        report.alreadyPresent
          ? `${report.id} is already verified on disk (${mb} MB).`
          : `Downloaded and SHA-256 verified ${report.id} (${mb} MB).`,
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloadingModelId(null);
      setDownloadProgress(null);
    }
  }

  async function handleDeleteModel(modelId: string) {
    setActionError(null);
    setActionMessage(null);
    try {
      await deleteModel(modelId);
      await onRefreshAll();
      setActionMessage(`Removed local GGUF artifact for ${modelId}.`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCreateProfile(e: React.FormEvent) {
    e.preventDefault();
    const name = newProfileName.trim();
    if (!name) return;
    await daemonRpc('createProfile', { name, cloneFromActive: true, activate: true });
    setNewProfileName('');
    await onRefreshAll();
    setActionMessage(`Created and switched to profile "${name}".`);
  }

  async function handleRenameProfile(e: React.FormEvent) {
    e.preventDefault();
    const name = renameDraft.trim();
    if (!name) return;
    await daemonRpc('renameProfile', { profileId: status.activeProfile.id, name });
    await onRefreshAll();
    setActionMessage(`Renamed active profile to "${name}".`);
  }

  async function handleDeleteProfile(profileId: string) {
    setActionError(null);
    try {
      await daemonRpc('deleteProfile', { profileId });
      await onRefreshAll();
      setActionMessage('Deleted profile.');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
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

  async function handlePurgeAll() {
    setActionError(null);
    await daemonRpc('purgeAll', {});
    setConfirmPurge(false);
    await onRefreshAll();
    setActionMessage('Purged all local profiles and Voice Memory back to a clean default.');
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[18px] font-semibold">Local AI, Extension Sync &amp; Profiles</h1>
        <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
          Connect your browser extension to lexel.db, download verified GGUF weights, and tune local
          inference.
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
            <h2 className="text-[14px] font-semibold">
              Browser Extension Bridge (Native Messaging)
            </h2>
            <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
              Writes <code className="lexel-mono">com.lexel.daemon.json</code> so Chrome, Brave,
              Edge, and Firefox sync rules, prompts, and local AI from{' '}
              <code className="lexel-mono">{envInfo?.dbPath ?? 'lexel.db'}</code>.
            </p>
          </div>
          <span className="text-[11px] lexel-mono" style={{ color: 'var(--lx-fg-muted)' }}>
            {isTauriRuntime() ? `Loopback :${status.httpPort}` : 'Browser Preview'}
          </span>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {(nativeStatus?.targets ?? []).map((target) => (
            <div
              key={target.browser}
              className="flex items-center justify-between rounded-[6px] border px-2.5 py-2 text-[12px]"
              style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
            >
              <div className="min-w-0">
                <div className="font-medium">{target.browser}</div>
                <div
                  className="truncate max-w-[260px] text-[11px] lexel-mono"
                  style={{ color: 'var(--lx-fg-muted)' }}
                >
                  {target.manifestPath}
                </div>
              </div>
              <span
                className="shrink-0 rounded-[4px] px-1.5 py-0.5 text-[11px] lexel-mono"
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
              Chrome / Chromium / Brave / Edge Extension ID(s)
            </label>
            <input
              id="chrome-ext-ids"
              type="text"
              value={extensionIdsInput}
              onChange={(e) => setExtensionIdsInput(e.target.value)}
              placeholder="Paste extension ID from chrome://extensions or Lexel Settings..."
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
            <h2 className="text-[14px] font-semibold">Local AI Engine</h2>
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

        <div
          className="grid gap-2 rounded-[6px] border p-2.5 text-[11px] sm:grid-cols-3"
          style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
        >
          <div>
            <div style={{ color: 'var(--lx-fg-muted)' }}>llama-server</div>
            <div className="lexel-mono font-medium">
              {status.runtime.llamaServerAvailable ? 'Detected' : 'Not on PATH'}
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--lx-fg-muted)' }}>Ollama</div>
            <div className="lexel-mono font-medium">
              {status.runtime.ollamaRunning
                ? `Running (${status.runtime.ollamaModels.length} models)`
                : status.runtime.ollamaBinaryAvailable
                  ? 'Installed (auto-starts on rewrite)'
                  : 'Not installed'}
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--lx-fg-muted)' }}>Readiness</div>
            <div
              className="lexel-mono font-medium"
              style={{
                color: hasAnyRuntime && hasAnyModel ? 'var(--lx-signal)' : 'var(--lx-warn)',
              }}
            >
              {hasAnyRuntime && hasAnyModel
                ? 'Ready for local rewrites'
                : !hasAnyModel
                  ? 'Download a GGUF model below'
                  : 'Install Ollama or llama-server'}
            </div>
          </div>
        </div>

        {!hasAnyRuntime && isTauriRuntime() && (
          <div
            className="rounded-[6px] border px-3 py-2 text-[12px]"
            style={{
              backgroundColor: 'var(--lx-warn-bg)',
              borderColor: 'var(--lx-warn)',
              color: 'var(--lx-warn)',
            }}
          >
            No local inference engine was detected yet. Install Ollama (ollama.com) or place{' '}
            <code className="lexel-mono">llama-server</code> in{' '}
            <code className="lexel-mono">{envInfo?.dataDir ?? '~/.local/share/lexel'}/bin/</code>,
            then click Enable Local AI.
          </div>
        )}

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
              onChange={(e) => void onPatchSettings({ runtime: e.target.value as RuntimeKind })}
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
          {status.models.map((m) => {
            const ready = m.ggufInstalled && m.ggufSizeValid;
            const downloading = downloadingModelId === m.id;
            const activePct =
              downloading && downloadProgress?.modelId === m.id ? downloadProgress.percent : 0;
            const downloadedMb =
              downloading && downloadProgress?.modelId === m.id
                ? Math.round(downloadProgress.bytesDownloaded / (1024 * 1024))
                : 0;
            const totalMb = Math.round(m.sizeBytes / (1024 * 1024));

            return (
              <div
                key={m.id}
                className="flex flex-col justify-between gap-2 rounded-[6px] border px-2.5 py-2 text-[12px]"
                style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
              >
                <div>
                  <div className="flex items-center justify-between font-medium">
                    <span>{m.label}</span>
                    <span
                      className="text-[11px] lexel-mono"
                      style={{
                        color:
                          ready || m.ollamaInstalled ? 'var(--lx-signal)' : 'var(--lx-fg-muted)',
                      }}
                    >
                      {ready
                        ? 'GGUF verified'
                        : m.ollamaInstalled
                          ? 'Ollama ready'
                          : 'Not downloaded'}
                    </span>
                  </div>
                  <div
                    className="mt-0.5 text-[11px] lexel-mono"
                    style={{ color: 'var(--lx-fg-muted)' }}
                  >
                    {m.ggufFilename} ({totalMb} MB)
                  </div>
                </div>

                {downloading && (
                  <div className="space-y-1">
                    <div
                      className="h-1.5 w-full overflow-hidden rounded-[4px]"
                      style={{ backgroundColor: 'var(--lx-muted)' }}
                    >
                      <div
                        className="h-full"
                        style={{
                          width: `${activePct}%`,
                          backgroundColor: 'var(--lx-signal)',
                        }}
                      />
                    </div>
                    <div className="text-[11px] lexel-mono" style={{ color: 'var(--lx-fg-muted)' }}>
                      {downloadedMb} / {totalMb} MB ({activePct}%)
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between gap-2 pt-1">
                  <span className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                    {m.description}
                  </span>
                  {ready ? (
                    <button
                      type="button"
                      disabled={downloadingModelId !== null}
                      onClick={() => void handleDeleteModel(m.id)}
                      className="shrink-0 rounded-[6px] border px-2 py-1 text-[11px]"
                      style={{
                        backgroundColor: 'var(--lx-card)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-danger)',
                      }}
                    >
                      Delete GGUF
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={downloadingModelId !== null}
                      onClick={() => void handleDownloadModel(m.id)}
                      className="shrink-0 rounded-[6px] border px-2.5 py-1 text-[11px] font-medium"
                      style={{
                        backgroundColor: 'var(--lx-muted)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    >
                      {downloading ? `Downloading ${activePct}%` : 'Download GGUF'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div
          className="grid gap-3 border-t pt-3 sm:grid-cols-3"
          style={{ borderColor: 'var(--lx-border)' }}
        >
          <div>
            <label
              htmlFor="ai-temperature"
              className="mb-1 block text-[11px] font-medium"
              style={{ color: 'var(--lx-fg-muted)' }}
            >
              Temperature ({settings.temperature.toFixed(2)})
            </label>
            <input
              id="ai-temperature"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.temperature}
              onChange={(e) =>
                void onPatchSettings({ temperature: Number.parseFloat(e.target.value) })
              }
              className="w-full"
            />
          </div>

          <div>
            <label
              htmlFor="ai-max-tokens"
              className="mb-1 block text-[11px] font-medium"
              style={{ color: 'var(--lx-fg-muted)' }}
            >
              Max Tokens
            </label>
            <input
              id="ai-max-tokens"
              type="number"
              min={64}
              max={1024}
              step={16}
              value={settings.maxTokens}
              onChange={(e) =>
                void onPatchSettings({
                  maxTokens: Math.max(64, Number.parseInt(e.target.value || '280', 10)),
                })
              }
              className="w-full rounded-[6px] border px-2.5 py-1 text-[12px] lexel-mono"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            />
          </div>

          <div>
            <label
              htmlFor="ai-idle-unload"
              className="mb-1 block text-[11px] font-medium"
              style={{ color: 'var(--lx-fg-muted)' }}
            >
              Idle Auto-Unload (sec)
            </label>
            <input
              id="ai-idle-unload"
              type="number"
              min={0}
              max={3600}
              step={30}
              value={settings.idleUnloadSecs}
              onChange={(e) =>
                void onPatchSettings({
                  idleUnloadSecs: Math.max(0, Number.parseInt(e.target.value || '180', 10)),
                })
              }
              className="w-full rounded-[6px] border px-2.5 py-1 text-[12px] lexel-mono"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label
              htmlFor="ai-ollama-endpoint"
              className="mb-1 block text-[11px] font-medium"
              style={{ color: 'var(--lx-fg-muted)' }}
            >
              Ollama Loopback Endpoint
            </label>
            <input
              id="ai-ollama-endpoint"
              type="text"
              defaultValue={settings.ollamaEndpoint}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== settings.ollamaEndpoint) {
                  void onPatchSettings({ ollamaEndpoint: v });
                }
              }}
              className="w-full rounded-[6px] border px-2.5 py-1 text-[12px] lexel-mono"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            />
          </div>

          <div>
            <label
              htmlFor="ai-openai-endpoint"
              className="mb-1 block text-[11px] font-medium"
              style={{ color: 'var(--lx-fg-muted)' }}
            >
              OpenAI-Compatible Loopback Endpoint
            </label>
            <input
              id="ai-openai-endpoint"
              type="text"
              defaultValue={settings.openaiCompatEndpoint}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== settings.openaiCompatEndpoint) {
                  void onPatchSettings({ openaiCompatEndpoint: v });
                }
              }}
              className="w-full rounded-[6px] border px-2.5 py-1 text-[12px] lexel-mono"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            />
          </div>
        </div>

        {settings.mainModelTier === 'custom' && (
          <div>
            <label
              htmlFor="ai-custom-model"
              className="mb-1 block text-[11px] font-medium"
              style={{ color: 'var(--lx-fg-muted)' }}
            >
              Custom Model Tag or GGUF Path
            </label>
            <input
              id="ai-custom-model"
              type="text"
              defaultValue={settings.customModel}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== settings.customModel) {
                  void daemonRpc('setMainModel', { model: v }).then(() => onRefreshAll());
                }
              }}
              className="w-full rounded-[6px] border px-2.5 py-1 text-[12px] lexel-mono"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            />
          </div>
        )}

        <div className="flex flex-wrap gap-4 text-[12px]">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.keepWarm}
              onChange={(e) => void onPatchSettings({ keepWarm: e.target.checked })}
            />
            Keep model warm in RAM (disable idle auto-unload)
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.saveVoiceMemory}
              onChange={(e) => void onPatchSettings({ saveVoiceMemory: e.target.checked })}
            />
            Save accepted rewrites to local Voice Memory
          </label>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section
          className="space-y-3 rounded-[8px] border p-3"
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

          <form onSubmit={handleRenameProfile} className="flex gap-2">
            <input
              type="text"
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              aria-label="Rename active profile"
              className="min-w-0 flex-1 rounded-[6px] border px-2.5 py-1 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            />
            <button
              type="submit"
              className="rounded-[6px] border px-2.5 py-1 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              Rename
            </button>
          </form>

          {status.profiles.length > 1 && (
            <div className="space-y-1">
              {status.profiles.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between rounded-[6px] border px-2 py-1 text-[11px]"
                  style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
                >
                  <span>
                    {p.name} {p.isActive ? '(active)' : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleDeleteProfile(p.id)}
                    className="rounded px-1.5 py-0.5 text-[11px]"
                    style={{ color: 'var(--lx-danger)' }}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}

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
            {!confirmPurge ? (
              <button
                type="button"
                onClick={() => setConfirmPurge(true)}
                className="rounded-[6px] border px-2.5 py-1 text-[12px]"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-danger)',
                }}
              >
                Purge Local Data
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handlePurgeAll()}
                className="rounded-[6px] border px-2.5 py-1 text-[12px] font-semibold"
                style={{
                  backgroundColor: 'var(--lx-danger-bg)',
                  borderColor: 'var(--lx-danger)',
                  color: 'var(--lx-danger)',
                }}
              >
                Confirm Purge All
              </button>
            )}
          </div>
        </section>

        <section
          className="space-y-2 rounded-[8px] border p-3"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <h2 className="text-[13px] font-semibold">Voice Memory ({voiceExamples.length})</h2>
          <div className="max-h-56 space-y-1.5 overflow-y-auto">
            {voiceExamples.length === 0 ? (
              <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
                No saved style pairs yet. Accept a rewrite in Quick Rewrite or the browser extension
                to build local style memory.
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
                      {ex.surfaceId}
                      {ex.subcontext ? ` (${ex.subcontext})` : ''}
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

      <div className="grid gap-4 md:grid-cols-2">
        <section
          className="space-y-2.5 rounded-[8px] border p-3"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <div>
            <h2 className="text-[13px] font-semibold">Local Writing Insights</h2>
            <p className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
              100% local SQLite counters for the active profile. Never stores raw text and never
              leaves your machine.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center lexel-mono">
            <div
              className="rounded-[6px] border p-2"
              style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
            >
              <div className="text-[15px] font-semibold">
                {writingStats?.totalWordsChecked ?? 0}
              </div>
              <div className="text-[10px]" style={{ color: 'var(--lx-fg-muted)' }}>
                Words Checked
              </div>
            </div>
            <div
              className="rounded-[6px] border p-2"
              style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
            >
              <div className="text-[15px] font-semibold">
                {(writingStats?.totalGrammarHits ?? 0) + (writingStats?.totalSlopHits ?? 0)}
              </div>
              <div className="text-[10px]" style={{ color: 'var(--lx-fg-muted)' }}>
                Grammar &amp; Slop
              </div>
            </div>
            <div
              className="rounded-[6px] border p-2"
              style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
            >
              <div className="text-[15px] font-semibold" style={{ color: 'var(--lx-signal)' }}>
                {writingStats?.totalFixesApplied ?? 0}
              </div>
              <div className="text-[10px]" style={{ color: 'var(--lx-fg-muted)' }}>
                Safe Fixes
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] lexel-mono">
            <span style={{ color: 'var(--lx-fg-muted)' }}>
              Checks run: {writingStats?.totalChecks ?? 0}
            </span>
            <span style={{ color: 'var(--lx-warn)' }}>
              Secrets caught: {writingStats?.totalSecretBlocks ?? 0}
            </span>
          </div>
          {(writingStats?.topSurfaces ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {(writingStats?.topSurfaces ?? []).map(([surface, count]) => (
                <span
                  key={surface}
                  className="rounded-[4px] border px-2 py-0.5 text-[11px] lexel-mono"
                  style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
                >
                  {surface}: {count}
                </span>
              ))}
            </div>
          )}
        </section>

        <section
          className="space-y-2 rounded-[8px] border p-3"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <div>
            <h2 className="text-[13px] font-semibold">System-Wide Hotkey &amp; OS Overlay</h2>
            <p className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
              Check text copied from Slack, Outlook, Notes, or terminals using the global desktop
              shortcut.
            </p>
          </div>
          <div
            className="space-y-1 rounded-[6px] border p-2.5 text-[11px] lexel-mono"
            style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
          >
            <div>
              Shortcut:{' '}
              <strong style={{ color: 'var(--lx-signal)' }}>
                {osOverlay?.globalShortcut ?? 'CmdOrCtrl+Shift+L'}
              </strong>
            </div>
            <div>Platform: {osOverlay?.platform ?? envInfo?.platform ?? 'desktop'}</div>
            <div>Mode: {osOverlay?.nativeOverlayMode ?? 'global_hotkey_clipboard'}</div>
          </div>
          <p className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
            {osOverlay?.notes ??
              'Copy any draft, press Cmd/Ctrl+Shift+L, and Lexel Desktop opens with the text ready to polish.'}
          </p>
        </section>
      </div>
    </div>
  );
}

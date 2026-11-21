import { CheckIcon, RefreshIcon } from './Icons';

export interface DoctorRuntimeDetails {
  llamaServerPath: string | null;
  llamaServerVersion: string | null;
  speculativeLookupSupported: boolean;
  speculativeLookupFlag: string | null;
  cachePromptSupported: boolean;
  hardwareAcceleration: string;
}

export interface DoctorWhisperStatus {
  binaryAvailable: boolean;
  binaryPath: string | null;
  modelAvailable: boolean;
  modelPath: string | null;
}

export interface DoctorNativeTarget {
  browser: string;
  manifestPath: string;
  installed: boolean;
  validJson: boolean;
  hostBinaryExists: boolean;
  allowedOrigins: string[];
}

export interface DoctorModelCheck {
  id: string;
  ggufPath: string;
  ggufInstalled: boolean;
  sizeValid: boolean;
  expectedSha256: string | null;
  actualSha256: string | null;
  sha256Verified: boolean;
  ollamaInstalled: boolean;
}

export interface DoctorPrivacyProof {
  localOnlyVerified: boolean;
  loopbackEnforced: boolean;
  totalSecretBlocks: number;
  redactSecretsEnabled: boolean;
  zeroTelemetry: boolean;
}

export interface DoctorReportData {
  ok: boolean;
  version: string;
  httpPort: number;
  dataDir: string;
  modelsDir: string;
  runtime: {
    activeBackend: string;
    modelLoaded: boolean;
    loadedModel: string | null;
    llamaServerAvailable: boolean;
    ollamaBinaryAvailable: boolean;
    ollamaRunning: boolean;
    ollamaModels: string[];
    lastError: string | null;
  };
  runtimeDetails: DoctorRuntimeDetails;
  whisper: DoctorWhisperStatus;
  nativeMessaging: DoctorNativeTarget[];
  models: DoctorModelCheck[];
  tier0LatencyMs: number | null;
  measuredTokPerSec: number | null;
  privacyProof: DoctorPrivacyProof;
}

export interface DoctorHealthCardProps {
  report: DoctorReportData | null;
  loading?: boolean;
  error?: string | null;
  onRunCheck: (bench?: boolean) => void;
  onInstallNative?: () => void;
  compact?: boolean;
}

function HealthRow({
  label,
  value,
  ok,
  muted,
}: {
  label: string;
  value: string;
  ok?: boolean;
  muted?: string;
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 border-b py-2 last:border-b-0"
      style={{ borderColor: 'var(--lx-border)' }}
    >
      <div className="min-w-0">
        <div className="text-[12px] font-medium" style={{ color: 'var(--lx-fg)' }}>
          {label}
        </div>
        {muted ? (
          <div className="truncate text-[11px] lexel-mono" style={{ color: 'var(--lx-fg-muted)' }}>
            {muted}
          </div>
        ) : null}
      </div>
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-[4px] border px-1.5 py-0.5 text-[11px] lexel-mono lx-tab-nums"
        style={{
          backgroundColor:
            ok === true
              ? 'var(--lx-ok-bg)'
              : ok === false
                ? 'var(--lx-warn-bg)'
                : 'var(--lx-surface)',
          borderColor:
            ok === true ? 'var(--lx-ok)' : ok === false ? 'var(--lx-warn)' : 'var(--lx-border)',
          color:
            ok === true ? 'var(--lx-ok)' : ok === false ? 'var(--lx-warn)' : 'var(--lx-fg-muted)',
        }}
      >
        {ok === true ? <CheckIcon className="h-3 w-3" /> : null}
        <span>{value}</span>
      </span>
    </div>
  );
}

export function DoctorHealthCard({
  report,
  loading = false,
  error = null,
  onRunCheck,
  onInstallNative,
  compact = false,
}: DoctorHealthCardProps) {
  const linkedBrowsers = report
    ? report.nativeMessaging.filter((t) => t.installed && t.validJson).length
    : 0;
  const verifiedModels = report
    ? report.models.filter((m) => (m.ggufInstalled && m.sha256Verified) || m.ollamaInstalled).length
    : 0;

  return (
    <section
      aria-label="System doctor diagnostics"
      className={`rounded-[8px] border ${compact ? 'p-3' : 'p-4'}`}
      style={{
        backgroundColor: 'var(--lx-card)',
        borderColor: 'var(--lx-border)',
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-2 pb-3">
        <div>
          <h2 className="text-[14px] font-semibold">Lexel Doctor</h2>
          <p className="mt-0.5 text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
            Verify local inference runtime, hardware acceleration, GGUF integrity, and browser
            bridges.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={loading}
            onClick={() => onRunCheck(false)}
            className="lx-pressable lx-btn-secondary inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] font-medium"
          >
            <RefreshIcon className="h-3.5 w-3.5" />
            <span>{loading ? 'Checking...' : 'Run check'}</span>
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => onRunCheck(true)}
            className="lx-pressable lx-btn-secondary px-2.5 py-1 text-[12px] font-medium"
          >
            Measure tok/s
          </button>
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-[6px] border px-3 py-2 text-[12px]"
          style={{
            backgroundColor: 'var(--lx-danger-bg)',
            borderColor: 'var(--lx-danger)',
            color: 'var(--lx-danger)',
          }}
        >
          {error}
        </div>
      ) : loading && !report ? (
        <p className="py-3 text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
          Running local diagnostics across runtime, models, and manifests...
        </p>
      ) : !report ? (
        <div
          className="rounded-[6px] border px-3 py-3 text-[12px]"
          style={{
            backgroundColor: 'var(--lx-surface)',
            borderColor: 'var(--lx-border)',
            color: 'var(--lx-fg-muted)',
          }}
        >
          No diagnostic snapshot yet. Run a health check to inspect local runtime and model
          checksums.
        </div>
      ) : (
        <div className="flex flex-col">
          <HealthRow
            label="Inference runtime & acceleration"
            value={`${report.runtime.activeBackend} (${report.runtimeDetails.hardwareAcceleration})`}
            ok={
              report.runtime.llamaServerAvailable ||
              report.runtime.ollamaBinaryAvailable ||
              report.runtime.ollamaRunning
            }
            muted={
              report.runtimeDetails.speculativeLookupSupported
                ? `Prompt lookup (${report.runtimeDetails.speculativeLookupFlag ?? 'supported'}) · KV cache ${report.runtimeDetails.cachePromptSupported ? 'on' : 'off'}`
                : (report.runtimeDetails.llamaServerPath ?? 'No llama-server binary detected')
            }
          />
          <HealthRow
            label="Local models & SHA-256 verification"
            value={`${verifiedModels}/${report.models.length} verified`}
            ok={verifiedModels > 0}
            muted={report.modelsDir}
          />
          <HealthRow
            label="Native Messaging browser bridges"
            value={`${linkedBrowsers}/${report.nativeMessaging.length} linked`}
            ok={linkedBrowsers > 0}
            muted={
              linkedBrowsers > 0
                ? report.nativeMessaging
                    .filter((t) => t.installed)
                    .map((t) => t.browser)
                    .join(', ')
                : 'No browser manifests registered yet'
            }
          />
          <HealthRow
            label="Offline voice dictation (whisper.cpp)"
            value={
              report.whisper.binaryAvailable && report.whisper.modelAvailable
                ? 'Ready'
                : report.whisper.binaryAvailable
                  ? 'Model missing'
                  : 'Not installed'
            }
            ok={report.whisper.binaryAvailable && report.whisper.modelAvailable}
            muted={
              report.whisper.modelPath ??
              report.whisper.binaryPath ??
              'Install whisper-cli and a ggml-*.bin model in models/whisper/'
            }
          />
          <HealthRow
            label="Measured local speed"
            value={
              report.tier0LatencyMs !== null
                ? `Tier 0: ${report.tier0LatencyMs.toFixed(2)}ms · AI: ${
                    report.measuredTokPerSec !== null
                      ? `${report.measuredTokPerSec.toFixed(1)} tok/s`
                      : 'not measured'
                  }`
                : 'Not measured'
            }
            ok={report.tier0LatencyMs !== null ? report.tier0LatencyMs < 5 : undefined}
            muted="Tier 0 budget is <5ms; click Measure tok/s to benchmark local AI"
          />
          <HealthRow
            label="Privacy isolation"
            value={
              report.privacyProof.localOnlyVerified && report.privacyProof.zeroTelemetry
                ? `Local only · ${report.privacyProof.totalSecretBlocks} secrets blocked`
                : 'Preview mode'
            }
            ok={report.privacyProof.localOnlyVerified && report.privacyProof.zeroTelemetry}
            muted={`Loopback 127.0.0.1:${report.httpPort} · redact-and-restore ${
              report.privacyProof.redactSecretsEnabled ? 'enabled' : 'off (strict block)'
            }`}
          />

          {linkedBrowsers === 0 && onInstallNative ? (
            <div className="pt-3">
              <button
                type="button"
                onClick={onInstallNative}
                className="lx-pressable lx-btn-primary px-3 py-1.5 text-[12px] font-semibold"
              >
                Register Browser Native Messaging
              </button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

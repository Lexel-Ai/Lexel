import type {
  AiTaskId,
  DaemonProfile,
  DaemonRuntimeSnapshot,
  DaemonStatusPayload,
  DoctorReport,
  GhostCompletionRequest,
  GhostCompletionResponse,
  RewriteResult,
  ScopedThreadContext,
  SurfaceId,
  UnifiedDaemonSettings,
  VoiceExample,
} from './types';

export const NATIVE_HOST_NAME = 'com.lexel.daemon';

interface NativeResponse<T = unknown> {
  id?: string | number;
  ok: boolean;
  stream?: boolean;
  done?: boolean;
  data?: T;
  error?: string;
}

export interface NativeDaemonResult<T> {
  connected: boolean;
  data?: T;
  error?: string;
  forbidden?: boolean;
  notFound?: boolean;
  installHint?: string;
}

export interface StreamChunkPayload {
  delta: string;
  accumulated: string;
}

function makeNativeInstallHint(): string {
  const extId = typeof chrome !== 'undefined' ? chrome.runtime?.id : undefined;
  return extId ? `lexel-daemon install-native-host --extension-id ${extId}` : 'make setup';
}

/**
 * Ask a running Lexel Desktop / lexel-daemon instance on 127.0.0.1:42424 to register this browser
 * extension's Origin in `com.lexel.daemon.json` so Native Messaging connects with zero manual setup.
 */
export async function registerExtensionWithDesktop(port = 42424): Promise<boolean> {
  if (typeof fetch !== 'function') return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 600);
    const resp = await fetch(`http://127.0.0.1:${port}/v1/bridge/register-extension`, {
      method: 'POST',
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    return resp.ok;
  } catch {
    return false;
  }
}

function sendNativeMessageOnce<T>(
  kind: string,
  payload: Record<string, unknown>,
): Promise<NativeDaemonResult<T>> {
  return new Promise((resolve) => {
    try {
      const req = { id: `${Date.now()}`, kind, payload };
      chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, req, (response: unknown) => {
        const lastErr = chrome.runtime.lastError?.message;
        if (lastErr) {
          const lower = lastErr.toLowerCase();
          const forbidden = lower.includes('forbidden');
          const notFound = lower.includes('not found') || lower.includes('specified native');
          resolve({
            connected: false,
            forbidden,
            notFound,
            installHint: makeNativeInstallHint(),
            error: lastErr,
          });
          return;
        }
        const parsed = response as NativeResponse<T> | undefined;
        if (!parsed || typeof parsed !== 'object') {
          resolve({
            connected: false,
            error: 'Empty response from lexel-daemon native host.',
          });
          return;
        }
        if (!parsed.ok) {
          resolve({
            connected: true,
            error: parsed.error ?? 'lexel-daemon rejected the request.',
          });
          return;
        }
        resolve({
          connected: true,
          data: parsed.data,
        });
      });
    } catch (err) {
      resolve({
        connected: false,
        installHint: makeNativeInstallHint(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

export async function callNativeDaemon<T>(
  kind: string,
  payload: Record<string, unknown> = {},
): Promise<NativeDaemonResult<T>> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendNativeMessage) {
    return {
      connected: false,
      error: 'Native messaging API is unavailable in this environment.',
    };
  }

  const first = await sendNativeMessageOnce<T>(kind, payload);
  if (!first.connected && (first.forbidden || first.notFound)) {
    const registered = await registerExtensionWithDesktop();
    if (registered) {
      return sendNativeMessageOnce<T>(kind, payload);
    }
  }
  return first;
}

/**
 * Stream incremental rewrite chunks from `lexel-daemon` via a persistent Native Messaging port
 * (`kind: "rewriteStream"` per docs/api/daemon-v0.2.md). Falls back cleanly to single-shot
 * `daemonRewrite` if `connectNative` is unavailable or the host responds without streaming.
 */
export async function daemonRewriteStream(
  params: {
    text: string;
    task: AiTaskId;
    surfaceId: SurfaceId;
    subcontext: string | null;
    threadContext?: string;
    domain?: string;
    candidates?: 1 | 2;
    redactSecrets?: boolean | null;
  },
  onChunk?: (chunk: StreamChunkPayload) => void,
): Promise<NativeDaemonResult<RewriteResult>> {
  if (typeof chrome === 'undefined' || typeof chrome.runtime?.connectNative !== 'function') {
    return daemonRewrite(params);
  }

  const runOnce = (): Promise<NativeDaemonResult<RewriteResult>> =>
    new Promise((resolve) => {
      let settled = false;
      let receivedAnyFrame = false;
      let port: chrome.runtime.Port | null = null;

      const finish = (result: NativeDaemonResult<RewriteResult>) => {
        if (settled) return;
        settled = true;
        try {
          port?.disconnect();
        } catch {
          // Port may already be closed.
        }
        resolve(result);
      };

      try {
        port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
      } catch (err) {
        finish({
          connected: false,
          installHint: makeNativeInstallHint(),
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      const reqId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      port.onMessage.addListener((raw: unknown) => {
        receivedAnyFrame = true;
        const msg = raw as NativeResponse<RewriteResult | StreamChunkPayload> | undefined;
        if (!msg || typeof msg !== 'object') {
          finish({ connected: true, error: 'Malformed native stream frame.' });
          return;
        }
        if (!msg.ok) {
          finish({
            connected: true,
            error: msg.error ?? 'lexel-daemon stream rewrite failed.',
          });
          return;
        }
        if (msg.stream && msg.done === false && msg.data) {
          const chunk = msg.data as StreamChunkPayload;
          if (typeof chunk.accumulated === 'string') {
            onChunk?.(chunk);
          }
          return;
        }
        if (msg.data) {
          finish({
            connected: true,
            data: msg.data as RewriteResult,
          });
          return;
        }
        finish({ connected: true, error: 'Daemon stream ended without a rewrite result.' });
      });

      port.onDisconnect.addListener(() => {
        const lastErr = chrome.runtime.lastError?.message;
        if (settled) return;
        if (!receivedAnyFrame) {
          const lower = (lastErr ?? '').toLowerCase();
          finish({
            connected: false,
            forbidden: lower.includes('forbidden'),
            notFound: lower.includes('not found') || lower.includes('specified native'),
            installHint: makeNativeInstallHint(),
            error: lastErr ?? 'Native messaging port disconnected before responding.',
          });
        } else {
          finish({
            connected: true,
            error: lastErr ?? 'Native messaging stream disconnected unexpectedly.',
          });
        }
      });

      port.postMessage({
        id: reqId,
        kind: 'rewriteStream',
        payload: params,
      });
    });

  const first = await runOnce();
  if (!first.connected && (first.forbidden || first.notFound)) {
    const registered = await registerExtensionWithDesktop();
    if (registered) {
      return runOnce();
    }
  }
  return first;
}

export function fetchDaemonStatus(): Promise<NativeDaemonResult<DaemonStatusPayload>> {
  return callNativeDaemon<DaemonStatusPayload>('status');
}

export function daemonDoctor(bench = false): Promise<NativeDaemonResult<DoctorReport>> {
  return callNativeDaemon<DoctorReport>('doctor', bench ? { bench: true } : {});
}

export function daemonGetSettings(): Promise<
  NativeDaemonResult<{ profile: DaemonProfile; settings: UnifiedDaemonSettings }>
> {
  return callNativeDaemon('getSettings');
}

export function daemonPatchSettings(
  patch: Partial<UnifiedDaemonSettings>,
): Promise<NativeDaemonResult<{ profile: DaemonProfile; settings: UnifiedDaemonSettings }>> {
  return callNativeDaemon('patchSettings', { patch });
}

export function daemonToggleAi(enabled: boolean): Promise<
  NativeDaemonResult<{
    activeProfile: DaemonProfile;
    activated: boolean;
    activationError: string | null;
    runtime: DaemonRuntimeSnapshot;
  }>
> {
  return callNativeDaemon('toggleAi', { enabled });
}

export function daemonSetMainModel(model: string): Promise<
  NativeDaemonResult<{
    activeProfile: DaemonProfile;
    activated: boolean;
    activationError: string | null;
    runtime: DaemonRuntimeSnapshot;
  }>
> {
  return callNativeDaemon('setMainModel', { model });
}

export function daemonUnloadAi(): Promise<NativeDaemonResult<DaemonRuntimeSnapshot>> {
  return callNativeDaemon('unloadAi');
}

export function daemonRewrite(params: {
  text: string;
  task: AiTaskId;
  surfaceId: SurfaceId;
  subcontext: string | null;
  threadContext?: string;
  domain?: string;
  candidates?: 1 | 2;
  redactSecrets?: boolean | null;
}): Promise<NativeDaemonResult<RewriteResult>> {
  return callNativeDaemon('rewrite', params);
}

export function daemonComplete(
  params: GhostCompletionRequest,
): Promise<NativeDaemonResult<GhostCompletionResponse>> {
  return callNativeDaemon('complete', { ...params });
}

export function daemonScopeThreadContext(
  source: string,
  threadContext: string,
  maxTokens = 300,
): Promise<NativeDaemonResult<ScopedThreadContext>> {
  return callNativeDaemon('scopeThreadContext', { source, threadContext, maxTokens });
}

export function daemonExpandSnippet(params: {
  trigger: string;
  surfaceId: SurfaceId;
  subcontext?: string | null;
  threadContext?: string;
  notes?: string;
  adaptWithAi?: boolean;
}): Promise<
  NativeDaemonResult<{
    trigger: string;
    rawExpansion: string;
    expandedText: string;
    surfaceId: SurfaceId;
    adaptedWithAi: boolean;
    latencyMs: number;
  }>
> {
  return callNativeDaemon('expandSnippet', params);
}

export function daemonRedactPreview(text: string): Promise<
  NativeDaemonResult<{
    redactedText: string;
    redactedCount: number;
    placeholders: Array<{
      placeholder: string;
      kind: string;
      label: string;
      maskedPreview: string;
    }>;
  }>
> {
  return callNativeDaemon('redactPreview', { text });
}

export function daemonListProfiles(): Promise<
  NativeDaemonResult<{ profiles: DaemonProfile[]; activeProfile: DaemonProfile }>
> {
  return callNativeDaemon('listProfiles');
}

export function daemonCreateProfile(
  name: string,
  cloneFromActive = true,
): Promise<NativeDaemonResult<DaemonProfile>> {
  return callNativeDaemon('createProfile', { name, cloneFromActive, activate: true });
}

export function daemonSwitchProfile(profileId: string): Promise<NativeDaemonResult<DaemonProfile>> {
  return callNativeDaemon('switchProfile', { profileId });
}

export function daemonRenameProfile(
  profileId: string,
  name: string,
): Promise<NativeDaemonResult<DaemonProfile>> {
  return callNativeDaemon('renameProfile', { profileId, name });
}

export function daemonDeleteProfile(profileId: string): Promise<NativeDaemonResult<DaemonProfile>> {
  return callNativeDaemon('deleteProfile', { profileId });
}

export function daemonListVoiceExamples(
  surfaceId?: SurfaceId,
): Promise<NativeDaemonResult<{ examples: VoiceExample[] }>> {
  return callNativeDaemon('listVoiceExamples', surfaceId ? { surfaceId } : {});
}

export function daemonSaveVoiceExample(
  example: Omit<VoiceExample, 'id' | 'createdAt'>,
): Promise<NativeDaemonResult<{ example: VoiceExample }>> {
  return callNativeDaemon('saveVoiceExample', { example });
}

export function daemonDeleteVoiceExample(
  id: string,
): Promise<NativeDaemonResult<{ deleted: boolean }>> {
  return callNativeDaemon('deleteVoiceExample', { id });
}

export function daemonPurgeAll(): Promise<NativeDaemonResult<DaemonProfile>> {
  return callNativeDaemon('purgeAll');
}

export function daemonLookupSynonyms(
  word: string,
): Promise<NativeDaemonResult<{ synonyms: string[] }>> {
  return callNativeDaemon('synonyms', { word });
}

export function daemonApplyRulePreset(preset: string): Promise<NativeDaemonResult<DaemonProfile>> {
  return callNativeDaemon('applyRulePreset', { preset });
}

export interface DownloadModelReport {
  id: string;
  ggufPath: string;
  bytesDownloaded: number;
  sha256: string;
  verified: boolean;
  alreadyPresent: boolean;
}

export function daemonDownloadModel(
  modelId: string,
): Promise<NativeDaemonResult<DownloadModelReport>> {
  return callNativeDaemon('downloadModel', { modelId });
}

export function daemonDeleteModel(
  modelId: string,
): Promise<NativeDaemonResult<{ deleted: boolean }>> {
  return callNativeDaemon('deleteModel', { modelId });
}

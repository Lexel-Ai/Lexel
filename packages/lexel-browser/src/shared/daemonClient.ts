import type {
  AiTaskId,
  DaemonProfile,
  DaemonRuntimeSnapshot,
  DaemonStatusPayload,
  RewriteResult,
  SurfaceId,
  UnifiedDaemonSettings,
  VoiceExample,
} from './types';

export const NATIVE_HOST_NAME = 'com.lexel.daemon';

interface NativeResponse<T = unknown> {
  id?: string | number;
  ok: boolean;
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

export function fetchDaemonStatus(): Promise<NativeDaemonResult<DaemonStatusPayload>> {
  return callNativeDaemon<DaemonStatusPayload>('status');
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
}): Promise<NativeDaemonResult<RewriteResult>> {
  return callNativeDaemon('rewrite', params);
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

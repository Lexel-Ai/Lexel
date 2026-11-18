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
  return extId
    ? `lexel-daemon install-native-host --extension-id ${extId}`
    : 'make setup';
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

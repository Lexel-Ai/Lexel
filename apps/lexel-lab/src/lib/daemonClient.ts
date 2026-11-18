import { assertLocalEndpoint } from './localAi';
import type {
  AiTaskId,
  DaemonConnectionConfig,
  DaemonProfile,
  DaemonRuntimeSnapshot,
  DaemonStatusPayload,
  RewriteResult,
  SurfaceId,
  UnifiedDaemonSettings,
  VoiceExample,
} from './types';

function normalizeBase(endpoint: string): string {
  return assertLocalEndpoint(endpoint).toString().replace(/\/+$/, '');
}

async function daemonFetch<T>(
  conn: DaemonConnectionConfig,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const base = normalizeBase(conn.endpoint);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (conn.token.trim()) {
    headers.Authorization = `Bearer ${conn.token.trim()}`;
  }
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers,
    signal: init?.signal ?? (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(8000) : undefined),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = body;
    try {
      const parsed = JSON.parse(body) as { error?: string };
      if (parsed.error) msg = parsed.error;
    } catch {
      // Keep plain response text when body is not JSON.
    }
    throw new Error(msg || `lexel-daemon returned HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function checkDaemonHealth(
  endpoint: string,
): Promise<{ ok: boolean; authRequired?: boolean; version?: string; error?: string }> {
  let base: string;
  try {
    base = normalizeBase(endpoint);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  try {
    const res = await fetch(`${base}/health`, {
      method: 'GET',
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(2500) : undefined,
    });
    if (!res.ok) {
      return { ok: false, error: `lexel-daemon health check returned HTTP ${res.status}` };
    }
    const data = (await res.json()) as { ok: boolean; authRequired?: boolean; version?: string };
    return data;
  } catch {
    return {
      ok: false,
      error: `Cannot reach lexel-daemon at ${base}. Start it with: make daemon`,
    };
  }
}

export function fetchDaemonStatus(conn: DaemonConnectionConfig): Promise<DaemonStatusPayload> {
  return daemonFetch<DaemonStatusPayload>(conn, '/v1/status');
}

export function listDaemonProfiles(
  conn: DaemonConnectionConfig,
): Promise<{ profiles: DaemonProfile[]; activeProfile: DaemonProfile }> {
  return daemonFetch(conn, '/v1/profiles');
}

export function createDaemonProfile(
  conn: DaemonConnectionConfig,
  name: string,
  cloneFromActive = true,
): Promise<DaemonProfile> {
  return daemonFetch(conn, '/v1/profiles', {
    method: 'POST',
    body: JSON.stringify({ name, cloneFromActive, activate: true }),
  });
}

export function switchDaemonProfile(
  conn: DaemonConnectionConfig,
  profileId: string,
): Promise<DaemonProfile> {
  return daemonFetch(conn, '/v1/profiles/switch', {
    method: 'POST',
    body: JSON.stringify({ profileId }),
  });
}

export function renameDaemonProfile(
  conn: DaemonConnectionConfig,
  profileId: string,
  name: string,
): Promise<DaemonProfile> {
  return daemonFetch(conn, `/v1/profiles/${encodeURIComponent(profileId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

export function deleteDaemonProfile(
  conn: DaemonConnectionConfig,
  profileId: string,
): Promise<DaemonProfile> {
  return daemonFetch(conn, `/v1/profiles/${encodeURIComponent(profileId)}`, {
    method: 'DELETE',
  });
}

export function patchDaemonSettings(
  conn: DaemonConnectionConfig,
  patch: Partial<UnifiedDaemonSettings>,
): Promise<{ profile: DaemonProfile; settings: UnifiedDaemonSettings }> {
  return daemonFetch(conn, '/v1/settings', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function toggleDaemonAi(
  conn: DaemonConnectionConfig,
  enabled: boolean,
): Promise<{
  activeProfile: DaemonProfile;
  activated: boolean;
  activationError: string | null;
  runtime: DaemonRuntimeSnapshot;
}> {
  return daemonFetch(conn, '/v1/ai/toggle', {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
}

export function setDaemonMainModel(
  conn: DaemonConnectionConfig,
  model: string,
): Promise<{
  activeProfile: DaemonProfile;
  activated: boolean;
  activationError: string | null;
  runtime: DaemonRuntimeSnapshot;
}> {
  return daemonFetch(conn, '/v1/ai/main-model', {
    method: 'POST',
    body: JSON.stringify({ model }),
  });
}

export function unloadDaemonAi(conn: DaemonConnectionConfig): Promise<DaemonRuntimeSnapshot> {
  return daemonFetch(conn, '/v1/ai/unload', { method: 'POST' });
}

export function rewriteWithDaemon(
  conn: DaemonConnectionConfig,
  params: {
    text: string;
    task: AiTaskId;
    surfaceId: SurfaceId;
    subcontext: string | null;
    threadContext?: string;
  },
): Promise<RewriteResult> {
  return daemonFetch<RewriteResult>(conn, '/v1/rewrite', {
    method: 'POST',
    body: JSON.stringify(params),
    signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(90000) : undefined,
  });
}

export function listDaemonVoiceExamples(
  conn: DaemonConnectionConfig,
): Promise<{ examples: VoiceExample[] }> {
  return daemonFetch(conn, '/v1/voice-examples');
}

export function saveDaemonVoiceExample(
  conn: DaemonConnectionConfig,
  example: Omit<VoiceExample, 'id' | 'createdAt'>,
): Promise<{ example: VoiceExample }> {
  return daemonFetch(conn, '/v1/voice-examples', {
    method: 'POST',
    body: JSON.stringify(example),
  });
}

export function deleteDaemonVoiceExample(
  conn: DaemonConnectionConfig,
  id: string,
): Promise<{ deleted: boolean }> {
  return daemonFetch(conn, `/v1/voice-examples/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function purgeDaemonAll(conn: DaemonConnectionConfig): Promise<DaemonProfile> {
  return daemonFetch(conn, '/v1/purge', { method: 'POST' });
}

export function fetchDaemonSynonyms(
  conn: DaemonConnectionConfig,
  word: string,
): Promise<{ synonyms: string[] }> {
  return daemonFetch(conn, '/v1/tier0/synonyms', {
    method: 'POST',
    body: JSON.stringify({ word }),
  });
}

export function applyDaemonRulePreset(
  conn: DaemonConnectionConfig,
  preset: string,
): Promise<DaemonProfile> {
  return daemonFetch(conn, '/v1/harper/apply-preset', {
    method: 'POST',
    body: JSON.stringify({ preset }),
  });
}

import { invoke } from '@tauri-apps/api/core';
import {
  applyRulePreset,
  applySafeDeterministicFixesShared,
  resolveSurfaceProfileShared,
  scanSecretsAndPii,
  scanTier0DiagnosticsShared,
  toSentenceCase,
  toTitleCase,
  verifyAiRewriteShared,
  type AiTaskId,
  type RulePresetId,
} from 'lexel-ui';
import manifestData from '../../../../models/manifest.json';
import type {
  DaemonProfile,
  DaemonStatusPayload,
  DesktopEnvInfo,
  DownloadModelReport,
  HarperRulesPayload,
  NativeHostInstallReport,
  NativeHostStatusReport,
  RewriteResponse,
  Tier0CheckResponse,
  UnifiedDaemonSettings,
  VoiceExample,
} from './types';

export interface ManifestModelSpec {
  id: 'lexel-0.5b' | 'lexel-1.5b';
  tier: 'lite' | 'standard';
  label: string;
  description: string;
  ollamaTag: string;
  ggufFilename: string;
  approxRamMb: number;
  sizeBytes: number;
}

export const MODEL_SPECS = manifestData.models as ManifestModelSpec[];

const PREVIEW_STORAGE_KEY = 'lexel.desktop.preview.v1';

interface PreviewStore {
  activeProfileId: string;
  profiles: DaemonProfile[];
  voiceExamples: VoiceExample[];
}

export function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  );
}

export function createDefaultSettings(): UnifiedDaemonSettings {
  return {
    theme: 'dark',
    aiEnabled: true,
    mainModelTier: 'lexel-1.5b',
    customModel: 'qwen2.5:1.5b',
    runtime: 'auto',
    ollamaEndpoint: 'http://127.0.0.1:11434',
    openaiCompatEndpoint: 'http://127.0.0.1:8080',
    temperature: 0.25,
    maxTokens: 280,
    idleUnloadSecs: 300,
    keepWarm: false,
    saveVoiceMemory: true,
    dialect: 0,
    isolateEnglish: false,
    openSuggestionsOnHover: true,
    activationKey: 'off',
    lintDelayMs: 60,
    defaultEnable: true,
    lintConfig: {},
    userDictionary: ['Lexel', 'Harper', 'Weirpack'],
    ignoredLints: '',
    privacyBlocklist: ['mail.google.com', '*.bankofamerica.com'],
    domainStatuses: {},
    surfaceOverrides: {},
    languageMode: 'plaintext',
    customSlopTerms: [],
    disabledSlopTerms: [],
    customSurfaces: [],
  };
}

function loadPreviewStore(): PreviewStore {
  try {
    const raw = globalThis.localStorage?.getItem(PREVIEW_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PreviewStore;
      if (Array.isArray(parsed.profiles) && parsed.profiles.length > 0) {
        return parsed;
      }
    }
  } catch {
    // Ignore corrupt preview storage and rebuild defaults.
  }

  const initial: PreviewStore = {
    activeProfileId: 'default',
    profiles: [
      {
        id: 'default',
        name: 'Default',
        isActive: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        settings: createDefaultSettings(),
      },
    ],
    voiceExamples: [],
  };
  savePreviewStore(initial);
  return initial;
}

function savePreviewStore(store: PreviewStore): void {
  try {
    globalThis.localStorage?.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Non-fatal in read-only test contexts.
  }
}

function getActiveProfile(store: PreviewStore): DaemonProfile {
  return store.profiles.find((p) => p.id === store.activeProfileId) ?? store.profiles[0];
}

function buildPreviewStatus(store: PreviewStore): DaemonStatusPayload {
  const active = getActiveProfile(store);
  return {
    version: '0.1.0',
    daemonRunning: false,
    httpPort: 42424,
    dataDir: '~/.local/share/lexel (browser preview)',
    modelsDir: '~/.local/share/lexel/models',
    activeProfile: active,
    profiles: store.profiles.map((p) => ({ ...p, isActive: p.id === active.id })),
    runtime: {
      activeBackend: 'preview',
      modelLoaded: false,
      loadedModel: null,
      llamaServerAvailable: false,
      ollamaBinaryAvailable: false,
      ollamaRunning: false,
      ollamaModels: [],
      lastError: null,
    },
    models: MODEL_SPECS.map((spec) => ({
      id: spec.id,
      tier: spec.tier,
      label: spec.label,
      description: spec.description,
      ollamaTag: spec.ollamaTag,
      ggufFilename: spec.ggufFilename,
      ggufPath: `~/.local/share/lexel/models/${spec.ggufFilename}`,
      ggufInstalled: false,
      ggufSizeValid: false,
      ollamaInstalled: false,
      approxRamMb: spec.approxRamMb,
      sizeBytes: spec.sizeBytes,
    })),
  };
}

function handlePreviewRpc(kind: string, payload: Record<string, unknown>): unknown {
  const store = loadPreviewStore();
  const active = getActiveProfile(store);

  switch (kind) {
    case 'status':
      return buildPreviewStatus(store);
    case 'getSettings':
      return { profile: active, settings: active.settings };
    case 'patchSettings': {
      const patch = (payload.patch ?? payload) as Partial<UnifiedDaemonSettings>;
      active.settings = { ...active.settings, ...patch };
      active.updatedAt = Date.now();
      savePreviewStore(store);
      return { profile: active, settings: active.settings };
    }
    case 'listProfiles':
      return {
        profiles: store.profiles.map((p) => ({ ...p, isActive: p.id === active.id })),
        activeProfile: active,
      };
    case 'createProfile': {
      const name = String(payload.name ?? 'Profile').trim() || 'Profile';
      const clone = payload.cloneFromActive !== false;
      const created: DaemonProfile = {
        id: `prof_${Date.now()}`,
        name,
        isActive: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        settings: clone ? structuredClone(active.settings) : createDefaultSettings(),
      };
      store.profiles.push(created);
      store.activeProfileId = created.id;
      savePreviewStore(store);
      return created;
    }
    case 'switchProfile': {
      const targetId = String(payload.profileId ?? '');
      const found = store.profiles.find((p) => p.id === targetId);
      if (!found) throw new Error(`Profile not found: ${targetId}`);
      store.activeProfileId = found.id;
      savePreviewStore(store);
      return found;
    }
    case 'deleteProfile': {
      if (store.profiles.length <= 1) throw new Error('Cannot delete the last profile.');
      const targetId = String(payload.profileId ?? '');
      store.profiles = store.profiles.filter((p) => p.id !== targetId);
      if (store.activeProfileId === targetId) {
        store.activeProfileId = store.profiles[0].id;
      }
      savePreviewStore(store);
      return { deleted: true };
    }
    case 'toggleAi': {
      active.settings.aiEnabled = Boolean(payload.enabled);
      savePreviewStore(store);
      return {
        activeProfile: active,
        activated: false,
        activationError: null,
        runtime: buildPreviewStatus(store).runtime,
      };
    }
    case 'setMainModel': {
      const model = String(payload.model ?? 'lexel-1.5b');
      active.settings.mainModelTier =
        model === '0.5b' || model === 'lexel-0.5b'
          ? 'lexel-0.5b'
          : model === '1.5b' || model === 'lexel-1.5b'
            ? 'lexel-1.5b'
            : 'custom';
      if (active.settings.mainModelTier === 'custom') {
        active.settings.customModel = model;
      }
      savePreviewStore(store);
      return {
        activeProfile: active,
        activated: false,
        activationError: null,
        runtime: buildPreviewStatus(store).runtime,
      };
    }
    case 'unloadAi':
      return buildPreviewStatus(store).runtime;
    case 'downloadModel':
      throw new Error(
        'Model downloads require the native Lexel Desktop app or `make setup`.',
      );
    case 'harperRules': {
      const sampleNames = [
        ['SpellCheck', 'Checks spelling against Harper dictionary and user lexicon.', true],
        ['AnA', 'Checks indefinite articles a/an before nouns.', true],
        ['AvoidContractions', 'Prefers expanded words over contractions in formal prose.', false],
        ['OxfordComma', 'Requires a serial comma before coordinating conjunctions.', false],
        ['LongSentences', 'Flags overly long sentences that reduce readability.', false],
      ] as const;
      return {
        rules: sampleNames.map(([name, description, defaultEnabled]) => {
          const override = active.settings.lintConfig[name];
          return {
            name,
            description,
            defaultEnabled,
            enabled: override === undefined || override === null ? defaultEnabled : override,
          };
        }),
        lintConfig: active.settings.lintConfig,
        dialect: active.settings.dialect,
        isolateEnglish: active.settings.isolateEnglish,
      } satisfies HarperRulesPayload;
    }
    case 'applyRulePreset': {
      const preset = String(payload.preset ?? 'curated') as RulePresetId;
      active.settings.lintConfig = applyRulePreset(active.settings.lintConfig, preset);
      savePreviewStore(store);
      return active;
    }
    case 'tier0Check': {
      const text = String(payload.text ?? '');
      const surfaceId = String(payload.surfaceId ?? 'general');
      const profile = resolveSurfaceProfileShared(surfaceId, active.settings.customSurfaces);
      const tier0Options = {
        customSlopTerms: active.settings.customSlopTerms,
        disabledSlopTerms: active.settings.disabledSlopTerms,
      };
      const diag = scanTier0DiagnosticsShared(text, profile, tier0Options);
      const safe = applySafeDeterministicFixesShared(text, profile, tier0Options);
      const secrets = scanSecretsAndPii(text);
      return {
        harper: [],
        slop: diag.slopLints.map((s) => ({
          start: s.span.start,
          end: s.span.end,
          term: s.problem_text,
          replacement: s.suggestions[0]?.replacement_text ?? null,
          category: 'slop',
        })),
        surface: diag.surfaceLints.map((v) => ({
          start: v.span.start,
          end: v.span.end,
          kind: v.lint_kind_pretty,
          message: v.message_html,
          problemText: v.problem_text,
        })),
        secrets: secrets.map((s) => ({
          start: s.start,
          end: s.end,
          kind: s.kind,
          masked: s.maskedPreview,
        })),
        safeFixedText: safe.text,
        safeFixesCount: safe.fixesApplied,
        blocked: false,
      } satisfies Tier0CheckResponse;
    }
    case 'fixSafe':
    case 'fixAllSafe': {
      const text = String(payload.text ?? '');
      const surfaceId = String(payload.surfaceId ?? 'general');
      const profile = resolveSurfaceProfileShared(surfaceId, active.settings.customSurfaces);
      return applySafeDeterministicFixesShared(text, profile, {
        customSlopTerms: active.settings.customSlopTerms,
        disabledSlopTerms: active.settings.disabledSlopTerms,
      });
    }
    case 'titleCase':
      return { text: toTitleCase(String(payload.text ?? '')) };
    case 'sentenceCase':
      return { text: toSentenceCase(String(payload.text ?? '')) };
    case 'rewrite': {
      const text = String(payload.text ?? '');
      const surfaceId = String(payload.surfaceId ?? 'general');
      const profile = resolveSurfaceProfileShared(surfaceId, active.settings.customSurfaces);
      const tier0Options = {
        customSlopTerms: active.settings.customSlopTerms,
        disabledSlopTerms: active.settings.disabledSlopTerms,
      };
      const safe = applySafeDeterministicFixesShared(text, profile, tier0Options);
      return {
        original: text,
        suggestion: safe.text,
        model: 'preview-deterministic',
        latencyMs: 2,
        gates: verifyAiRewriteShared(text, safe.text, profile, tier0Options),
        surfaceId,
        subcontext: (payload.subcontext as string | null) ?? null,
      } satisfies RewriteResponse;
    }
    case 'listVoiceExamples': {
      const surface = payload.surfaceId ? String(payload.surfaceId) : null;
      return {
        examples: surface
          ? store.voiceExamples.filter((e) => e.surfaceId === surface)
          : store.voiceExamples,
      };
    }
    case 'saveVoiceExample': {
      const raw = (payload.example ?? payload) as Partial<VoiceExample>;
      const ex: VoiceExample = {
        id: `voice_${Date.now()}`,
        surfaceId: String(raw.surfaceId ?? 'general'),
        subcontext: raw.subcontext ?? null,
        original: String(raw.original ?? ''),
        rewritten: String(raw.rewritten ?? ''),
        action: String(raw.action ?? 'accepted'),
        createdAt: Date.now(),
      };
      store.voiceExamples.unshift(ex);
      savePreviewStore(store);
      return { example: ex };
    }
    case 'deleteVoiceExample': {
      const id = String(payload.id ?? '');
      store.voiceExamples = store.voiceExamples.filter((e) => e.id !== id);
      savePreviewStore(store);
      return { deleted: true };
    }
    case 'exportBackup':
      return {
        version: 1,
        exportedAt: Date.now(),
        profiles: store.profiles,
        voiceExamples: store.voiceExamples,
      };
    case 'importBackup': {
      const backup = (payload.backup ?? payload) as {
        profiles?: DaemonProfile[];
        voiceExamples?: VoiceExample[];
      };
      if (!Array.isArray(backup.profiles) || backup.profiles.length === 0) {
        throw new Error('Backup JSON has no profiles.');
      }
      store.profiles = backup.profiles;
      store.activeProfileId = backup.profiles.find((p) => p.isActive)?.id ?? backup.profiles[0].id;
      store.voiceExamples = Array.isArray(backup.voiceExamples) ? backup.voiceExamples : [];
      savePreviewStore(store);
      return getActiveProfile(store);
    }
    case 'purgeAll': {
      const fresh: PreviewStore = {
        activeProfileId: 'default',
        profiles: [
          {
            id: 'default',
            name: 'Default',
            isActive: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            settings: createDefaultSettings(),
          },
        ],
        voiceExamples: [],
      };
      savePreviewStore(fresh);
      return fresh.profiles[0];
    }
    default:
      throw new Error(`Unsupported preview RPC command: ${kind}`);
  }
}

export async function daemonRpc<T>(
  kind: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  if (isTauriRuntime()) {
    return invoke<T>('daemon_rpc', { kind, payload });
  }
  return handlePreviewRpc(kind, payload) as T;
}

export async function getDesktopEnvInfo(): Promise<DesktopEnvInfo> {
  if (isTauriRuntime()) {
    return invoke<DesktopEnvInfo>('desktop_env_info');
  }
  return {
    platform: 'browser-preview',
    arch: 'web',
    dataDir: '~/.local/share/lexel',
    dbPath: '~/.local/share/lexel/lexel.db',
    modelsDir: '~/.local/share/lexel/models',
    daemonBin: null,
  };
}

export async function getNativeHostStatus(): Promise<NativeHostStatusReport> {
  if (isTauriRuntime()) {
    return invoke<NativeHostStatusReport>('native_host_status');
  }
  return {
    hostName: 'com.lexel.daemon',
    daemonBin: null,
    targets: [
      { browser: 'Google Chrome', manifestPath: '~/.config/google-chrome/NativeMessagingHosts/com.lexel.daemon.json', installed: false },
      { browser: 'Chromium', manifestPath: '~/.config/chromium/NativeMessagingHosts/com.lexel.daemon.json', installed: false },
      { browser: 'Brave', manifestPath: '~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.lexel.daemon.json', installed: false },
      { browser: 'Firefox', manifestPath: '~/.mozilla/native-messaging-hosts/com.lexel.daemon.json', installed: false },
    ],
  };
}

export async function installNativeMessaging(
  extensionIds: string[],
): Promise<NativeHostInstallReport> {
  if (isTauriRuntime()) {
    return invoke<NativeHostInstallReport>('install_native_messaging', { extensionIds });
  }
  throw new Error('Native Messaging installation requires running Lexel Desktop via Tauri.');
}

export function downloadModel(modelId: string): Promise<DownloadModelReport> {
  return daemonRpc<DownloadModelReport>('downloadModel', { modelId });
}

export function rewriteWithTask(params: {
  text: string;
  task: AiTaskId;
  surfaceId: string;
  subcontext: string | null;
  threadContext?: string;
}): Promise<RewriteResponse> {
  return daemonRpc<RewriteResponse>('rewrite', params);
}

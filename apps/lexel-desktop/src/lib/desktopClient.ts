import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  applyRulePreset,
  applySafeDeterministicFixesShared,
  type DoctorReportData,
  normalizeTypography,
  type RulePresetId,
  resolveSurfaceProfileShared,
  scanInvisibleChars,
  scanSecretsAndPii,
  scanStructureIssues,
  scanStyleGuide,
  scanTier0DiagnosticsShared,
  type TonePillId,
  toSentenceCase,
  toTitleCase,
  verifyAiRewriteShared,
} from 'lexel-ui';
import manifestData from '../../../../models/manifest.json';
import type {
  ActiveWindowSurface,
  ClipboardPolishReport,
  DaemonProfile,
  DaemonStatusPayload,
  DesktopEnvInfo,
  DownloadModelReport,
  DownloadProgress,
  DraftSnapshot,
  ExpandSnippetResponse,
  ExtendedTextSnippet,
  GitVoiceImportReport,
  HarperRulesPayload,
  NativeHostInstallReport,
  NativeHostStatusReport,
  OsOverlayCapabilities,
  RedactPreviewResponse,
  RewriteBeforePasteReport,
  RewriteResponse,
  Tier0CheckResponse,
  TranscribeResponse,
  UnifiedDaemonSettings,
  VoiceExample,
  WeeklyInsightsReport,
  WritingStatsSummary,
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

export const BUILTIN_STARTER_SNIPPETS: readonly ExtendedTextSnippet[] = [
  {
    trigger: '/standup',
    expansion: 'Yesterday:\n- {{notes}}\n\nToday:\n- \n\nBlockers:\n- None',
    label: 'Daily standup update',
    surfaceId: null,
    adaptToSurface: true,
    category: 'status',
    builtIn: true,
  },
  {
    trigger: '/lgtm',
    expansion: 'Looks good to me. No blocking issues.',
    label: 'PR approval',
    surfaceId: 'web_github_pr',
    adaptToSurface: true,
    category: 'code-review',
    builtIn: true,
  },
  {
    trigger: '/decline',
    expansion: 'Thanks for reaching out. I cannot take this on right now, so I will pass.',
    label: 'Polite decline',
    surfaceId: 'web_email',
    adaptToSurface: true,
    category: 'email',
    builtIn: true,
  },
];

const PREVIEW_STORAGE_KEY = 'lexel.desktop.preview.v2';

interface PreviewStore {
  activeProfileId: string;
  profiles: DaemonProfile[];
  voiceExamples: VoiceExample[];
  drafts?: DraftSnapshot[];
  stats?: WritingStatsSummary;
  crutchCounts?: Record<string, number>;
  slopCounts?: Record<string, number>;
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
    temperature: 0.3,
    maxTokens: 280,
    idleUnloadSecs: 180,
    keepWarm: false,
    saveVoiceMemory: true,
    dialect: 0,
    isolateEnglish: false,
    openSuggestionsOnHover: true,
    activationKey: 'off',
    lintDelayMs: 0,
    defaultEnable: true,
    hotkey: { modifiers: ['Alt'], key: 'l' },
    lintConfig: {},
    userDictionary: ['Lexel', 'Harper', 'Weirpack'],
    ignoredLints: '',
    privacyBlocklist: [
      '1password.com',
      'bitwarden.com',
      'accounts.google.com',
      'chase.com',
      'bankofamerica.com',
      'paypal.com',
      'stripe.com',
    ],
    domainStatuses: {},
    surfaceOverrides: {},
    languageMode: 'plaintext',
    customSlopTerms: [],
    disabledSlopTerms: [],
    customSurfaces: [],
    weirpacks: [],
    styleGuide: [],
    snippets: [],
    redactSecrets: false,
    ghostTextEnabled: false,
    crutchWords: ['just', 'actually', 'basically', 'honestly'],
    whisperModelPath: '',
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
    stats: {
      totalChecks: 0,
      totalWordsChecked: 0,
      totalGrammarHits: 0,
      totalSlopHits: 0,
      totalSecretBlocks: 0,
      totalFixesApplied: 0,
      topSurfaces: [],
    },
    crutchCounts: {},
    slopCounts: {},
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
    version: '0.2.0',
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

function buildPreviewRedact(text: string): RedactPreviewResponse {
  const matches = scanSecretsAndPii(text);
  if (matches.length === 0) {
    return { redactedText: text, redactedCount: 0, placeholders: [] };
  }
  let out = '';
  let cursor = 0;
  const placeholders: RedactPreviewResponse['placeholders'] = [];
  matches.forEach((m, idx) => {
    const token = `[LEXEL_REDACTED_${idx + 1}]`;
    out += text.slice(cursor, m.start) + token;
    cursor = m.end;
    placeholders.push({
      placeholder: token,
      kind: m.kind,
      label: m.label,
      maskedPreview: m.maskedPreview,
    });
  });
  out += text.slice(cursor);
  return { redactedText: out, redactedCount: matches.length, placeholders };
}

function buildPreviewRewriteSuggestion(_text: string, task: TonePillId, safeText: string): string {
  switch (task) {
    case 'shorten': {
      const compact = safeText
        .replace(/\b(in order to)\b/gi, 'to')
        .replace(/\b(due to the fact that)\b/gi, 'because')
        .replace(/\b(really|very|basically|actually|just)\s+/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      return compact || safeText;
    }
    case 'direct':
      return safeText
        .replace(/^(hi|hello|hey|just wanted to|i was wondering if|honestly|basically)[,\s]+/i, '')
        .replace(/^[a-z]/, (c) => c.toUpperCase())
        .trim();
    case 'softer':
      return safeText
        .replace(/\bobviously[,\s]*/gi, '')
        .replace(/\bas i already said[,\s]*/gi, 'To recap, ')
        .replace(/\bwhy didn't you\b/gi, 'Could we check whether you had a chance to')
        .trim();
    case 'bluf': {
      const sentences = safeText
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const askIdx = sentences.findIndex((s) => s.endsWith('?'));
      if (askIdx > 0) {
        const [ask] = sentences.splice(askIdx, 1);
        return [ask, ...sentences].join(' ');
      }
      return safeText;
    }
    default:
      return safeText;
  }
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
    case 'renameProfile': {
      const targetId = String(payload.profileId ?? '');
      const name = String(payload.name ?? '').trim();
      const found = store.profiles.find((p) => p.id === targetId);
      if (!found) throw new Error(`Profile not found: ${targetId}`);
      if (name) {
        found.name = name;
        found.updatedAt = Date.now();
        savePreviewStore(store);
      }
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
      return getActiveProfile(store);
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
      } else {
        active.settings.customModel =
          active.settings.mainModelTier === 'lexel-0.5b' ? 'qwen2.5:0.5b' : 'qwen2.5:1.5b';
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
    case 'deleteModel':
      throw new Error(
        'Model file management requires the native Lexel Desktop app or `make setup`.',
      );
    case 'harperRules': {
      const sampleRules = [
        ['SpellCheck', 'Checks spelling against Harper dictionary and user lexicon.', true],
        ['AnA', 'Checks indefinite articles a/an before nouns.', true],
        ['AvoidContractions', 'Prefers expanded words over contractions in formal prose.', false],
        ['OxfordComma', 'Requires a serial comma before coordinating conjunctions.', false],
        ['LongSentences', 'Flags overly long sentences that reduce readability.', false],
      ] as const;
      return {
        rules: sampleRules.map(([id, description, defaultEnabled]) => {
          const override = active.settings.lintConfig[id];
          return {
            id,
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
    case 'buildWeirpack': {
      const rawName = String(payload.ruleName ?? 'CustomLexelRule').replace(/[^A-Za-z0-9_]/g, '');
      const name = `${rawName || 'CustomLexelRule'}.weirpack`;
      const stored = {
        name,
        bytesBase64: '',
        ruleCount: 1,
        enabled: true,
      };
      const existing = active.settings.weirpacks ?? [];
      active.settings.weirpacks = [...existing.filter((p) => p.name !== name), stored];
      active.updatedAt = Date.now();
      savePreviewStore(store);
      return {
        weirpack: stored,
        summary: {
          ruleCount: 1,
          ruleNames: [rawName || 'CustomLexelRule'],
          hasDictionary: false,
          failures: {},
        },
        profile: active,
      };
    }
    case 'validateWeirpack': {
      const name = String(payload.name ?? 'custom.weirpack').trim() || 'custom.weirpack';
      const stored = {
        name,
        bytesBase64: String(payload.bytesBase64 ?? ''),
        ruleCount: 1,
        enabled: true,
      };
      if (payload.save) {
        const existing = active.settings.weirpacks ?? [];
        active.settings.weirpacks = [...existing.filter((p) => p.name !== name), stored];
        active.updatedAt = Date.now();
        savePreviewStore(store);
      }
      return {
        weirpack: stored,
        summary: { ruleCount: 1, ruleNames: [], hasDictionary: false, failures: {} },
        profile: active,
      };
    }
    case 'tier0Check': {
      const text = String(payload.text ?? '');
      const surfaceId = String(payload.surfaceId ?? 'general');
      const profile = resolveSurfaceProfileShared(surfaceId, active.settings.customSurfaces);
      const tier0Options = {
        customSlopTerms: active.settings.customSlopTerms,
        disabledSlopTerms: active.settings.disabledSlopTerms,
        styleGuide: active.settings.styleGuide ?? [],
      };
      const diag = scanTier0DiagnosticsShared(text, profile, tier0Options);
      const safe = applySafeDeterministicFixesShared(text, profile, tier0Options);
      const secrets = scanSecretsAndPii(text);

      // Record real local preview stats on explicit check
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      if (words > 0) {
        const prev = store.stats ?? {
          totalChecks: 0,
          totalWordsChecked: 0,
          totalGrammarHits: 0,
          totalSlopHits: 0,
          totalSecretBlocks: 0,
          totalFixesApplied: 0,
          topSurfaces: [],
        };
        const surfaceMap = new Map(prev.topSurfaces);
        surfaceMap.set(surfaceId, (surfaceMap.get(surfaceId) ?? 0) + 1);
        store.stats = {
          ...prev,
          totalChecks: prev.totalChecks + 1,
          totalWordsChecked: prev.totalWordsChecked + words,
          totalSlopHits: prev.totalSlopHits + diag.slopLints.length,
          totalSecretBlocks: prev.totalSecretBlocks + secrets.length,
          topSurfaces: [...surfaceMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
        };
        const slopCounts = store.slopCounts ?? {};
        for (const s of diag.slopLints) {
          const key = s.problem_text.toLowerCase();
          slopCounts[key] = (slopCounts[key] ?? 0) + 1;
        }
        store.slopCounts = slopCounts;

        const crutchCounts = store.crutchCounts ?? {};
        for (const word of ['just', 'actually', 'basically', 'honestly', 'really']) {
          const hits = text.match(new RegExp(`\\b${word}\\b`, 'gi'))?.length ?? 0;
          if (hits > 0) crutchCounts[word] = (crutchCounts[word] ?? 0) + hits;
        }
        store.crutchCounts = crutchCounts;
        savePreviewStore(store);
      }

      return {
        harper: [],
        slop: diag.slopLints.map((s) => ({
          start: s.span.start,
          end: s.span.end,
          term: s.problem_text,
          isEmDash: s.problem_text.includes('—') || s.problem_text.includes('--'),
          suggestion: s.suggestions[0]?.replacement_text ?? null,
        })),
        surface: diag.surfaceLints.map((v) => ({
          start: v.span.start,
          end: v.span.end,
          kind: v.lint_kind_pretty,
          message: v.message_html,
        })),
        secrets: secrets.map((s) => ({
          start: s.start,
          end: s.end,
          kind: s.kind,
          label: s.label,
          maskedPreview: s.maskedPreview,
        })),
        invisibleChars: scanInvisibleChars(text),
        structure: scanStructureIssues(text),
        styleGuide: scanStyleGuide(text, active.settings.styleGuide ?? []),
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
      const res = applySafeDeterministicFixesShared(text, profile, {
        customSlopTerms: active.settings.customSlopTerms,
        disabledSlopTerms: active.settings.disabledSlopTerms,
        styleGuide: active.settings.styleGuide ?? [],
      });
      if (res.fixesApplied > 0 && store.stats) {
        store.stats.totalFixesApplied += res.fixesApplied;
        savePreviewStore(store);
      }
      return res;
    }
    case 'redactPreview':
      return buildPreviewRedact(String(payload.text ?? ''));
    case 'titleCase':
      return { text: toTitleCase(String(payload.text ?? '')) };
    case 'sentenceCase':
      return { text: toSentenceCase(String(payload.text ?? '')) };
    case 'normalizeTypography':
      return normalizeTypography(String(payload.text ?? ''));
    case 'synonyms':
      return { synonyms: [] };
    case 'rewrite': {
      const text = String(payload.text ?? '');
      const task = (payload.task as TonePillId) ?? 'deslop';
      const surfaceId = String(payload.surfaceId ?? 'general');
      const requestedCandidates = Number(payload.candidates ?? 1);
      const redact =
        typeof payload.redactSecrets === 'boolean'
          ? payload.redactSecrets
          : Boolean(active.settings.redactSecrets);

      const profile = resolveSurfaceProfileShared(surfaceId, active.settings.customSurfaces);
      const tier0Options = {
        customSlopTerms: active.settings.customSlopTerms,
        disabledSlopTerms: active.settings.disabledSlopTerms,
      };
      const secrets = scanSecretsAndPii(text);
      if (secrets.length > 0 && !redact) {
        throw new Error(
          `Draft contains detected secrets or PII (${secrets.map((s) => s.label).join(', ')}). Remove them or enable Redact-and-Restore.`,
        );
      }

      const safe = applySafeDeterministicFixesShared(text, profile, tier0Options);
      const primary = buildPreviewRewriteSuggestion(text, task, safe.text);
      const primaryGates = verifyAiRewriteShared(text, primary, profile, tier0Options);

      const candidates = [
        {
          label: task === 'shorten' ? 'Tight' : 'Direct',
          suggestion: primary,
          gates: primaryGates,
          retried: false,
        },
      ];
      if (requestedCandidates >= 2) {
        const ultraShort = buildPreviewRewriteSuggestion(text, 'shorten', primary);
        candidates.push({
          label: 'Ultra-Short',
          suggestion: ultraShort,
          gates: verifyAiRewriteShared(text, ultraShort, profile, tier0Options),
          retried: false,
        });
      }

      const fastPath = task === 'deslop' || task === 'fix_grammar_flow';
      return {
        original: text,
        suggestion: primary,
        model: fastPath ? 'tier0-deterministic' : 'preview-deterministic',
        latencyMs: 2,
        gates: primaryGates,
        surfaceId,
        subcontext: (payload.subcontext as string | null) ?? null,
        fastPath,
        retried: false,
        failedConstraints: [],
        candidates,
        redactedCount: redact ? secrets.length : 0,
        restoredCleanly: true,
      } satisfies RewriteResponse;
    }
    case 'listSnippets': {
      const user = active.settings.snippets ?? [];
      const userTriggers = new Set(user.map((s) => s.trigger));
      const merged = [
        ...BUILTIN_STARTER_SNIPPETS.filter((b) => !userTriggers.has(b.trigger)),
        ...user,
      ];
      return { snippets: merged };
    }
    case 'expandSnippet': {
      const trigger = String(payload.trigger ?? '').trim();
      const surfaceId = String(payload.surfaceId ?? 'general');
      const notes = String(payload.notes ?? '').trim();
      const subcontext = String(payload.subcontext ?? '').trim();
      const user = active.settings.snippets ?? [];
      const all = [...user, ...BUILTIN_STARTER_SNIPPETS];
      const match = all.find((s) => s.trigger === trigger);
      if (!match) {
        throw new Error(`Snippet not found: ${trigger}`);
      }
      const today = new Date().toISOString().slice(0, 10);
      const expandedText = match.expansion
        .replaceAll('{{date}}', today)
        .replaceAll('{{surface}}', surfaceId)
        .replaceAll('{{subcontext}}', subcontext)
        .replaceAll('{{notes}}', notes || 'Update details');
      return {
        trigger,
        rawExpansion: match.expansion,
        expandedText,
        surfaceId,
        adaptedWithAi: false,
        latencyMs: 1,
      } satisfies ExpandSnippetResponse;
    }
    case 'transcribe':
      throw new Error(
        'Offline voice transcription requires native Lexel Desktop with `whisper-cli` and a local GGML model in models/whisper/.',
      );
    case 'doctor': {
      const start = performance.now();
      const profile = resolveSurfaceProfileShared('general', active.settings.customSurfaces);
      scanTier0DiagnosticsShared('In todays landscape, we delve into local latency.', profile);
      const elapsed = Math.max(0.1, Number((performance.now() - start).toFixed(2)));
      return {
        ok: true,
        version: '0.2.0',
        httpPort: 42424,
        dataDir: '~/.local/share/lexel (browser preview)',
        modelsDir: '~/.local/share/lexel/models',
        runtime: buildPreviewStatus(store).runtime,
        runtimeDetails: {
          llamaServerPath: null,
          llamaServerVersion: null,
          speculativeLookupSupported: false,
          speculativeLookupFlag: null,
          cachePromptSupported: false,
          hardwareAcceleration: 'browser-preview',
        },
        whisper: {
          binaryAvailable: false,
          binaryPath: null,
          modelAvailable: false,
          modelPath: null,
        },
        nativeMessaging: [
          {
            browser: 'Google Chrome',
            manifestPath: '~/.config/google-chrome/NativeMessagingHosts/com.lexel.daemon.json',
            installed: false,
            validJson: false,
            hostBinaryExists: false,
            allowedOrigins: [],
          },
          {
            browser: 'Firefox',
            manifestPath: '~/.mozilla/native-messaging-hosts/com.lexel.daemon.json',
            installed: false,
            validJson: false,
            hostBinaryExists: false,
            allowedOrigins: [],
          },
        ],
        models: MODEL_SPECS.map((m) => ({
          id: m.id,
          ggufPath: `~/.local/share/lexel/models/${m.ggufFilename}`,
          ggufInstalled: false,
          sizeValid: false,
          expectedSha256: null,
          actualSha256: null,
          sha256Verified: false,
          ollamaInstalled: false,
        })),
        tier0LatencyMs: elapsed,
        measuredTokPerSec: null,
        privacyProof: {
          localOnlyVerified: false,
          loopbackEnforced: true,
          totalSecretBlocks: store.stats?.totalSecretBlocks ?? 0,
          redactSecretsEnabled: Boolean(active.settings.redactSecrets),
          zeroTelemetry: true,
        },
      } satisfies DoctorReportData;
    }
    case 'weeklyInsights': {
      const stats = store.stats ?? {
        totalChecks: 0,
        totalWordsChecked: 0,
        totalGrammarHits: 0,
        totalSlopHits: 0,
        totalSecretBlocks: 0,
        totalFixesApplied: 0,
        topSurfaces: [],
      };
      const banned = active.settings.crutchWords ?? [];
      const bannedLower = new Set(banned.map((w) => w.toLowerCase()));
      const crutchEntries = Object.entries(store.crutchCounts ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([word, count]) => ({ word, count, banned: bannedLower.has(word.toLowerCase()) }));
      const slopEntries = Object.entries(store.slopCounts ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([term, count]) => ({ term, count }));
      const today = new Date().toISOString().slice(0, 10);
      return {
        periodDays: Number(payload.days ?? 7),
        checksInPeriod: stats.totalChecks,
        wordsInPeriod: stats.totalWordsChecked,
        slopCaughtInPeriod: stats.totalSlopHits,
        grammarHitsInPeriod: stats.totalGrammarHits,
        secretsBlockedInPeriod: stats.totalSecretBlocks,
        fixesAppliedInPeriod: stats.totalFixesApplied,
        clarityScore: null,
        clarityDelta: null,
        concisenessScore: null,
        concisenessDelta: null,
        topCrutchWords: crutchEntries,
        bannedCrutchWords: banned,
        topSlopPatterns: slopEntries,
        dailyBuckets:
          stats.totalChecks > 0
            ? [
                {
                  day: today,
                  checks: stats.totalChecks,
                  words: stats.totalWordsChecked,
                  slopHits: stats.totalSlopHits,
                  grammarHits: stats.totalGrammarHits,
                  fixesApplied: stats.totalFixesApplied,
                },
              ]
            : [],
        voiceExamplesCount: store.voiceExamples.length,
      } satisfies WeeklyInsightsReport;
    }
    case 'getCrutchWords':
      return { words: active.settings.crutchWords ?? [] };
    case 'setCrutchWords': {
      const words = Array.isArray(payload.words)
        ? payload.words.map((w) => String(w).trim()).filter(Boolean)
        : [];
      active.settings.crutchWords = [...new Set(words)];
      savePreviewStore(store);
      return { words: active.settings.crutchWords };
    }
    case 'importVoiceExamples': {
      const samples = Array.isArray(payload.samples)
        ? (payload.samples as Array<{ surfaceId?: string; text?: string; original?: string }>)
        : [];
      let importedCount = 0;
      let skippedSecretsCount = 0;
      for (const s of samples) {
        const text = String(s.text ?? '').trim();
        if (!text) continue;
        if (scanSecretsAndPii(text).length > 0) {
          skippedSecretsCount += 1;
          continue;
        }
        store.voiceExamples.unshift({
          id: `voice_${Date.now()}_${importedCount}`,
          surfaceId: String(s.surfaceId ?? 'general'),
          subcontext: null,
          original: String(s.original ?? text),
          rewritten: text,
          action: 'imported',
          createdAt: Date.now(),
        });
        importedCount += 1;
      }
      savePreviewStore(store);
      return { importedCount, skippedSecretsCount };
    }
    case 'exportSimpo': {
      const pairs = store.voiceExamples
        .filter(
          (e) => (e.action === 'edited' || e.action === 'rejected') && e.original !== e.rewritten,
        )
        .map((e) => ({
          pair_id: `user_pref_${e.id}`,
          example_id: e.id,
          surface_id: e.surfaceId,
          task: 'deslop',
          subcontext: e.subcontext,
          source: e.original,
          chosen: e.rewritten,
          rejected: e.original,
          perturbation_type: e.action === 'rejected' ? 'user_rejection' : 'user_edit',
          origin: 'lexel_user_feedback',
          created_at: e.createdAt,
        }));
      return { pairs };
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
    case 'writingStats':
      return (
        store.stats ?? {
          totalChecks: 0,
          totalWordsChecked: 0,
          totalGrammarHits: 0,
          totalSlopHits: 0,
          totalSecretBlocks: 0,
          totalFixesApplied: 0,
          topSurfaces: [],
        }
      );
    case 'listDrafts':
      return { drafts: store.drafts ?? [] };
    case 'saveDraft': {
      const raw = (payload.draft ?? payload) as Partial<DraftSnapshot>;
      const content = String(raw.content ?? '');
      const snapshot: DraftSnapshot = {
        id: `draft_${Date.now()}`,
        profileId: active.id,
        surfaceId: String(raw.surfaceId ?? 'general'),
        title:
          String(raw.title ?? '').trim() ||
          content.trim().split('\n')[0]?.slice(0, 48) ||
          'Untitled draft',
        content,
        wordCount: content.trim() ? content.trim().split(/\s+/).length : 0,
        createdAt: Date.now(),
      };
      store.drafts = [snapshot, ...(store.drafts ?? [])].slice(0, 50);
      savePreviewStore(store);
      return { draft: snapshot };
    }
    case 'deleteDraft': {
      const id = String(payload.id ?? '');
      store.drafts = (store.drafts ?? []).filter((d) => d.id !== id);
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
        stats: {
          totalChecks: 0,
          totalWordsChecked: 0,
          totalGrammarHits: 0,
          totalSlopHits: 0,
          totalSecretBlocks: 0,
          totalFixesApplied: 0,
          topSurfaces: [],
        },
        crutchCounts: {},
        slopCounts: {},
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
      {
        browser: 'Google Chrome',
        manifestPath: '~/.config/google-chrome/NativeMessagingHosts/com.lexel.daemon.json',
        installed: false,
      },
      {
        browser: 'Chromium',
        manifestPath: '~/.config/chromium/NativeMessagingHosts/com.lexel.daemon.json',
        installed: false,
      },
      {
        browser: 'Brave',
        manifestPath:
          '~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.lexel.daemon.json',
        installed: false,
      },
      {
        browser: 'Microsoft Edge',
        manifestPath: '~/.config/microsoft-edge/NativeMessagingHosts/com.lexel.daemon.json',
        installed: false,
      },
      {
        browser: 'Firefox',
        manifestPath: '~/.mozilla/native-messaging-hosts/com.lexel.daemon.json',
        installed: false,
      },
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
  if (isTauriRuntime()) {
    return invoke<DownloadModelReport>('download_model_with_progress', { modelId });
  }
  return daemonRpc<DownloadModelReport>('downloadModel', { modelId });
}

export function deleteModel(modelId: string): Promise<{ deleted: boolean }> {
  return daemonRpc<{ deleted: boolean }>('deleteModel', { modelId });
}

export async function subscribeToModelProgress(
  onProgress: (progress: DownloadProgress) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }
  return listen<DownloadProgress>('lexel://model-download-progress', (event) => {
    onProgress(event.payload);
  });
}

export async function subscribeToStateChanges(
  onChange: (kind: string) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }
  return listen<string>('lexel://state-changed', (event) => {
    onChange(event.payload);
  });
}

export async function subscribeToClipboardDraft(
  onDraft: (text: string) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }
  return listen<string>('lexel://clipboard-draft', (event) => {
    onDraft(event.payload);
  });
}

export async function subscribeToRewriteBeforePaste(
  onReport: (report: RewriteBeforePasteReport) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }
  return listen<RewriteBeforePasteReport>('lexel://rewrite-before-paste', (event) => {
    onReport(event.payload);
  });
}

export async function readClipboardText(): Promise<string> {
  if (isTauriRuntime()) {
    return invoke<string>('read_clipboard_text');
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
    return navigator.clipboard.readText();
  }
  throw new Error('Clipboard reading is unavailable in this preview context.');
}

export async function writeClipboardText(text: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke<void>('write_clipboard_text', { text });
    return;
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  }
}

export async function polishClipboardSafe(surfaceId?: string): Promise<ClipboardPolishReport> {
  if (isTauriRuntime()) {
    return invoke<ClipboardPolishReport>('polish_clipboard_safe', { surfaceId });
  }
  const original = await readClipboardText();
  const fixed = await daemonRpc<{ text: string; fixesApplied: number; categories: string[] }>(
    'fixAllSafe',
    { text: original, surfaceId: surfaceId ?? 'general' },
  );
  if (fixed.fixesApplied > 0 && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(fixed.text);
  }
  return {
    original,
    polished: fixed.text,
    fixesApplied: fixed.fixesApplied,
    secretsBlocked: 0,
    categories: fixed.categories,
  };
}

export async function detectActiveWindowSurface(): Promise<ActiveWindowSurface> {
  if (isTauriRuntime()) {
    return invoke<ActiveWindowSurface>('detect_active_window_surface');
  }
  return {
    appName: null,
    windowTitle: null,
    detectedSurfaceId: 'general',
    supported: false,
    note: 'Active window detection runs in native Lexel Desktop. Use the surface selector to override manually.',
  };
}

export async function setClipboardOverrideSurface(surfaceId: string | null): Promise<void> {
  if (isTauriRuntime()) {
    await invoke<void>('set_clipboard_override_surface', { surfaceId });
  }
}

export async function rewriteBeforePaste(params?: {
  surfaceId?: string | null;
  useAi?: boolean;
}): Promise<RewriteBeforePasteReport> {
  if (isTauriRuntime()) {
    return invoke<RewriteBeforePasteReport>('rewrite_before_paste', {
      surfaceId: params?.surfaceId ?? null,
      useAi: params?.useAi ?? true,
    });
  }
  const original = await readClipboardText();
  const res = await rewriteWithTask({
    text: original,
    task: 'deslop',
    surfaceId: params?.surfaceId ?? 'general',
    subcontext: null,
  });
  await writeClipboardText(res.suggestion).catch(() => undefined);
  return {
    original,
    rewritten: res.suggestion,
    surfaceId: res.surfaceId,
    detectedApp: null,
    usedAi: !res.fastPath,
    pastedAutomatically: false,
    secretsBlocked: 0,
    fixesApplied: original === res.suggestion ? 0 : 1,
    note: 'Copied polished text to clipboard (preview mode does not simulate OS paste).',
  };
}

export async function importGitLogVoice(params: {
  repoPath: string;
  author?: string;
  limit?: number;
}): Promise<GitVoiceImportReport> {
  if (isTauriRuntime()) {
    return invoke<GitVoiceImportReport>('import_git_log_voice', {
      repoPath: params.repoPath,
      author: params.author?.trim() || null,
      limit: params.limit ?? 25,
    });
  }
  throw new Error('Reading local git repositories requires running native Lexel Desktop.');
}

export async function getOsOverlayCapabilities(): Promise<OsOverlayCapabilities> {
  if (isTauriRuntime()) {
    return invoke<OsOverlayCapabilities>('os_overlay_capabilities');
  }
  return {
    platform: 'browser-preview',
    globalShortcut: 'CmdOrCtrl+Shift+L',
    rewriteBeforePasteShortcut: 'CmdOrCtrl+Alt+V',
    clipboardPolishReady: false,
    activeWindowDetectionSupported: false,
    nativeOverlayMode: 'preview',
    notes:
      'Launch native Lexel Desktop to activate Cmd/Ctrl+Shift+L Quick Rewrite and Cmd/Ctrl+Alt+V Rewrite Before Paste.',
  };
}

export async function getDoctorReport(bench = false): Promise<DoctorReportData> {
  return daemonRpc<DoctorReportData>('doctor', { bench });
}

export async function getWeeklyInsights(days = 7): Promise<WeeklyInsightsReport> {
  try {
    return await daemonRpc<WeeklyInsightsReport>('weeklyInsights', { days });
  } catch {
    // Graceful fallback if connected to an older daemon before weeklyInsights RPC is wired.
    const stats = await daemonRpc<WritingStatsSummary>('writingStats', {});
    return {
      periodDays: days,
      checksInPeriod: stats.totalChecks,
      wordsInPeriod: stats.totalWordsChecked,
      slopCaughtInPeriod: stats.totalSlopHits,
      grammarHitsInPeriod: stats.totalGrammarHits,
      secretsBlockedInPeriod: stats.totalSecretBlocks,
      fixesAppliedInPeriod: stats.totalFixesApplied,
      clarityScore: null,
      clarityDelta: null,
      concisenessScore: null,
      concisenessDelta: null,
      topCrutchWords: [],
      bannedCrutchWords: [],
      topSlopPatterns: [],
      dailyBuckets: [],
      voiceExamplesCount: 0,
    };
  }
}

export async function importVoiceSamples(
  samples: Array<{ surfaceId: string; text: string; original?: string }>,
  source: 'paste' | 'git_log' = 'paste',
): Promise<{ importedCount: number; skippedSecretsCount: number }> {
  try {
    return await daemonRpc<{ importedCount: number; skippedSecretsCount: number }>(
      'importVoiceExamples',
      { samples, source },
    );
  } catch {
    // Fallback to sequential saveVoiceExample calls while keeping secrets scrubbed.
    let importedCount = 0;
    let skippedSecretsCount = 0;
    for (const s of samples) {
      const cleaned = s.text.trim();
      if (!cleaned) continue;
      if (scanSecretsAndPii(cleaned).length > 0) {
        skippedSecretsCount += 1;
        continue;
      }
      await daemonRpc('saveVoiceExample', {
        example: {
          surfaceId: s.surfaceId,
          subcontext: null,
          original: s.original ?? cleaned,
          rewritten: cleaned,
          action: 'imported',
        },
      });
      importedCount += 1;
    }
    return { importedCount, skippedSecretsCount };
  }
}

export async function getRedactPreview(text: string): Promise<RedactPreviewResponse> {
  try {
    return await daemonRpc<RedactPreviewResponse>('redactPreview', { text });
  } catch {
    return buildPreviewRedact(text);
  }
}

export async function listAllSnippets(): Promise<ExtendedTextSnippet[]> {
  try {
    const res = await daemonRpc<{ snippets: ExtendedTextSnippet[] }>('listSnippets', {});
    return res.snippets ?? [];
  } catch {
    return [...BUILTIN_STARTER_SNIPPETS];
  }
}

export async function expandContextSnippet(params: {
  trigger: string;
  surfaceId: string;
  subcontext?: string | null;
  notes?: string;
  adaptWithAi?: boolean;
}): Promise<ExpandSnippetResponse> {
  return daemonRpc<ExpandSnippetResponse>('expandSnippet', params);
}

export async function transcribeAudio(params: {
  audioBase64: string;
  audioFormat?: string;
  language?: string;
  surfaceId: string;
  subcontext?: string | null;
  rewriteTask?: TonePillId | null;
}): Promise<TranscribeResponse> {
  return daemonRpc<TranscribeResponse>('transcribe', {
    audioBase64: params.audioBase64,
    audioFormat: params.audioFormat ?? 'wav',
    language: params.language ?? 'en',
    surfaceId: params.surfaceId,
    subcontext: params.subcontext ?? null,
    rewriteTask: params.rewriteTask ?? undefined,
  });
}

export function rewriteWithTask(params: {
  text: string;
  task: TonePillId;
  surfaceId: string;
  subcontext: string | null;
  threadContext?: string;
  candidates?: number;
  redactSecrets?: boolean | null;
}): Promise<RewriteResponse> {
  return daemonRpc<RewriteResponse>('rewrite', params);
}

/**
 * Stream rewrite tokens via loopback SSE (`POST /v1/rewrite/stream`) when running against
 * the local daemon, falling back cleanly to `rewriteWithTask` when SSE is unavailable.
 */
export async function rewriteStreamWithTask(
  params: {
    text: string;
    task: TonePillId;
    surfaceId: string;
    subcontext: string | null;
    threadContext?: string;
    candidates?: number;
    redactSecrets?: boolean | null;
  },
  callbacks: {
    onChunk: (delta: string, accumulated: string) => void;
    signal?: AbortSignal;
  },
): Promise<RewriteResponse> {
  if (isTauriRuntime()) {
    try {
      const conn = await daemonRpc<{ endpoint: string; token: string }>('getDaemonConnection', {});
      const resp = await fetch(`${conn.endpoint}/v1/rewrite/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${conn.token}`,
        },
        body: JSON.stringify(params),
        signal: callbacks.signal,
      });

      if (resp.ok && resp.body) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = 'message';
        let finalResponse: RewriteResponse | null = null;
        let streamError: string | null = null;

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) {
              currentEvent = 'message';
              continue;
            }
            if (line.startsWith('event:')) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              const jsonText = line.slice(5).trim();
              if (!jsonText) continue;
              const parsed = JSON.parse(jsonText) as Record<string, unknown>;
              if (currentEvent === 'chunk') {
                callbacks.onChunk(String(parsed.delta ?? ''), String(parsed.accumulated ?? ''));
              } else if (currentEvent === 'complete') {
                finalResponse = parsed as unknown as RewriteResponse;
              } else if (currentEvent === 'error') {
                streamError = String(parsed.error ?? 'Streaming rewrite failed.');
              }
            }
          }
        }

        if (streamError) {
          throw new Error(streamError);
        }
        if (finalResponse) {
          return finalResponse;
        }
      }
    } catch (err) {
      if (callbacks.signal?.aborted) {
        throw new Error('Rewrite cancelled.');
      }
      // Fall back to standard RPC if /v1/rewrite/stream is unavailable.
      if (err instanceof Error && !/fetch|network|404|405/i.test(err.message)) {
        throw err;
      }
    }
  }

  // Preview or fallback path: invoke standard RPC and emit progressive word chunks for visual continuity.
  const result = await rewriteWithTask(params);
  if (!result.fastPath) {
    const parts = result.suggestion.match(/\S+\s*/g) ?? [result.suggestion];
    let acc = '';
    for (const part of parts) {
      if (callbacks.signal?.aborted) {
        throw new Error('Rewrite cancelled.');
      }
      acc += part;
      callbacks.onChunk(part, acc);
    }
  }
  return result;
}

import {
  createBinaryModuleFromUrl,
  type Dialect,
  type LintConfig,
  LocalLinter,
  unpackWeirpackBytes,
} from 'harper.js';
import { type UnpackedLintGroups, unpackLint } from 'lint-framework';
import {
  daemonCreateProfile,
  daemonDeleteProfile,
  daemonApplyRulePreset,
  daemonDeleteVoiceExample,
  daemonListProfiles,
  daemonListVoiceExamples,
  daemonLookupSynonyms,
  daemonPatchSettings,
  daemonPurgeAll,
  daemonRenameProfile,
  daemonRewrite,
  daemonSaveVoiceExample,
  daemonSetMainModel,
  daemonSwitchProfile,
  daemonToggleAi,
  daemonUnloadAi,
  fetchDaemonStatus,
} from '../shared/daemonClient';
import {
  applyRulePreset,
  applySafeGrammarLints,
  normalizeTypography,
  toSentenceCase,
  type Tier0Lint,
} from 'lexel-ui';
import {
  checkLocalAiHealth,
  generateLocalRewrite,
  type LocalAiHealth,
} from '../shared/localAiClient';
import { inferTierFromModelName, resolveModelNameForTier } from '../shared/models';
import { buildRewriteMessages } from '../shared/promptBuilder';
import {
  applyUnifiedSettingsToStorage,
  deleteVoiceExample,
  getActiveDraft,
  getAiSettings,
  getAllDomainStatuses,
  getAllSurfaceOverrides,
  getCustomSlopConfig,
  getCustomSurfaces,
  getLanguageMode,
  getPageSummary,
  getPrivacyBlocklist,
  getStoredWeirpacks,
  getSurfaceOverride,
  getTheme,
  getVoiceExamples,
  normalizeAiSettings,
  saveVoiceExample,
  setActiveDraft,
  setAiSettings,
  setCustomSlopConfig,
  setCustomSurfaces,
  setLanguageMode,
  setPageSummary,
  setPrivacyBlocklist,
  setStoredWeirpacks,
  setSurfaceOverride,
  setTheme,
} from '../shared/storage';
import { isDomainBlocked } from '../shared/surfaceDetector';
import type {
  ActivationKey,
  AiSettings,
  ExtensionRequest,
  Hotkey,
  LintResponse,
  RewriteResult,
  SurfaceId,
} from '../shared/types';
import {
  applySafeDeterministicFixes,
  hasSecrets,
  sanitizeModelOutput,
  scanTier0Diagnostics,
  verifyAiRewrite,
} from '../shared/verifier';
import { detectBrowserDialect } from './detectDialect';

let linter: LocalLinter | null = null;
let initPromise: Promise<void> | null = null;
let daemonSyncAttempted = false;

const DOMAIN_KEY_PREFIX = 'domainStatus ';

function domainKey(domain: string): string {
  return `${DOMAIN_KEY_PREFIX}${domain.toLowerCase()}`;
}

async function getDialect(): Promise<Dialect> {
  const res = await chrome.storage.local.get('dialect');
  return res.dialect !== undefined ? (res.dialect as Dialect) : detectBrowserDialect();
}

async function getUserDictionary(): Promise<string[]> {
  const res = await chrome.storage.local.get({ userDictionary: [] as string[] });
  return Array.isArray(res.userDictionary) ? (res.userDictionary as string[]) : [];
}

async function getIgnoredLints(instance: LocalLinter): Promise<string> {
  const fallback = await instance.exportIgnoredLints();
  const res = await chrome.storage.local.get({ ignoredLints: fallback });
  return typeof res.ignoredLints === 'string' ? res.ignoredLints : fallback;
}

async function getStoredLintConfig(instance: LocalLinter): Promise<LintConfig> {
  const fallback = await instance.getLintConfigAsJSON();
  const res = await chrome.storage.local.get({ lintConfig: fallback });
  return JSON.parse(res.lintConfig as string) as LintConfig;
}

async function syncFromDaemonOnce(force = false): Promise<boolean> {
  if (daemonSyncAttempted && !force) return false;
  daemonSyncAttempted = true;
  const statusRes = await fetchDaemonStatus();
  if (!statusRes.connected || !statusRes.data) {
    return false;
  }
  await applyUnifiedSettingsToStorage(statusRes.data.activeProfile.settings);
  const voiceRes = await daemonListVoiceExamples();
  if (voiceRes.connected && voiceRes.data) {
    await chrome.storage.local.set({ lexel_voice_examples: voiceRes.data.examples });
  }
  return true;
}

async function pushPatchToDaemon(patch: Record<string, unknown>): Promise<void> {
  await daemonPatchSettings(patch).catch(() => undefined);
}

function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

async function initLinter(dialectOverride?: Dialect): Promise<void> {
  if (linter) {
    linter.dispose();
  }
  const dialect = dialectOverride ?? (await getDialect());
  const instance = new LocalLinter({
    binary: createBinaryModuleFromUrl(chrome.runtime.getURL('wasm/harper_wasm_bg.wasm')),
    dialect,
  });

  await instance.setup();

  const [ignored, dict, config, weirpacks] = await Promise.all([
    getIgnoredLints(instance),
    getUserDictionary(),
    getStoredLintConfig(instance),
    getStoredWeirpacks(),
  ]);

  if (ignored) {
    await instance.importIgnoredLints(ignored);
  }
  if (dict.length > 0) {
    await instance.importWords(dict);
  }
  await instance.setLintConfig(config);
  for (const pack of weirpacks) {
    if (!pack.enabled) continue;
    try {
      await instance.loadWeirpackFromBytes(base64ToBytes(pack.bytesBase64));
    } catch {
      // Skip corrupted pack entries during background init
    }
  }
  linter = instance;
}

async function ensureLinter(): Promise<LocalLinter> {
  if (!daemonSyncAttempted) {
    await syncFromDaemonOnce(false);
  }
  if (linter) return linter;
  if (!initPromise) {
    initPromise = initLinter().finally(() => {
      initPromise = null;
    });
  }
  await initPromise;
  if (!linter) {
    throw new Error('Failed to initialize Harper WASM linter.');
  }
  return linter;
}

async function isDomainEnabled(domain: string): Promise<boolean> {
  const blocklist = await getPrivacyBlocklist();
  if (isDomainBlocked(domain, blocklist)) {
    return false;
  }
  const key = domainKey(domain);
  const res = await chrome.storage.local.get({
    [key]: undefined,
    defaultEnable: true,
  });
  if (typeof res[key] === 'boolean') {
    return res[key] as boolean;
  }
  return res.defaultEnable !== false;
}

async function handleLint(
  req: Extract<ExtensionRequest, { kind: 'lint' }>,
  sender?: chrome.runtime.MessageSender,
): Promise<LintResponse> {
  if (!req.text.trim()) {
    return { kind: 'lints', lints: {} };
  }
  const instance = await ensureLinter();
  const enabled = await isDomainEnabled(req.domain);
  if (!enabled) {
    return { kind: 'lints', lints: {} };
  }

  const [isolateRes, languageMode, slopCfg, customSurfaces] = await Promise.all([
    chrome.storage.local.get({ isolateEnglish: false }),
    getLanguageMode(),
    getCustomSlopConfig(),
    getCustomSurfaces(),
  ]);
  const isolateEnglish =
    (req.options?.isolateEnglish as boolean | undefined) ?? isolateRes.isolateEnglish === true;

  const grouped = await instance.organizedLints(req.text, {
    ...(req.options ?? {}),
    language:
      (req.options?.language as 'plaintext' | 'markdown' | 'typst' | undefined) ?? languageMode,
    isolateEnglish,
  });

  const unpackedEntries = await Promise.all(
    Object.entries(grouped).map(async ([source, lints]) => {
      const unpacked = await Promise.all(lints.map((lint) => unpackLint(req.text, lint, instance)));
      for (const l of lints) {
        l.free();
      }
      return [source, unpacked] as const;
    }),
  );

  const bySource = Object.fromEntries(unpackedEntries) as UnpackedLintGroups;
  const surfaceId: SurfaceId = req.surfaceId ?? 'general';
  const { slopLints, surfaceLints, secretLints } = scanTier0Diagnostics(req.text, surfaceId, {
    customSlopTerms: slopCfg.customTerms,
    disabledSlopTerms: slopCfg.disabledTerms,
    customSurfaces,
  });

  if (secretLints.length > 0) {
    bySource.LexelSecrets = secretLints;
  }
  if (slopLints.length > 0) {
    bySource.LexelAntiSlop = slopLints;
  }
  if (surfaceLints.length > 0) {
    bySource.LexelSurface = surfaceLints;
  }

  const harperCount = Object.entries(bySource)
    .filter(([k]) => k !== 'LexelAntiSlop' && k !== 'LexelSurface' && k !== 'LexelSecrets')
    .reduce((acc, [, list]) => acc + list.length, 0);

  if (sender?.tab?.id != null) {
    await setPageSummary({
      tabId: sender.tab.id,
      domain: req.domain,
      surfaceId,
      subcontext: req.subcontext ?? null,
      harperCount,
      slopCount: slopLints.length,
      surfaceWarningCount: surfaceLints.length,
      updatedAt: Date.now(),
    });
  }

  return { kind: 'lints', lints: bySource };
}

async function handleAiHealth(): Promise<LocalAiHealth> {
  const settings = await getAiSettings();
  const daemonStatus = await fetchDaemonStatus();

  if (daemonStatus.connected && daemonStatus.data) {
    const payload = daemonStatus.data;
    const rt = payload.runtime;
    const activeSettings = payload.activeProfile.settings;
    await applyUnifiedSettingsToStorage(activeSettings);

    const effectiveModel = resolveModelNameForTier(
      activeSettings.mainModelTier,
      activeSettings.customModel,
    );
    const matchedManifest = payload.models.find(
      (m) => m.id === activeSettings.mainModelTier || m.ollamaTag === effectiveModel,
    );

    const anyBackendCapable =
      rt.llamaServerAvailable || rt.ollamaBinaryAvailable || rt.ollamaRunning;
    const modelAvailable =
      activeSettings.mainModelTier === 'custom'
        ? rt.ollamaModels.includes(effectiveModel) || rt.modelLoaded
        : Boolean(
            matchedManifest?.ggufInstalled ||
              matchedManifest?.ollamaInstalled ||
              rt.ollamaModels.includes(effectiveModel),
          );

    const models = Array.from(
      new Set([
        ...payload.models.filter((m) => m.ggufInstalled || m.ollamaInstalled).map((m) => m.ollamaTag),
        ...rt.ollamaModels,
      ]),
    );

    let error: string | undefined;
    if (!activeSettings.aiEnabled) {
      error = 'Local AI is turned off.';
    } else if (!modelAvailable && !anyBackendCapable) {
      error = 'No local models or runtime found. Run `make setup` in the Lexel repo.';
    } else if (!modelAvailable) {
      error = `Model "${effectiveModel}" is not downloaded yet. Run \`make setup\` to fetch both 0.5B and 1.5B models.`;
    } else if (!anyBackendCapable && activeSettings.runtime === 'auto') {
      error =
        'GGUF models are installed, but neither llama-server nor Ollama was detected on PATH.';
    }

    return {
      ok: activeSettings.aiEnabled && anyBackendCapable && modelAvailable,
      models,
      modelAvailable,
      error,
      source: 'daemon',
      daemonConnected: true,
      runtimeBackend: rt.activeBackend,
      modelLoaded: rt.modelLoaded,
      loadedModel: rt.loadedModel,
      activeProfile: payload.activeProfile,
      profiles: payload.profiles,
      installedModels: payload.models,
    };
  }

  const fallback = await checkLocalAiHealth(settings);
  return {
    ...fallback,
    source: 'direct',
    daemonConnected: false,
    nativeHostCommand: daemonStatus.installHint,
    nativeHostForbidden: daemonStatus.forbidden,
  };
}

async function handleAiRewrite(
  req: Extract<ExtensionRequest, { kind: 'aiRewrite' }>,
): Promise<{ ok: true; result: RewriteResult } | { ok: false; error: string }> {
  if (hasSecrets(req.text)) {
    return {
      ok: false,
      error: 'Secrets Guard blocked this rewrite because sensitive tokens or PII were detected.',
    };
  }
  const started = performance.now();
  try {
    const daemonRes = await daemonRewrite({
      text: req.text,
      task: req.task,
      surfaceId: req.surfaceId,
      subcontext: req.subcontext,
      threadContext: req.threadContext,
      domain: req.domain,
    });
    if (daemonRes.connected) {
      if (daemonRes.data) {
        return { ok: true, result: daemonRes.data };
      }
      return { ok: false, error: daemonRes.error ?? 'lexel-daemon failed to rewrite.' };
    }

    const [settings, slopCfg, customSurfaces] = await Promise.all([
      getAiSettings(),
      getCustomSlopConfig(),
      getCustomSurfaces(),
    ]);
    const voiceExamples = await getVoiceExamples(req.surfaceId);
    const messages = buildRewriteMessages({
      text: req.text,
      task: req.task,
      surfaceId: req.surfaceId,
      subcontext: req.subcontext,
      threadContext: req.threadContext,
      voiceExamples,
    });

    const raw = await generateLocalRewrite(settings, messages);
    const suggestion = sanitizeModelOutput(raw);
    const gates = verifyAiRewrite(req.text, suggestion, req.surfaceId, {
      customSlopTerms: slopCfg.customTerms,
      disabledSlopTerms: slopCfg.disabledTerms,
      customSurfaces,
    });

    return {
      ok: true,
      result: {
        original: req.text,
        suggestion,
        model: settings.model,
        latencyMs: Math.round(performance.now() - started),
        gates,
        surfaceId: req.surfaceId,
        subcontext: req.subcontext,
      },
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function handleSetAiSettings(nextRaw: AiSettings): Promise<void> {
  const next = normalizeAiSettings(nextRaw);
  await setAiSettings(next);
  await pushPatchToDaemon({
    aiEnabled: next.enabled,
    mainModelTier: next.mainModelTier,
    customModel: next.model,
    runtime: next.runtime,
    ollamaEndpoint: next.provider === 'ollama' ? next.endpoint : 'http://127.0.0.1:11434',
    openaiCompatEndpoint:
      next.provider === 'openai_compat' ? next.endpoint : next.openAiCompatEndpoint,
    temperature: next.temperature,
    maxTokens: next.maxTokens,
    idleUnloadSecs: next.idleUnloadSecs,
    keepWarm: next.keepWarm,
    saveVoiceMemory: next.saveVoiceMemory,
  });
}

async function handleRequest(
  req: ExtensionRequest,
  sender?: chrome.runtime.MessageSender,
): Promise<unknown> {
  switch (req.kind) {
    case 'lint':
      return handleLint(req, sender);
    case 'getConfig': {
      const instance = await ensureLinter();
      return { kind: 'getConfig', config: await getStoredLintConfig(instance) };
    }
    case 'setConfig': {
      const instance = await ensureLinter();
      await instance.setLintConfig(req.config);
      const json = await instance.getLintConfigAsJSON();
      await chrome.storage.local.set({ lintConfig: json });
      await pushPatchToDaemon({ lintConfig: req.config });
      return { kind: 'unit' };
    }
    case 'getLintDescriptions': {
      const instance = await ensureLinter();
      return {
        kind: 'getLintDescriptions',
        descriptions: await instance.getLintDescriptionsHTML(),
      };
    }
    case 'getDefaultLintConfig': {
      const instance = await ensureLinter();
      return {
        kind: 'getDefaultLintConfig',
        config: await instance.getDefaultLintConfig(),
      };
    }
    case 'getDialect':
      return { kind: 'getDialect', dialect: await getDialect() };
    case 'setDialect':
      await chrome.storage.local.set({ dialect: req.dialect });
      await initLinter(req.dialect);
      await pushPatchToDaemon({ dialect: req.dialect });
      return { kind: 'unit' };
    case 'getIsolateEnglish': {
      const res = await chrome.storage.local.get({ isolateEnglish: false });
      return { kind: 'getIsolateEnglish', isolateEnglish: res.isolateEnglish === true };
    }
    case 'setIsolateEnglish':
      await chrome.storage.local.set({ isolateEnglish: req.isolateEnglish });
      await pushPatchToDaemon({ isolateEnglish: req.isolateEnglish });
      return { kind: 'unit' };
    case 'getOpenSuggestionsOnHover': {
      const res = await chrome.storage.local.get({ openSuggestionsOnHover: true });
      return { kind: 'getOpenSuggestionsOnHover', enabled: res.openSuggestionsOnHover !== false };
    }
    case 'setOpenSuggestionsOnHover':
      await chrome.storage.local.set({ openSuggestionsOnHover: req.enabled });
      await pushPatchToDaemon({ openSuggestionsOnHover: req.enabled });
      return { kind: 'unit' };
    case 'getDelay': {
      const res = await chrome.storage.local.get({ delay: 0 });
      return { kind: 'getDelay', delay: typeof res.delay === 'number' ? res.delay : 0 };
    }
    case 'setDelay': {
      const delay = Math.max(0, Math.trunc(req.delay));
      await chrome.storage.local.set({ delay });
      await pushPatchToDaemon({ lintDelayMs: delay });
      return { kind: 'unit' };
    }
    case 'getActivationKey': {
      const res = await chrome.storage.local.get({ activationKey: 'off' as ActivationKey });
      return { kind: 'getActivationKey', key: res.activationKey };
    }
    case 'setActivationKey':
      await chrome.storage.local.set({ activationKey: req.key });
      await pushPatchToDaemon({ activationKey: req.key });
      return { kind: 'unit' };
    case 'getHotkey': {
      const res = await chrome.storage.local.get({
        hotkey: { modifiers: ['Alt'], key: 'l' } as Hotkey,
      });
      return { kind: 'getHotkey', hotkey: res.hotkey };
    }
    case 'setHotkey':
      await chrome.storage.local.set({ hotkey: req.hotkey });
      await pushPatchToDaemon({ hotkey: req.hotkey });
      return { kind: 'unit' };
    case 'getDomainStatus':
      return {
        kind: 'getDomainStatus',
        domain: req.domain,
        enabled: await isDomainEnabled(req.domain),
      };
    case 'setDomainStatus': {
      const domain = req.domain.toLowerCase();
      await chrome.storage.local.set({ [domainKey(domain)]: req.enabled });
      await pushPatchToDaemon({ domainStatuses: { [domain]: req.enabled } });
      return { kind: 'unit' };
    }
    case 'getDomainStatuses':
      return { statuses: await getAllDomainStatuses() };
    case 'removeDomainStatus': {
      const domain = req.domain.toLowerCase();
      await chrome.storage.local.remove(domainKey(domain));
      await pushPatchToDaemon({ domainStatuses: { [domain]: null } });
      return { kind: 'unit' };
    }
    case 'getDefaultStatus': {
      const res = await chrome.storage.local.get({ defaultEnable: true });
      return { kind: 'getDefaultStatus', enabled: res.defaultEnable !== false };
    }
    case 'setDefaultStatus':
      await chrome.storage.local.set({ defaultEnable: req.enabled });
      await pushPatchToDaemon({ defaultEnable: req.enabled });
      return { kind: 'unit' };
    case 'getEnabledDomains': {
      const all = await chrome.storage.local.get(null);
      const domains = Object.entries(all)
        .filter(([k, v]) => k.startsWith(DOMAIN_KEY_PREFIX) && v === true)
        .map(([k]) => k.slice(DOMAIN_KEY_PREFIX.length))
        .sort();
      return { kind: 'getEnabledDomains', domains };
    }
    case 'getUserDictionary':
      return { kind: 'getUserDictionary', words: await getUserDictionary() };
    case 'setUserDictionary': {
      const unique = [...new Set(req.words.map((w) => w.trim()).filter(Boolean))];
      await chrome.storage.local.set({ userDictionary: unique });
      await initLinter();
      await pushPatchToDaemon({ userDictionary: unique });
      return { kind: 'unit' };
    }
    case 'addToUserDictionary': {
      const instance = await ensureLinter();
      const existing = await getUserDictionary();
      const merged = [...new Set([...existing, ...req.words.map((w) => w.trim()).filter(Boolean)])];
      await chrome.storage.local.set({ userDictionary: merged });
      await instance.importWords(req.words);
      await pushPatchToDaemon({ userDictionary: merged });
      return { kind: 'unit' };
    }
    case 'ignoreLint': {
      const instance = await ensureLinter();
      if (/^\d+$/.test(req.contextHash)) {
        await instance.ignoreLintHash(BigInt(req.contextHash));
        const ignoredLints = await instance.exportIgnoredLints();
        await chrome.storage.local.set({ ignoredLints });
        await pushPatchToDaemon({ ignoredLints });
      }
      return { kind: 'unit' };
    }
    case 'clearIgnoredLints': {
      const instance = await ensureLinter();
      await instance.clearIgnoredLints();
      const ignoredLints = await instance.exportIgnoredLints();
      await chrome.storage.local.set({ ignoredLints });
      await pushPatchToDaemon({ ignoredLints });
      return { kind: 'clearIgnoredLints', success: true };
    }
    case 'getAiSettings':
      return { kind: 'getAiSettings', settings: await getAiSettings() };
    case 'setAiSettings':
      await handleSetAiSettings(req.settings);
      return { kind: 'unit' };
    case 'toggleAi': {
      const current = await getAiSettings();
      await setAiSettings({ ...current, enabled: req.enabled });
      const res = await daemonToggleAi(req.enabled);
      return {
        ok: true,
        daemonConnected: res.connected,
        activationError: res.data?.activationError ?? res.error ?? null,
        health: await handleAiHealth(),
      };
    }
    case 'setMainModel': {
      const current = await getAiSettings();
      const tier = inferTierFromModelName(req.model);
      const effective = resolveModelNameForTier(tier, req.model);
      await setAiSettings({ ...current, mainModelTier: tier, model: effective });
      const res = await daemonSetMainModel(req.model);
      return {
        ok: true,
        daemonConnected: res.connected,
        activationError: res.data?.activationError ?? res.error ?? null,
        health: await handleAiHealth(),
      };
    }
    case 'unloadAi': {
      await daemonUnloadAi();
      return { ok: true, health: await handleAiHealth() };
    }
    case 'aiHealth':
      return handleAiHealth();
    case 'aiListModels': {
      const health = await handleAiHealth();
      return { models: health.models, ok: health.ok, error: health.error };
    }
    case 'aiRewrite':
      return handleAiRewrite(req);
    case 'getDaemonStatus':
      return fetchDaemonStatus();
    case 'syncFromDaemon': {
      const synced = await syncFromDaemonOnce(true);
      if (synced) {
        await initLinter();
      }
      return { synced };
    }
    case 'listProfiles':
      return daemonListProfiles();
    case 'createProfile': {
      const res = await daemonCreateProfile(req.name, req.cloneFromActive ?? true);
      if (res.connected && res.data) {
        await applyUnifiedSettingsToStorage(res.data.settings);
        await initLinter();
      }
      return res;
    }
    case 'switchProfile': {
      const res = await daemonSwitchProfile(req.profileId);
      if (res.connected && res.data) {
        await applyUnifiedSettingsToStorage(res.data.settings);
        const voiceRes = await daemonListVoiceExamples();
        if (voiceRes.connected && voiceRes.data) {
          await chrome.storage.local.set({ lexel_voice_examples: voiceRes.data.examples });
        }
        await initLinter();
      }
      return res;
    }
    case 'renameProfile':
      return daemonRenameProfile(req.profileId, req.name);
    case 'deleteProfile': {
      const res = await daemonDeleteProfile(req.profileId);
      if (res.connected && res.data) {
        await applyUnifiedSettingsToStorage(res.data.settings);
        await initLinter();
      }
      return res;
    }
    case 'getVoiceExamples': {
      const remote = await daemonListVoiceExamples(req.surfaceId);
      if (remote.connected && remote.data) {
        return { examples: remote.data.examples };
      }
      return { examples: await getVoiceExamples(req.surfaceId) };
    }
    case 'saveVoiceExample': {
      const local = await saveVoiceExample(req.example);
      const remote = await daemonSaveVoiceExample(req.example);
      return { example: remote.data?.example ?? local };
    }
    case 'deleteVoiceExample':
      await deleteVoiceExample(req.id);
      await daemonDeleteVoiceExample(req.id);
      return { kind: 'unit' };
    case 'getPrivacyBlocklist':
      return { domains: await getPrivacyBlocklist() };
    case 'setPrivacyBlocklist':
      await setPrivacyBlocklist(req.domains);
      await pushPatchToDaemon({ privacyBlocklist: req.domains });
      return { kind: 'unit' };
    case 'getSurfaceOverride':
      return { surfaceId: await getSurfaceOverride(req.domain) };
    case 'getSurfaceOverrides':
      return { overrides: await getAllSurfaceOverrides() };
    case 'setSurfaceOverride': {
      const domain = req.domain.toLowerCase();
      await setSurfaceOverride(domain, req.surfaceId);
      await pushPatchToDaemon({ surfaceOverrides: { [domain]: req.surfaceId } });
      return { kind: 'unit' };
    }
    case 'getTheme':
      return { theme: await getTheme() };
    case 'setTheme':
      await setTheme(req.theme);
      await pushPatchToDaemon({ theme: req.theme });
      return { kind: 'unit' };
    case 'setPageSummary':
      if (sender?.tab?.id != null) {
        await setPageSummary({
          ...req.summary,
          tabId: sender.tab.id,
          updatedAt: Date.now(),
        });
      }
      return { kind: 'unit' };
    case 'getPageSummary':
      return { summary: await getPageSummary(req.tabId) };
    case 'setActiveDraft':
      await setActiveDraft(req.draft);
      return { kind: 'unit' };
    case 'getActiveDraft':
      return { draft: await getActiveDraft() };
    case 'openSidePanel': {
      const targetWindow = req.windowId ?? sender?.tab?.windowId;
      if (targetWindow != null && chrome.sidePanel?.open) {
        await chrome.sidePanel.open({ windowId: targetWindow });
      }
      return { kind: 'unit' };
    }
    case 'openOptions':
      await chrome.runtime.openOptionsPage();
      return { kind: 'unit' };
    case 'getStructuredLintConfig': {
      const instance = await ensureLinter();
      return { config: await instance.getStructuredLintConfig() };
    }
    case 'toTitleCase': {
      const instance = await ensureLinter();
      return { text: await instance.toTitleCase(req.text) };
    }
    case 'fixSafeIssues': {
      const [slopCfg, customSurfaces] = await Promise.all([
        getCustomSlopConfig(),
        getCustomSurfaces(),
      ]);
      return {
        result: applySafeDeterministicFixes(req.text, req.surfaceId, {
          customSlopTerms: slopCfg.customTerms,
          disabledSlopTerms: slopCfg.disabledTerms,
          customSurfaces,
        }),
      };
    }
    case 'loadWeirpack': {
      const instance = await ensureLinter();
      const bytes = base64ToBytes(req.bytesBase64);
      const archive = unpackWeirpackBytes(bytes);
      const ruleCount = [...archive.files.keys()].filter((k) => k.endsWith('.weir')).length;
      const failures = await instance.loadWeirpackFromBytes(bytes);
      if (failures && Object.keys(failures).length > 0) {
        return { ok: false, failures };
      }
      const existing = await getStoredWeirpacks();
      await setStoredWeirpacks([
        ...existing.filter((p) => p.name !== req.name),
        { name: req.name, bytesBase64: req.bytesBase64, ruleCount, enabled: true },
      ]);
      return { ok: true, ruleCount };
    }
    case 'getWeirpacks':
      return { weirpacks: await getStoredWeirpacks() };
    case 'toggleWeirpack': {
      const existing = await getStoredWeirpacks();
      await setStoredWeirpacks(
        existing.map((p) => (p.name === req.name ? { ...p, enabled: req.enabled } : p)),
      );
      await initLinter();
      return { kind: 'unit' };
    }
    case 'removeWeirpack': {
      const existing = await getStoredWeirpacks();
      await setStoredWeirpacks(existing.filter((p) => p.name !== req.name));
      await initLinter();
      return { kind: 'unit' };
    }
    case 'getLanguageMode':
      return { language: await getLanguageMode() };
    case 'setLanguageMode':
      await setLanguageMode(req.language);
      await pushPatchToDaemon({ languageMode: req.language });
      return { kind: 'unit' };
    case 'getCustomSlopConfig':
      return getCustomSlopConfig();
    case 'setCustomSlopConfig':
      await setCustomSlopConfig(req.customTerms, req.disabledTerms);
      await pushPatchToDaemon({
        customSlopTerms: req.customTerms,
        disabledSlopTerms: req.disabledTerms,
      });
      return { kind: 'unit' };
    case 'allowSlopTerm': {
      const clean = req.term.trim();
      if (!clean) return { kind: 'unit' };
      const slopCfg = await getCustomSlopConfig();
      const exists = slopCfg.disabledTerms.some(
        (t) => t.toLowerCase() === clean.toLowerCase(),
      );
      if (!exists) {
        const nextDisabled = [...slopCfg.disabledTerms, clean];
        await setCustomSlopConfig(slopCfg.customTerms, nextDisabled);
        await pushPatchToDaemon({
          customSlopTerms: slopCfg.customTerms,
          disabledSlopTerms: nextDisabled,
        });
      }
      return { kind: 'unit' };
    }
    case 'applyRulePreset': {
      const instance = await ensureLinter();
      const current = await getStoredLintConfig(instance);
      const nextConfig = applyRulePreset(current as Record<string, boolean | null>, req.presetId);
      await instance.setLintConfig(nextConfig);
      const json = await instance.getLintConfigAsJSON();
      await chrome.storage.local.set({ lintConfig: json });
      const daemonRes = await daemonApplyRulePreset(req.presetId);
      if (!daemonRes.connected) {
        await pushPatchToDaemon({ lintConfig: nextConfig });
      }
      return { config: nextConfig };
    }
    case 'fixAllSafe': {
      const [instance, isolateRes, languageMode, slopCfg, customSurfaces] = await Promise.all([
        ensureLinter(),
        chrome.storage.local.get({ isolateEnglish: false }),
        getLanguageMode(),
        getCustomSlopConfig(),
        getCustomSurfaces(),
      ]);
      const slopFixed = applySafeDeterministicFixes(req.text, req.surfaceId, {
        customSlopTerms: slopCfg.customTerms,
        disabledSlopTerms: slopCfg.disabledTerms,
        customSurfaces,
      });
      const norm = normalizeTypography(slopFixed.text);
      const grouped = await instance.organizedLints(norm.text, {
        language: languageMode,
        isolateEnglish: isolateRes.isolateEnglish === true,
      });
      const unpackedAll: Tier0Lint[] = [];
      for (const lints of Object.values(grouped)) {
        for (const lint of lints) {
          unpackedAll.push(await unpackLint(norm.text, lint, instance));
          lint.free();
        }
      }
      const grammarFixed = applySafeGrammarLints(norm.text, unpackedAll);
      return {
        result: {
          text: grammarFixed.text,
          fixesApplied: slopFixed.fixesApplied + norm.fixesApplied + grammarFixed.applied,
          categories: [
            ...new Set([
              ...slopFixed.categories,
              ...norm.categories,
              ...(grammarFixed.applied > 0 ? ['harper_safe'] : []),
            ]),
          ],
        },
      };
    }
    case 'toSentenceCase':
      return { text: toSentenceCase(req.text) };
    case 'normalizeTypography':
      return { result: normalizeTypography(req.text) };
    case 'lookupSynonyms': {
      const daemonRes = await daemonLookupSynonyms(req.word);
      if (daemonRes.connected && daemonRes.data) {
        return { ok: true, synonyms: daemonRes.data.synonyms };
      }
      return {
        ok: false,
        synonyms: [],
        error: daemonRes.error ?? 'Start lexel-daemon to look up local thesaurus synonyms.',
      };
    }
    case 'getCustomSurfaces':
      return { surfaces: await getCustomSurfaces() };
    case 'setCustomSurfaces':
      await setCustomSurfaces(req.surfaces);
      await pushPatchToDaemon({ customSurfaces: req.surfaces });
      return { kind: 'unit' };
    case 'getStatsSummary': {
      const instance = await ensureLinter();
      return { summary: await instance.summarizeStats() };
    }
    case 'exportStats': {
      const instance = await ensureLinter();
      return { statsJson: await instance.generateStatsFile() };
    }
    case 'importStats': {
      const instance = await ensureLinter();
      await instance.importStatsFile(req.statsJson);
      return { kind: 'unit' };
    }
    case 'applySuggestionStat':
      return { kind: 'unit' };
    case 'exportAllData':
      return { data: await chrome.storage.local.get(null) };
    case 'purgeAllData':
      await chrome.storage.local.clear();
      await daemonPurgeAll();
      await initLinter();
      return { kind: 'unit' };
  }
}

chrome.runtime.onMessage.addListener((message: ExtensionRequest, sender, sendResponse) => {
  (async () => {
    try {
      const result = await handleRequest(message, sender);
      sendResponse(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendResponse({ ok: false, error: msg });
    }
  })();
  return true;
});

void ensureLinter().catch((err) => {
  console.error('Lexel linter init error:', err);
});

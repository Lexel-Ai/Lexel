import {
  createBinaryModuleFromUrl,
  type Dialect,
  type LintConfig,
  LocalLinter,
} from 'harper.js';
import { type UnpackedLintGroups, unpackLint } from 'lint-framework';
import { checkLocalAiHealth, generateLocalRewrite } from '../shared/localAiClient';
import { buildRewriteMessages } from '../shared/promptBuilder';
import {
  deleteVoiceExample,
  getActiveDraft,
  getAiSettings,
  getPageSummary,
  getPrivacyBlocklist,
  getSurfaceOverride,
  getTheme,
  getVoiceExamples,
  saveVoiceExample,
  setActiveDraft,
  setAiSettings,
  setPageSummary,
  setPrivacyBlocklist,
  setSurfaceOverride,
  setTheme,
} from '../shared/storage';
import { isDomainBlocked } from '../shared/surfaceDetector';
import type {
  ActivationKey,
  ExtensionRequest,
  Hotkey,
  LintResponse,
  RewriteResult,
  SurfaceId,
} from '../shared/types';
import { sanitizeModelOutput, scanTier0Diagnostics, verifyAiRewrite } from '../shared/verifier';
import { detectBrowserDialect } from './detectDialect';

let linter: LocalLinter | null = null;
let initPromise: Promise<void> | null = null;

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

  const [ignored, dict, config] = await Promise.all([
    getIgnoredLints(instance),
    getUserDictionary(),
    getStoredLintConfig(instance),
  ]);

  if (ignored) {
    await instance.importIgnoredLints(ignored);
  }
  if (dict.length > 0) {
    await instance.importWords(dict);
  }
  await instance.setLintConfig(config);
  linter = instance;
}

async function ensureLinter(): Promise<LocalLinter> {
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

  const isolateRes = await chrome.storage.local.get({ isolateEnglish: false });
  const isolateEnglish =
    (req.options?.isolateEnglish as boolean | undefined) ?? isolateRes.isolateEnglish === true;

  const grouped = await instance.organizedLints(req.text, {
    ...(req.options ?? {}),
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
  const { slopLints, surfaceLints } = scanTier0Diagnostics(req.text, surfaceId);

  if (slopLints.length > 0) {
    bySource.LexelAntiSlop = slopLints;
  }
  if (surfaceLints.length > 0) {
    bySource.LexelSurface = surfaceLints;
  }

  const harperCount = Object.entries(bySource)
    .filter(([k]) => k !== 'LexelAntiSlop' && k !== 'LexelSurface')
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

async function handleAiRewrite(
  req: Extract<ExtensionRequest, { kind: 'aiRewrite' }>,
): Promise<{ ok: true; result: RewriteResult } | { ok: false; error: string }> {
  const started = performance.now();
  try {
    const settings = await getAiSettings();
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
    const gates = verifyAiRewrite(req.text, suggestion, req.surfaceId);

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
      return { kind: 'unit' };
    }
    case 'getLintDescriptions': {
      const instance = await ensureLinter();
      return {
        kind: 'getLintDescriptions',
        descriptions: await instance.getLintDescriptionsHTML(),
      };
    }
    case 'getDialect':
      return { kind: 'getDialect', dialect: await getDialect() };
    case 'setDialect':
      await chrome.storage.local.set({ dialect: req.dialect });
      await initLinter(req.dialect);
      return { kind: 'unit' };
    case 'getIsolateEnglish': {
      const res = await chrome.storage.local.get({ isolateEnglish: false });
      return { kind: 'getIsolateEnglish', isolateEnglish: res.isolateEnglish === true };
    }
    case 'setIsolateEnglish':
      await chrome.storage.local.set({ isolateEnglish: req.isolateEnglish });
      return { kind: 'unit' };
    case 'getOpenSuggestionsOnHover': {
      const res = await chrome.storage.local.get({ openSuggestionsOnHover: false });
      return { kind: 'getOpenSuggestionsOnHover', enabled: res.openSuggestionsOnHover === true };
    }
    case 'setOpenSuggestionsOnHover':
      await chrome.storage.local.set({ openSuggestionsOnHover: req.enabled });
      return { kind: 'unit' };
    case 'getDelay': {
      const res = await chrome.storage.local.get({ delay: 0 });
      return { kind: 'getDelay', delay: typeof res.delay === 'number' ? res.delay : 0 };
    }
    case 'setDelay':
      await chrome.storage.local.set({ delay: Math.max(0, Math.trunc(req.delay)) });
      return { kind: 'unit' };
    case 'getActivationKey': {
      const res = await chrome.storage.local.get({ activationKey: 'off' as ActivationKey });
      return { kind: 'getActivationKey', key: res.activationKey };
    }
    case 'setActivationKey':
      await chrome.storage.local.set({ activationKey: req.key });
      return { kind: 'unit' };
    case 'getHotkey': {
      const res = await chrome.storage.local.get({
        hotkey: { modifiers: ['Alt'], key: 'l' } as Hotkey,
      });
      return { kind: 'getHotkey', hotkey: res.hotkey };
    }
    case 'setHotkey':
      await chrome.storage.local.set({ hotkey: req.hotkey });
      return { kind: 'unit' };
    case 'getDomainStatus':
      return {
        kind: 'getDomainStatus',
        domain: req.domain,
        enabled: await isDomainEnabled(req.domain),
      };
    case 'setDomainStatus':
      await chrome.storage.local.set({ [domainKey(req.domain)]: req.enabled });
      return { kind: 'unit' };
    case 'getDefaultStatus': {
      const res = await chrome.storage.local.get({ defaultEnable: true });
      return { kind: 'getDefaultStatus', enabled: res.defaultEnable !== false };
    }
    case 'setDefaultStatus':
      await chrome.storage.local.set({ defaultEnable: req.enabled });
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
      return { kind: 'unit' };
    }
    case 'addToUserDictionary': {
      const instance = await ensureLinter();
      const existing = await getUserDictionary();
      const merged = [...new Set([...existing, ...req.words.map((w) => w.trim()).filter(Boolean)])];
      await chrome.storage.local.set({ userDictionary: merged });
      await instance.importWords(req.words);
      return { kind: 'unit' };
    }
    case 'ignoreLint': {
      const instance = await ensureLinter();
      if (/^\d+$/.test(req.contextHash)) {
        await instance.ignoreLintHash(BigInt(req.contextHash));
        await chrome.storage.local.set({ ignoredLints: await instance.exportIgnoredLints() });
      }
      return { kind: 'unit' };
    }
    case 'clearIgnoredLints': {
      const instance = await ensureLinter();
      await instance.clearIgnoredLints();
      await chrome.storage.local.set({ ignoredLints: await instance.exportIgnoredLints() });
      return { kind: 'clearIgnoredLints', success: true };
    }
    case 'getAiSettings':
      return { kind: 'getAiSettings', settings: await getAiSettings() };
    case 'setAiSettings':
      await setAiSettings(req.settings);
      return { kind: 'unit' };
    case 'aiHealth':
      return checkLocalAiHealth(await getAiSettings());
    case 'aiListModels': {
      const health = await checkLocalAiHealth(await getAiSettings());
      return { models: health.models, ok: health.ok, error: health.error };
    }
    case 'aiRewrite':
      return handleAiRewrite(req);
    case 'getVoiceExamples':
      return { examples: await getVoiceExamples(req.surfaceId) };
    case 'saveVoiceExample':
      return { example: await saveVoiceExample(req.example) };
    case 'deleteVoiceExample':
      await deleteVoiceExample(req.id);
      return { kind: 'unit' };
    case 'getPrivacyBlocklist':
      return { domains: await getPrivacyBlocklist() };
    case 'setPrivacyBlocklist':
      await setPrivacyBlocklist(req.domains);
      return { kind: 'unit' };
    case 'getSurfaceOverride':
      return { surfaceId: await getSurfaceOverride(req.domain) };
    case 'setSurfaceOverride':
      await setSurfaceOverride(req.domain, req.surfaceId);
      return { kind: 'unit' };
    case 'getTheme':
      return { theme: await getTheme() };
    case 'setTheme':
      await setTheme(req.theme);
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
    case 'exportAllData':
      return { data: await chrome.storage.local.get(null) };
    case 'purgeAllData':
      await chrome.storage.local.clear();
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

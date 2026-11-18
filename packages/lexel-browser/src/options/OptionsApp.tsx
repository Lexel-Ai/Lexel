import { packWeirpackFiles } from 'harper.js';
import type {
  Dialect,
  LintConfig,
  StructuredLintConfig,
  StructuredLintSetting,
  Summary,
  WeirpackTestFailures,
} from 'harper.js';
import {
  BUILTIN_SURFACES,
  EditableSurfaceCard,
  HARPER_RULE_PRESETS,
  NibIcon,
  StatusPill,
  ThemeToggle,
  applyRulePreset,
  resetSurfaceOverride,
  upsertSurfaceOverride,
  type RulePresetId,
} from 'lexel-ui';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { LocalAiHealth } from '../shared/localAiClient';
import { MODEL_MANIFEST_SPECS, resolveModelNameForTier } from '../shared/models';
import { listSurfaceProfiles } from '../shared/surfaceDetector';
import type {
  ActivationKey,
  AiSettings,
  DaemonProfile,
  Hotkey,
  LintLanguage,
  MainModelTier,
  RuntimeKind,
  StoredWeirpack,
  SurfaceId,
  SurfaceProfile,
  VoiceExample,
} from '../shared/types';
import { SLOP_TERMS } from '../shared/verifier';

type TabId = 'account' | 'ai' | 'rules' | 'privacy';
type RulesSubTab = 'harper' | 'slop' | 'sites' | 'surfaces' | 'weirpacks' | 'stats';

function stripHtml(html: string): string {
  if (typeof DOMParser === 'undefined') return html.replace(/<[^>]+>/g, '').trim();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function OptionsApp() {
  const [tab, setTab] = useState<TabId>('account');
  const [rulesSubTab, setRulesSubTab] = useState<RulesSubTab>('harper');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [aiHealth, setAiHealth] = useState<LocalAiHealth | null>(null);
  const [defaultEnable, setDefaultEnable] = useState(true);
  const [dialect, setDialect] = useState<Dialect>(0);
  const [isolateEnglish, setIsolateEnglish] = useState(false);
  const [hoverPopup, setHoverPopup] = useState(true);
  const [activationKey, setActivationKey] = useState<ActivationKey>('off');
  const [delayMs, setDelayMs] = useState(0);
  const [hotkey, setHotkey] = useState<Hotkey>({ modifiers: ['Alt'], key: 'l' });
  const [lintConfig, setLintConfig] = useState<LintConfig>({});
  const [defaultLintConfig, setDefaultLintConfig] = useState<LintConfig>({});
  const [structuredConfig, setStructuredConfig] = useState<StructuredLintConfig | null>(null);
  const [lintDescriptions, setLintDescriptions] = useState<Record<string, string>>({});
  const [languageMode, setLanguageMode] = useState<LintLanguage>('plaintext');
  const [customSlopTerms, setCustomSlopTerms] = useState<string[]>([]);
  const [disabledSlopTerms, setDisabledSlopTerms] = useState<string[]>([]);
  const [newSlopTerm, setNewSlopTerm] = useState('');
  const [customSurfaces, setCustomSurfaces] = useState<SurfaceProfile[]>([]);
  const [surfaceIdDraft, setSurfaceIdDraft] = useState('');
  const [surfaceLabelDraft, setSurfaceLabelDraft] = useState('');
  const [surfaceMaxChars, setSurfaceMaxChars] = useState(1200);
  const [surfaceDirective, setSurfaceDirective] = useState('');
  const [weirpacks, setWeirpacks] = useState<StoredWeirpack[]>([]);
  const [weirRuleName, setWeirRuleName] = useState('CustomAvoidSynergy');
  const [weirExpr, setWeirExpr] = useState('synergy');
  const [weirReplacement, setWeirReplacement] = useState('coordination');
  const [weirMessage, setWeirMessage] = useState('Use plain phrasing instead of buzzword.');
  const [weirTestBad, setWeirTestBad] = useState('We need team synergy now.');
  const [weirTestGood, setWeirTestGood] = useState('We need team coordination now.');
  const [statsSummary, setStatsSummary] = useState<Summary | null>(null);
  const weirpackInputRef = useRef<HTMLInputElement | null>(null);
  const [ruleSearch, setRuleSearch] = useState('');
  const [domainStatuses, setDomainStatuses] = useState<Record<string, boolean>>({});
  const [surfaceOverrides, setSurfaceOverrides] = useState<Record<string, SurfaceId>>({});
  const [newSiteDomain, setNewSiteDomain] = useState('');
  const [newSiteEnabled, setNewSiteEnabled] = useState(true);
  const [newSiteSurface, setNewSiteSurface] = useState<string>('auto');
  const [dictionaryText, setDictionaryText] = useState('');
  const [blocklistText, setBlocklistText] = useState('');
  const [voiceExamples, setVoiceExamples] = useState<VoiceExample[]>([]);
  const [newProfileName, setNewProfileName] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function loadAll() {
    const [
      themeRes,
      aiRes,
      healthRes,
      defaultRes,
      dialectRes,
      isoRes,
      hoverRes,
      actRes,
      delayRes,
      hotkeyRes,
      configRes,
      defaultConfigRes,
      descRes,
      domainStatusesRes,
      surfaceOverridesRes,
      dictRes,
      blockRes,
      voiceRes,
      structuredRes,
      langRes,
      slopRes,
      surfacesRes,
      packsRes,
      statsRes,
    ] = await Promise.all([
      chrome.runtime.sendMessage({ kind: 'getTheme' }) as Promise<{ theme: 'dark' | 'light' }>,
      chrome.runtime.sendMessage({ kind: 'getAiSettings' }) as Promise<{ settings: AiSettings }>,
      chrome.runtime.sendMessage({ kind: 'aiHealth' }) as Promise<LocalAiHealth>,
      chrome.runtime.sendMessage({ kind: 'getDefaultStatus' }) as Promise<{ enabled: boolean }>,
      chrome.runtime.sendMessage({ kind: 'getDialect' }) as Promise<{ dialect: Dialect }>,
      chrome.runtime.sendMessage({ kind: 'getIsolateEnglish' }) as Promise<{
        isolateEnglish: boolean;
      }>,
      chrome.runtime.sendMessage({ kind: 'getOpenSuggestionsOnHover' }) as Promise<{
        enabled: boolean;
      }>,
      chrome.runtime.sendMessage({ kind: 'getActivationKey' }) as Promise<{ key: ActivationKey }>,
      chrome.runtime.sendMessage({ kind: 'getDelay' }) as Promise<{ delay: number }>,
      chrome.runtime.sendMessage({ kind: 'getHotkey' }) as Promise<{ hotkey: Hotkey }>,
      chrome.runtime.sendMessage({ kind: 'getConfig' }) as Promise<{ config: LintConfig }>,
      chrome.runtime.sendMessage({ kind: 'getDefaultLintConfig' }) as Promise<{
        config: LintConfig;
      }>,
      chrome.runtime.sendMessage({ kind: 'getLintDescriptions' }) as Promise<{
        descriptions: Record<string, string>;
      }>,
      chrome.runtime.sendMessage({ kind: 'getDomainStatuses' }) as Promise<{
        statuses: Record<string, boolean>;
      }>,
      chrome.runtime.sendMessage({ kind: 'getSurfaceOverrides' }) as Promise<{
        overrides: Record<string, SurfaceId>;
      }>,
      chrome.runtime.sendMessage({ kind: 'getUserDictionary' }) as Promise<{ words: string[] }>,
      chrome.runtime.sendMessage({ kind: 'getPrivacyBlocklist' }) as Promise<{
        domains: string[];
      }>,
      chrome.runtime.sendMessage({ kind: 'getVoiceExamples' }) as Promise<{
        examples: VoiceExample[];
      }>,
      chrome.runtime.sendMessage({ kind: 'getStructuredLintConfig' }) as Promise<{
        config?: StructuredLintConfig;
      }>,
      chrome.runtime.sendMessage({ kind: 'getLanguageMode' }) as Promise<{
        language?: LintLanguage;
      }>,
      chrome.runtime.sendMessage({ kind: 'getCustomSlopConfig' }) as Promise<{
        customTerms?: string[];
        disabledTerms?: string[];
      }>,
      chrome.runtime.sendMessage({ kind: 'getCustomSurfaces' }) as Promise<{
        surfaces?: SurfaceProfile[];
      }>,
      chrome.runtime.sendMessage({ kind: 'getWeirpacks' }) as Promise<{
        weirpacks?: StoredWeirpack[];
      }>,
      chrome.runtime.sendMessage({ kind: 'getStatsSummary' }) as Promise<{
        summary?: Summary;
      }>,
    ]);

    setTheme(themeRes.theme);
    setAiSettings(aiRes.settings);
    setAiHealth(healthRes);
    setDefaultEnable(defaultRes.enabled);
    setDialect(dialectRes.dialect);
    setIsolateEnglish(isoRes.isolateEnglish);
    setHoverPopup(hoverRes.enabled);
    setActivationKey(actRes.key);
    setDelayMs(delayRes.delay);
    setHotkey(hotkeyRes.hotkey ?? { modifiers: ['Alt'], key: 'l' });
    setLintConfig(configRes.config ?? {});
    setDefaultLintConfig(defaultConfigRes.config ?? {});
    setStructuredConfig(structuredRes?.config ?? null);
    setLintDescriptions(descRes.descriptions ?? {});
    setDomainStatuses(domainStatusesRes.statuses ?? {});
    setSurfaceOverrides(surfaceOverridesRes.overrides ?? {});
    setDictionaryText(dictRes.words.join('\n'));
    setBlocklistText(blockRes.domains.join('\n'));
    setVoiceExamples(voiceRes.examples);
    setLanguageMode(langRes?.language ?? 'plaintext');
    setCustomSlopTerms(slopRes?.customTerms ?? []);
    setDisabledSlopTerms(slopRes?.disabledTerms ?? []);
    setCustomSurfaces(surfacesRes?.surfaces ?? []);
    setWeirpacks(packsRes?.weirpacks ?? []);
    setStatsSummary(statsRes?.summary ?? null);
    if (healthRes.activeProfile) {
      setRenameDraft(healthRes.activeProfile.name);
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  const harperRuleEntries = useMemo(() => {
    const q = ruleSearch.trim().toLowerCase();
    return Object.keys(defaultLintConfig)
      .sort()
      .filter((id) => {
        if (!q) return true;
        const desc = lintDescriptions[id] ? stripHtml(lintDescriptions[id]).toLowerCase() : '';
        return id.toLowerCase().includes(q) || desc.includes(q);
      })
      .map((id) => {
        const cur = lintConfig[id] !== undefined ? lintConfig[id] : defaultLintConfig[id];
        return {
          id,
          enabled: cur !== false,
          desc: lintDescriptions[id] ? stripHtml(lintDescriptions[id]) : 'Harper grammar rule.',
        };
      });
  }, [defaultLintConfig, lintConfig, lintDescriptions, ruleSearch]);

  const managedDomains = useMemo(() => {
    const keys = new Set([
      ...Object.keys(domainStatuses),
      ...Object.keys(surfaceOverrides),
    ]);
    return Array.from(keys).sort();
  }, [domainStatuses, surfaceOverrides]);

  async function saveAi(next: AiSettings) {
    setErrorMsg(null);
    const resolvedModel = resolveModelNameForTier(next.mainModelTier, next.model);
    const updated: AiSettings = {
      ...next,
      model: resolvedModel,
      provider: next.runtime === 'openai_compat' ? 'openai_compat' : 'ollama',
    };
    setAiSettings(updated);
    await chrome.runtime.sendMessage({ kind: 'setAiSettings', settings: updated });
    const res = (await chrome.runtime.sendMessage({
      kind: 'toggleAi',
      enabled: updated.enabled,
    })) as { health?: LocalAiHealth; activationError?: string | null };
    if (res.health) {
      setAiHealth({ ...res.health, error: res.activationError ?? res.health.error });
    }
    setNotice('Local AI settings saved.');
  }

  async function handleSelectMainModel(tierOrId: MainModelTier) {
    if (!aiSettings) return;
    setErrorMsg(null);
    const nextModel =
      tierOrId === 'custom'
        ? aiSettings.model
        : resolveModelNameForTier(tierOrId, aiSettings.model);
    const next: AiSettings = {
      ...aiSettings,
      mainModelTier: tierOrId,
      model: nextModel,
    };
    setAiSettings(next);
    if (tierOrId === 'custom') {
      await saveAi(next);
      return;
    }
    const res = (await chrome.runtime.sendMessage({
      kind: 'setMainModel',
      model: tierOrId,
    })) as { health?: LocalAiHealth; activationError?: string | null };
    if (res.health) {
      setAiHealth({ ...res.health, error: res.activationError ?? res.health.error });
    }
    setNotice(`Main model set to ${nextModel}.`);
  }

  async function handleUnloadModel() {
    const res = (await chrome.runtime.sendMessage({ kind: 'unloadAi' })) as {
      health?: LocalAiHealth;
    };
    if (res.health) setAiHealth(res.health);
    setNotice('Unloaded active model weights from memory.');
  }

  async function handleReconnectDaemon() {
    setErrorMsg(null);
    await chrome.runtime.sendMessage({ kind: 'syncFromDaemon' });
    await loadAll();
    setNotice('Checked lexel-daemon connection and synced profile.');
  }

  async function handleCreateProfile() {
    const name = newProfileName.trim();
    if (!name) return;
    setErrorMsg(null);
    const res = (await chrome.runtime.sendMessage({
      kind: 'createProfile',
      name,
      cloneFromActive: true,
    })) as { connected: boolean; data?: DaemonProfile; error?: string };
    if (!res.connected || !res.data) {
      setErrorMsg(res.error ?? 'Could not create profile.');
      return;
    }
    setNewProfileName('');
    await loadAll();
    setNotice(`Created and switched to profile "${res.data.name}".`);
  }

  async function handleSwitchProfile(profileId: string) {
    setErrorMsg(null);
    await chrome.runtime.sendMessage({ kind: 'switchProfile', profileId });
    await loadAll();
    setNotice('Switched synced local account profile.');
  }

  async function handleRenameActiveProfile() {
    if (!aiHealth?.activeProfile || !renameDraft.trim()) return;
    await chrome.runtime.sendMessage({
      kind: 'renameProfile',
      profileId: aiHealth.activeProfile.id,
      name: renameDraft.trim(),
    });
    await loadAll();
    setNotice('Updated profile name.');
  }

  async function handleDeleteProfile(profileId: string) {
    const res = (await chrome.runtime.sendMessage({ kind: 'deleteProfile', profileId })) as {
      error?: string;
    };
    if (res.error) {
      setErrorMsg(res.error);
      return;
    }
    await loadAll();
    setNotice('Deleted profile.');
  }

  async function saveGeneralRules() {
    await Promise.all([
      chrome.runtime.sendMessage({ kind: 'setDefaultStatus', enabled: defaultEnable }),
      chrome.runtime.sendMessage({ kind: 'setDialect', dialect }),
      chrome.runtime.sendMessage({ kind: 'setLanguageMode', language: languageMode }),
      chrome.runtime.sendMessage({ kind: 'setIsolateEnglish', isolateEnglish }),
      chrome.runtime.sendMessage({ kind: 'setOpenSuggestionsOnHover', enabled: hoverPopup }),
      chrome.runtime.sendMessage({ kind: 'setActivationKey', key: activationKey }),
      chrome.runtime.sendMessage({ kind: 'setDelay', delay: delayMs }),
      chrome.runtime.sendMessage({ kind: 'setHotkey', hotkey }),
    ]);
    setNotice('Extension behavior and grammar preferences saved.');
  }

  async function handleOneOfManyChange(names: string[], selected: string | null) {
    const nextConfig: LintConfig = { ...lintConfig };
    for (const id of names) {
      nextConfig[id] = selected ? id === selected : false;
    }
    setLintConfig(nextConfig);
    await chrome.runtime.sendMessage({ kind: 'setConfig', config: nextConfig });
  }

  async function saveCustomSlop(nextCustom: string[], nextDisabled: string[]) {
    setCustomSlopTerms(nextCustom);
    setDisabledSlopTerms(nextDisabled);
    await chrome.runtime.sendMessage({
      kind: 'setCustomSlopConfig',
      customTerms: nextCustom,
      disabledTerms: nextDisabled,
    });
  }

  async function saveCustomSurfaceList(next: SurfaceProfile[]) {
    setCustomSurfaces(next);
    await chrome.runtime.sendMessage({ kind: 'setCustomSurfaces', surfaces: next });
  }

  async function handleUploadWeirpack(file: File | undefined) {
    if (!file) return;
    setNotice(null);
    setErrorMsg(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const res = (await chrome.runtime.sendMessage({
        kind: 'loadWeirpack',
        name: file.name,
        bytesBase64: btoa(bin),
      })) as { ok?: boolean; ruleCount?: number; failures?: WeirpackTestFailures; error?: string };
      if (!res?.ok) {
        const failText = res?.failures
          ? Object.entries(res.failures)
              .map(([rule, cases]) => `${rule}: ${cases.length} failing test(s)`)
              .join('; ')
          : res?.error ?? 'Invalid pack';
        setErrorMsg(`Weirpack rejected (${failText}).`);
        return;
      }
      await loadAll();
      setNotice(`Loaded ${file.name} (${res.ruleCount ?? 0} rule(s)).`);
    } catch (err) {
      setErrorMsg((err as Error).message);
    }
  }

  async function handleRuleToggle(ruleId: string, enabled: boolean) {
    const nextConfig: LintConfig = { ...lintConfig, [ruleId]: enabled };
    setLintConfig(nextConfig);
    await chrome.runtime.sendMessage({ kind: 'setConfig', config: nextConfig });
  }

  async function handleResetAllRules() {
    setLintConfig(defaultLintConfig);
    await chrome.runtime.sendMessage({ kind: 'setConfig', config: defaultLintConfig });
    setNotice('Reset all Harper grammar rules to curated defaults.');
  }

  async function handleApplyRulePreset(presetId: RulePresetId) {
    setNotice(null);
    setErrorMsg(null);
    const res = (await chrome.runtime.sendMessage({
      kind: 'applyRulePreset',
      presetId,
    })) as { config?: LintConfig };
    const nextConfig =
      res?.config ?? applyRulePreset(lintConfig as Record<string, boolean | null>, presetId);
    setLintConfig(nextConfig);
    const presetLabel = HARPER_RULE_PRESETS.find((p) => p.id === presetId)?.label ?? presetId;
    setNotice(`Applied "${presetLabel}" Harper preset.`);
  }

  async function handleBuildCustomWeirpack(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    setErrorMsg(null);
    const cleanName = weirRuleName.replace(/[^A-Za-z0-9_]/g, '') || 'CustomLexelRule';
    const rawExpr = weirExpr.trim();
    if (!rawExpr || !weirReplacement.trim()) {
      setErrorMsg('Enter both a target phrase and a plain replacement.');
      return;
    }
    const exprClause =
      rawExpr.includes(' ') && !rawExpr.startsWith('(') ? `(${rawExpr})` : rawExpr;
    const escapeQuotes = (v: string) => v.replaceAll('"', '\\"');
    const lines = [
      `expr main ${exprClause}`,
      `let message "${escapeQuotes(weirMessage.trim() || `Prefer ${weirReplacement.trim()}.`)}"`,
      `let description "Custom Lexel Weir rule"`,
      `let kind "Style"`,
      `let becomes "${escapeQuotes(weirReplacement.trim())}"`,
      `let strategy "MatchCase"`,
    ];
    if (weirTestBad.trim() && weirTestGood.trim()) {
      lines.push(`test "${escapeQuotes(weirTestBad.trim())}" "${escapeQuotes(weirTestGood.trim())}"`);
    }
    try {
      const files = new Map<string, string>([
        [
          'manifest.json',
          JSON.stringify(
            {
              name: `${cleanName}.weirpack`,
              author: 'Lexel User',
              version: '0.1.0',
              description: `Custom rule for ${rawExpr}`,
              license: 'Apache-2.0',
            },
            null,
            2,
          ),
        ],
        [`${cleanName}.weir`, lines.join('\n')],
      ]);
      const bytes = packWeirpackFiles(files);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const res = (await chrome.runtime.sendMessage({
        kind: 'loadWeirpack',
        name: `${cleanName}.weirpack`,
        bytesBase64: btoa(bin),
      })) as { ok?: boolean; ruleCount?: number; failures?: WeirpackTestFailures; error?: string };
      if (!res?.ok) {
        const failText = res?.failures
          ? Object.entries(res.failures)
              .map(([k, v]) => `${k}: ${Object.keys(v).length} failed`)
              .join('; ')
          : res?.error ?? 'Invalid Weir expression or failed unit test.';
        setErrorMsg(`Weirpack test failed (${failText}).`);
        return;
      }
      setNotice(`Built & enabled ${cleanName}.weirpack (embedded Weir tests passed).`);
      await loadAll();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleAddSiteRule() {
    const clean = newSiteDomain.trim().toLowerCase();
    if (!clean) return;
    await chrome.runtime.sendMessage({
      kind: 'setDomainStatus',
      domain: clean,
      enabled: newSiteEnabled,
    });
    const nextOverride = newSiteSurface === 'auto' ? null : (newSiteSurface as SurfaceId);
    await chrome.runtime.sendMessage({
      kind: 'setSurfaceOverride',
      domain: clean,
      surfaceId: nextOverride,
    });
    setDomainStatuses((prev) => ({ ...prev, [clean]: newSiteEnabled }));
    setSurfaceOverrides((prev) => {
      const next = { ...prev };
      if (nextOverride) next[clean] = nextOverride;
      else delete next[clean];
      return next;
    });
    setNewSiteDomain('');
    setNotice(`Saved site rule for ${clean}.`);
  }

  async function handleRemoveSiteRule(domain: string) {
    await Promise.all([
      chrome.runtime.sendMessage({ kind: 'removeDomainStatus', domain }),
      chrome.runtime.sendMessage({ kind: 'setSurfaceOverride', domain, surfaceId: null }),
    ]);
    setDomainStatuses((prev) => {
      const next = { ...prev };
      delete next[domain];
      return next;
    });
    setSurfaceOverrides((prev) => {
      const next = { ...prev };
      delete next[domain];
      return next;
    });
  }

  async function savePrivacyAndDict() {
    const words = dictionaryText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const domains = blocklistText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    await Promise.all([
      chrome.runtime.sendMessage({ kind: 'setUserDictionary', words }),
      chrome.runtime.sendMessage({ kind: 'setPrivacyBlocklist', domains }),
    ]);
    setNotice('Dictionary and privacy blocklist saved.');
  }

  async function handleExport() {
    const res = (await chrome.runtime.sendMessage({ kind: 'exportAllData' })) as { data: unknown };
    const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lexel-local-backup.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handlePurge() {
    await chrome.runtime.sendMessage({ kind: 'purgeAllData' });
    await loadAll();
    setNotice('All local Lexel settings and voice memory purged.');
  }

  return (
    <div data-theme={theme} className="lexel-root min-h-screen p-6">
      <div className="max-w-4xl mx-auto flex flex-col gap-5">
        <header
          className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b"
          style={{ borderColor: 'var(--lx-border)' }}
        >
          <div className="flex items-center gap-2.5">
            <NibIcon className="w-5 h-5" />
            <div>
              <h1 className="text-lg font-semibold m-0">Lexel Settings</h1>
              <p className="text-xs m-0" style={{ color: 'var(--lx-fg-muted)' }}>
                100% local grammar engine, synced profile account, and private AI runtime
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <StatusPill
              state={
                !aiSettings?.enabled
                  ? 'offline'
                  : aiHealth?.ok && aiHealth.modelAvailable !== false
                    ? 'ready'
                    : 'error'
              }
              label={
                !aiSettings?.enabled
                  ? 'AI Off'
                  : aiHealth?.ok && aiHealth.modelAvailable !== false
                    ? `${aiSettings.model} Ready`
                    : aiHealth?.ok
                      ? 'Model Missing'
                      : 'Local AI Offline'
              }
            />
            <ThemeToggle
              theme={theme}
              onToggle={async () => {
                const next = theme === 'dark' ? 'light' : 'dark';
                setTheme(next);
                await chrome.runtime.sendMessage({ kind: 'setTheme', theme: next });
              }}
            />
          </div>
        </header>

        <nav className="flex flex-wrap gap-2" aria-label="Settings sections">
          {(
            [
              { id: 'account', label: 'Account & Models' },
              { id: 'ai', label: 'Local AI' },
              { id: 'rules', label: 'Extension & Harper Rules' },
              { id: 'privacy', label: 'Dictionary & Privacy' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className="rounded-[6px] border px-3 py-1.5 text-xs font-medium"
              style={{
                backgroundColor: tab === item.id ? 'var(--lx-accent)' : 'var(--lx-card)',
                borderColor: 'var(--lx-border)',
                color: tab === item.id ? 'var(--lx-on-accent)' : 'var(--lx-fg)',
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {notice ? (
          <div
            className="rounded-[6px] border px-3 py-2 text-xs"
            style={{
              backgroundColor: 'var(--lx-signal-bg)',
              borderColor: 'var(--lx-signal)',
              color: 'var(--lx-signal)',
            }}
          >
            {notice}
          </div>
        ) : null}

        {errorMsg ? (
          <div
            className="rounded-[6px] border px-3 py-2 text-xs"
            style={{
              backgroundColor: 'var(--lx-danger-bg)',
              borderColor: 'var(--lx-danger)',
              color: 'var(--lx-danger)',
            }}
          >
            {errorMsg}
          </div>
        ) : null}

        {tab === 'account' ? (
          <div className="flex flex-col gap-4">
            <section
              className="rounded-[8px] border p-4 flex flex-col gap-3"
              style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold m-0">Local Account &amp; App Sync</h2>
                  <p className="text-xs m-0 mt-0.5" style={{ color: 'var(--lx-fg-muted)' }}>
                    One shared SQLite profile links the Browser Extension, Lexel Lab, Desktop, and IDE on this machine.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleReconnectDaemon()}
                  className="rounded-[6px] border px-3 py-1.5 text-xs font-medium"
                  style={{
                    backgroundColor: 'var(--lx-muted)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                >
                  Sync Now
                </button>
              </div>

              {aiHealth?.daemonConnected && aiHealth.activeProfile ? (
                <div className="flex flex-col gap-3 pt-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span style={{ color: 'var(--lx-fg-muted)' }}>Active profile:</span>
                    <span className="font-semibold lexel-mono" style={{ color: 'var(--lx-signal)' }}>
                      {aiHealth.activeProfile.name}
                    </span>
                    <span style={{ color: 'var(--lx-fg-muted)' }}>
                      (backend: {aiHealth.runtimeBackend ?? 'idle'})
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="flex flex-col gap-2">
                      <span className="text-xs font-medium">Switch Profile</span>
                      <div className="flex flex-col gap-1.5">
                        {(aiHealth.profiles ?? []).map((p) => (
                          <div
                            key={p.id}
                            className="rounded-[6px] border px-3 py-2 flex items-center justify-between gap-2 text-xs"
                            style={{
                              backgroundColor: 'var(--lx-bg)',
                              borderColor: p.isActive ? 'var(--lx-signal)' : 'var(--lx-border)',
                            }}
                          >
                            <div className="min-w-0">
                              <div className="font-medium truncate">{p.name}</div>
                              <div className="text-[11px] lexel-mono" style={{ color: 'var(--lx-fg-muted)' }}>
                                {p.settings.mainModelTier} · AI {p.settings.aiEnabled ? 'ON' : 'OFF'}
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              {!p.isActive ? (
                                <button
                                  type="button"
                                  onClick={() => void handleSwitchProfile(p.id)}
                                  className="rounded-[6px] px-2.5 py-1 text-[11px] font-semibold"
                                  style={{
                                    backgroundColor: 'var(--lx-accent)',
                                    color: 'var(--lx-on-accent)',
                                  }}
                                >
                                  Use
                                </button>
                              ) : (
                                <span
                                  className="text-[11px] font-medium lexel-mono"
                                  style={{ color: 'var(--lx-signal)' }}
                                >
                                  Active
                                </span>
                              )}
                              {(aiHealth.profiles ?? []).length > 1 ? (
                                <button
                                  type="button"
                                  onClick={() => void handleDeleteProfile(p.id)}
                                  className="rounded-[6px] border px-2 py-1 text-[11px]"
                                  style={{
                                    borderColor: 'var(--lx-border)',
                                    color: 'var(--lx-danger)',
                                  }}
                                >
                                  Delete
                                </button>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="flex flex-col gap-3">
                      <label className="flex flex-col gap-1 text-xs">
                        <span>Create New Profile</span>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={newProfileName}
                            onChange={(e) => setNewProfileName(e.target.value)}
                            placeholder="Work, Personal, Open Source..."
                            className="flex-1 rounded-[6px] border px-2.5 py-1.5 text-xs"
                            style={{
                              backgroundColor: 'var(--lx-bg)',
                              borderColor: 'var(--lx-border)',
                              color: 'var(--lx-fg)',
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => void handleCreateProfile()}
                            className="rounded-[6px] px-3 py-1.5 text-xs font-semibold shrink-0"
                            style={{
                              backgroundColor: 'var(--lx-accent)',
                              color: 'var(--lx-on-accent)',
                            }}
                          >
                            Create
                          </button>
                        </div>
                      </label>

                      <label className="flex flex-col gap-1 text-xs">
                        <span>Rename Active Profile</span>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={renameDraft}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            className="flex-1 rounded-[6px] border px-2.5 py-1.5 text-xs"
                            style={{
                              backgroundColor: 'var(--lx-bg)',
                              borderColor: 'var(--lx-border)',
                              color: 'var(--lx-fg)',
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => void handleRenameActiveProfile()}
                            className="rounded-[6px] border px-3 py-1.5 text-xs font-medium shrink-0"
                            style={{
                              backgroundColor: 'var(--lx-muted)',
                              borderColor: 'var(--lx-border)',
                              color: 'var(--lx-fg)',
                            }}
                          >
                            Rename
                          </button>
                        </div>
                      </label>
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  className="rounded-[6px] border p-3 text-xs space-y-2"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-warn)',
                  }}
                >
                  <div style={{ color: 'var(--lx-warn)' }}>
                    Native Messaging bridge to lexel-daemon is not connected yet.
                  </div>
                  <p className="m-0" style={{ color: 'var(--lx-fg-muted)' }}>
                    Run <span className="lexel-mono">make setup</span> in the Lexel repository to download both 0.5B and 1.5B models and build lexel-daemon, then register this extension ID:
                  </p>
                  <div
                    className="rounded-[4px] border px-2.5 py-1.5 lexel-mono text-[11px] break-all"
                    style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
                  >
                    {aiHealth?.nativeHostCommand ?? 'make setup'}
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void navigator.clipboard.writeText(aiHealth?.nativeHostCommand ?? 'make setup')
                    }
                    className="rounded-[6px] border px-2.5 py-1 text-[11px] font-medium"
                    style={{
                      backgroundColor: 'var(--lx-muted)',
                      borderColor: 'var(--lx-border)',
                      color: 'var(--lx-fg)',
                    }}
                  >
                    Copy Setup Command
                  </button>
                </div>
              )}
            </section>

            <section
              className="rounded-[8px] border p-4 flex flex-col gap-3"
              style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
            >
              <h2 className="text-sm font-semibold m-0">Downloaded Local Models (0.5B &amp; 1.5B)</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {MODEL_MANIFEST_SPECS.map((spec) => {
                  const status = aiHealth?.installedModels?.find((m) => m.id === spec.id);
                  const isSelected = aiSettings?.mainModelTier === spec.id;
                  return (
                    <div
                      key={spec.id}
                      className="rounded-[6px] border p-3 flex flex-col justify-between gap-2 text-xs"
                      style={{
                        backgroundColor: 'var(--lx-bg)',
                        borderColor: isSelected ? 'var(--lx-signal)' : 'var(--lx-border)',
                      }}
                    >
                      <div className="space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold">{spec.label}</span>
                          <span className="lexel-mono text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                            ~{spec.approxRamMb} MB RAM
                          </span>
                        </div>
                        <p className="m-0 text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                          {spec.description}
                        </p>
                        <div className="lexel-mono text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                          GGUF: {status ? (status.ggufInstalled ? 'Installed' : 'Not downloaded') : spec.ggufFilename}
                          {status ? ` · Ollama: ${status.ollamaInstalled ? 'Ready' : 'Auto-imports on toggle'}` : ''}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleSelectMainModel(spec.id)}
                        className="self-start rounded-[6px] border px-2.5 py-1 text-xs font-semibold"
                        style={{
                          backgroundColor: isSelected ? 'var(--lx-accent)' : 'var(--lx-muted)',
                          borderColor: 'var(--lx-border)',
                          color: isSelected ? 'var(--lx-on-accent)' : 'var(--lx-fg)',
                        }}
                      >
                        {isSelected ? 'Selected Main Model' : `Set ${spec.id === 'lexel-0.5b' ? '0.5B' : '1.5B'} as Main`}
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        ) : null}

        {tab === 'ai' && aiSettings ? (
          <section
            className="rounded-[8px] border p-4 flex flex-col gap-4"
            style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
          >
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium">Enable Local AI Rewrites</span>
                <p className="text-[11px] m-0" style={{ color: 'var(--lx-fg-muted)' }}>
                  Turning off unloads model weights from RAM immediately while keeping Tier 0 grammar checks active.
                </p>
              </div>
              <input
                type="checkbox"
                aria-label="Enable Local AI Rewrites"
                checked={aiSettings.enabled}
                onChange={(e) => void saveAi({ ...aiSettings, enabled: e.target.checked })}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-xs">
                <span>Main Model Tier</span>
                <select
                  value={aiSettings.mainModelTier}
                  onChange={(e) => void handleSelectMainModel(e.target.value as MainModelTier)}
                  className="rounded-[6px] border px-2.5 py-1.5 text-xs"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                >
                  <option value="lexel-1.5b">Lexel 1.5B (Standard · ~1.04 GB)</option>
                  <option value="lexel-0.5b">Lexel 0.5B (Lite · ~469 MB)</option>
                  <option value="custom">Custom Local Model / GGUF</option>
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span>Runtime Engine</span>
                <select
                  value={aiSettings.runtime}
                  onChange={(e) => {
                    const runtime = e.target.value as RuntimeKind;
                    setAiSettings({
                      ...aiSettings,
                      runtime,
                      provider: runtime === 'openai_compat' ? 'openai_compat' : 'ollama',
                      endpoint:
                        runtime === 'openai_compat'
                          ? aiSettings.openAiCompatEndpoint
                          : 'http://127.0.0.1:11434',
                    });
                  }}
                  className="rounded-[6px] border px-2.5 py-1.5 text-xs"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                >
                  <option value="auto">Auto (llama-server or Ollama via daemon)</option>
                  <option value="llama_server">Managed llama-server (GGUF)</option>
                  <option value="ollama">Ollama (127.0.0.1:11434)</option>
                  <option value="openai_compat">Local OpenAI-Compat</option>
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span>Localhost Endpoint</span>
                <input
                  type="text"
                  value={aiSettings.endpoint}
                  onChange={(e) => setAiSettings({ ...aiSettings, endpoint: e.target.value })}
                  className="rounded-[6px] border px-2.5 py-1.5 text-xs lexel-mono"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span>{aiSettings.mainModelTier === 'custom' ? 'Custom Model / GGUF Path' : 'Effective Model Tag'}</span>
                <input
                  type="text"
                  value={aiSettings.model}
                  disabled={aiSettings.mainModelTier !== 'custom'}
                  onChange={(e) => setAiSettings({ ...aiSettings, model: e.target.value })}
                  className="rounded-[6px] border px-2.5 py-1.5 text-xs lexel-mono"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span>Idle Auto-Unload (seconds)</span>
                <input
                  type="number"
                  min={0}
                  max={3600}
                  step={30}
                  value={aiSettings.idleUnloadSecs}
                  onChange={(e) =>
                    setAiSettings({
                      ...aiSettings,
                      idleUnloadSecs: Math.max(0, Number.parseInt(e.target.value || '180', 10)),
                    })
                  }
                  className="rounded-[6px] border px-2.5 py-1.5 text-xs lexel-mono"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span>Temperature ({aiSettings.temperature})</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={aiSettings.temperature}
                  onChange={(e) =>
                    setAiSettings({ ...aiSettings, temperature: Number.parseFloat(e.target.value) })
                  }
                />
              </label>
            </div>

            <div className="flex flex-wrap gap-4 text-xs">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={aiSettings.keepWarm}
                  onChange={(e) => setAiSettings({ ...aiSettings, keepWarm: e.target.checked })}
                />
                <span>Keep model warm in RAM (disable idle unload)</span>
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={aiSettings.saveVoiceMemory}
                  onChange={(e) =>
                    setAiSettings({ ...aiSettings, saveVoiceMemory: e.target.checked })
                  }
                />
                <span>Save accepted rewrites to Voice Memory</span>
              </label>
            </div>

            {aiHealth?.error ? (
              <div
                className="rounded-[6px] border p-2.5 text-xs"
                style={{
                  backgroundColor: 'var(--lx-warn-bg)',
                  borderColor: 'var(--lx-warn)',
                  color: 'var(--lx-warn)',
                }}
              >
                {aiHealth.error}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                onClick={() => void saveAi(aiSettings)}
                className="rounded-[6px] px-3 py-1.5 text-xs font-semibold"
                style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
              >
                Save &amp; Test Connection
              </button>
              {aiHealth?.daemonConnected && aiHealth.modelLoaded ? (
                <button
                  type="button"
                  onClick={() => void handleUnloadModel()}
                  className="rounded-[6px] border px-3 py-1.5 text-xs font-medium"
                  style={{
                    backgroundColor: 'var(--lx-muted)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                >
                  Unload Model from RAM ({aiHealth.loadedModel})
                </button>
              ) : null}
            </div>
          </section>
        ) : null}

        {tab === 'rules' ? (
          <section
            className="rounded-[8px] border p-4 flex flex-col gap-4"
            style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
          >
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <label className="flex flex-col gap-1 text-xs">
                <span>English Dialect</span>
                <select
                  value={dialect}
                  onChange={(e) => setDialect(Number(e.target.value) as Dialect)}
                  className="rounded-[6px] border px-2.5 py-1.5 text-xs"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                >
                  <option value={0}>American</option>
                  <option value={1}>British</option>
                  <option value={2}>Australian</option>
                  <option value={3}>Canadian</option>
                  <option value={4}>Indian</option>
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span>Document Parser Mode</span>
                <select
                  value={languageMode}
                  onChange={(e) => setLanguageMode(e.target.value as LintLanguage)}
                  className="rounded-[6px] border px-2.5 py-1.5 text-xs"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                >
                  <option value="plaintext">Plaintext</option>
                  <option value="markdown">Markdown</option>
                  <option value="typst">Typst</option>
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span>Activation Key Guard</span>
                <select
                  value={activationKey}
                  onChange={(e) => setActivationKey(e.target.value as ActivationKey)}
                  className="rounded-[6px] border px-2.5 py-1.5 text-xs"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                >
                  <option value="off">Off (always lint)</option>
                  <option value="shift">Hold Shift</option>
                  <option value="control">Hold Control</option>
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span>Lint Delay (ms)</span>
                <input
                  type="number"
                  min={0}
                  max={2000}
                  value={delayMs}
                  onChange={(e) => setDelayMs(Number.parseInt(e.target.value || '0', 10))}
                  className="rounded-[6px] border px-2.5 py-1.5 text-xs lexel-mono"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
              </label>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex flex-wrap gap-4">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={defaultEnable}
                    onChange={(e) => setDefaultEnable(e.target.checked)}
                  />
                  <span>Enable extension on all sites by default</span>
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={isolateEnglish}
                    onChange={(e) => setIsolateEnglish(e.target.checked)}
                  />
                  <span>Isolate English in mixed-language text</span>
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={hoverPopup}
                    onChange={(e) => setHoverPopup(e.target.checked)}
                  />
                  <span>Open underline suggestions on hover</span>
                </label>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    await chrome.runtime.sendMessage({ kind: 'clearIgnoredLints' });
                    setNotice('Cleared ignored lints.');
                  }}
                  className="rounded-[6px] border px-2.5 py-1 text-xs"
                  style={{
                    backgroundColor: 'var(--lx-muted)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                >
                  Clear Ignored Lints
                </button>
                <button
                  type="button"
                  onClick={() => void saveGeneralRules()}
                  className="rounded-[6px] px-3 py-1.5 text-xs font-semibold"
                  style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
                >
                  Save Extension Settings
                </button>
              </div>
            </div>

            <div className="border-t pt-3 flex flex-col gap-3" style={{ borderColor: 'var(--lx-border)' }}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Rule management views">
                  {(
                    [
                      { id: 'harper', label: `Harper Rules (${Object.keys(defaultLintConfig).length})` },
                      { id: 'slop', label: `Anti-Slop (${SLOP_TERMS.length + customSlopTerms.length})` },
                      { id: 'sites', label: `Site Controls (${managedDomains.length})` },
                      { id: 'surfaces', label: `Surfaces (${listSurfaceProfiles(customSurfaces).length})` },
                      { id: 'weirpacks', label: `Weirpacks (${weirpacks.length})` },
                      { id: 'stats', label: 'Writing Stats' },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={rulesSubTab === item.id}
                      onClick={() => setRulesSubTab(item.id)}
                      className="rounded-[6px] border px-2.5 py-1 text-xs font-medium"
                      style={{
                        backgroundColor: rulesSubTab === item.id ? 'var(--lx-accent)' : 'var(--lx-bg)',
                        borderColor: 'var(--lx-border)',
                        color: rulesSubTab === item.id ? 'var(--lx-on-accent)' : 'var(--lx-fg)',
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>

                {rulesSubTab === 'harper' ? (
                  <button
                    type="button"
                    onClick={() => void handleResetAllRules()}
                    className="rounded-[6px] border px-2.5 py-1 text-xs"
                    style={{
                      backgroundColor: 'var(--lx-muted)',
                      borderColor: 'var(--lx-border)',
                      color: 'var(--lx-fg)',
                    }}
                  >
                    Reset All Rules
                  </button>
                ) : null}
              </div>

              {rulesSubTab === 'harper' ? (
                <div className="flex flex-col gap-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-medium mr-1" style={{ color: 'var(--lx-fg-muted)' }}>
                      Presets:
                    </span>
                    {HARPER_RULE_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => void handleApplyRulePreset(preset.id)}
                        title={preset.description}
                        className="rounded-[6px] border px-2 py-1 text-[11px] font-medium"
                        style={{
                          backgroundColor: 'var(--lx-bg)',
                          borderColor: 'var(--lx-border)',
                          color: 'var(--lx-fg)',
                        }}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                  <input
                    type="search"
                    value={ruleSearch}
                    onChange={(e) => setRuleSearch(e.target.value)}
                    placeholder="Filter Harper grammar rules by ID or description..."
                    aria-label="Filter Harper grammar rules"
                    className="rounded-[6px] border px-3 py-1.5 text-xs"
                    style={{
                      backgroundColor: 'var(--lx-bg)',
                      borderColor: 'var(--lx-border)',
                      color: 'var(--lx-fg)',
                    }}
                  />
                  <div
                    className="rounded-[6px] border p-2 max-h-[420px] overflow-y-auto space-y-2"
                    style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-bg)' }}
                  >
                    {structuredConfig ? (
                      <OptionsStructuredRules
                        settings={structuredConfig.settings}
                        query={ruleSearch.trim().toLowerCase()}
                        lintConfig={lintConfig}
                        defaultLintConfig={defaultLintConfig}
                        descriptions={lintDescriptions}
                        onToggle={handleRuleToggle}
                        onOneOfMany={handleOneOfManyChange}
                      />
                    ) : (
                      harperRuleEntries.map((rule) => (
                        <label
                          key={rule.id}
                          className="px-3 py-2 flex items-start justify-between gap-3 text-xs border-b"
                          style={{ borderColor: 'var(--lx-border)' }}
                        >
                          <div className="min-w-0">
                            <div className="font-semibold lexel-mono">{rule.id}</div>
                            <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                              {rule.desc}
                            </div>
                          </div>
                          <input
                            type="checkbox"
                            checked={rule.enabled}
                            onChange={(e) => void handleRuleToggle(rule.id, e.target.checked)}
                          />
                        </label>
                      ))
                    )}
                  </div>
                </div>
              ) : null}

              {rulesSubTab === 'slop' ? (
                <div className="flex flex-col gap-3">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newSlopTerm}
                      onChange={(e) => setNewSlopTerm(e.target.value)}
                      placeholder="Add custom banned phrase..."
                      aria-label="Add custom banned phrase"
                      className="flex-1 rounded-[6px] border px-2.5 py-1.5 text-xs"
                      style={{
                        backgroundColor: 'var(--lx-bg)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const t = newSlopTerm.trim();
                        if (!t) return;
                        void saveCustomSlop(
                          customSlopTerms.includes(t) ? customSlopTerms : [...customSlopTerms, t],
                          disabledSlopTerms,
                        );
                        setNewSlopTerm('');
                      }}
                      className="rounded-[6px] px-3 py-1.5 text-xs font-semibold"
                      style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
                    >
                      Add
                    </button>
                  </div>
                  {customSlopTerms.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {customSlopTerms.map((term) => (
                        <button
                          key={term}
                          type="button"
                          onClick={() =>
                            void saveCustomSlop(
                              customSlopTerms.filter((t) => t !== term),
                              disabledSlopTerms,
                            )
                          }
                          className="rounded-[4px] border px-2 py-0.5 text-xs lexel-mono"
                          style={{
                            backgroundColor: 'var(--lx-signal-bg)',
                            borderColor: 'var(--lx-signal)',
                            color: 'var(--lx-signal)',
                          }}
                        >
                          {term} ×
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-1.5">
                    {SLOP_TERMS.map((term) => {
                      const muted = disabledSlopTerms.some(
                        (d) => d.toLowerCase() === term.toLowerCase(),
                      );
                      return (
                        <button
                          key={term}
                          type="button"
                          onClick={() => {
                            const nextDisabled = muted
                              ? disabledSlopTerms.filter((d) => d.toLowerCase() !== term.toLowerCase())
                              : [...disabledSlopTerms, term];
                            void saveCustomSlop(customSlopTerms, nextDisabled);
                          }}
                          className="rounded-[4px] border px-2 py-0.5 text-xs lexel-mono"
                          style={{
                            backgroundColor: 'var(--lx-bg)',
                            borderColor: 'var(--lx-border)',
                            color: muted ? 'var(--lx-fg-muted)' : 'var(--lx-fg)',
                            textDecoration: muted ? 'line-through' : 'none',
                            opacity: muted ? 0.6 : 1,
                          }}
                        >
                          {term}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {rulesSubTab === 'sites' ? (
                <div className="flex flex-col gap-3">
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                    <input
                      type="text"
                      value={newSiteDomain}
                      onChange={(e) => setNewSiteDomain(e.target.value)}
                      placeholder="Domain (e.g. reddit.com)"
                      aria-label="Site domain"
                      className="md:col-span-2 rounded-[6px] border px-2.5 py-1.5 text-xs lexel-mono"
                      style={{
                        backgroundColor: 'var(--lx-bg)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    />
                    <select
                      aria-label="Site status"
                      value={newSiteEnabled ? 'active' : 'paused'}
                      onChange={(e) => setNewSiteEnabled(e.target.value === 'active')}
                      className="rounded-[6px] border px-2 py-1.5 text-xs"
                      style={{
                        backgroundColor: 'var(--lx-bg)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    >
                      <option value="active">Active</option>
                      <option value="paused">Paused</option>
                    </select>
                    <div className="flex gap-2">
                      <select
                        aria-label="Site surface override"
                        value={newSiteSurface}
                        onChange={(e) => setNewSiteSurface(e.target.value)}
                        className="flex-1 rounded-[6px] border px-2 py-1.5 text-xs"
                        style={{
                          backgroundColor: 'var(--lx-bg)',
                          borderColor: 'var(--lx-border)',
                          color: 'var(--lx-fg)',
                        }}
                      >
                        <option value="auto">Auto Surface</option>
                        {listSurfaceProfiles(customSurfaces).map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => void handleAddSiteRule()}
                        className="rounded-[6px] px-3 py-1.5 text-xs font-semibold shrink-0"
                        style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
                      >
                        Save
                      </button>
                    </div>
                  </div>

                  {managedDomains.length === 0 ? (
                    <p className="text-xs m-0" style={{ color: 'var(--lx-fg-muted)' }}>
                      No per-domain overrides configured yet. Sites follow the global default above.
                    </p>
                  ) : (
                    <div
                      className="rounded-[6px] border divide-y"
                      style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-bg)' }}
                    >
                      {managedDomains.map((dom) => (
                        <div
                          key={dom}
                          className="px-3 py-2 flex items-center justify-between gap-2 text-xs"
                          style={{ borderColor: 'var(--lx-border)' }}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="lexel-mono font-medium truncate">{dom}</span>
                            <span className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                              {domainStatuses[dom] === false ? 'Paused' : 'Active'}
                              {surfaceOverrides[dom] ? ` · ${surfaceOverrides[dom]}` : ''}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleRemoveSiteRule(dom)}
                            className="text-[11px]"
                            style={{ color: 'var(--lx-danger)' }}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}

              {rulesSubTab === 'surfaces' ? (
                <div className="flex flex-col gap-3">
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                    <input
                      type="text"
                      value={surfaceIdDraft}
                      onChange={(e) => setSurfaceIdDraft(e.target.value)}
                      placeholder="ID slug (e.g. docs)"
                      aria-label="Custom surface ID"
                      className="rounded-[6px] border px-2.5 py-1.5 text-xs lexel-mono"
                      style={{
                        backgroundColor: 'var(--lx-bg)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    />
                    <input
                      type="text"
                      value={surfaceLabelDraft}
                      onChange={(e) => setSurfaceLabelDraft(e.target.value)}
                      placeholder="Display label"
                      aria-label="Custom surface label"
                      className="rounded-[6px] border px-2.5 py-1.5 text-xs"
                      style={{
                        backgroundColor: 'var(--lx-bg)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    />
                    <input
                      type="number"
                      min={40}
                      max={20000}
                      value={surfaceMaxChars}
                      onChange={(e) =>
                        setSurfaceMaxChars(Number.parseInt(e.target.value || '1200', 10))
                      }
                      aria-label="Custom surface max characters"
                      className="rounded-[6px] border px-2.5 py-1.5 text-xs lexel-mono"
                      style={{
                        backgroundColor: 'var(--lx-bg)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const slug = surfaceIdDraft
                          .trim()
                          .toLowerCase()
                          .replace(/[^a-z0-9_]+/g, '_');
                        const label = surfaceLabelDraft.trim();
                        if (!slug || !label) return;
                        const entry: SurfaceProfile = {
                          id: slug,
                          label,
                          hostPatterns: [],
                          register: 'custom',
                          minChars: 1,
                          maxChars: Math.max(40, surfaceMaxChars),
                          allowLinks: true,
                          allowEmojis: false,
                          allowHashtags: false,
                          allowEmDashes: false,
                          bannedOpeners: [],
                          promptDirective:
                            surfaceDirective.trim() || `Write concisely for ${label}.`,
                          quickActions: [{ id: 'rewrite_surface', label: `Match ${label}` }],
                        };
                        void saveCustomSurfaceList([
                          ...customSurfaces.filter((s) => s.id !== entry.id),
                          entry,
                        ]);
                        setSurfaceIdDraft('');
                        setSurfaceLabelDraft('');
                        setSurfaceDirective('');
                      }}
                      className="rounded-[6px] px-3 py-1.5 text-xs font-semibold"
                      style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
                    >
                      Add Custom Surface
                    </button>
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    {listSurfaceProfiles(customSurfaces).map((p) => {
                      const isCustomOnly = !BUILTIN_SURFACES.some((b) => b.id === p.id);
                      return (
                        <EditableSurfaceCard
                          key={p.id}
                          profile={p}
                          isCustomOnly={isCustomOnly}
                          onSaveOverride={(baseSurface, patch) => {
                            const next = upsertSurfaceOverride(customSurfaces, baseSurface, patch);
                            void saveCustomSurfaceList(next);
                            setNotice(`Saved prompt & rules for ${baseSurface.label}.`);
                          }}
                          onResetOrDelete={(prof, customOnly) => {
                            const next = resetSurfaceOverride(customSurfaces, prof.id);
                            void saveCustomSurfaceList(next);
                            setNotice(
                              customOnly
                                ? `Deleted custom surface "${prof.label}".`
                                : `Reset "${prof.label}" back to default prompt & rules.`,
                            );
                          }}
                        />
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {rulesSubTab === 'weirpacks' ? (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
                      Load local `.weirpack` bundles. Embedded Weir unit tests run before activation.
                    </span>
                    <input
                      ref={weirpackInputRef}
                      type="file"
                      accept=".weirpack,application/zip"
                      className="hidden"
                      onChange={(e) => {
                        void handleUploadWeirpack(e.target.files?.[0]);
                        e.target.value = '';
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => weirpackInputRef.current?.click()}
                      className="rounded-[6px] px-3 py-1.5 text-xs font-semibold"
                      style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
                    >
                      Upload .weirpack
                    </button>
                  </div>
                  <form
                    onSubmit={(e) => void handleBuildCustomWeirpack(e)}
                    className="rounded-[6px] border p-3 flex flex-col gap-2"
                    style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-bg)' }}
                  >
                    <div className="text-xs font-semibold">Build &amp; Test Custom Weir Rule</div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <input
                        type="text"
                        value={weirRuleName}
                        onChange={(e) => setWeirRuleName(e.target.value)}
                        placeholder="Rule ID (e.g. AvoidSynergy)"
                        aria-label="Weir rule name"
                        className="rounded-[6px] border px-2 py-1 text-xs lexel-mono"
                        style={{
                          backgroundColor: 'var(--lx-card)',
                          borderColor: 'var(--lx-border)',
                          color: 'var(--lx-fg)',
                        }}
                      />
                      <input
                        type="text"
                        value={weirExpr}
                        onChange={(e) => setWeirExpr(e.target.value)}
                        placeholder="Phrase to flag (e.g. delve into)"
                        aria-label="Weir phrase to flag"
                        className="rounded-[6px] border px-2 py-1 text-xs"
                        style={{
                          backgroundColor: 'var(--lx-card)',
                          borderColor: 'var(--lx-border)',
                          color: 'var(--lx-fg)',
                        }}
                      />
                      <input
                        type="text"
                        value={weirReplacement}
                        onChange={(e) => setWeirReplacement(e.target.value)}
                        placeholder="Plain replacement"
                        aria-label="Weir replacement"
                        className="rounded-[6px] border px-2 py-1 text-xs"
                        style={{
                          backgroundColor: 'var(--lx-card)',
                          borderColor: 'var(--lx-border)',
                          color: 'var(--lx-fg)',
                        }}
                      />
                    </div>
                    <input
                      type="text"
                      value={weirMessage}
                      onChange={(e) => setWeirMessage(e.target.value)}
                      placeholder="Diagnostic hint message"
                      aria-label="Weir message"
                      className="rounded-[6px] border px-2 py-1 text-xs"
                      style={{
                        backgroundColor: 'var(--lx-card)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <input
                        type="text"
                        value={weirTestBad}
                        onChange={(e) => setWeirTestBad(e.target.value)}
                        placeholder="Unit test input (before fix)"
                        aria-label="Weir test before"
                        className="rounded-[6px] border px-2 py-1 text-xs"
                        style={{
                          backgroundColor: 'var(--lx-card)',
                          borderColor: 'var(--lx-border)',
                          color: 'var(--lx-fg)',
                        }}
                      />
                      <input
                        type="text"
                        value={weirTestGood}
                        onChange={(e) => setWeirTestGood(e.target.value)}
                        placeholder="Expected output (after fix)"
                        aria-label="Weir test after"
                        className="rounded-[6px] border px-2 py-1 text-xs"
                        style={{
                          backgroundColor: 'var(--lx-card)',
                          borderColor: 'var(--lx-border)',
                          color: 'var(--lx-fg)',
                        }}
                      />
                    </div>
                    <div className="flex justify-end">
                      <button
                        type="submit"
                        className="rounded-[6px] border px-3 py-1 text-xs font-semibold"
                        style={{
                          backgroundColor: 'var(--lx-muted)',
                          borderColor: 'var(--lx-border)',
                          color: 'var(--lx-fg)',
                        }}
                      >
                        Run Weir Tests &amp; Enable Pack
                      </button>
                    </div>
                  </form>
                  {weirpacks.length === 0 ? (
                    <p className="text-xs m-0" style={{ color: 'var(--lx-fg-muted)' }}>
                      No custom Weirpacks uploaded yet.
                    </p>
                  ) : (
                    <div
                      className="rounded-[6px] border divide-y"
                      style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-bg)' }}
                    >
                      {weirpacks.map((pack) => (
                        <div
                          key={pack.name}
                          className="px-3 py-2 flex items-center justify-between gap-2 text-xs"
                          style={{ borderColor: 'var(--lx-border)' }}
                        >
                          <span>
                            <span className="font-semibold lexel-mono">{pack.name}</span> ({pack.ruleCount} rules)
                          </span>
                          <div className="flex items-center gap-3">
                            <label className="inline-flex items-center gap-1">
                              <input
                                type="checkbox"
                                checked={pack.enabled}
                                onChange={(e) => {
                                  void chrome.runtime
                                    .sendMessage({
                                      kind: 'toggleWeirpack',
                                      name: pack.name,
                                      enabled: e.target.checked,
                                    })
                                    .then(() => loadAll());
                                }}
                              />
                              <span>Enabled</span>
                            </label>
                            <button
                              type="button"
                              onClick={() => {
                                void chrome.runtime
                                  .sendMessage({ kind: 'removeWeirpack', name: pack.name })
                                  .then(() => loadAll());
                              }}
                              style={{ color: 'var(--lx-danger)' }}
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}

              {rulesSubTab === 'stats' ? (
                <div className="rounded-[6px] border p-3 text-xs space-y-2" style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-bg)' }}>
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">Local Writing Stats (Harper Engine)</span>
                    <button
                      type="button"
                      onClick={async () => {
                        const res = (await chrome.runtime.sendMessage({ kind: 'exportStats' })) as {
                          statsJson?: string;
                        };
                        if (!res.statsJson) return;
                        const blob = new Blob([res.statsJson], { type: 'text/plain' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = 'lexel-browser-stats.log';
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                      className="rounded-[6px] border px-2.5 py-1 text-[11px]"
                      style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-card)' }}
                    >
                      Export Log
                    </button>
                  </div>
                  {statsSummary ? (
                    <div className="lexel-mono text-[11px] space-y-1">
                      <div>Total fixes applied: {statsSummary.total_applied}</div>
                      {Object.entries(statsSummary.lint_counts).map(([kind, count]) => (
                        <div key={kind} className="flex justify-between">
                          <span>{kind}</span>
                          <span>{count}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ color: 'var(--lx-fg-muted)' }}>No stats recorded yet.</div>
                  )}
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {tab === 'privacy' ? (
          <section
            className="rounded-[8px] border p-4 flex flex-col gap-4"
            style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-xs">
                <span>Custom User Dictionary (one word per line)</span>
                <textarea
                  rows={6}
                  value={dictionaryText}
                  onChange={(e) => setDictionaryText(e.target.value)}
                  className="rounded-[6px] border p-2 text-xs lexel-mono"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span>Privacy Blocklist Domains (one per line)</span>
                <textarea
                  rows={6}
                  value={blocklistText}
                  onChange={(e) => setBlocklistText(e.target.value)}
                  className="rounded-[6px] border p-2 text-xs lexel-mono"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
              </label>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void savePrivacyAndDict()}
                className="rounded-[6px] px-3 py-1.5 text-xs font-semibold"
                style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
              >
                Save Dictionary &amp; Blocklist
              </button>
              <button
                type="button"
                onClick={() => void handleExport()}
                className="rounded-[6px] border px-3 py-1.5 text-xs font-medium"
                style={{
                  backgroundColor: 'var(--lx-muted)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              >
                Export Local JSON
              </button>
              <button
                type="button"
                onClick={() => void handlePurge()}
                className="ml-auto rounded-[6px] border px-3 py-1.5 text-xs font-medium"
                style={{
                  backgroundColor: 'var(--lx-danger-bg)',
                  borderColor: 'var(--lx-danger)',
                  color: 'var(--lx-danger)',
                }}
              >
                Purge All Local Data
              </button>
            </div>

            <div className="border-t pt-3" style={{ borderColor: 'var(--lx-border)' }}>
              <h2 className="text-sm font-semibold m-0 mb-2">
                Local Voice Memory ({voiceExamples.length})
              </h2>
              {voiceExamples.length === 0 ? (
                <p className="text-xs m-0" style={{ color: 'var(--lx-fg-muted)' }}>
                  No accepted rewrites stored yet. Accepting a local AI rewrite saves a few-shot style example here on your device.
                </p>
              ) : (
                <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
                  {voiceExamples.map((ex) => (
                    <div
                      key={ex.id}
                      className="rounded-[6px] border p-2.5 text-xs flex items-start justify-between gap-2"
                      style={{ backgroundColor: 'var(--lx-bg)', borderColor: 'var(--lx-border)' }}
                    >
                      <div className="space-y-1">
                        <div className="lexel-mono text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                          {ex.surfaceId}
                          {ex.subcontext ? ` / ${ex.subcontext}` : ''}
                        </div>
                        <div>{ex.rewritten}</div>
                      </div>
                      <button
                        type="button"
                        onClick={async () => {
                          await chrome.runtime.sendMessage({ kind: 'deleteVoiceExample', id: ex.id });
                          setVoiceExamples((prev) => prev.filter((item) => item.id !== ex.id));
                        }}
                        className="text-[11px]"
                        style={{ color: 'var(--lx-danger)' }}
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function OptionsStructuredRules({
  settings,
  query,
  lintConfig,
  defaultLintConfig,
  descriptions,
  onToggle,
  onOneOfMany,
}: {
  settings: StructuredLintSetting[];
  query: string;
  lintConfig: LintConfig;
  defaultLintConfig: LintConfig;
  descriptions: Record<string, string>;
  onToggle: (ruleId: string, enabled: boolean) => Promise<void>;
  onOneOfMany: (names: string[], selected: string | null) => Promise<void>;
}) {
  const matches = (setting: StructuredLintSetting): boolean => {
    if (!query) return true;
    if ('Bool' in setting) {
      const desc = descriptions[setting.Bool.name]
        ? stripHtml(descriptions[setting.Bool.name]).toLowerCase()
        : '';
      return (
        setting.Bool.name.toLowerCase().includes(query) ||
        (setting.Bool.label ?? '').toLowerCase().includes(query) ||
        desc.includes(query)
      );
    }
    if ('OneOfMany' in setting) {
      return setting.OneOfMany.names.some((n) => n.toLowerCase().includes(query));
    }
    return (
      setting.Group.label.toLowerCase().includes(query) ||
      setting.Group.description.toLowerCase().includes(query) ||
      setting.Group.child.settings.some(matches)
    );
  };

  return (
    <div className="space-y-2">
      {settings.filter(matches).map((setting, idx) => {
        if ('Group' in setting) {
          return (
            <details
              key={`${setting.Group.label}-${idx}`}
              open={query.length > 0}
              className="rounded-[6px] border p-2"
              style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-card)' }}
            >
              <summary className="cursor-pointer text-xs font-semibold flex justify-between">
                <span>{setting.Group.label}</span>
                <span className="font-normal text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                  {setting.Group.child.settings.length}
                </span>
              </summary>
              <div className="mt-2 space-y-1.5">
                {setting.Group.description ? (
                  <p className="text-[11px] m-0" style={{ color: 'var(--lx-fg-muted)' }}>
                    {setting.Group.description}
                  </p>
                ) : null}
                <OptionsStructuredRules
                  settings={setting.Group.child.settings}
                  query={query}
                  lintConfig={lintConfig}
                  defaultLintConfig={defaultLintConfig}
                  descriptions={descriptions}
                  onToggle={onToggle}
                  onOneOfMany={onOneOfMany}
                />
              </div>
            </details>
          );
        }
        if ('OneOfMany' in setting) {
          const { names, name, labels } = setting.OneOfMany;
          const active =
            names.find((n) => lintConfig[n] === true) ??
            (names.every((n) => lintConfig[n] === false) ? '' : name ?? '');
          return (
            <div
              key={names.join('-')}
              className="rounded-[6px] border px-2.5 py-2 flex items-center justify-between gap-2 text-xs"
              style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-bg)' }}
            >
              <span className="lexel-mono font-medium">{names[0]}</span>
              <select
                value={active}
                onChange={(e) => void onOneOfMany(names, e.target.value || null)}
                className="rounded-[6px] border px-2 py-1 text-xs"
                style={{
                  backgroundColor: 'var(--lx-card)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              >
                <option value="">Off</option>
                {names.map((ruleName, optIdx) => (
                  <option key={ruleName} value={ruleName}>
                    {labels?.[optIdx] ?? ruleName}
                  </option>
                ))}
              </select>
            </div>
          );
        }
        const { name, state, label } = setting.Bool;
        const checked =
          lintConfig[name] !== undefined && lintConfig[name] !== null
            ? lintConfig[name] === true
            : defaultLintConfig[name] !== undefined && defaultLintConfig[name] !== null
              ? defaultLintConfig[name] === true
              : state;
        return (
          <label
            key={name}
            className="px-2.5 py-1.5 flex items-start justify-between gap-3 text-xs border-b"
            style={{ borderColor: 'var(--lx-border)' }}
          >
            <div className="min-w-0">
              <div className="font-semibold lexel-mono">{label ?? name}</div>
              {descriptions[name] ? (
                <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                  {stripHtml(descriptions[name])}
                </div>
              ) : null}
            </div>
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => void onToggle(name, e.target.checked)}
            />
          </label>
        );
      })}
    </div>
  );
}

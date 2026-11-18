import type {
  Dialect,
  LintConfig,
  StructuredLintConfig,
  Summary,
  WeirpackTestFailures,
} from 'harper.js';
import {
  BUILTIN_SURFACES,
  EditableSurfaceCard,
  RewriteDiffCard,
  StatusPill,
  SurfaceBadge,
  applyRulePreset,
  normalizeTypography,
  resetSurfaceOverride,
  toSentenceCase,
  upsertSurfaceOverride,
  type AiHealthState,
  type RulePresetId,
} from 'lexel-ui';
import type { IgnorableLintBox, UnpackedLint, UnpackedLintGroups } from 'lint-framework';
import {
  BookOpenCheck,
  CaseSensitive,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Eraser,
  FilePenLine,
  MonitorDown,
  Moon,
  PenLine,
  PenTool,
  RefreshCw,
  ShieldAlert,
  SlidersHorizontal,
  Sun,
  WandSparkles,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LabSuggestionPopover } from './components/LabSuggestionPopover';
import { RulesWorkspace } from './components/RulesWorkspace';
import { SettingsView } from './components/SettingsView';
import {
  checkDaemonHealth,
  createDaemonProfile,
  deleteDaemonProfile,
  deleteDaemonVoiceExample,
  fetchDaemonStatus,
  listDaemonVoiceExamples,
  patchDaemonSettings,
  purgeDaemonAll,
  rewriteWithDaemon,
  applyDaemonRulePreset,
  fetchDaemonSynonyms,
  saveDaemonVoiceExample,
  setDaemonMainModel,
  switchDaemonProfile,
  toggleDaemonAi,
  unloadDaemonAi,
} from './lib/daemonClient';
import {
  computeWritingMetrics,
  LexelLabEngine,
  type LabLintResult,
  uint8ArrayToBase64,
} from './lib/engine';
import { type ActiveLabLint, LabLintController } from './lib/labLintController';
import { checkLocalAiHealth, generateLocalRewrite, type LocalAiHealth } from './lib/localAi';
import { MODEL_MANIFEST_SPECS, resolveModelNameForTier } from './lib/models';
import { LAB_PRESETS } from './lib/presets';
import { buildRewriteMessages } from './lib/promptBuilder';
import {
  applyDaemonProfileToLabState,
  clearLabState,
  createVoiceExampleEntry,
  labStateToDaemonPatch,
  loadLabState,
  parseImportedLabState,
  saveLabState,
} from './lib/storage';
import { listSurfaceProfiles, resolveSurfaceProfile } from './lib/surfaces';
import type {
  AiSettings,
  AiTaskId,
  DaemonConnectionConfig,
  LabSettingsState,
  MainModelTier,
  RewriteResult,
  SurfaceId,
} from './lib/types';
import {
  applySafeDeterministicFixes,
  hasSecrets,
  sanitizeModelOutput,
  verifyAiRewrite,
} from './lib/verifier';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type WorkspaceId = 'studio' | 'rules' | 'settings';
type InspectorTab = 'diagnostics' | 'stats' | 'ai';

const TASK_OPTIONS: Array<{ id: AiTaskId; label: string }> = [
  { id: 'rewrite_surface', label: 'Match surface style' },
  { id: 'deslop', label: 'Remove AI slop' },
  { id: 'fix_grammar_flow', label: 'Fix grammar & flow' },
  { id: 'shorten', label: 'Shorten concisely' },
  { id: 'reply_draft', label: 'Draft reply' },
];

const DIALECT_NAMES: Record<number, string> = {
  0: 'US English',
  1: 'UK English',
  2: 'AU English',
  3: 'CA English',
  4: 'IN English',
};

function lintSignalColor(rule: string, lintKind: string): string {
  if (rule === 'LexelSecrets') return 'var(--lx-danger)';
  if (lintKind === 'Spelling' || lintKind === 'Typo') return 'var(--lx-danger)';
  if (
    rule === 'LexelAntiSlop' ||
    rule === 'LexelSurface' ||
    lintKind === 'Style' ||
    lintKind === 'Readability'
  ) {
    return 'var(--lx-warn)';
  }
  return 'var(--lx-signal)';
}

export function App() {
  const [state, setState] = useState<LabSettingsState>(() => loadLabState());
  const [workspace, setWorkspace] = useState<WorkspaceId>('studio');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('diagnostics');
  const [wasmStatus, setWasmStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [wasmError, setWasmError] = useState<string | null>(null);
  const [lintSummary, setLintSummary] = useState<LabLintResult>({
    lints: {},
    grammarCount: 0,
    slopCount: 0,
    surfaceCount: 0,
    secretCount: 0,
    latencyMs: 0,
  });
  const [activeLint, setActiveLint] = useState<ActiveLabLint | null>(null);
  const [ruleConfig, setRuleConfig] = useState<LintConfig>({});
  const [defaultRuleConfig, setDefaultRuleConfig] = useState<LintConfig>({});
  const [structuredConfig, setStructuredConfig] = useState<StructuredLintConfig | null>(null);
  const [ruleDescriptions, setRuleDescriptions] = useState<Record<string, string>>({});
  const [harperStats, setHarperStats] = useState<Summary | null>(null);
  const [tier0Notice, setTier0Notice] = useState<string | null>(null);
  const [undoDraftText, setUndoDraftText] = useState<string | null>(null);
  const [synonymQuery, setSynonymQuery] = useState('');
  const [synonymList, setSynonymList] = useState<string[]>([]);
  const [synonymMsg, setSynonymMsg] = useState<string | null>(null);

  const [aiHealth, setAiHealth] = useState<LocalAiHealth | null>(null);
  const [task, setTask] = useState<AiTaskId>('rewrite_surface');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [rewriteResult, setRewriteResult] = useState<RewriteResult | null>(null);
  const [copiedRewrite, setCopiedRewrite] = useState(false);
  const [copiedDraft, setCopiedDraft] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const engineRef = useRef<LexelLabEngine | null>(null);
  const controllerRef = useRef<LabLintController | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const skipNextDaemonPushRef = useRef(false);
  const daemonConnectedRef = useRef(false);

  useEffect(() => {
    saveLabState(state);
  }, [state]);

  useEffect(() => {
    if (!daemonConnectedRef.current) return;
    if (skipNextDaemonPushRef.current) {
      skipNextDaemonPushRef.current = false;
      return;
    }
    const conn = state.daemonConnection;
    if (!conn.enabled || !conn.token.trim()) return;
    const timer = window.setTimeout(() => {
      void patchDaemonSettings(conn, labStateToDaemonPatch(stateRef.current)).catch(() => undefined);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [
    state.theme,
    state.dialect,
    state.isolateEnglish,
    state.openSuggestionsOnHover,
    state.activationKey,
    state.delayMs,
    state.defaultEnable,
    state.lintConfig,
    state.ignoredLints,
    state.userDictionary,
    state.privacyBlocklist,
    state.domainStatuses,
    state.surfaceOverrides,
    state.languageMode,
    state.customSlopTerms,
    state.disabledSlopTerms,
    state.customSurfaces,
    state.aiSettings,
  ]);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const refreshAiHealth = useCallback(
    async (aiSettings: AiSettings, connOverride?: DaemonConnectionConfig) => {
      const conn = connOverride ?? stateRef.current.daemonConnection;
      if (conn.enabled && conn.token.trim()) {
        try {
          const [status, voiceRes] = await Promise.all([
            fetchDaemonStatus(conn),
            listDaemonVoiceExamples(conn).catch(() => ({ examples: undefined })),
          ]);
          daemonConnectedRef.current = true;
          skipNextDaemonPushRef.current = true;
          setState((prev) =>
            applyDaemonProfileToLabState(prev, status.activeProfile, voiceRes.examples),
          );

          const activeSettings = status.activeProfile.settings;
          const effectiveModel = resolveModelNameForTier(
            activeSettings.mainModelTier,
            activeSettings.customModel,
          );
          const rt = status.runtime;
          const matched = status.models.find(
            (m) => m.id === activeSettings.mainModelTier || m.ollamaTag === effectiveModel,
          );
          const anyCapable =
            rt.llamaServerAvailable || rt.ollamaBinaryAvailable || rt.ollamaRunning;
          const modelAvailable =
            activeSettings.mainModelTier === 'custom'
              ? rt.ollamaModels.includes(effectiveModel) || rt.modelLoaded
              : Boolean(
                  matched?.ggufInstalled ||
                    matched?.ollamaInstalled ||
                    rt.ollamaModels.includes(effectiveModel),
                );
          const models = Array.from(
            new Set([
              ...status.models
                .filter((m) => m.ggufInstalled || m.ollamaInstalled)
                .map((m) => m.ollamaTag),
              ...rt.ollamaModels,
            ]),
          );
          let error: string | undefined;
          if (!activeSettings.aiEnabled) {
            error = 'Local AI is turned off.';
          } else if (!modelAvailable) {
            error = `Model "${effectiveModel}" is not downloaded yet. Run \`make setup\`.`;
          } else if (!anyCapable && activeSettings.runtime === 'auto') {
            error = 'GGUF models are installed, but neither llama-server nor Ollama was detected.';
          }

          setAiHealth({
            ok: activeSettings.aiEnabled && anyCapable && modelAvailable,
            models,
            modelAvailable,
            error,
            source: 'daemon',
            daemonConnected: true,
            runtimeBackend: rt.activeBackend,
            modelLoaded: rt.modelLoaded,
            loadedModel: rt.loadedModel,
            activeProfile: status.activeProfile,
            profiles: status.profiles,
            installedModels: status.models,
          });
          return;
        } catch (err) {
          daemonConnectedRef.current = false;
          const probe = await checkDaemonHealth(conn.endpoint);
          const direct = await checkLocalAiHealth(aiSettings);
          setAiHealth({
            ...direct,
            source: 'direct',
            daemonConnected: false,
            daemonAuthRequired: Boolean(probe.ok && probe.authRequired),
            error: (err as Error).message || direct.error,
          });
          return;
        }
      }

      daemonConnectedRef.current = false;
      const [probe, direct] = await Promise.all([
        conn.enabled
          ? checkDaemonHealth(conn.endpoint)
          : Promise.resolve({ ok: false, authRequired: false }),
        checkLocalAiHealth(aiSettings),
      ]);
      setAiHealth({
        ...direct,
        source: 'direct',
        daemonConnected: false,
        daemonAuthRequired: Boolean(probe.ok && probe.authRequired),
      });
    },
    [],
  );

  useEffect(() => {
    void refreshAiHealth(state.aiSettings);
  }, [refreshAiHealth]);

  useEffect(() => {
    const engine = new LexelLabEngine();
    engineRef.current = engine;

    const controller = new LabLintController(
      async (text): Promise<UnpackedLintGroups> => {
        const s = stateRef.current;
        try {
          const result = await engine.lint(text, {
            surfaceId: s.surfaceId,
            dialect: s.dialect,
            languageMode: s.languageMode,
            isolateEnglish: s.isolateEnglish,
            lintConfig: s.lintConfig,
            userDictionary: s.userDictionary,
            ignoredLints: s.ignoredLints,
            customSlopTerms: s.customSlopTerms,
            disabledSlopTerms: s.disabledSlopTerms,
            customSurfaces: s.customSurfaces,
            weirpacks: s.weirpacks,
          });
          setWasmStatus('ready');
          setWasmError(null);
          setLintSummary(result);
          void engine.summarizeStats().then((sum) => {
            if (sum) setHarperStats(sum);
          });
          return result.lints;
        } catch (err) {
          setWasmStatus('error');
          setWasmError((err as Error).message);
          return {};
        }
      },
      {
        ignoreLint: async (hash) => {
          const exported = await engine.ignoreLintHash(hash);
          if (exported) {
            setState((prev) => ({ ...prev, ignoredLints: exported }));
          }
        },
        onActiveLintChange: (next) => setActiveLint(next),
        onTextMutated: (nextText) => {
          setState((prev) => ({ ...prev, draftText: nextText }));
        },
      },
    );
    controllerRef.current = controller;

    void engine
      .init({
        dialect: stateRef.current.dialect,
        lintConfig: stateRef.current.lintConfig,
        userDictionary: stateRef.current.userDictionary,
        ignoredLints: stateRef.current.ignoredLints,
        weirpacks: stateRef.current.weirpacks,
      })
      .then(async () => {
        setWasmStatus('ready');
        const meta = await engine.getFullConfigAndDescriptions();
        setRuleConfig(meta.config);
        setDefaultRuleConfig(meta.defaultConfig);
        setStructuredConfig(meta.structuredConfig);
        setRuleDescriptions(meta.descriptions);
        if (textareaRef.current) {
          controller.attach(textareaRef.current);
        }
        await controller.refresh(true);
      })
      .catch((err) => {
        setWasmStatus('error');
        setWasmError((err as Error).message);
      });

    return () => {
      controller.destroy();
      engine.dispose();
    };
  }, []);

  useEffect(() => {
    if (workspace === 'studio' && textareaRef.current && controllerRef.current) {
      controllerRef.current.attach(textareaRef.current);
      void controllerRef.current.refresh(true);
    }
  }, [workspace]);

  useEffect(() => {
    controllerRef.current?.setOptions({
      openSuggestionsOnHover: state.openSuggestionsOnHover,
      activationKey: state.activationKey,
      delayMs: state.delayMs,
    });
  }, [state.openSuggestionsOnHover, state.activationKey, state.delayMs]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    void engine
      .init({
        dialect: state.dialect,
        lintConfig: state.lintConfig,
        userDictionary: state.userDictionary,
        ignoredLints: state.ignoredLints,
        weirpacks: state.weirpacks,
      })
      .then(async () => {
        const meta = await engine.getFullConfigAndDescriptions();
        setRuleConfig(meta.config);
        setDefaultRuleConfig(meta.defaultConfig);
        setStructuredConfig(meta.structuredConfig);
        await controllerRef.current?.refresh(true);
      })
      .catch(() => undefined);
  }, [state.dialect, state.userDictionary, state.weirpacks]);

  useEffect(() => {
    if (!state.draftText.trim()) {
      setLintSummary({
        lints: {},
        grammarCount: 0,
        slopCount: 0,
        surfaceCount: 0,
        secretCount: 0,
        latencyMs: 0,
      });
    }
    void controllerRef.current?.refresh(true);
  }, [
    state.surfaceId,
    state.languageMode,
    state.isolateEnglish,
    state.lintConfig,
    state.ignoredLints,
    state.customSlopTerms,
    state.disabledSlopTerms,
    state.customSurfaces,
  ]);

  const allSurfaces = useMemo(
    () => listSurfaceProfiles(state.customSurfaces),
    [state.customSurfaces],
  );
  const profile = resolveSurfaceProfile(state.surfaceId, state.customSurfaces);
  const textStats = useMemo(
    () =>
      computeWritingMetrics(state.draftText, {
        slopCount: lintSummary.slopCount,
        secretCount: lintSummary.secretCount,
      }),
    [state.draftText, lintSummary.slopCount, lintSummary.secretCount],
  );

  const flattenedLints = useMemo(() => {
    const items: Array<{ rule: string; lint: UnpackedLint }> = [];
    for (const [rule, list] of Object.entries(lintSummary.lints)) {
      for (const lint of list) {
        items.push({ rule, lint });
      }
    }
    return items.sort((a, b) => a.lint.span.start - b.lint.span.start);
  }, [lintSummary.lints]);

  const totalDiagnostics = flattenedLints.length;

  async function runAiTask(overrideTask?: AiTaskId) {
    const chosenTask = overrideTask ?? task;
    if (!state.draftText.trim()) {
      setAiError('Write or load a sample draft before running a rewrite.');
      return;
    }
    if (hasSecrets(state.draftText)) {
      setWorkspace('studio');
      setInspectorTab('ai');
      setAiError('Draft contains detected secrets or PII. Remove sensitive tokens before sending to AI.');
      return;
    }
    if (overrideTask) setTask(overrideTask);
    setWorkspace('studio');
    setInspectorTab('ai');
    setAiLoading(true);
    setAiError(null);
    setCopiedRewrite(false);
    const started = performance.now();

    try {
      const conn = state.daemonConnection;
      if (conn.enabled && conn.token.trim() && aiHealth?.daemonConnected) {
        const res = await rewriteWithDaemon(conn, {
          text: state.draftText,
          task: chosenTask,
          surfaceId: state.surfaceId,
          subcontext: state.subcontext.trim() || null,
          threadContext: chosenTask === 'reply_draft' ? state.threadContext : undefined,
        });
        setRewriteResult(res);
      } else {
        const messages = buildRewriteMessages({
          text: state.draftText,
          task: chosenTask,
          surfaceId: state.surfaceId,
          subcontext: state.subcontext.trim() || null,
          threadContext: chosenTask === 'reply_draft' ? state.threadContext : undefined,
          voiceExamples: state.voiceExamples,
          customSurfaces: state.customSurfaces,
        });
        const raw = await generateLocalRewrite(state.aiSettings, messages);
        const suggestion = sanitizeModelOutput(raw);
        const gates = verifyAiRewrite(state.draftText, suggestion, state.surfaceId, {
          customSlopTerms: state.customSlopTerms,
          disabledSlopTerms: state.disabledSlopTerms,
          customSurfaces: state.customSurfaces,
        });

        setRewriteResult({
          original: state.draftText,
          suggestion,
          model: state.aiSettings.model,
          latencyMs: Math.round(performance.now() - started),
          gates,
          surfaceId: state.surfaceId,
          subcontext: state.subcontext.trim() || null,
        });
      }
    } catch (err) {
      setAiError((err as Error).message);
      void refreshAiHealth(state.aiSettings);
    } finally {
      setAiLoading(false);
    }
  }

  function handleApplyRewrite() {
    if (!rewriteResult) return;
    if (
      state.aiSettings.saveVoiceMemory &&
      state.daemonConnection.enabled &&
      state.daemonConnection.token.trim() &&
      aiHealth?.daemonConnected
    ) {
      void saveDaemonVoiceExample(state.daemonConnection, {
        surfaceId: state.surfaceId,
        subcontext: state.subcontext.trim() || null,
        original: rewriteResult.original,
        rewritten: rewriteResult.suggestion,
        action: 'accepted',
      }).catch(() => undefined);
    }
    setState((prev) => {
      const nextExamples = prev.aiSettings.saveVoiceMemory
        ? [
            createVoiceExampleEntry({
              surfaceId: prev.surfaceId,
              subcontext: prev.subcontext.trim() || null,
              original: rewriteResult.original,
              rewritten: rewriteResult.suggestion,
              action: 'accepted',
            }),
            ...prev.voiceExamples,
          ].slice(0, 150)
        : prev.voiceExamples;
      return {
        ...prev,
        draftText: rewriteResult.suggestion,
        voiceExamples: nextExamples,
      };
    });
    setRewriteResult(null);
    requestAnimationFrame(() => void controllerRef.current?.refresh(true));
  }

  async function handleToggleAi(enabled: boolean) {
    const nextAi = { ...state.aiSettings, enabled };
    setState((prev) => ({ ...prev, aiSettings: nextAi }));
    if (aiHealth?.daemonConnected && state.daemonConnection.token.trim()) {
      await toggleDaemonAi(state.daemonConnection, enabled).catch(() => undefined);
    }
    await refreshAiHealth(nextAi);
  }

  async function handleSelectMainModel(modelSpec: string) {
    const tier: MainModelTier =
      modelSpec === 'lexel-0.5b' || modelSpec === '0.5b'
        ? 'lexel-0.5b'
        : modelSpec === 'lexel-1.5b' || modelSpec === '1.5b'
          ? 'lexel-1.5b'
          : 'custom';
    const nextModel = resolveModelNameForTier(tier, modelSpec);
    const nextAi = { ...state.aiSettings, mainModelTier: tier, model: nextModel };
    setState((prev) => ({ ...prev, aiSettings: nextAi }));
    if (aiHealth?.daemonConnected && state.daemonConnection.token.trim()) {
      await setDaemonMainModel(state.daemonConnection, modelSpec).catch(() => undefined);
    }
    await refreshAiHealth(nextAi);
  }

  async function handleUnloadModel() {
    if (aiHealth?.daemonConnected && state.daemonConnection.token.trim()) {
      await unloadDaemonAi(state.daemonConnection).catch(() => undefined);
      await refreshAiHealth(state.aiSettings);
    }
  }

  async function handleSyncDaemon(conn: DaemonConnectionConfig) {
    await refreshAiHealth(state.aiSettings, conn);
  }

  async function handleCreateProfile(name: string) {
    if (!state.daemonConnection.token.trim()) return;
    await createDaemonProfile(state.daemonConnection, name, true);
    await refreshAiHealth(state.aiSettings);
  }

  async function handleSwitchProfile(profileId: string) {
    if (!state.daemonConnection.token.trim()) return;
    await switchDaemonProfile(state.daemonConnection, profileId);
    await refreshAiHealth(state.aiSettings);
  }

  async function handleDeleteProfile(profileId: string) {
    if (!state.daemonConnection.token.trim()) return;
    await deleteDaemonProfile(state.daemonConnection, profileId);
    await refreshAiHealth(state.aiSettings);
  }

  async function handleDeleteVoiceExample(id: string) {
    setState((prev) => ({
      ...prev,
      voiceExamples: prev.voiceExamples.filter((item) => item.id !== id),
    }));
    if (aiHealth?.daemonConnected && state.daemonConnection.token.trim()) {
      await deleteDaemonVoiceExample(state.daemonConnection, id).catch(() => undefined);
    }
  }

  async function handleRuleChange(ruleId: string, value: boolean | null) {
    const nextConfig: LintConfig = { ...state.lintConfig, [ruleId]: value };
    setState((prev) => ({ ...prev, lintConfig: nextConfig }));
    await engineRef.current?.setLintConfig(nextConfig);
    setRuleConfig((prev) => ({ ...prev, [ruleId]: value }));
    await controllerRef.current?.refresh(true);
  }

  async function handleOneOfManyChange(names: string[], selected: string | null) {
    const nextConfig: LintConfig = { ...state.lintConfig };
    for (const id of names) {
      nextConfig[id] = selected ? id === selected : false;
    }
    setState((prev) => ({ ...prev, lintConfig: nextConfig }));
    await engineRef.current?.setLintConfig(nextConfig);
    setRuleConfig((prev) => {
      const updated = { ...prev };
      for (const id of names) updated[id] = selected ? id === selected : false;
      return updated;
    });
    await controllerRef.current?.refresh(true);
  }

  async function handleResetAllRules() {
    setState((prev) => ({ ...prev, lintConfig: {} }));
    await engineRef.current?.setLintConfig(defaultRuleConfig);
    setRuleConfig(defaultRuleConfig);
    await controllerRef.current?.refresh(true);
  }

  async function handleApplyRulePreset(presetId: RulePresetId) {
    const nextConfig = applyRulePreset(
      state.lintConfig as Record<string, boolean | null>,
      presetId,
    );
    setState((prev) => ({ ...prev, lintConfig: nextConfig }));
    await engineRef.current?.setLintConfig(
      Object.keys(nextConfig).length === 0 ? defaultRuleConfig : nextConfig,
    );
    const updated = await engineRef.current?.getFullConfigAndDescriptions();
    if (updated) {
      setRuleConfig(updated.config);
    }
    if (aiHealth?.daemonConnected && state.daemonConnection.token.trim()) {
      await applyDaemonRulePreset(state.daemonConnection, presetId).catch(() => undefined);
    }
    await controllerRef.current?.refresh(true);
  }

  function handleAllowSlopTerm(term: string) {
    const clean = term.trim();
    if (!clean) return;
    setState((prev) => {
      if (prev.disabledSlopTerms.some((t) => t.toLowerCase() === clean.toLowerCase())) {
        return prev;
      }
      return {
        ...prev,
        disabledSlopTerms: [...prev.disabledSlopTerms, clean],
      };
    });
    setTier0Notice(`Allowed "${clean}" in your local anti-slop list.`);
    requestAnimationFrame(() => void controllerRef.current?.refresh(true));
  }

  function handleFixSafeIssues() {
    if (!state.draftText.trim()) return;
    const res = applySafeDeterministicFixes(state.draftText, profile, {
      customSlopTerms: state.customSlopTerms,
      disabledSlopTerms: state.disabledSlopTerms,
      customSurfaces: state.customSurfaces,
    });
    if (res.fixesApplied === 0) {
      setTier0Notice('No deterministic slop, em dash, emoji, or hashtag fixes needed.');
      return;
    }
    setUndoDraftText(state.draftText);
    setState((prev) => ({ ...prev, draftText: res.text }));
    setTier0Notice(`Applied ${res.fixesApplied} deterministic fix${res.fixesApplied === 1 ? '' : 'es'} offline.`);
    requestAnimationFrame(() => void controllerRef.current?.refresh(true));
  }

  async function handleFixAllSafe() {
    if (!state.draftText.trim()) return;
    const slopRes = applySafeDeterministicFixes(state.draftText, profile, {
      customSlopTerms: state.customSlopTerms,
      disabledSlopTerms: state.disabledSlopTerms,
      customSurfaces: state.customSurfaces,
    });
    const normRes = normalizeTypography(slopRes.text);
    const harperRes = engineRef.current
      ? await engineRef.current.applySafeHarperFixes(
          normRes.text,
          state.languageMode,
          state.isolateEnglish,
        )
      : { text: normRes.text, applied: 0 };
    const total = slopRes.fixesApplied + normRes.fixesApplied + harperRes.applied;
    if (total === 0 && harperRes.text === state.draftText) {
      setTier0Notice('No deterministic slop, formatting, or safe grammar fixes needed.');
      return;
    }
    setUndoDraftText(state.draftText);
    setState((prev) => ({ ...prev, draftText: harperRes.text }));
    setTier0Notice(
      `Applied ${total} deterministic fix${total === 1 ? '' : 'es'} (${slopRes.fixesApplied} style, ${normRes.fixesApplied} format, ${harperRes.applied} grammar).`,
    );
    requestAnimationFrame(() => void controllerRef.current?.refresh(true));
  }

  async function handleTitleCase() {
    if (!state.draftText.trim() || !engineRef.current) return;
    const next = await engineRef.current.toTitleCase(state.draftText);
    if (next !== state.draftText) {
      setUndoDraftText(state.draftText);
      setState((prev) => ({ ...prev, draftText: next }));
    }
    setTier0Notice('Converted draft to Chicago title case.');
    requestAnimationFrame(() => void controllerRef.current?.refresh(true));
  }

  function handleSentenceCase() {
    if (!state.draftText.trim()) return;
    const next = toSentenceCase(state.draftText);
    if (next !== state.draftText) {
      setUndoDraftText(state.draftText);
      setState((prev) => ({ ...prev, draftText: next }));
    }
    setTier0Notice('Converted draft to sentence case.');
    requestAnimationFrame(() => void controllerRef.current?.refresh(true));
  }

  function handleNormalizeFormatting() {
    if (!state.draftText.trim()) return;
    const res = normalizeTypography(state.draftText);
    if (res.fixesApplied === 0 && res.text === state.draftText) {
      setTier0Notice('Quotes, ellipses, and spacing are already normalized.');
      return;
    }
    setUndoDraftText(state.draftText);
    setState((prev) => ({ ...prev, draftText: res.text }));
    setTier0Notice('Normalized quotes, ellipses, and whitespace outside code blocks.');
    requestAnimationFrame(() => void controllerRef.current?.refresh(true));
  }

  function handleUndoDraftTransform() {
    if (undoDraftText == null) return;
    setState((prev) => ({ ...prev, draftText: undoDraftText }));
    setUndoDraftText(null);
    setTier0Notice('Restored previous draft before deterministic transform.');
    requestAnimationFrame(() => void controllerRef.current?.refresh(true));
  }

  async function handleLookupSynonyms(e: React.FormEvent) {
    e.preventDefault();
    const q = synonymQuery.trim();
    if (!q) return;
    if (!aiHealth?.daemonConnected || !state.daemonConnection.token.trim()) {
      setSynonymList([]);
      setSynonymMsg('Start & connect lexel-daemon in Settings to search offline harper-thesaurus.');
      return;
    }
    setSynonymMsg('Looking up...');
    try {
      const res = await fetchDaemonSynonyms(state.daemonConnection, q);
      setSynonymList(res.synonyms);
      setSynonymMsg(res.synonyms.length === 0 ? `No synonyms found for "${q}".` : null);
    } catch (err) {
      setSynonymList([]);
      setSynonymMsg(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleImportWeirpack(
    name: string,
    bytes: Uint8Array,
    ruleCount: number,
  ): Promise<WeirpackTestFailures | undefined> {
    if (!engineRef.current) {
      throw new Error('Harper WASM engine not ready yet.');
    }
    const failures = await engineRef.current.loadWeirpackBytes(bytes);
    if (failures && Object.keys(failures).length > 0) {
      return failures;
    }
    const bytesBase64 = uint8ArrayToBase64(bytes);
    setState((prev) => ({
      ...prev,
      weirpacks: [
        ...prev.weirpacks.filter((p) => p.name !== name),
        { name, bytesBase64, ruleCount, enabled: true },
      ],
    }));
    await controllerRef.current?.refresh(true);
    return undefined;
  }

  function handleToggleWeirpack(name: string, enabled: boolean) {
    setState((prev) => ({
      ...prev,
      weirpacks: prev.weirpacks.map((p) => (p.name === name ? { ...p, enabled } : p)),
    }));
  }

  function handleRemoveWeirpack(name: string) {
    setState((prev) => ({
      ...prev,
      weirpacks: prev.weirpacks.filter((p) => p.name !== name),
    }));
  }

  async function handleExportStats() {
    if (!engineRef.current) return;
    const content = await engineRef.current.exportStatsFile();
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lexel-writing-stats.log';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleClearIgnoredLints() {
    const exported = (await engineRef.current?.clearIgnoredLints()) ?? '';
    setState((prev) => ({ ...prev, ignoredLints: exported }));
  }

  function handleAddWord(word: string) {
    const cleaned = word.trim();
    if (!cleaned) return;
    setState((prev) => ({
      ...prev,
      userDictionary: [...new Set([...prev.userDictionary, cleaned])],
    }));
  }

  function handleExportJson() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lexel-lab-backup.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleImportJson(jsonText: string) {
    const imported = parseImportedLabState(jsonText);
    setState(imported);
    void refreshAiHealth(imported.aiSettings);
  }

  const aiState: AiHealthState = !state.aiSettings.enabled
    ? 'offline'
    : aiHealth?.ok && aiHealth.modelAvailable !== false
      ? 'ready'
      : aiHealth
        ? 'error'
        : 'loading';

  const aiLabel = !state.aiSettings.enabled
    ? 'AI Off'
    : aiHealth?.ok && aiHealth.modelAvailable !== false
      ? `${state.aiSettings.model}`
      : aiHealth?.ok
        ? 'Model Missing'
        : 'AI Offline';

  const navItems: Array<{ id: WorkspaceId; label: string; meta?: string }> = [
    { id: 'studio', label: 'Write & Check', meta: totalDiagnostics > 0 ? String(totalDiagnostics) : undefined },
    { id: 'rules', label: 'Rules & Lexicon', meta: String(Object.keys(defaultRuleConfig).length || '') || undefined },
    { id: 'settings', label: 'System & AI' },
  ];

  return (
    <div data-theme={state.theme} className="lexel-root h-screen flex flex-col overflow-hidden">
      <header
        className="h-[52px] shrink-0 border-b px-4 flex items-center justify-between gap-3"
        style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2">
            <PenTool className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
            <h1 className="text-sm font-semibold tracking-tight m-0">Lexel Lab</h1>
          </div>
          <span
            className="hidden sm:inline-flex items-center rounded-[4px] border px-1.5 py-0.5 text-[11px] lexel-mono"
            style={{
              backgroundColor: 'var(--lx-bg)',
              borderColor: 'var(--lx-border)',
              color: wasmStatus === 'ready' ? 'var(--lx-signal)' : 'var(--lx-fg-muted)',
            }}
          >
            {wasmStatus === 'ready'
              ? `Tier 0 ${lintSummary.latencyMs}ms`
              : wasmStatus === 'error'
                ? 'WASM Error'
                : 'Loading WASM'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <StatusPill state={aiState} label={aiLabel} />

          {installPrompt ? (
            <button
              type="button"
              onClick={async () => {
                await installPrompt.prompt();
                await installPrompt.userChoice;
                setInstallPrompt(null);
              }}
              className="inline-flex items-center gap-1.5 rounded-[6px] border px-2.5 py-1 text-xs font-medium"
              style={{
                backgroundColor: 'var(--lx-bg)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              <MonitorDown className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
              <span>Install</span>
            </button>
          ) : null}

          <a
            href="./downloads/lexel-lab-standalone.zip"
            download="lexel-lab-standalone.zip"
            className="inline-flex items-center gap-1.5 rounded-[6px] border px-2.5 py-1 text-xs font-medium no-underline"
            style={{
              backgroundColor: 'var(--lx-bg)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
            title="Download offline Lexel Lab bundle"
          >
            <Download className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
            <span>Download (.zip)</span>
          </a>

          <button
            type="button"
            onClick={() =>
              setState((prev) => ({
                ...prev,
                theme: prev.theme === 'dark' ? 'light' : 'dark',
              }))
            }
            aria-label={state.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title={state.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] border transition-colors"
            style={{
              backgroundColor: 'var(--lx-muted)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          >
            {state.theme === 'dark' ? (
              <Sun className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Moon className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex flex-col md:flex-row">
        <nav
          aria-label="Workspace sections"
          className="md:w-[208px] shrink-0 border-b md:border-b-0 md:border-r p-2.5 flex md:flex-col justify-between gap-2 overflow-x-auto"
          style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
        >
          <div className="flex md:flex-col gap-1">
            {navItems.map((item) => {
              const active = workspace === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setWorkspace(item.id)}
                  className="flex items-center justify-between gap-2 rounded-[6px] px-3 py-2 text-xs font-medium whitespace-nowrap text-left transition-colors"
                  style={{
                    backgroundColor: active ? 'var(--lx-accent)' : 'transparent',
                    color: active ? 'var(--lx-on-accent)' : 'var(--lx-fg-muted)',
                  }}
                >
                  <span className="inline-flex items-center gap-2">
                    {item.id === 'studio' ? (
                      <FilePenLine className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
                    ) : item.id === 'rules' ? (
                      <BookOpenCheck className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
                    ) : (
                      <SlidersHorizontal className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
                    )}
                    <span>{item.label}</span>
                  </span>
                  {item.meta ? (
                    <span
                      className="rounded-[4px] px-1.5 py-0.5 text-[10px] lexel-mono"
                      style={{
                        backgroundColor: active ? 'rgba(128,128,128,0.22)' : 'var(--lx-muted)',
                        color: active ? 'var(--lx-on-accent)' : 'var(--lx-fg)',
                      }}
                    >
                      {item.meta}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>

          <div
            className="hidden md:flex flex-col gap-1 border-t pt-3 px-2 text-[11px] lexel-mono"
            style={{ borderColor: 'var(--lx-border)', color: 'var(--lx-fg-muted)' }}
          >
            <div>{DIALECT_NAMES[state.dialect] ?? 'US English'}</div>
            <div>Surface: {profile.label}</div>
            <div>Voice Memory: {state.voiceExamples.length}</div>
          </div>
        </nav>

        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          {wasmError ? (
            <div
              className="m-4 mb-0 rounded-[6px] border px-3 py-2 text-xs"
              style={{
                backgroundColor: 'var(--lx-danger-bg)',
                borderColor: 'var(--lx-danger)',
                color: 'var(--lx-danger)',
              }}
            >
              WASM Engine Error: {wasmError}
            </div>
          ) : null}

          {workspace === 'rules' ? (
            <RulesWorkspace
              ruleConfig={ruleConfig}
              defaultRuleConfig={defaultRuleConfig}
              structuredConfig={structuredConfig}
              ruleDescriptions={ruleDescriptions}
              customSlopTerms={state.customSlopTerms}
              disabledSlopTerms={state.disabledSlopTerms}
              customSurfaces={state.customSurfaces}
              weirpacks={state.weirpacks}
              onRuleChange={handleRuleChange}
              onOneOfManyChange={handleOneOfManyChange}
              onResetAllRules={handleResetAllRules}
              onApplyRulePreset={handleApplyRulePreset}
              onUpdateCustomSlop={(customTerms, disabledTerms) =>
                setState((prev) => ({
                  ...prev,
                  customSlopTerms: customTerms,
                  disabledSlopTerms: disabledTerms,
                }))
              }
              onUpdateCustomSurfaces={(surfaces) =>
                setState((prev) => ({ ...prev, customSurfaces: surfaces }))
              }
              onImportWeirpack={handleImportWeirpack}
              onToggleWeirpack={handleToggleWeirpack}
              onRemoveWeirpack={handleRemoveWeirpack}
            />
          ) : workspace === 'settings' ? (
            <SettingsView
              state={state}
              aiHealth={aiHealth}
              onUpdateState={setState}
              onTestAi={refreshAiHealth}
              onToggleAi={handleToggleAi}
              onSelectMainModel={handleSelectMainModel}
              onUnloadModel={handleUnloadModel}
              onSyncDaemon={handleSyncDaemon}
              onCreateProfile={handleCreateProfile}
              onSwitchProfile={handleSwitchProfile}
              onDeleteProfile={handleDeleteProfile}
              onDeleteVoiceExample={handleDeleteVoiceExample}
              onClearIgnoredLints={handleClearIgnoredLints}
              onExportJson={handleExportJson}
              onImportJson={handleImportJson}
              onPurgeAll={() => {
                if (aiHealth?.daemonConnected && state.daemonConnection.token.trim()) {
                  void purgeDaemonAll(state.daemonConnection).catch(() => undefined);
                }
                const clean = clearLabState();
                setState(clean);
                setRewriteResult(null);
              }}
            />
          ) : (
            <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12">
              <section
                className="lg:col-span-7 xl:col-span-8 flex flex-col min-h-0 border-b lg:border-b-0 lg:border-r"
                style={{ backgroundColor: 'var(--lx-bg)', borderColor: 'var(--lx-border)' }}
              >
                <div
                  className="px-5 py-2.5 border-b flex flex-wrap items-center justify-between gap-2"
                  style={{ borderColor: 'var(--lx-border)' }}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label="Sample preset"
                      value=""
                      onChange={(e) => {
                        const preset = LAB_PRESETS.find((p) => p.id === e.target.value);
                        if (!preset) return;
                        setRewriteResult(null);
                        setAiError(null);
                        setState((prev) => ({
                          ...prev,
                          surfaceId: preset.surfaceId,
                          subcontext: preset.subcontext,
                          draftText: preset.text,
                          threadContext: preset.threadContext ?? '',
                        }));
                        requestAnimationFrame(() => void controllerRef.current?.refresh(true));
                      }}
                      className="rounded-[6px] border px-2 py-1 text-xs"
                      style={{
                        backgroundColor: 'var(--lx-surface)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    >
                      <option value="" disabled>
                        Load sample...
                      </option>
                      {LAB_PRESETS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>

                    <select
                      aria-label="Target surface"
                      value={state.surfaceId}
                      onChange={(e) =>
                        setState((prev) => ({ ...prev, surfaceId: e.target.value as SurfaceId }))
                      }
                      className="rounded-[6px] border px-2 py-1 text-xs font-medium"
                      style={{
                        backgroundColor: 'var(--lx-surface)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    >
                      {allSurfaces.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>

                    <input
                      type="text"
                      aria-label="Surface subcontext"
                      value={state.subcontext}
                      onChange={(e) => setState((prev) => ({ ...prev, subcontext: e.target.value }))}
                      placeholder="Subcontext (e.g. r/rust)"
                      className="w-36 rounded-[6px] border px-2 py-1 text-xs lexel-mono"
                      style={{
                        backgroundColor: 'var(--lx-surface)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    />

                    <SurfaceBadge
                      label={profile.label}
                      subcontext={state.subcontext.trim() || null}
                      charCount={textStats.chars}
                      maxChars={profile.maxChars}
                    />
                  </div>

                  <label className="inline-flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={state.openSuggestionsOnHover}
                      onChange={(e) =>
                        setState((prev) => ({
                          ...prev,
                          openSuggestionsOnHover: e.target.checked,
                        }))
                      }
                    />
                    <span style={{ color: 'var(--lx-fg-muted)' }}>Hover fixes</span>
                  </label>
                </div>

                {lintSummary.secretCount > 0 ? (
                  <div
                    role="alert"
                    className="mx-5 mt-3 rounded-[6px] border px-3 py-2 flex items-center gap-2 text-xs font-medium"
                    style={{
                      backgroundColor: 'var(--lx-danger-bg)',
                      borderColor: 'var(--lx-danger)',
                      color: 'var(--lx-danger)',
                    }}
                  >
                    <ShieldAlert className="w-4 h-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                    <span>
                      Secrets Guard flagged {lintSummary.secretCount} sensitive token or PII item
                      {lintSummary.secretCount === 1 ? '' : 's'} in this draft. AI rewrite is paused until removed.
                    </span>
                  </div>
                ) : null}

                {tier0Notice ? (
                  <div
                    className="mx-5 mt-2 rounded-[6px] border px-3 py-1.5 flex items-center justify-between gap-2 text-[11px]"
                    style={{
                      backgroundColor: 'var(--lx-signal-bg)',
                      borderColor: 'var(--lx-signal)',
                      color: 'var(--lx-signal)',
                    }}
                  >
                    <span>{tier0Notice}</span>
                    <button type="button" onClick={() => setTier0Notice(null)} className="underline">
                      Dismiss
                    </button>
                  </div>
                ) : null}

                <div className="flex-1 min-h-[260px] p-5 md:p-7 flex flex-col">
                  <textarea
                    ref={textareaRef}
                    value={state.draftText}
                    onChange={(e) => setState((prev) => ({ ...prev, draftText: e.target.value }))}
                    data-lexel-ignore="true"
                    data-enable-grammarly="false"
                    spellCheck={false}
                    placeholder="Write or paste a draft here. Hover or click any underlined word to fix it..."
                    aria-label="Lexel Lab draft editor"
                    className="w-full flex-1 bg-transparent border-0 text-[15px] leading-[1.7] resize-none focus:outline-none"
                    style={{ color: 'var(--lx-fg)' }}
                  />
                </div>

                <div
                  className="px-5 py-2 border-t flex flex-wrap items-center justify-between gap-2 text-[11px]"
                  style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-surface)' }}
                >
                  <div className="flex flex-wrap items-center gap-3 lexel-mono" style={{ color: 'var(--lx-fg-muted)' }}>
                    <span>{textStats.words} words</span>
                    <span>{textStats.readingTimeSec}s read</span>
                    <span>Slop {textStats.slopDensity}/100w</span>
                    <span>Grammar {lintSummary.grammarCount}</span>
                    <span>Platform {lintSummary.surfaceCount}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={handleFixSafeIssues}
                      className="inline-flex items-center gap-1 rounded-[6px] border px-2.5 py-1 text-[11px] font-medium"
                      style={{
                        backgroundColor: 'var(--lx-bg)',
                        borderColor: 'var(--lx-signal)',
                        color: 'var(--lx-signal)',
                      }}
                    >
                      <WandSparkles className="w-3 h-3" strokeWidth={1.75} aria-hidden="true" />
                      <span>Fix Safe Issues</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleFixAllSafe()}
                      className="inline-flex items-center gap-1 rounded-[6px] border px-2.5 py-1 text-[11px] font-semibold"
                      style={{
                        backgroundColor: 'var(--lx-bg)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                      title="Apply safe slop, formatting, and single-suggestion Harper fixes"
                    >
                      <span>Fix All Safe</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleTitleCase()}
                      className="inline-flex items-center gap-1 rounded-[6px] border px-2.5 py-1 text-[11px] font-medium"
                      style={{
                        backgroundColor: 'var(--lx-bg)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    >
                      <CaseSensitive className="w-3 h-3" strokeWidth={1.75} aria-hidden="true" />
                      <span>Title Case</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleSentenceCase}
                      className="inline-flex items-center gap-1 rounded-[6px] border px-2.5 py-1 text-[11px] font-medium"
                      style={{
                        backgroundColor: 'var(--lx-bg)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    >
                      <span>Sentence Case</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleNormalizeFormatting}
                      className="inline-flex items-center gap-1 rounded-[6px] border px-2.5 py-1 text-[11px] font-medium"
                      style={{
                        backgroundColor: 'var(--lx-bg)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    >
                      <span>Clean Quotes</span>
                    </button>
                    {undoDraftText != null ? (
                      <button
                        type="button"
                        onClick={handleUndoDraftTransform}
                        className="inline-flex items-center gap-1 rounded-[6px] border px-2.5 py-1 text-[11px] font-medium"
                        style={{
                          backgroundColor: 'var(--lx-warn-bg)',
                          borderColor: 'var(--lx-warn)',
                          color: 'var(--lx-warn)',
                        }}
                      >
                        <span>Undo</span>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(state.draftText);
                        setCopiedDraft(true);
                        window.setTimeout(() => setCopiedDraft(false), 1500);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-[6px] border px-2.5 py-1 text-[11px] font-medium"
                      style={{
                        backgroundColor: 'var(--lx-bg)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    >
                      {copiedDraft ? (
                        <Check className="w-3 h-3" strokeWidth={2} aria-hidden="true" />
                      ) : (
                        <Copy className="w-3 h-3" strokeWidth={1.75} aria-hidden="true" />
                      )}
                      <span>{copiedDraft ? 'Copied' : 'Copy'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setState((prev) => ({ ...prev, draftText: '' }));
                        setRewriteResult(null);
                      }}
                      className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1 text-[11px]"
                      style={{ color: 'var(--lx-fg-muted)' }}
                    >
                      <Eraser className="w-3 h-3" strokeWidth={1.75} aria-hidden="true" />
                      <span>Clear</span>
                    </button>
                  </div>
                </div>
              </section>

              <aside
                className="lg:col-span-5 xl:col-span-4 flex flex-col min-h-0"
                style={{ backgroundColor: 'var(--lx-surface)' }}
              >
                <div
                  className="px-4 pt-3 border-b flex items-center gap-4"
                  role="tablist"
                  aria-label="Inspector views"
                  style={{ borderColor: 'var(--lx-border)' }}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={inspectorTab === 'diagnostics'}
                    onClick={() => setInspectorTab('diagnostics')}
                    className="pb-2.5 text-xs font-semibold border-b-2 transition-colors"
                    style={{
                      borderColor:
                        inspectorTab === 'diagnostics' ? 'var(--lx-signal)' : 'transparent',
                      color:
                        inspectorTab === 'diagnostics' ? 'var(--lx-fg)' : 'var(--lx-fg-muted)',
                    }}
                  >
                    Diagnostics ({totalDiagnostics})
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={inspectorTab === 'stats'}
                    onClick={() => setInspectorTab('stats')}
                    className="pb-2.5 text-xs font-semibold border-b-2 transition-colors"
                    style={{
                      borderColor: inspectorTab === 'stats' ? 'var(--lx-signal)' : 'transparent',
                      color: inspectorTab === 'stats' ? 'var(--lx-fg)' : 'var(--lx-fg-muted)',
                    }}
                  >
                    Stats
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={inspectorTab === 'ai'}
                    onClick={() => setInspectorTab('ai')}
                    className="pb-2.5 text-xs font-semibold border-b-2 transition-colors"
                    style={{
                      borderColor: inspectorTab === 'ai' ? 'var(--lx-signal)' : 'transparent',
                      color: inspectorTab === 'ai' ? 'var(--lx-fg)' : 'var(--lx-fg-muted)',
                    }}
                  >
                    Local AI
                  </button>
                </div>

                {inspectorTab === 'stats' ? (
                  <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 text-xs">
                    <div
                      className="rounded-[8px] border p-3.5 grid grid-cols-2 gap-3"
                      style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-card)' }}
                    >
                      <div>
                        <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                          Reading Time
                        </div>
                        <div className="text-base font-semibold lexel-mono">{textStats.readingTimeSec}s</div>
                      </div>
                      <div>
                        <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                          Slop Density
                        </div>
                        <div className="text-base font-semibold lexel-mono">{textStats.slopDensity} / 100w</div>
                      </div>
                      <div>
                        <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                          Words / Sentences
                        </div>
                        <div className="text-sm font-semibold lexel-mono">
                          {textStats.words} / {textStats.sentences}
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                          Secrets Detected
                        </div>
                        <div className="text-sm font-semibold lexel-mono">{textStats.secretCount}</div>
                      </div>
                      <div>
                        <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                          FK Grade Level
                        </div>
                        <div className="text-sm font-semibold lexel-mono">
                          {textStats.fleschKincaidGrade.toFixed(1)}
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                          Reading Ease
                        </div>
                        <div className="text-sm font-semibold lexel-mono">
                          {textStats.fleschReadingEase.toFixed(0)} / 100
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                          Long Sentences
                        </div>
                        <div
                          className="text-sm font-semibold lexel-mono"
                          style={{
                            color: textStats.longSentences > 0 ? 'var(--lx-warn)' : 'var(--lx-fg)',
                          }}
                        >
                          {textStats.longSentences}
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                          Passive Hints
                        </div>
                        <div className="text-sm font-semibold lexel-mono">
                          {textStats.passiveHintCount}
                        </div>
                      </div>
                    </div>

                    <div
                      className="rounded-[8px] border p-3.5 flex flex-col gap-2"
                      style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-card)' }}
                    >
                      <div className="text-xs font-semibold">Offline Thesaurus (harper-thesaurus)</div>
                      <form onSubmit={(e) => void handleLookupSynonyms(e)} className="flex gap-1.5">
                        <input
                          type="text"
                          value={synonymQuery}
                          onChange={(e) => setSynonymQuery(e.target.value)}
                          placeholder="Look up plain alternatives..."
                          aria-label="Look up word synonyms"
                          className="flex-1 rounded-[6px] border px-2.5 py-1 text-xs"
                          style={{
                            backgroundColor: 'var(--lx-bg)',
                            borderColor: 'var(--lx-border)',
                            color: 'var(--lx-fg)',
                          }}
                        />
                        <button
                          type="submit"
                          className="rounded-[6px] border px-2.5 py-1 text-xs font-medium"
                          style={{
                            backgroundColor: 'var(--lx-surface)',
                            borderColor: 'var(--lx-border)',
                            color: 'var(--lx-fg)',
                          }}
                        >
                          Search
                        </button>
                      </form>
                      {synonymMsg ? (
                        <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                          {synonymMsg}
                        </div>
                      ) : null}
                      {synonymList.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {synonymList.map((syn) => (
                            <button
                              key={syn}
                              type="button"
                              onClick={() => void navigator.clipboard.writeText(syn)}
                              className="rounded-[4px] border px-2 py-0.5 text-[11px] lexel-mono"
                              style={{
                                backgroundColor: 'var(--lx-bg)',
                                borderColor: 'var(--lx-border)',
                                color: 'var(--lx-signal)',
                              }}
                              title="Copy synonym to clipboard"
                            >
                              {syn}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>

                    <div
                      className="rounded-[8px] border p-3.5 flex flex-col gap-2"
                      style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-card)' }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold">Harper Session Telemetry (Local)</span>
                        <button
                          type="button"
                          onClick={() => void handleExportStats()}
                          className="rounded-[6px] border px-2 py-1 text-[11px]"
                          style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-surface)' }}
                        >
                          Export Log
                        </button>
                      </div>
                      {harperStats ? (
                        <div className="space-y-1.5 lexel-mono text-[11px]">
                          <div>Total fixes recorded: {harperStats.total_applied}</div>
                          {Object.keys(harperStats.lint_counts).length > 0 ? (
                            <div className="pt-1 border-t space-y-1" style={{ borderColor: 'var(--lx-border)' }}>
                              {Object.entries(harperStats.lint_counts)
                                .slice(0, 8)
                                .map(([kind, count]) => (
                                  <div key={kind} className="flex justify-between">
                                    <span>{kind}</span>
                                    <span>{count}</span>
                                  </div>
                                ))}
                            </div>
                          ) : (
                            <div style={{ color: 'var(--lx-fg-muted)' }}>No Harper fixes recorded yet.</div>
                          )}
                        </div>
                      ) : (
                        <div style={{ color: 'var(--lx-fg-muted)' }}>Run checks to collect local stats.</div>
                      )}
                    </div>
                  </div>
                ) : inspectorTab === 'diagnostics' ? (
                  <div className="flex-1 overflow-y-auto divide-y" style={{ borderColor: 'var(--lx-border)' }}>
                    {flattenedLints.length === 0 ? (
                      <div className="p-6 text-xs space-y-2" style={{ color: 'var(--lx-fg-muted)' }}>
                        <div className="flex items-center gap-1.5 font-semibold" style={{ color: 'var(--lx-fg)' }}>
                          {state.draftText.trim() ? (
                            <CheckCircle2
                              className="w-3.5 h-3.5"
                              strokeWidth={1.75}
                              style={{ color: 'var(--lx-signal)' }}
                              aria-hidden="true"
                            />
                          ) : null}
                          <span>{state.draftText.trim() ? 'Clean draft' : 'Waiting for text'}</span>
                        </div>
                        <p className="m-0 leading-relaxed">
                          {state.draftText.trim()
                            ? `No grammar, anti-slop, or ${profile.label} warnings found.`
                            : 'Type in the editor or load a sample preset to test Tier 0 grammar and anti-slop checks.'}
                        </p>
                      </div>
                    ) : (
                      flattenedLints.map(({ rule, lint }, idx) => {
                        const sigColor = lintSignalColor(rule, lint.lint_kind);
                        return (
                          <div
                            key={`${lint.context_hash}-${lint.span.start}-${idx}`}
                            className="p-3.5 flex flex-col gap-2"
                            style={{ borderColor: 'var(--lx-border)' }}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <span
                                  className="inline-block w-1.5 h-3.5 rounded-[2px] shrink-0"
                                  style={{ backgroundColor: sigColor }}
                                  aria-hidden="true"
                                />
                                <span className="text-[11px] font-semibold lexel-mono truncate">
                                  {lint.problem_text}
                                </span>
                                <span
                                  className="text-[10px] lexel-mono shrink-0"
                                  style={{ color: 'var(--lx-fg-muted)' }}
                                >
                                  {lint.lint_kind_pretty}
                                </span>
                              </div>
                              <span
                                className="text-[10px] lexel-mono shrink-0"
                                style={{ color: 'var(--lx-fg-muted)' }}
                              >
                                {rule}
                              </span>
                            </div>

                            <div className="flex flex-wrap items-center gap-1.5">
                              {lint.suggestions.slice(0, 3).map((sug, sIdx) => (
                                <button
                                  key={sIdx}
                                  type="button"
                                  onClick={() => {
                                    const text = state.draftText;
                                    const replacement =
                                      sug.kind === 1
                                        ? ''
                                        : sug.kind === 2
                                          ? text.slice(lint.span.start, lint.span.end) +
                                            sug.replacement_text
                                          : sug.replacement_text;
                                    const next =
                                      text.slice(0, lint.span.start) +
                                      replacement +
                                      text.slice(lint.span.end);
                                    setState((prev) => ({ ...prev, draftText: next }));
                                    requestAnimationFrame(
                                      () => void controllerRef.current?.refresh(true),
                                    );
                                  }}
                                  className="rounded-[6px] border px-2 py-0.5 text-[11px] font-medium"
                                  style={{
                                    backgroundColor: 'var(--lx-bg)',
                                    borderColor: 'var(--lx-signal)',
                                    color: 'var(--lx-signal)',
                                  }}
                                >
                                  {sug.kind === 1 ? 'Remove' : sug.replacement_text || 'Fix'}
                                </button>
                              ))}
                              {lint.suggestions.length === 0 && state.aiSettings.enabled ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void runAiTask(
                                      rule === 'LexelAntiSlop' ? 'deslop' : 'fix_grammar_flow',
                                    )
                                  }
                                  className="inline-flex items-center gap-1 rounded-[6px] px-2.5 py-0.5 text-[11px] font-semibold"
                                  style={{
                                    backgroundColor: 'var(--lx-accent)',
                                    color: 'var(--lx-on-accent)',
                                  }}
                                >
                                  <PenLine className="w-3 h-3" strokeWidth={1.75} aria-hidden="true" />
                                  <span>Rewrite with AI</span>
                                </button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                ) : (
                  <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
                    <EditableSurfaceCard
                      profile={profile}
                      isCustomOnly={!BUILTIN_SURFACES.some((b) => b.id === profile.id)}
                      onSaveOverride={(baseSurface, patch) => {
                        const next = upsertSurfaceOverride(state.customSurfaces, baseSurface, patch);
                        setState((prev) => ({ ...prev, customSurfaces: next }));
                        setTier0Notice(`Updated prompt & rules for ${baseSurface.label}.`);
                        requestAnimationFrame(() => void controllerRef.current?.refresh(true));
                      }}
                      onResetOrDelete={(prof) => {
                        const next = resetSurfaceOverride(state.customSurfaces, prof.id);
                        setState((prev) => ({ ...prev, customSurfaces: next }));
                        setTier0Notice(`Reset "${prof.label}" back to default prompt & rules.`);
                        requestAnimationFrame(() => void controllerRef.current?.refresh(true));
                      }}
                    />

                    {!state.aiSettings.enabled ? (
                      <div
                        className="rounded-[6px] border p-3 flex items-center justify-between gap-2 text-xs"
                        style={{
                          backgroundColor: 'var(--lx-bg)',
                          borderColor: 'var(--lx-border)',
                          color: 'var(--lx-fg-muted)',
                        }}
                      >
                        <span>Local AI is turned off.</span>
                        <button
                          type="button"
                          onClick={() => void handleToggleAi(true)}
                          className="rounded-[6px] px-2.5 py-1 text-xs font-semibold shrink-0"
                          style={{
                            backgroundColor: 'var(--lx-accent)',
                            color: 'var(--lx-on-accent)',
                          }}
                        >
                          Turn AI On
                        </button>
                      </div>
                    ) : aiHealth && (!aiHealth.ok || aiHealth.modelAvailable === false) ? (
                      <div
                        className="rounded-[6px] border p-3 flex flex-col gap-2 text-xs"
                        style={{
                          backgroundColor: 'var(--lx-warn-bg)',
                          borderColor: 'var(--lx-warn)',
                          color: 'var(--lx-warn)',
                        }}
                      >
                        <div className="leading-snug break-words">{aiHealth.error}</div>
                        {aiHealth.models.length > 0 ? (
                          <select
                            aria-label="Switch available model"
                            value={state.aiSettings.model}
                            onChange={(e) => void handleSelectMainModel(e.target.value)}
                            className="rounded-[6px] border px-2 py-1 text-xs lexel-mono"
                            style={{
                              backgroundColor: 'var(--lx-bg)',
                              borderColor: 'var(--lx-border)',
                              color: 'var(--lx-fg)',
                            }}
                          >
                            <option value={state.aiSettings.model}>
                              {state.aiSettings.model} (missing)
                            </option>
                            {aiHealth.models.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                        ) : null}
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => void refreshAiHealth(state.aiSettings)}
                            className="inline-flex items-center gap-1.5 rounded-[6px] border px-2.5 py-1 text-[11px] font-medium"
                            style={{
                              backgroundColor: 'var(--lx-bg)',
                              borderColor: 'var(--lx-border)',
                              color: 'var(--lx-fg)',
                            }}
                          >
                            <RefreshCw className="w-3 h-3" strokeWidth={1.75} aria-hidden="true" />
                            <span>Retry connection</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setWorkspace('settings')}
                            className="inline-flex items-center gap-1.5 rounded-[6px] border px-2.5 py-1 text-[11px]"
                            style={{
                              backgroundColor: 'var(--lx-bg)',
                              borderColor: 'var(--lx-border)',
                              color: 'var(--lx-fg-muted)',
                            }}
                          >
                            <SlidersHorizontal className="w-3 h-3" strokeWidth={1.75} aria-hidden="true" />
                            <span>AI Settings</span>
                          </button>
                        </div>
                      </div>
                    ) : null}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <label className="flex flex-col gap-1 text-xs">
                        <span className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                          Rewrite Action
                        </span>
                        <select
                          value={task}
                          onChange={(e) => setTask(e.target.value as AiTaskId)}
                          className="rounded-[6px] border px-2.5 py-1.5 text-xs"
                          style={{
                            backgroundColor: 'var(--lx-bg)',
                            borderColor: 'var(--lx-border)',
                            color: 'var(--lx-fg)',
                          }}
                        >
                          {TASK_OPTIONS.map((opt) => (
                            <option key={opt.id} value={opt.id}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="flex flex-col gap-1 text-xs">
                        <span className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                          Main Model
                        </span>
                        <select
                          value={
                            state.aiSettings.mainModelTier === 'custom'
                              ? state.aiSettings.model
                              : state.aiSettings.mainModelTier
                          }
                          onChange={(e) => void handleSelectMainModel(e.target.value)}
                          className="rounded-[6px] border px-2.5 py-1.5 text-xs"
                          style={{
                            backgroundColor: 'var(--lx-bg)',
                            borderColor: 'var(--lx-border)',
                            color: 'var(--lx-fg)',
                          }}
                        >
                          {MODEL_MANIFEST_SPECS.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label}
                            </option>
                          ))}
                          {state.aiSettings.mainModelTier === 'custom' ? (
                            <option value={state.aiSettings.model}>{state.aiSettings.model}</option>
                          ) : null}
                        </select>
                      </label>
                    </div>

                    {task === 'reply_draft' ? (
                      <label className="flex flex-col gap-1 text-xs">
                        <span className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                          Parent Post or Comment Context
                        </span>
                        <textarea
                          rows={3}
                          value={state.threadContext}
                          onChange={(e) =>
                            setState((prev) => ({ ...prev, threadContext: e.target.value }))
                          }
                          data-lexel-ignore="true"
                          data-enable-grammarly="false"
                          spellCheck={false}
                          placeholder="Paste the post or comment you are replying to..."
                          className="rounded-[6px] border p-2 text-xs resize-y"
                          style={{
                            backgroundColor: 'var(--lx-bg)',
                            borderColor: 'var(--lx-border)',
                            color: 'var(--lx-fg)',
                          }}
                        />
                      </label>
                    ) : null}

                    <button
                      type="button"
                      disabled={aiLoading || !state.aiSettings.enabled}
                      onClick={() => void runAiTask()}
                      className="w-full inline-flex items-center justify-center gap-1.5 rounded-[6px] px-3 py-2 text-xs font-semibold"
                      style={{
                        backgroundColor: 'var(--lx-accent)',
                        color: 'var(--lx-on-accent)',
                      }}
                    >
                      <PenLine className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
                      <span>
                        {aiLoading ? `Running ${state.aiSettings.model}...` : 'Rewrite with Local AI'}
                      </span>
                    </button>

                    {aiError ? (
                      <div
                        className="rounded-[6px] border p-2.5 text-xs break-words"
                        style={{
                          backgroundColor: 'var(--lx-danger-bg)',
                          borderColor: 'var(--lx-danger)',
                          color: 'var(--lx-danger)',
                        }}
                      >
                        {aiError}
                      </div>
                    ) : null}

                    {rewriteResult ? (
                      <RewriteDiffCard
                        original={rewriteResult.original}
                        suggestion={rewriteResult.suggestion}
                        gates={rewriteResult.gates}
                        modelName={rewriteResult.model}
                        latencyMs={rewriteResult.latencyMs}
                        onApply={handleApplyRewrite}
                        onCopy={() => {
                          void navigator.clipboard.writeText(rewriteResult.suggestion);
                          setCopiedRewrite(true);
                        }}
                        onRetry={() => void runAiTask()}
                        onReject={() => setRewriteResult(null)}
                        copied={copiedRewrite}
                      />
                    ) : (
                      <div
                        className="rounded-[6px] border p-3 text-xs leading-relaxed"
                        style={{
                          backgroundColor: 'var(--lx-bg)',
                          borderColor: 'var(--lx-border)',
                          color: 'var(--lx-fg-muted)',
                        }}
                      >
                        Run a rewrite to inspect the diff and Tier 2 checks (Zero-Slop, Numbers, Code Tokens, Surface Rules).
                      </div>
                    )}
                  </div>
                )}
              </aside>
            </div>
          )}
        </div>
      </div>

      <LabSuggestionPopover
        active={activeLint}
        aiEnabled={state.aiSettings.enabled}
        onHoverChange={(hovered) => controllerRef.current?.setPopoverHovered(hovered)}
        onClose={() => controllerRef.current?.closePopup()}
        onAddToDictionary={handleAddWord}
        onDisableRule={(ruleId) => void handleRuleChange(ruleId, false)}
        onAllowSlopTerm={handleAllowSlopTerm}
        onOpenSettings={() => setWorkspace('rules')}
        onFixWithAi={(box: IgnorableLintBox) => {
          void runAiTask(box.rule === 'LexelAntiSlop' ? 'deslop' : 'fix_grammar_flow');
        }}
      />
    </div>
  );
}

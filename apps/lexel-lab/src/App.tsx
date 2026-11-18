import type { Dialect, LintConfig } from 'harper.js';
import {
  NibIcon,
  RewriteDiffCard,
  SlidersIcon,
  StatusPill,
  SurfaceBadge,
  ThemeToggle,
  type AiHealthState,
} from 'lexel-ui';
import type { IgnorableLintBox, UnpackedLint, UnpackedLintGroups } from 'lint-framework';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LabSuggestionPopover } from './components/LabSuggestionPopover';
import { SettingsView } from './components/SettingsView';
import { computeTextStats, LexelLabEngine, type LabLintResult } from './lib/engine';
import { type ActiveLabLint, LabLintController } from './lib/labLintController';
import { checkLocalAiHealth, generateLocalRewrite, type LocalAiHealth } from './lib/localAi';
import { LAB_PRESETS } from './lib/presets';
import { buildRewriteMessages } from './lib/promptBuilder';
import {
  clearLabState,
  createVoiceExampleEntry,
  loadLabState,
  parseImportedLabState,
  saveLabState,
} from './lib/storage';
import { getSurfaceProfile, SURFACE_PROFILES } from './lib/surfaces';
import type { AiSettings, AiTaskId, LabSettingsState, RewriteResult, SurfaceId } from './lib/types';
import { sanitizeModelOutput, verifyAiRewrite } from './lib/verifier';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const TASK_OPTIONS: Array<{ id: AiTaskId; label: string }> = [
  { id: 'rewrite_surface', label: 'Match surface style' },
  { id: 'deslop', label: 'Remove AI slop' },
  { id: 'fix_grammar_flow', label: 'Fix grammar & flow' },
  { id: 'shorten', label: 'Shorten concisely' },
  { id: 'reply_draft', label: 'Draft reply' },
];

export function App() {
  const [state, setState] = useState<LabSettingsState>(() => loadLabState());
  const [view, setView] = useState<'editor' | 'settings'>('editor');
  const [wasmStatus, setWasmStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [wasmError, setWasmError] = useState<string | null>(null);
  const [lintSummary, setLintSummary] = useState<LabLintResult>({
    lints: {},
    grammarCount: 0,
    slopCount: 0,
    surfaceCount: 0,
    latencyMs: 0,
  });
  const [activeLint, setActiveLint] = useState<ActiveLabLint | null>(null);
  const [ruleConfig, setRuleConfig] = useState<LintConfig>({});
  const [defaultRuleConfig, setDefaultRuleConfig] = useState<LintConfig>({});
  const [ruleDescriptions, setRuleDescriptions] = useState<Record<string, string>>({});

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

  useEffect(() => {
    saveLabState(state);
  }, [state]);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const refreshAiHealth = useCallback(async (aiSettings: AiSettings) => {
    const health = await checkLocalAiHealth(aiSettings);
    setAiHealth(health);
  }, []);

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
            isolateEnglish: s.isolateEnglish,
            lintConfig: s.lintConfig,
            userDictionary: s.userDictionary,
            ignoredLints: s.ignoredLints,
          });
          setWasmStatus('ready');
          setWasmError(null);
          setLintSummary(result);
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
      })
      .then(async () => {
        setWasmStatus('ready');
        const meta = await engine.getFullConfigAndDescriptions();
        setRuleConfig(meta.config);
        setDefaultRuleConfig(meta.defaultConfig);
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
    if (view === 'editor' && textareaRef.current && controllerRef.current) {
      controllerRef.current.attach(textareaRef.current);
      void controllerRef.current.refresh(true);
    }
  }, [view]);

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
      })
      .then(async () => {
        const meta = await engine.getFullConfigAndDescriptions();
        setRuleConfig(meta.config);
        setDefaultRuleConfig(meta.defaultConfig);
        await controllerRef.current?.refresh(true);
      })
      .catch(() => undefined);
  }, [state.dialect, state.userDictionary]);

  useEffect(() => {
    if (!state.draftText.trim()) {
      setLintSummary({
        lints: {},
        grammarCount: 0,
        slopCount: 0,
        surfaceCount: 0,
        latencyMs: 0,
      });
    }
    void controllerRef.current?.refresh(true);
  }, [state.surfaceId, state.isolateEnglish, state.lintConfig, state.ignoredLints]);

  const profile = getSurfaceProfile(state.surfaceId);
  const textStats = useMemo(() => computeTextStats(state.draftText), [state.draftText]);

  const flattenedLints = useMemo(() => {
    const items: Array<{ rule: string; lint: UnpackedLint }> = [];
    for (const [rule, list] of Object.entries(lintSummary.lints)) {
      for (const lint of list) {
        items.push({ rule, lint });
      }
    }
    return items.sort((a, b) => a.lint.span.start - b.lint.span.start);
  }, [lintSummary.lints]);

  async function runAiTask(overrideTask?: AiTaskId) {
    const chosenTask = overrideTask ?? task;
    if (!state.draftText.trim()) {
      setAiError('Enter or load sample text before running a rewrite.');
      return;
    }
    if (overrideTask) setTask(overrideTask);
    setAiLoading(true);
    setAiError(null);
    setCopiedRewrite(false);
    const started = performance.now();

    try {
      const messages = buildRewriteMessages({
        text: state.draftText,
        task: chosenTask,
        surfaceId: state.surfaceId,
        subcontext: state.subcontext.trim() || null,
        threadContext: chosenTask === 'reply_draft' ? state.threadContext : undefined,
        voiceExamples: state.voiceExamples,
      });
      const raw = await generateLocalRewrite(state.aiSettings, messages);
      const suggestion = sanitizeModelOutput(raw);
      const gates = verifyAiRewrite(state.draftText, suggestion, state.surfaceId);

      setRewriteResult({
        original: state.draftText,
        suggestion,
        model: state.aiSettings.model,
        latencyMs: Math.round(performance.now() - started),
        gates,
        surfaceId: state.surfaceId,
        subcontext: state.subcontext.trim() || null,
      });
    } catch (err) {
      setAiError((err as Error).message);
      void refreshAiHealth(state.aiSettings);
    } finally {
      setAiLoading(false);
    }
  }

  function handleApplyRewrite() {
    if (!rewriteResult) return;
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

  async function handleRuleChange(ruleId: string, value: boolean | null) {
    const nextConfig: LintConfig = { ...state.lintConfig, [ruleId]: value };
    setState((prev) => ({ ...prev, lintConfig: nextConfig }));
    await engineRef.current?.setLintConfig(nextConfig);
    setRuleConfig((prev) => ({ ...prev, [ruleId]: value }));
    await controllerRef.current?.refresh(true);
  }

  async function handleResetAllRules() {
    setState((prev) => ({ ...prev, lintConfig: {} }));
    await engineRef.current?.setLintConfig(defaultRuleConfig);
    setRuleConfig(defaultRuleConfig);
    await controllerRef.current?.refresh(true);
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
      ? `${state.aiSettings.model} Ready`
      : aiHealth?.ok
        ? 'Model Missing'
        : 'Local AI Offline';

  return (
    <div data-theme={state.theme} className="lexel-root min-h-screen flex flex-col">
      <header
        className="border-b px-4 py-3 flex flex-wrap items-center justify-between gap-3"
        style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
      >
        <div className="flex items-center gap-2.5">
          <NibIcon className="w-5 h-5" />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold m-0">Lexel Lab</h1>
              <span
                className="rounded-[4px] border px-1.5 py-0.5 text-[11px] lexel-mono"
                style={{
                  backgroundColor: 'var(--lx-bg)',
                  borderColor: 'var(--lx-border)',
                  color: wasmStatus === 'ready' ? 'var(--lx-accent)' : 'var(--lx-fg-muted)',
                }}
              >
                {wasmStatus === 'ready'
                  ? `Tier 0: ${lintSummary.latencyMs}ms`
                  : wasmStatus === 'error'
                    ? 'WASM Error'
                    : 'Loading WASM...'}
              </span>
            </div>
            <p className="text-[11px] m-0" style={{ color: 'var(--lx-fg-muted)' }}>
              Standalone local grammar, anti-slop, surface rules, and AI testing studio
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <StatusPill state={aiState} label={aiLabel} />

          {installPrompt ? (
            <button
              type="button"
              onClick={async () => {
                await installPrompt.prompt();
                await installPrompt.userChoice;
                setInstallPrompt(null);
              }}
              className="rounded-[6px] border px-2.5 py-1.5 text-xs font-medium"
              style={{
                backgroundColor: 'var(--lx-muted)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              Install App
            </button>
          ) : null}

          <a
            href="./downloads/lexel-lab-standalone.zip"
            download="lexel-lab-standalone.zip"
            className="rounded-[6px] border px-2.5 py-1.5 text-xs font-medium no-underline"
            style={{
              backgroundColor: 'var(--lx-muted)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
            title="Download offline Lexel Lab bundle with launcher scripts"
          >
            Download App (.zip)
          </a>

          <button
            type="button"
            onClick={() => setView(view === 'editor' ? 'settings' : 'editor')}
            className="inline-flex items-center gap-1.5 rounded-[6px] border px-2.5 py-1.5 text-xs font-medium"
            style={{
              backgroundColor: view === 'settings' ? 'var(--lx-accent)' : 'var(--lx-muted)',
              borderColor: 'var(--lx-border)',
              color: view === 'settings' ? 'var(--lx-on-accent)' : 'var(--lx-fg)',
            }}
          >
            <SlidersIcon className="w-3.5 h-3.5" />
            <span>{view === 'settings' ? 'Back to Lab' : 'All Settings'}</span>
          </button>

          <ThemeToggle
            theme={state.theme}
            onToggle={() =>
              setState((prev) => ({
                ...prev,
                theme: prev.theme === 'dark' ? 'light' : 'dark',
              }))
            }
          />
        </div>
      </header>

      <main className="flex-1 p-4 md:p-6">
        {wasmError ? (
          <div
            className="max-w-6xl mx-auto mb-4 rounded-[8px] border p-3 text-xs"
            style={{
              backgroundColor: 'var(--lx-danger-bg)',
              borderColor: 'var(--lx-danger)',
              color: 'var(--lx-danger)',
            }}
          >
            WASM Engine Error: {wasmError}
          </div>
        ) : null}

        {view === 'settings' ? (
          <SettingsView
            state={state}
            aiHealth={aiHealth}
            ruleConfig={ruleConfig}
            defaultRuleConfig={defaultRuleConfig}
            ruleDescriptions={ruleDescriptions}
            onUpdateState={setState}
            onTestAi={refreshAiHealth}
            onRuleChange={handleRuleChange}
            onResetAllRules={handleResetAllRules}
            onClearIgnoredLints={handleClearIgnoredLints}
            onExportJson={handleExportJson}
            onImportJson={handleImportJson}
            onPurgeAll={() => {
              const clean = clearLabState();
              setState(clean);
              setRewriteResult(null);
            }}
            onBackToEditor={() => setView('editor')}
          />
        ) : (
          <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            <section className="lg:col-span-7 flex flex-col gap-3">
              <div
                className="rounded-[8px] border p-3 flex flex-col gap-3"
                style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
              >
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                  <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                    <span>Sample Preset</span>
                    <select
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
                      className="rounded-[6px] border px-2 py-1.5 text-xs"
                      style={{
                        backgroundColor: 'var(--lx-bg)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    >
                      <option value="" disabled>
                        Load a sample...
                      </option>
                      {LAB_PRESETS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                    <span>Surface Profile</span>
                    <select
                      value={state.surfaceId}
                      onChange={(e) =>
                        setState((prev) => ({ ...prev, surfaceId: e.target.value as SurfaceId }))
                      }
                      className="rounded-[6px] border px-2 py-1.5 text-xs"
                      style={{
                        backgroundColor: 'var(--lx-bg)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    >
                      {SURFACE_PROFILES.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                    <span>Subcontext</span>
                    <input
                      type="text"
                      value={state.subcontext}
                      onChange={(e) => setState((prev) => ({ ...prev, subcontext: e.target.value }))}
                      placeholder="e.g. r/rust"
                      className="rounded-[6px] border px-2 py-1.5 text-xs lexel-mono"
                      style={{
                        backgroundColor: 'var(--lx-bg)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    />
                  </label>

                  <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                    <span>Dialect</span>
                    <select
                      value={state.dialect}
                      onChange={(e) =>
                        setState((prev) => ({
                          ...prev,
                          dialect: Number(e.target.value) as Dialect,
                        }))
                      }
                      className="rounded-[6px] border px-2 py-1.5 text-xs"
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
                    </select>
                  </label>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <SurfaceBadge
                      label={profile.label}
                      subcontext={state.subcontext.trim() || null}
                      charCount={textStats.chars}
                      maxChars={profile.maxChars}
                    />
                    {!profile.allowLinks ? (
                      <span
                        className="rounded-[4px] border px-1.5 py-0.5 text-[11px] lexel-mono"
                        style={{ borderColor: 'var(--lx-border)', color: 'var(--lx-fg-muted)' }}
                      >
                        No links
                      </span>
                    ) : null}
                    {!profile.allowEmojis ? (
                      <span
                        className="rounded-[4px] border px-1.5 py-0.5 text-[11px] lexel-mono"
                        style={{ borderColor: 'var(--lx-border)', color: 'var(--lx-fg-muted)' }}
                      >
                        No emojis
                      </span>
                    ) : null}
                    {!profile.allowHashtags ? (
                      <span
                        className="rounded-[4px] border px-1.5 py-0.5 text-[11px] lexel-mono"
                        style={{ borderColor: 'var(--lx-border)', color: 'var(--lx-fg-muted)' }}
                      >
                        No hashtags
                      </span>
                    ) : null}
                  </div>

                  <label className="inline-flex items-center gap-2 text-xs">
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
                    <span style={{ color: 'var(--lx-fg-muted)' }}>Hover to fix</span>
                  </label>
                </div>

                <textarea
                  ref={textareaRef}
                  rows={10}
                  value={state.draftText}
                  onChange={(e) => setState((prev) => ({ ...prev, draftText: e.target.value }))}
                  placeholder="Type or paste a draft here. Hover or click any underlined word to fix it with Lexel..."
                  aria-label="Lexel Lab draft editor"
                  className="w-full rounded-[8px] border p-3 text-sm leading-relaxed resize-y"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />

                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex flex-wrap items-center gap-3 lexel-mono text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                    <span>{textStats.words} words</span>
                    <span>{textStats.sentences} sentences</span>
                    <span>Grammar: {lintSummary.grammarCount}</span>
                    <span>Anti-Slop: {lintSummary.slopCount}</span>
                    <span>Platform: {lintSummary.surfaceCount}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(state.draftText);
                        setCopiedDraft(true);
                        window.setTimeout(() => setCopiedDraft(false), 1500);
                      }}
                      className="rounded-[6px] border px-2.5 py-1 text-xs"
                      style={{
                        backgroundColor: 'var(--lx-muted)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    >
                      {copiedDraft ? 'Copied' : 'Copy text'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setState((prev) => ({ ...prev, draftText: '' }));
                        setRewriteResult(null);
                      }}
                      className="rounded-[6px] px-2.5 py-1 text-xs"
                      style={{ color: 'var(--lx-fg-muted)' }}
                    >
                      Clear
                    </button>
                  </div>
                </div>
              </div>

              <div
                className="rounded-[8px] border p-3 flex flex-col gap-2"
                style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
              >
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-xs font-semibold m-0">
                    Tier 0 Diagnostics ({flattenedLints.length})
                  </h2>
                  <span className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                    Hover or click any underline above, or apply directly here
                  </span>
                </div>

                {flattenedLints.length === 0 ? (
                  <p className="text-xs m-0 py-2" style={{ color: 'var(--lx-fg-muted)' }}>
                    {state.draftText.trim()
                      ? 'No grammar, anti-slop, or surface warnings detected.'
                      : 'Enter text above to inspect live diagnostics.'}
                  </p>
                ) : (
                  <div className="flex flex-col gap-1.5 max-h-72 overflow-y-auto pr-1">
                    {flattenedLints.map(({ rule, lint }, idx) => (
                      <div
                        key={`${lint.context_hash}-${lint.span.start}-${idx}`}
                        className="rounded-[6px] border p-2 text-xs flex flex-wrap items-center justify-between gap-2"
                        style={{ backgroundColor: 'var(--lx-bg)', borderColor: 'var(--lx-border)' }}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span
                              className="rounded-[4px] border px-1.5 py-0.5 text-[10px] lexel-mono font-semibold"
                              style={{
                                borderColor: 'var(--lx-border)',
                                backgroundColor: 'var(--lx-muted)',
                                color: 'var(--lx-fg)',
                              }}
                            >
                              {lint.lint_kind_pretty}
                            </span>
                            <span className="lexel-mono text-[11px] font-semibold">
                              {lint.problem_text}
                            </span>
                            <span className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                              ({rule})
                            </span>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-1">
                          {lint.suggestions.slice(0, 2).map((sug, sIdx) => (
                            <button
                              key={sIdx}
                              type="button"
                              onClick={() => {
                                const text = state.draftText;
                                const replacement =
                                  sug.kind === 1
                                    ? ''
                                    : sug.kind === 2
                                      ? text.slice(lint.span.start, lint.span.end) + sug.replacement_text
                                      : sug.replacement_text;
                                const next =
                                  text.slice(0, lint.span.start) +
                                  replacement +
                                  text.slice(lint.span.end);
                                setState((prev) => ({ ...prev, draftText: next }));
                                requestAnimationFrame(() => void controllerRef.current?.refresh(true));
                              }}
                              className="rounded-[6px] border px-2 py-0.5 text-[11px] font-medium"
                              style={{
                                backgroundColor: 'var(--lx-card)',
                                borderColor: 'var(--lx-accent)',
                                color: 'var(--lx-accent)',
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
                              className="rounded-[6px] px-2 py-0.5 text-[11px] font-semibold"
                              style={{
                                backgroundColor: 'var(--lx-accent)',
                                color: 'var(--lx-on-accent)',
                              }}
                            >
                              Rewrite with AI
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section
              className="lg:col-span-5 rounded-[8px] border p-4 flex flex-col gap-3"
              style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
            >
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold m-0">Local AI Workbench (Tier 1 &amp; 2)</h2>
                  <p className="text-[11px] m-0" style={{ color: 'var(--lx-fg-muted)' }}>
                    {profile.promptDirective}
                  </p>
                </div>
              </div>

              {!state.aiSettings.enabled ? (
                <div
                  className="rounded-[6px] border p-2.5 flex items-center justify-between gap-2 text-xs"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg-muted)',
                  }}
                >
                  <span>Local AI is turned off in Settings.</span>
                  <button
                    type="button"
                    onClick={() => {
                      const nextAi = { ...state.aiSettings, enabled: true };
                      setState((prev) => ({ ...prev, aiSettings: nextAi }));
                      void refreshAiHealth(nextAi);
                    }}
                    className="rounded-[6px] px-2.5 py-1 text-xs font-semibold shrink-0"
                    style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
                  >
                    Turn AI On
                  </button>
                </div>
              ) : aiHealth && (!aiHealth.ok || aiHealth.modelAvailable === false) ? (
                <div
                  className="rounded-[6px] border p-2.5 flex flex-col gap-2 text-xs"
                  style={{
                    backgroundColor: 'var(--lx-warn-bg)',
                    borderColor: 'var(--lx-warn)',
                    color: 'var(--lx-warn)',
                  }}
                >
                  <div className="leading-snug break-words">{aiHealth.error}</div>
                  {aiHealth.models.length > 0 ? (
                    <label className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--lx-fg)' }}>
                      <span>Switch model:</span>
                      <select
                        value={state.aiSettings.model}
                        onChange={(e) => {
                          const nextAi = { ...state.aiSettings, model: e.target.value };
                          setState((prev) => ({ ...prev, aiSettings: nextAi }));
                          void refreshAiHealth(nextAi);
                        }}
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
                    </label>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void refreshAiHealth(state.aiSettings)}
                      className="rounded-[6px] border px-2.5 py-1 text-[11px] font-medium"
                      style={{
                        backgroundColor: 'var(--lx-muted)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    >
                      Retry connection
                    </button>
                    <button
                      type="button"
                      onClick={() => setView('settings')}
                      className="rounded-[6px] border px-2.5 py-1 text-[11px]"
                      style={{
                        backgroundColor: 'var(--lx-bg)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg-muted)',
                      }}
                    >
                      AI Settings
                    </button>
                  </div>
                </div>
              ) : null}

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
                className="w-full rounded-[6px] px-3 py-2 text-xs font-semibold"
                style={{
                  backgroundColor: 'var(--lx-accent)',
                  color: 'var(--lx-on-accent)',
                }}
              >
                {aiLoading ? `Running ${state.aiSettings.model}...` : 'Rewrite with Local AI'}
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
                  className="rounded-[6px] border p-3 text-xs"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg-muted)',
                  }}
                >
                  Trigger a rewrite to inspect Tier 2 deterministic verification gates (Zero-Slop, Numbers, Code Tokens, Surface Rules).
                </div>
              )}
            </section>
          </div>
        )}
      </main>

      <LabSuggestionPopover
        active={activeLint}
        aiEnabled={state.aiSettings.enabled}
        onHoverChange={(hovered) => controllerRef.current?.setPopoverHovered(hovered)}
        onClose={() => controllerRef.current?.closePopup()}
        onAddToDictionary={handleAddWord}
        onDisableRule={(ruleId) => void handleRuleChange(ruleId, false)}
        onOpenSettings={() => setView('settings')}
        onFixWithAi={(box: IgnorableLintBox) => {
          void runAiTask(box.rule === 'LexelAntiSlop' ? 'deslop' : 'fix_grammar_flow');
        }}
      />
    </div>
  );
}

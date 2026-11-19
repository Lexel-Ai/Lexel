import { BUILTIN_SURFACES, HARPER_RULE_PRESETS, type RulePresetId, SLOP_TERMS } from 'lexel-ui';
import type React from 'react';
import { useMemo, useRef, useState } from 'react';
import { daemonRpc } from '../lib/desktopClient';
import type {
  HarperRulesPayload,
  Hotkey,
  StoredWeirpack,
  StyleGuideRule,
  TextSnippet,
  UnifiedDaemonSettings,
} from '../lib/types';

interface RulesPaneProps {
  settings: UnifiedDaemonSettings;
  harperRules: HarperRulesPayload | null;
  onPatchSettings: (patch: Partial<UnifiedDaemonSettings>) => Promise<void>;
  onRefreshRules: () => Promise<void>;
}

// Matches harper-core & harper.js Dialect enum order: 0=US, 1=UK, 2=AU, 3=CA, 4=IN.
const DIALECTS = [
  { id: 0, label: 'American English' },
  { id: 1, label: 'British English' },
  { id: 2, label: 'Australian English' },
  { id: 3, label: 'Canadian English' },
  { id: 4, label: 'Indian English' },
];

export function RulesPane({
  settings,
  harperRules,
  onPatchSettings,
  onRefreshRules,
}: RulesPaneProps) {
  const [ruleSearch, setRuleSearch] = useState('');
  const [slopInput, setSlopInput] = useState('');
  const [dictInput, setDictInput] = useState('');
  const [blockDomainInput, setBlockDomainInput] = useState('');
  const [siteDomainInput, setSiteDomainInput] = useState('');
  const [siteEnabledInput, setSiteEnabledInput] = useState(true);
  const [siteSurfaceInput, setSiteSurfaceInput] = useState('auto');
  const [weirRuleName, setWeirRuleName] = useState('CustomAvoidSynergy');
  const [weirExpr, setWeirExpr] = useState('synergy');
  const [weirReplacement, setWeirReplacement] = useState('coordination');
  const [weirMessage, setWeirMessage] = useState('Use plain phrasing instead of buzzword.');
  const [weirTestBad, setWeirTestBad] = useState('We need team synergy now.');
  const [weirTestGood, setWeirTestGood] = useState('We need team coordination now.');
  const [weirNotice, setWeirNotice] = useState<string | null>(null);
  const [weirError, setWeirError] = useState<string | null>(null);
  const weirUploadRef = useRef<HTMLInputElement | null>(null);
  const [styleTerm, setStyleTerm] = useState('');
  const [stylePreferred, setStylePreferred] = useState('');
  const [styleNote, setStyleNote] = useState('');
  const [styleCaseSensitive, setStyleCaseSensitive] = useState(false);
  const [styleNotice, setStyleNotice] = useState<string | null>(null);
  const styleImportRef = useRef<HTMLInputElement | null>(null);
  const [snippetTrigger, setSnippetTrigger] = useState('');
  const [snippetExpansion, setSnippetExpansion] = useState('');
  const [snippetLabel, setSnippetLabel] = useState('');

  const activeHotkey: Hotkey = settings.hotkey ?? { modifiers: ['Alt'], key: 'l' };
  const weirpacks: StoredWeirpack[] = settings.weirpacks ?? [];
  const styleGuide: StyleGuideRule[] = settings.styleGuide ?? [];
  const snippets: TextSnippet[] = settings.snippets ?? [];

  const allSurfaces = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of BUILTIN_SURFACES) {
      map.set(s.id, s.label);
    }
    for (const s of settings.customSurfaces ?? []) {
      map.set(s.id, s.label);
    }
    return [...map.entries()].map(([id, label]) => ({ id, label }));
  }, [settings.customSurfaces]);

  const managedDomains = useMemo(() => {
    const keys = new Set([
      ...Object.keys(settings.domainStatuses ?? {}),
      ...Object.keys(settings.surfaceOverrides ?? {}),
    ]);
    return [...keys].sort();
  }, [settings.domainStatuses, settings.surfaceOverrides]);

  const visibleRules = useMemo(() => {
    const rules = harperRules?.rules ?? [];
    const q = ruleSearch.trim().toLowerCase();
    const filtered = q
      ? rules.filter(
          (r) => r.id.toLowerCase().includes(q) || r.description.toLowerCase().includes(q),
        )
      : rules;
    return filtered.slice(0, 120);
  }, [harperRules, ruleSearch]);

  async function handlePreset(preset: RulePresetId) {
    await daemonRpc('applyRulePreset', { preset });
    await onRefreshRules();
  }

  async function toggleRule(id: string, nextValue: boolean) {
    const nextConfig = { ...settings.lintConfig, [id]: nextValue };
    await onPatchSettings({ lintConfig: nextConfig });
    await onRefreshRules();
  }

  async function toggleSlopTerm(term: string) {
    const disabled = new Set(settings.disabledSlopTerms);
    if (disabled.has(term)) {
      disabled.delete(term);
    } else {
      disabled.add(term);
    }
    await onPatchSettings({ disabledSlopTerms: [...disabled] });
  }

  async function addCustomSlop(e: React.FormEvent) {
    e.preventDefault();
    const cleaned = slopInput.trim();
    if (!cleaned) return;
    if (!settings.customSlopTerms.includes(cleaned)) {
      await onPatchSettings({
        customSlopTerms: [...settings.customSlopTerms, cleaned],
      });
    }
    setSlopInput('');
  }

  async function removeCustomSlop(entry: string) {
    await onPatchSettings({
      customSlopTerms: settings.customSlopTerms.filter((t) => t !== entry),
    });
  }

  async function addDictionaryWord(e: React.FormEvent) {
    e.preventDefault();
    const word = dictInput.trim();
    if (!word) return;
    if (!settings.userDictionary.includes(word)) {
      await onPatchSettings({
        userDictionary: [...settings.userDictionary, word],
      });
    }
    setDictInput('');
  }

  async function addBlockedDomain(e: React.FormEvent) {
    e.preventDefault();
    const domain = blockDomainInput.trim().toLowerCase();
    if (!domain) return;
    if (!settings.privacyBlocklist.includes(domain)) {
      await onPatchSettings({
        privacyBlocklist: [...settings.privacyBlocklist, domain],
      });
    }
    setBlockDomainInput('');
  }

  async function toggleHotkeyModifier(mod: 'Ctrl' | 'Shift' | 'Alt') {
    const has = activeHotkey.modifiers.includes(mod);
    const nextMods = has
      ? activeHotkey.modifiers.filter((m) => m !== mod)
      : [...activeHotkey.modifiers, mod];
    if (nextMods.length === 0) return;
    await onPatchSettings({
      hotkey: { ...activeHotkey, modifiers: nextMods },
    });
  }

  async function addManagedSite(e: React.FormEvent) {
    e.preventDefault();
    const clean = siteDomainInput.trim().toLowerCase();
    if (!clean) return;
    const nextStatuses = { ...settings.domainStatuses, [clean]: siteEnabledInput };
    const nextOverrides = { ...settings.surfaceOverrides };
    if (siteSurfaceInput === 'auto') {
      delete nextOverrides[clean];
    } else {
      nextOverrides[clean] = siteSurfaceInput;
    }
    await onPatchSettings({
      domainStatuses: nextStatuses,
      surfaceOverrides: nextOverrides,
    });
    setSiteDomainInput('');
  }

  async function removeManagedSite(domain: string) {
    await onPatchSettings({
      domainStatuses: { [domain]: null } as unknown as Record<string, boolean>,
      surfaceOverrides: { [domain]: null } as unknown as Record<string, string>,
    });
  }

  async function handleBuildWeirpack(e: React.FormEvent) {
    e.preventDefault();
    setWeirNotice(null);
    setWeirError(null);
    try {
      const res = await daemonRpc<{ weirpack: StoredWeirpack }>('buildWeirpack', {
        ruleName: weirRuleName,
        expr: weirExpr,
        replacement: weirReplacement,
        message: weirMessage,
        testBad: weirTestBad,
        testGood: weirTestGood,
      });
      await onRefreshRules();
      setWeirNotice(`Built and synced ${res.weirpack.name} (${res.weirpack.ruleCount} rule).`);
    } catch (err) {
      setWeirError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleUploadWeirpack(file: File | undefined) {
    if (!file) return;
    setWeirNotice(null);
    setWeirError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i++) {
        bin += String.fromCharCode(bytes[i]);
      }
      const res = await daemonRpc<{ weirpack: StoredWeirpack }>('validateWeirpack', {
        name: file.name,
        bytesBase64: btoa(bin),
        save: true,
      });
      await onRefreshRules();
      setWeirNotice(`Validated and synced ${res.weirpack.name} (${res.weirpack.ruleCount} rules).`);
    } catch (err) {
      setWeirError(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggleWeirpack(name: string, enabled: boolean) {
    await onPatchSettings({
      weirpacks: weirpacks.map((p) => (p.name === name ? { ...p, enabled } : p)),
    });
    await onRefreshRules();
  }

  async function removeWeirpack(name: string) {
    await onPatchSettings({
      weirpacks: weirpacks.filter((p) => p.name !== name),
    });
    await onRefreshRules();
  }

  async function addStyleRule(e: React.FormEvent) {
    e.preventDefault();
    const term = styleTerm.trim();
    const preferred = stylePreferred.trim();
    if (!term || !preferred) return;
    const next: StyleGuideRule[] = [
      ...styleGuide.filter((r) => r.term.toLowerCase() !== term.toLowerCase()),
      {
        term,
        preferred,
        caseSensitive: styleCaseSensitive,
        note: styleNote.trim() || null,
      },
    ];
    await onPatchSettings({ styleGuide: next });
    setStyleTerm('');
    setStylePreferred('');
    setStyleNote('');
    setStyleNotice(`Saved style rule "${term}" -> "${preferred}".`);
  }

  function exportStyleGuideJson() {
    const blob = new Blob([JSON.stringify(styleGuide, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lexel-style-guide.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importStyleGuideJson(file: File | undefined) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!Array.isArray(parsed)) {
        setStyleNotice('Style guide JSON must be an array of { term, preferred } rules.');
        return;
      }
      const valid = parsed.filter(
        (r): r is StyleGuideRule =>
          Boolean(r) &&
          typeof r === 'object' &&
          typeof (r as StyleGuideRule).term === 'string' &&
          typeof (r as StyleGuideRule).preferred === 'string',
      );
      await onPatchSettings({ styleGuide: valid });
      setStyleNotice(`Imported ${valid.length} team style guide rule(s).`);
    } catch {
      setStyleNotice('Could not parse style guide JSON file.');
    }
  }

  async function addSnippet(e: React.FormEvent) {
    e.preventDefault();
    const trigger = snippetTrigger.trim();
    const expansion = snippetExpansion.trim();
    if (trigger.length < 2 || !expansion) return;
    const next: TextSnippet[] = [
      ...snippets.filter((s) => s.trigger !== trigger),
      { trigger, expansion, label: snippetLabel.trim() || trigger },
    ];
    await onPatchSettings({ snippets: next });
    setSnippetTrigger('');
    setSnippetExpansion('');
    setSnippetLabel('');
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[18px] font-semibold">Grammar, Anti-Slop, Extension &amp; Privacy</h1>
        <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
          Every deterministic Tier 0 rule and browser extension preference lives in lexel.db and
          syncs automatically.
        </p>
      </header>

      <section
        className="space-y-3 rounded-[8px] border p-3"
        style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label
              htmlFor="desktop-dialect"
              className="mb-1 block text-[11px] font-medium"
              style={{ color: 'var(--lx-fg-muted)' }}
            >
              English Dialect
            </label>
            <select
              id="desktop-dialect"
              value={settings.dialect}
              onChange={(e) => void onPatchSettings({ dialect: Number(e.target.value) })}
              className="w-full rounded-[6px] border px-2.5 py-1.5 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              {DIALECTS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="desktop-language-mode"
              className="mb-1 block text-[11px] font-medium"
              style={{ color: 'var(--lx-fg-muted)' }}
            >
              Parser Mode
            </label>
            <select
              id="desktop-language-mode"
              value={settings.languageMode}
              onChange={(e) =>
                void onPatchSettings({
                  languageMode: e.target.value as 'plaintext' | 'markdown' | 'typst',
                })
              }
              className="w-full rounded-[6px] border px-2.5 py-1.5 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              <option value="plaintext">Plain English</option>
              <option value="markdown">Markdown (code blocks ignored)</option>
              <option value="typst">Typst</option>
            </select>
          </div>

          <div className="flex items-end pb-1">
            <label className="flex items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={settings.isolateEnglish}
                onChange={(e) => void onPatchSettings({ isolateEnglish: e.target.checked })}
              />
              Isolate English in mixed-language text
            </label>
          </div>
        </div>

        <div className="pt-1">
          <div className="mb-1.5 text-[11px] font-medium" style={{ color: 'var(--lx-fg-muted)' }}>
            Harper Rule Presets
          </div>
          <div className="flex flex-wrap gap-2">
            {HARPER_RULE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => void handlePreset(preset.id)}
                title={preset.description}
                className="rounded-[6px] border px-2.5 py-1 text-[12px]"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section
        className="space-y-3 rounded-[8px] border p-3"
        style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
      >
        <div>
          <h2 className="text-[13px] font-semibold">Browser Extension Behavior (Synced)</h2>
          <p className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
            Changes here apply to Chrome, Brave, Edge, and Firefox tabs on next sync.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label
              htmlFor="desktop-activation-key"
              className="mb-1 block text-[11px] font-medium"
              style={{ color: 'var(--lx-fg-muted)' }}
            >
              Popup Activation Guard
            </label>
            <select
              id="desktop-activation-key"
              value={settings.activationKey}
              onChange={(e) =>
                void onPatchSettings({
                  activationKey: e.target.value as 'off' | 'shift' | 'control',
                })
              }
              className="w-full rounded-[6px] border px-2.5 py-1.5 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              <option value="off">No guard key (default)</option>
              <option value="shift">Hold Shift to open popup</option>
              <option value="control">Hold Control to open popup</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="desktop-lint-delay"
              className="mb-1 block text-[11px] font-medium"
              style={{ color: 'var(--lx-fg-muted)' }}
            >
              Lint Delay (ms)
            </label>
            <input
              id="desktop-lint-delay"
              type="number"
              min={0}
              max={2000}
              step={25}
              value={settings.lintDelayMs}
              onChange={(e) =>
                void onPatchSettings({
                  lintDelayMs: Math.max(0, Number.parseInt(e.target.value || '0', 10)),
                })
              }
              className="w-full rounded-[6px] border px-2.5 py-1.5 text-[12px] lexel-mono"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            />
          </div>

          <div>
            <div className="mb-1 text-[11px] font-medium" style={{ color: 'var(--lx-fg-muted)' }}>
              In-Page AI Rewrite Shortcut
            </div>
            <div className="flex items-center gap-1.5">
              {(['Ctrl', 'Shift', 'Alt'] as const).map((mod) => {
                const active = activeHotkey.modifiers.includes(mod);
                return (
                  <button
                    key={mod}
                    type="button"
                    onClick={() => void toggleHotkeyModifier(mod)}
                    className="rounded-[4px] border px-2 py-1 text-[11px] lexel-mono"
                    style={{
                      backgroundColor: active ? 'var(--lx-accent)' : 'var(--lx-surface)',
                      borderColor: 'var(--lx-border)',
                      color: active ? 'var(--lx-on-accent)' : 'var(--lx-fg)',
                    }}
                  >
                    {mod}
                  </button>
                );
              })}
              <input
                type="text"
                maxLength={1}
                aria-label="Shortcut key"
                value={activeHotkey.key}
                onChange={(e) => {
                  const k = e.target.value.trim().toLowerCase();
                  if (k) {
                    void onPatchSettings({ hotkey: { ...activeHotkey, key: k } });
                  }
                }}
                className="w-10 rounded-[6px] border px-2 py-1 text-center text-[12px] lexel-mono uppercase"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-4 text-[12px]">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.openSuggestionsOnHover}
              onChange={(e) => void onPatchSettings({ openSuggestionsOnHover: e.target.checked })}
            />
            Open grammar suggestions on underline hover
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.defaultEnable}
              onChange={(e) => void onPatchSettings({ defaultEnable: e.target.checked })}
            />
            Enable Lexel automatically on new websites
          </label>
        </div>
      </section>

      <section
        className="space-y-2 rounded-[8px] border p-3"
        style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[13px] font-semibold">
            Harper Rules ({harperRules?.rules.length ?? 0})
          </h2>
          <input
            type="search"
            value={ruleSearch}
            onChange={(e) => setRuleSearch(e.target.value)}
            placeholder="Search grammar rules..."
            aria-label="Search grammar rules"
            className="w-60 rounded-[6px] border px-2.5 py-1 text-[12px]"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          />
        </div>

        <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
          {visibleRules.length === 0 ? (
            <p className="text-[12px] py-2" style={{ color: 'var(--lx-fg-muted)' }}>
              No grammar rules match &ldquo;{ruleSearch}&rdquo;. Clear the filter to browse all
              rules.
            </p>
          ) : (
            visibleRules.map((rule) => (
              <label
                key={rule.id}
                className="flex items-start justify-between gap-3 rounded-[6px] border px-2.5 py-2 text-[12px]"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                }}
              >
                <div>
                  <div className="font-medium lexel-mono">{rule.id}</div>
                  <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                    {rule.description}
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={(e) => void toggleRule(rule.id, e.target.checked)}
                  className="mt-0.5"
                />
              </label>
            ))
          )}
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section
          className="space-y-2 rounded-[8px] border p-3"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <h2 className="text-[13px] font-semibold">
            Anti-Slop Scanner ({SLOP_TERMS.length + settings.customSlopTerms.length})
          </h2>
          <form onSubmit={addCustomSlop} className="flex gap-2">
            <input
              type="text"
              value={slopInput}
              onChange={(e) => setSlopInput(e.target.value)}
              placeholder="phrase => replacement (or phrase)"
              aria-label="Add custom slop phrase"
              className="min-w-0 flex-1 rounded-[6px] border px-2.5 py-1 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            />
            <button
              type="submit"
              className="rounded-[6px] border px-2.5 py-1 text-[12px] font-medium"
              style={{
                backgroundColor: 'var(--lx-muted)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              Add
            </button>
          </form>

          {settings.customSlopTerms.length > 0 && (
            <div className="space-y-1 pt-1">
              <div className="text-[11px] font-medium" style={{ color: 'var(--lx-fg-muted)' }}>
                Custom terms ({settings.customSlopTerms.length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {settings.customSlopTerms.map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    onClick={() => void removeCustomSlop(entry)}
                    title="Remove custom slop term"
                    className="rounded-[4px] border px-2 py-0.5 text-[11px] lexel-mono"
                    style={{
                      backgroundColor: 'var(--lx-signal-bg)',
                      borderColor: 'var(--lx-signal)',
                      color: 'var(--lx-signal)',
                    }}
                  >
                    {entry} x
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex max-h-44 flex-wrap gap-1.5 overflow-y-auto pt-1">
            {SLOP_TERMS.map((term) => {
              const enabled = !settings.disabledSlopTerms.includes(term);
              return (
                <button
                  key={term}
                  type="button"
                  onClick={() => void toggleSlopTerm(term)}
                  className="rounded-[4px] border px-2 py-0.5 text-[11px] lexel-mono"
                  style={{
                    backgroundColor: enabled ? 'var(--lx-surface)' : 'var(--lx-muted)',
                    borderColor: enabled ? 'var(--lx-border)' : 'transparent',
                    color: enabled ? 'var(--lx-fg)' : 'var(--lx-fg-muted)',
                    textDecoration: enabled ? 'none' : 'line-through',
                  }}
                >
                  {term}
                </button>
              );
            })}
          </div>
        </section>

        <section
          className="space-y-2 rounded-[8px] border p-3"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <h2 className="text-[13px] font-semibold">
            Personal Dictionary ({settings.userDictionary.length})
          </h2>
          <form onSubmit={addDictionaryWord} className="flex gap-2">
            <input
              type="text"
              value={dictInput}
              onChange={(e) => setDictInput(e.target.value)}
              placeholder="Add accepted word or crate name..."
              aria-label="Add dictionary word"
              className="min-w-0 flex-1 rounded-[6px] border px-2.5 py-1 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            />
            <button
              type="submit"
              className="rounded-[6px] border px-2.5 py-1 text-[12px] font-medium"
              style={{
                backgroundColor: 'var(--lx-muted)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              Add
            </button>
          </form>

          <div className="flex max-h-44 flex-wrap gap-1.5 overflow-y-auto pt-1">
            {settings.userDictionary.length === 0 ? (
              <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
                No personal words added yet. Add project names or domain jargon above.
              </p>
            ) : (
              settings.userDictionary.map((word) => (
                <button
                  key={word}
                  type="button"
                  onClick={() =>
                    void onPatchSettings({
                      userDictionary: settings.userDictionary.filter((w) => w !== word),
                    })
                  }
                  title="Remove word"
                  className="rounded-[4px] border px-2 py-0.5 text-[11px] lexel-mono"
                  style={{
                    backgroundColor: 'var(--lx-surface)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                >
                  {word} x
                </button>
              ))
            )}
          </div>
        </section>
      </div>

      <section
        className="space-y-2 rounded-[8px] border p-3"
        style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
      >
        <div>
          <h2 className="text-[13px] font-semibold">
            Privacy Blocklist ({settings.privacyBlocklist.length})
          </h2>
          <p className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
            Lexel blocks local AI and pauses linting on matching hostnames (supports exact hosts or
            *.domain.com).
          </p>
        </div>

        <form onSubmit={addBlockedDomain} className="flex gap-2">
          <input
            type="text"
            value={blockDomainInput}
            onChange={(e) => setBlockDomainInput(e.target.value)}
            placeholder="e.g. *.chase.com or vault.example.com"
            aria-label="Add blocked domain"
            className="min-w-0 flex-1 rounded-[6px] border px-2.5 py-1 text-[12px] lexel-mono"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          />
          <button
            type="submit"
            className="rounded-[6px] border px-2.5 py-1 text-[12px] font-medium"
            style={{
              backgroundColor: 'var(--lx-muted)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          >
            Block Domain
          </button>
        </form>

        <div className="flex max-h-36 flex-wrap gap-1.5 overflow-y-auto pt-1">
          {settings.privacyBlocklist.map((domain) => (
            <button
              key={domain}
              type="button"
              onClick={() =>
                void onPatchSettings({
                  privacyBlocklist: settings.privacyBlocklist.filter((d) => d !== domain),
                })
              }
              title="Remove from privacy blocklist"
              className="rounded-[4px] border px-2 py-0.5 text-[11px] lexel-mono"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              {domain} x
            </button>
          ))}
        </div>
      </section>

      <section
        className="space-y-3 rounded-[8px] border p-3"
        style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
      >
        <div>
          <h2 className="text-[13px] font-semibold">Managed Websites ({managedDomains.length})</h2>
          <p className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
            Control per-site pause/enable state and surface overrides for Chrome, Brave, Edge, and
            Firefox from one place.
          </p>
        </div>

        <form onSubmit={addManagedSite} className="grid gap-2 sm:grid-cols-4">
          <input
            type="text"
            value={siteDomainInput}
            onChange={(e) => setSiteDomainInput(e.target.value)}
            placeholder="mail.google.com or github.com"
            aria-label="Website hostname"
            className="rounded-[6px] border px-2.5 py-1.5 text-[12px] lexel-mono sm:col-span-2"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          />
          <select
            aria-label="Site surface override"
            value={siteSurfaceInput}
            onChange={(e) => setSiteSurfaceInput(e.target.value)}
            className="rounded-[6px] border px-2 py-1.5 text-[12px]"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          >
            <option value="auto">Auto-detect surface</option>
            {allSurfaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11px]">
              <input
                type="checkbox"
                checked={siteEnabledInput}
                onChange={(e) => setSiteEnabledInput(e.target.checked)}
              />
              Active
            </label>
            <button
              type="submit"
              className="ml-auto rounded-[6px] border px-2.5 py-1.5 text-[12px] font-medium"
              style={{
                backgroundColor: 'var(--lx-muted)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              Save Site
            </button>
          </div>
        </form>

        {managedDomains.length === 0 ? (
          <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
            No per-site overrides yet. Lexel follows your default website setting everywhere.
          </p>
        ) : (
          <div className="space-y-1.5">
            {managedDomains.map((domain) => {
              const enabled = settings.domainStatuses[domain] ?? settings.defaultEnable;
              const surface = settings.surfaceOverrides[domain] ?? 'auto';
              return (
                <div
                  key={domain}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] border px-2.5 py-2 text-[12px]"
                  style={{
                    backgroundColor: 'var(--lx-surface)',
                    borderColor: 'var(--lx-border)',
                  }}
                >
                  <span className="font-medium lexel-mono">{domain}</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label={`Surface override for ${domain}`}
                      value={surface}
                      onChange={(e) => {
                        const val = e.target.value;
                        void onPatchSettings({
                          surfaceOverrides: {
                            [domain]: val === 'auto' ? null : val,
                          } as unknown as Record<string, string>,
                        });
                      }}
                      className="rounded-[4px] border px-2 py-0.5 text-[11px]"
                      style={{
                        backgroundColor: 'var(--lx-card)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg)',
                      }}
                    >
                      <option value="auto">Auto</option>
                      {allSurfaces.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() =>
                        void onPatchSettings({
                          domainStatuses: { [domain]: !enabled },
                        })
                      }
                      className="rounded-[4px] border px-2 py-0.5 text-[11px] font-medium"
                      style={{
                        backgroundColor: enabled ? 'var(--lx-accent)' : 'var(--lx-muted)',
                        borderColor: 'var(--lx-border)',
                        color: enabled ? 'var(--lx-on-accent)' : 'var(--lx-fg)',
                      }}
                    >
                      {enabled ? 'Enabled' : 'Paused'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeManagedSite(domain)}
                      className="rounded-[4px] border px-2 py-0.5 text-[11px]"
                      style={{
                        backgroundColor: 'var(--lx-card)',
                        borderColor: 'var(--lx-border)',
                        color: 'var(--lx-fg-muted)',
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section
        className="space-y-3 rounded-[8px] border p-3"
        style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-[13px] font-semibold">Weirpack Studio ({weirpacks.length})</h2>
            <p className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
              Build or import deterministic Harper `.weirpack` bundles. Packs run embedded tests and
              sync to Browser Extension, CLI, and LSP.
            </p>
          </div>
          <div>
            <input
              ref={weirUploadRef}
              type="file"
              accept=".weirpack,.zip"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                void handleUploadWeirpack(file);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => weirUploadRef.current?.click()}
              className="rounded-[6px] border px-2.5 py-1 text-[12px] font-medium"
              style={{
                backgroundColor: 'var(--lx-muted)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              Upload .weirpack
            </button>
          </div>
        </div>

        {weirNotice && (
          <div
            className="rounded-[6px] border px-2.5 py-1.5 text-[11px]"
            style={{
              backgroundColor: 'var(--lx-signal-bg)',
              borderColor: 'var(--lx-signal)',
              color: 'var(--lx-signal)',
            }}
          >
            {weirNotice}
          </div>
        )}
        {weirError && (
          <div
            className="rounded-[6px] border px-2.5 py-1.5 text-[11px]"
            style={{
              backgroundColor: 'var(--lx-danger-bg)',
              borderColor: 'var(--lx-danger)',
              color: 'var(--lx-danger)',
            }}
          >
            {weirError}
          </div>
        )}

        <form onSubmit={handleBuildWeirpack} className="grid gap-2 sm:grid-cols-2">
          <input
            type="text"
            value={weirRuleName}
            onChange={(e) => setWeirRuleName(e.target.value)}
            placeholder="Rule name (PascalCase)"
            aria-label="Weir rule name"
            className="rounded-[6px] border px-2.5 py-1.5 text-[12px] lexel-mono"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          />
          <input
            type="text"
            value={weirMessage}
            onChange={(e) => setWeirMessage(e.target.value)}
            placeholder="Diagnostic message"
            aria-label="Weir diagnostic message"
            className="rounded-[6px] border px-2.5 py-1.5 text-[12px]"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          />
          <input
            type="text"
            value={weirExpr}
            onChange={(e) => setWeirExpr(e.target.value)}
            placeholder="Target word or phrase"
            aria-label="Weir target phrase"
            className="rounded-[6px] border px-2.5 py-1.5 text-[12px]"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          />
          <input
            type="text"
            value={weirReplacement}
            onChange={(e) => setWeirReplacement(e.target.value)}
            placeholder="Preferred replacement"
            aria-label="Weir replacement"
            className="rounded-[6px] border px-2.5 py-1.5 text-[12px]"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          />
          <input
            type="text"
            value={weirTestBad}
            onChange={(e) => setWeirTestBad(e.target.value)}
            placeholder="Unit test before sentence"
            aria-label="Weir test before"
            className="rounded-[6px] border px-2.5 py-1.5 text-[12px]"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          />
          <input
            type="text"
            value={weirTestGood}
            onChange={(e) => setWeirTestGood(e.target.value)}
            placeholder="Unit test expected sentence"
            aria-label="Weir test expected"
            className="rounded-[6px] border px-2.5 py-1.5 text-[12px]"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          />
          <div className="sm:col-span-2">
            <button
              type="submit"
              className="rounded-[6px] px-3 py-1.5 text-[12px] font-semibold"
              style={{
                backgroundColor: 'var(--lx-accent)',
                color: 'var(--lx-on-accent)',
              }}
            >
              Build, Test &amp; Sync Weirpack
            </button>
          </div>
        </form>

        {weirpacks.length > 0 && (
          <div className="space-y-1.5 pt-1">
            {weirpacks.map((pack) => (
              <div
                key={pack.name}
                className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] border px-2.5 py-2 text-[12px]"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                }}
              >
                <div>
                  <span className="font-medium lexel-mono">{pack.name}</span>
                  <span className="ml-2 text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                    {pack.ruleCount} rule(s)
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-[11px]">
                    <input
                      type="checkbox"
                      checked={pack.enabled}
                      onChange={(e) => void toggleWeirpack(pack.name, e.target.checked)}
                    />
                    Enabled
                  </label>
                  <button
                    type="button"
                    onClick={() => void removeWeirpack(pack.name)}
                    className="rounded-[4px] border px-2 py-0.5 text-[11px]"
                    style={{
                      backgroundColor: 'var(--lx-card)',
                      borderColor: 'var(--lx-border)',
                      color: 'var(--lx-fg-muted)',
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section
          className="space-y-2.5 rounded-[8px] border p-3"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-[13px] font-semibold">Team Style Guide ({styleGuide.length})</h2>
              <p className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                Enforce product names and team wording across Desktop, Extension, CLI, and LSP.
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <input
                ref={styleImportRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  void importStyleGuideJson(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => styleImportRef.current?.click()}
                className="rounded-[4px] border px-2 py-0.5 text-[11px]"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              >
                Import JSON
              </button>
              <button
                type="button"
                onClick={exportStyleGuideJson}
                className="rounded-[4px] border px-2 py-0.5 text-[11px]"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              >
                Export
              </button>
            </div>
          </div>

          {styleNotice && (
            <div className="text-[11px]" style={{ color: 'var(--lx-signal)' }}>
              {styleNotice}
            </div>
          )}

          <form onSubmit={addStyleRule} className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                value={styleTerm}
                onChange={(e) => setStyleTerm(e.target.value)}
                placeholder="Avoid term (e.g. grey)"
                aria-label="Style guide term to replace"
                className="rounded-[6px] border px-2.5 py-1 text-[12px]"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
              <input
                type="text"
                value={stylePreferred}
                onChange={(e) => setStylePreferred(e.target.value)}
                placeholder="Preferred (e.g. gray)"
                aria-label="Style guide preferred term"
                className="rounded-[6px] border px-2.5 py-1 text-[12px]"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={styleNote}
                onChange={(e) => setStyleNote(e.target.value)}
                placeholder="Optional note (e.g. US brand style)"
                aria-label="Style guide note"
                className="min-w-0 flex-1 rounded-[6px] border px-2.5 py-1 text-[12px]"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
              <label className="flex items-center gap-1 text-[11px]">
                <input
                  type="checkbox"
                  checked={styleCaseSensitive}
                  onChange={(e) => setStyleCaseSensitive(e.target.checked)}
                />
                Case-sensitive
              </label>
              <button
                type="submit"
                className="rounded-[6px] border px-2.5 py-1 text-[12px] font-medium"
                style={{
                  backgroundColor: 'var(--lx-muted)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              >
                Add Rule
              </button>
            </div>
          </form>

          {styleGuide.length === 0 ? (
            <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
              No team terminology rules yet. Add rules like &ldquo;Postgres&rdquo; -&gt;
              &ldquo;PostgreSQL&rdquo;.
            </p>
          ) : (
            <div className="max-h-44 space-y-1.5 overflow-y-auto pr-1">
              {styleGuide.map((rule) => (
                <div
                  key={`${rule.term}-${rule.preferred}`}
                  className="flex items-center justify-between gap-2 rounded-[6px] border px-2.5 py-1.5 text-[12px]"
                  style={{
                    backgroundColor: 'var(--lx-surface)',
                    borderColor: 'var(--lx-border)',
                  }}
                >
                  <div className="min-w-0 truncate">
                    <span className="lexel-mono">{rule.term}</span> -&gt;{' '}
                    <strong className="lexel-mono">{rule.preferred}</strong>
                    {rule.note ? (
                      <span className="ml-1.5 text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                        ({rule.note})
                      </span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void onPatchSettings({
                        styleGuide: styleGuide.filter((r) => r.term !== rule.term),
                      })
                    }
                    className="rounded-[4px] border px-2 py-0.5 text-[11px]"
                    style={{
                      backgroundColor: 'var(--lx-card)',
                      borderColor: 'var(--lx-border)',
                      color: 'var(--lx-fg-muted)',
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section
          className="space-y-2.5 rounded-[8px] border p-3"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <div>
            <h2 className="text-[13px] font-semibold">
              Personal Text Snippets ({snippets.length})
            </h2>
            <p className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
              Type a trigger (e.g. <code>;lgtm</code> or <code>;sig</code>) then Space or Tab in
              Desktop or any browser text box to expand instantly.
            </p>
          </div>

          <form onSubmit={addSnippet} className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                value={snippetTrigger}
                onChange={(e) => setSnippetTrigger(e.target.value)}
                placeholder="Trigger (e.g. ;lgtm)"
                aria-label="Snippet trigger"
                className="rounded-[6px] border px-2.5 py-1 text-[12px] lexel-mono"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
              <input
                type="text"
                value={snippetLabel}
                onChange={(e) => setSnippetLabel(e.target.value)}
                placeholder="Label (optional)"
                aria-label="Snippet label"
                className="rounded-[6px] border px-2.5 py-1 text-[12px]"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={snippetExpansion}
                onChange={(e) => setSnippetExpansion(e.target.value)}
                placeholder="Expanded text (e.g. Looks good to me, ready to merge.)"
                aria-label="Snippet expansion text"
                className="min-w-0 flex-1 rounded-[6px] border px-2.5 py-1 text-[12px]"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
              <button
                type="submit"
                className="rounded-[6px] border px-2.5 py-1 text-[12px] font-medium"
                style={{
                  backgroundColor: 'var(--lx-muted)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              >
                Add Snippet
              </button>
            </div>
          </form>

          {snippets.length === 0 ? (
            <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
              No shortcuts configured yet. Snippets skip password and privacy-blocked fields.
            </p>
          ) : (
            <div className="max-h-44 space-y-1.5 overflow-y-auto pr-1">
              {snippets.map((snippet) => (
                <div
                  key={snippet.trigger}
                  className="flex items-center justify-between gap-2 rounded-[6px] border px-2.5 py-1.5 text-[12px]"
                  style={{
                    backgroundColor: 'var(--lx-surface)',
                    borderColor: 'var(--lx-border)',
                  }}
                >
                  <div className="min-w-0 truncate">
                    <span
                      className="rounded-[4px] border px-1.5 py-0.5 text-[11px] lexel-mono"
                      style={{
                        backgroundColor: 'var(--lx-signal-bg)',
                        borderColor: 'var(--lx-signal)',
                        color: 'var(--lx-signal)',
                      }}
                    >
                      {snippet.trigger}
                    </span>{' '}
                    <span style={{ color: 'var(--lx-fg-muted)' }}>{snippet.expansion}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void onPatchSettings({
                        snippets: snippets.filter((s) => s.trigger !== snippet.trigger),
                      })
                    }
                    className="rounded-[4px] border px-2 py-0.5 text-[11px]"
                    style={{
                      backgroundColor: 'var(--lx-card)',
                      borderColor: 'var(--lx-border)',
                      color: 'var(--lx-fg-muted)',
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

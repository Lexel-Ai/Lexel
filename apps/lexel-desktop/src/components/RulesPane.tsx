import {
  HARPER_RULE_PRESETS,
  SLOP_TERMS,
  type RulePresetId,
} from 'lexel-ui';
import React, { useMemo, useState } from 'react';
import { daemonRpc } from '../lib/desktopClient';
import type { HarperRulesPayload, Hotkey, UnifiedDaemonSettings } from '../lib/types';

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

  const activeHotkey: Hotkey = settings.hotkey ?? { modifiers: ['Alt'], key: 'l' };

  const visibleRules = useMemo(() => {
    const rules = harperRules?.rules ?? [];
    const q = ruleSearch.trim().toLowerCase();
    const filtered = q
      ? rules.filter(
          (r) =>
            r.id.toLowerCase().includes(q) || r.description.toLowerCase().includes(q),
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

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[18px] font-semibold">Grammar, Anti-Slop, Extension &amp; Privacy</h1>
        <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
          Every deterministic Tier 0 rule and browser extension preference lives in lexel.db and syncs automatically.
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
              onChange={(e) =>
                void onPatchSettings({ openSuggestionsOnHover: e.target.checked })
              }
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
              No grammar rules match &ldquo;{ruleSearch}&rdquo;. Clear the filter to browse all rules.
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
            Lexel blocks local AI and pauses linting on matching hostnames (supports exact hosts or *.domain.com).
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
    </div>
  );
}

import {
  HARPER_RULE_PRESETS,
  SLOP_TERMS,
  type RulePresetId,
} from 'lexel-ui';
import React, { useMemo, useState } from 'react';
import { daemonRpc } from '../lib/desktopClient';
import type { HarperRulesPayload, UnifiedDaemonSettings } from '../lib/types';

interface RulesPaneProps {
  settings: UnifiedDaemonSettings;
  harperRules: HarperRulesPayload | null;
  onPatchSettings: (patch: Partial<UnifiedDaemonSettings>) => Promise<void>;
  onRefreshRules: () => Promise<void>;
}

const DIALECTS = [
  { id: 0, label: 'American English' },
  { id: 1, label: 'British English' },
  { id: 2, label: 'Canadian English' },
  { id: 3, label: 'Australian English' },
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

  const visibleRules = useMemo(() => {
    const rules = harperRules?.rules ?? [];
    const q = ruleSearch.trim().toLowerCase();
    const filtered = q
      ? rules.filter(
          (r) =>
            r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q),
        )
      : rules;
    return filtered.slice(0, 120);
  }, [harperRules, ruleSearch]);

  async function handlePreset(preset: RulePresetId) {
    await daemonRpc('applyRulePreset', { preset });
    await onRefreshRules();
  }

  async function toggleRule(name: string, nextValue: boolean) {
    const nextConfig = { ...settings.lintConfig, [name]: nextValue };
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

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[18px] font-semibold">Grammar, Anti-Slop &amp; Lexicon</h1>
        <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
          All deterministic Tier 0 rules live in lexel.db and stay synced with the browser extension.
        </p>
      </header>

      <section
        className="space-y-3 rounded-[8px] border p-3"
        style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
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
              className="rounded-[6px] border px-2.5 py-1.5 text-[12px]"
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

          <label className="flex items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={settings.isolateEnglish}
              onChange={(e) => void onPatchSettings({ isolateEnglish: e.target.checked })}
            />
            Isolate English segments in mixed-language text
          </label>
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
          {visibleRules.map((rule) => (
            <label
              key={rule.name}
              className="flex items-start justify-between gap-3 rounded-[6px] border px-2.5 py-2 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
              }}
            >
              <div>
                <div className="font-medium lexel-mono">{rule.name}</div>
                <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                  {rule.description}
                </div>
              </div>
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(e) => void toggleRule(rule.name, e.target.checked)}
                className="mt-0.5"
              />
            </label>
          ))}
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
            {settings.userDictionary.map((word) => (
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
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

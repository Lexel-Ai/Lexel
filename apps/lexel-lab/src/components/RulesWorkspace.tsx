import type { LintConfig } from 'harper.js';
import { RotateCcw, Search } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { SURFACE_PROFILES } from '../lib/surfaces';
import { SLOP_TERMS } from '../lib/verifier';

type RulesSubTab = 'grammar' | 'slop' | 'surfaces';

function stripHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export interface RulesWorkspaceProps {
  ruleConfig: LintConfig;
  defaultRuleConfig: LintConfig;
  ruleDescriptions: Record<string, string>;
  onRuleChange: (ruleId: string, value: boolean | null) => Promise<void>;
  onResetAllRules: () => Promise<void>;
}

export function RulesWorkspace({
  ruleConfig,
  defaultRuleConfig,
  ruleDescriptions,
  onRuleChange,
  onResetAllRules,
}: RulesWorkspaceProps) {
  const [subTab, setSubTab] = useState<RulesSubTab>('grammar');
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const ruleEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    return Object.keys(defaultRuleConfig)
      .sort()
      .filter((id) => {
        if (!q) return true;
        const desc = ruleDescriptions[id] ? stripHtml(ruleDescriptions[id]).toLowerCase() : '';
        return id.toLowerCase().includes(q) || desc.includes(q);
      })
      .map((id) => {
        const currentVal = ruleConfig[id] !== undefined ? ruleConfig[id] : defaultRuleConfig[id];
        const effectiveEnabled = currentVal !== false;
        const desc = ruleDescriptions[id] ? stripHtml(ruleDescriptions[id]) : 'Harper grammar rule.';
        return { id, effectiveEnabled, desc };
      });
  }, [ruleConfig, defaultRuleConfig, ruleDescriptions, search]);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-5xl mx-auto flex flex-col gap-5">
        <div className="flex flex-wrap items-end justify-between gap-3 pb-4 border-b" style={{ borderColor: 'var(--lx-border)' }}>
          <div>
            <h2 className="text-lg font-semibold tracking-tight m-0">Rules &amp; Lexicon</h2>
            <p className="text-xs m-0 mt-1" style={{ color: 'var(--lx-fg-muted)' }}>
              Inspect and toggle deterministic grammar rules, anti-slop terms, and platform constraints.
            </p>
          </div>
          <div className="flex gap-1.5" role="tablist" aria-label="Rule catalog sections">
            {(
              [
                { id: 'grammar', label: `Grammar (${Object.keys(defaultRuleConfig).length})` },
                { id: 'slop', label: `Anti-Slop (${SLOP_TERMS.length})` },
                { id: 'surfaces', label: `Surfaces (${SURFACE_PROFILES.length})` },
              ] as const
            ).map((item) => {
              const active = subTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setSubTab(item.id)}
                  className="rounded-[6px] border px-3 py-1.5 text-xs font-medium"
                  style={{
                    backgroundColor: active ? 'var(--lx-accent)' : 'var(--lx-surface)',
                    borderColor: active ? 'var(--lx-accent)' : 'var(--lx-border)',
                    color: active ? 'var(--lx-on-accent)' : 'var(--lx-fg)',
                  }}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>

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

        {subTab === 'grammar' ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="relative flex-1 min-w-[240px]">
                <Search
                  className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                  strokeWidth={1.75}
                  style={{ color: 'var(--lx-fg-muted)' }}
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search 900+ Harper rules by name or description..."
                  aria-label="Search grammar rules"
                  className="w-full rounded-[6px] border pl-8 pr-3 py-1.5 text-xs"
                  style={{
                    backgroundColor: 'var(--lx-surface)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  void onResetAllRules().then(() => setNotice('Reset all grammar rules to defaults.'));
                }}
                className="inline-flex items-center gap-1.5 rounded-[6px] border px-3 py-1.5 text-xs font-medium"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              >
                <RotateCcw className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
                <span>Reset defaults</span>
              </button>
            </div>

            {ruleEntries.length === 0 ? (
              <div className="py-10 text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
                {Object.keys(defaultRuleConfig).length === 0
                  ? 'Loading Harper rule catalog...'
                  : 'No rules match that filter.'}
              </div>
            ) : (
              <div
                className="rounded-[8px] border divide-y"
                style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-card)' }}
              >
                {ruleEntries.map((rule) => (
                  <label
                    key={rule.id}
                    className="px-4 py-3 flex items-start justify-between gap-4 text-xs"
                    style={{ borderColor: 'var(--lx-border)' }}
                  >
                    <div className="min-w-0">
                      <div className="font-semibold lexel-mono">{rule.id}</div>
                      <div className="text-[11px] mt-0.5 leading-relaxed" style={{ color: 'var(--lx-fg-muted)' }}>
                        {rule.desc}
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={rule.effectiveEnabled}
                      onChange={(e) => void onRuleChange(rule.id, e.target.checked)}
                      className="mt-0.5"
                    />
                  </label>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {subTab === 'slop' ? (
          <div className="flex flex-col gap-3">
            <p className="text-xs m-0" style={{ color: 'var(--lx-fg-muted)' }}>
              Loaded directly from <span className="lexel-mono">rules/slop_terms.json</span>. Matched case-insensitively at Tier 0 in sub-millisecond time.
            </p>
            <div className="flex flex-wrap gap-2">
              {SLOP_TERMS.map((term) => (
                <span
                  key={term}
                  className="rounded-[4px] border px-2.5 py-1 text-xs lexel-mono"
                  style={{
                    backgroundColor: 'var(--lx-surface)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                >
                  {term}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {subTab === 'surfaces' ? (
          <div className="flex flex-col gap-3">
            <p className="text-xs m-0" style={{ color: 'var(--lx-fg-muted)' }}>
              Loaded directly from <span className="lexel-mono">ml/personas/surfaces.json</span>. Governs both Tier 0 warnings and Tier 1/2 AI prompts.
            </p>
            <div
              className="rounded-[8px] border divide-y"
              style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-card)' }}
            >
              {SURFACE_PROFILES.map((p) => (
                <div key={p.id} className="p-4 flex flex-col gap-1.5" style={{ borderColor: 'var(--lx-border)' }}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{p.label}</span>
                      <span className="lexel-mono text-[11px]" style={{ color: 'var(--lx-signal)' }}>
                        {p.id}
                      </span>
                    </div>
                    <span className="lexel-mono text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                      {p.minChars}–{p.maxChars} chars · links:{p.allowLinks ? 'yes' : 'no'} · emojis:
                      {p.allowEmojis ? 'yes' : 'no'} · hashtags:{p.allowHashtags ? 'yes' : 'no'} · em-dash:
                      {p.allowEmDashes ? 'yes' : 'no'}
                    </span>
                  </div>
                  <p className="text-xs m-0" style={{ color: 'var(--lx-fg-muted)' }}>
                    {p.promptDirective}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

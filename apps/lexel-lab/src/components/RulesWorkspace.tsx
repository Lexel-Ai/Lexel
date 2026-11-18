import {
  type LintConfig,
  type StructuredLintConfig,
  type StructuredLintSetting,
  type WeirpackTestFailures,
  unpackWeirpackBytes,
} from 'harper.js';
import { packWeirpackFiles } from 'harper.js';
import { HARPER_RULE_PRESETS, type RulePresetId } from 'lexel-ui';
import { PackagePlus, Plus, RotateCcw, Search, Trash2, Upload } from 'lucide-react';
import React, { useMemo, useRef, useState } from 'react';
import { listSurfaceProfiles } from '../lib/surfaces';
import type { StoredWeirpack, SurfaceProfile } from '../lib/types';
import { SLOP_TERMS } from '../lib/verifier';

type RulesSubTab = 'grammar' | 'slop' | 'surfaces' | 'weirpacks';

function stripHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function settingMatchesQuery(
  setting: StructuredLintSetting,
  query: string,
  descriptions: Record<string, string>,
): boolean {
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
    return (
      setting.OneOfMany.names.some((n) => n.toLowerCase().includes(query)) ||
      (setting.OneOfMany.labels ?? []).some((l) => l.toLowerCase().includes(query))
    );
  }
  return (
    setting.Group.label.toLowerCase().includes(query) ||
    setting.Group.description.toLowerCase().includes(query) ||
    setting.Group.child.settings.some((child) => settingMatchesQuery(child, query, descriptions))
  );
}

export interface RulesWorkspaceProps {
  ruleConfig: LintConfig;
  defaultRuleConfig: LintConfig;
  structuredConfig: StructuredLintConfig | null;
  ruleDescriptions: Record<string, string>;
  customSlopTerms: string[];
  disabledSlopTerms: string[];
  customSurfaces: SurfaceProfile[];
  weirpacks: StoredWeirpack[];
  onRuleChange: (ruleId: string, value: boolean | null) => Promise<void>;
  onOneOfManyChange: (names: string[], selected: string | null) => Promise<void>;
  onResetAllRules: () => Promise<void>;
  onApplyRulePreset?: (presetId: RulePresetId) => Promise<void>;
  onUpdateCustomSlop: (customTerms: string[], disabledTerms: string[]) => void;
  onUpdateCustomSurfaces: (surfaces: SurfaceProfile[]) => void;
  onImportWeirpack: (
    name: string,
    bytes: Uint8Array,
    ruleCount: number,
  ) => Promise<WeirpackTestFailures | undefined>;
  onToggleWeirpack: (name: string, enabled: boolean) => void;
  onRemoveWeirpack: (name: string) => void;
}

export function RulesWorkspace({
  ruleConfig,
  defaultRuleConfig,
  structuredConfig,
  ruleDescriptions,
  customSlopTerms,
  disabledSlopTerms,
  customSurfaces,
  weirpacks,
  onRuleChange,
  onOneOfManyChange,
  onResetAllRules,
  onApplyRulePreset,
  onUpdateCustomSlop,
  onUpdateCustomSurfaces,
  onImportWeirpack,
  onToggleWeirpack,
  onRemoveWeirpack,
}: RulesWorkspaceProps) {
  const [subTab, setSubTab] = useState<RulesSubTab>('grammar');
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [weirRuleName, setWeirRuleName] = useState('CustomAvoidSynergy');
  const [weirExpr, setWeirExpr] = useState('synergy');
  const [weirReplacement, setWeirReplacement] = useState('coordination');
  const [weirMessage, setWeirMessage] = useState('Use plain phrasing instead of buzzword.');
  const [weirTestBad, setWeirTestBad] = useState('We need team synergy now.');
  const [weirTestGood, setWeirTestGood] = useState('We need team coordination now.');

  const [newSlopTerm, setNewSlopTerm] = useState('');
  const [surfaceIdDraft, setSurfaceIdDraft] = useState('');
  const [surfaceLabelDraft, setSurfaceLabelDraft] = useState('');
  const [surfaceMaxChars, setSurfaceMaxChars] = useState(1200);
  const [surfaceDirective, setSurfaceDirective] = useState('');
  const [surfaceAllowLinks, setSurfaceAllowLinks] = useState(true);
  const [surfaceAllowEmojis, setSurfaceAllowEmojis] = useState(false);
  const [surfaceAllowHashtags, setSurfaceAllowHashtags] = useState(false);
  const [surfaceAllowEmDashes, setSurfaceAllowEmDashes] = useState(false);

  const weirpackInputRef = useRef<HTMLInputElement | null>(null);

  const allSurfaces = useMemo(() => listSurfaceProfiles(customSurfaces), [customSurfaces]);
  const disabledSet = useMemo(
    () => new Set(disabledSlopTerms.map((t) => t.toLowerCase())),
    [disabledSlopTerms],
  );
  const customIds = useMemo(() => new Set(customSurfaces.map((s) => s.id)), [customSurfaces]);

  const query = search.trim().toLowerCase();

  const fallbackEntries = useMemo(() => {
    return Object.keys(defaultRuleConfig)
      .sort()
      .filter((id) => {
        if (!query) return true;
        const desc = ruleDescriptions[id] ? stripHtml(ruleDescriptions[id]).toLowerCase() : '';
        return id.toLowerCase().includes(query) || desc.includes(query);
      })
      .map((id) => {
        const currentVal = ruleConfig[id] !== undefined ? ruleConfig[id] : defaultRuleConfig[id];
        const effectiveEnabled = currentVal !== false;
        const desc = ruleDescriptions[id] ? stripHtml(ruleDescriptions[id]) : 'Harper grammar rule.';
        return { id, effectiveEnabled, desc };
      });
  }, [ruleConfig, defaultRuleConfig, ruleDescriptions, query]);

  function resolveBoolState(name: string, defaultState: boolean): boolean {
    if (ruleConfig[name] !== undefined && ruleConfig[name] !== null) {
      return ruleConfig[name] === true;
    }
    if (defaultRuleConfig[name] !== undefined && defaultRuleConfig[name] !== null) {
      return defaultRuleConfig[name] === true;
    }
    return defaultState;
  }

  function resolveSelectedOneOfMany(names: string[], fallback?: string | null): string {
    const active = names.find((n) => ruleConfig[n] === true);
    if (active) return active;
    if (names.every((n) => ruleConfig[n] === false)) return '';
    return fallback ?? names.find((n) => defaultRuleConfig[n] === true) ?? '';
  }

  function renderStructuredSettings(settings: StructuredLintSetting[], depth = 0): React.ReactNode {
    const visible = settings.filter((s) => settingMatchesQuery(s, query, ruleDescriptions));
    if (visible.length === 0) return null;

    return (
      <div className="flex flex-col gap-2">
        {visible.map((setting, idx) => {
          if ('Group' in setting) {
            const { label, description, child } = setting.Group;
            return (
              <details
                key={`group-${depth}-${label}-${idx}`}
                open={depth === 0 || query.length > 0}
                className="rounded-[8px] border overflow-hidden"
                style={{
                  borderColor: 'var(--lx-border)',
                  backgroundColor: depth === 0 ? 'var(--lx-card)' : 'var(--lx-surface)',
                }}
              >
                <summary className="px-4 py-3 cursor-pointer flex items-center justify-between gap-3 text-xs font-semibold">
                  <span>{label}</span>
                  <span className="text-[11px] font-normal" style={{ color: 'var(--lx-fg-muted)' }}>
                    {child.settings.length} items
                  </span>
                </summary>
                <div
                  className="px-4 pb-4 pt-2 border-t flex flex-col gap-2.5"
                  style={{ borderColor: 'var(--lx-border)' }}
                >
                  {description ? (
                    <p className="text-[11px] m-0" style={{ color: 'var(--lx-fg-muted)' }}>
                      {description}
                    </p>
                  ) : null}
                  {renderStructuredSettings(child.settings, depth + 1)}
                </div>
              </details>
            );
          }

          if ('OneOfMany' in setting) {
            const { names, name, labels } = setting.OneOfMany;
            const current = resolveSelectedOneOfMany(names, name);
            return (
              <div
                key={`oneof-${names.join('-')}`}
                className="rounded-[6px] border px-3 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs"
                style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-surface)' }}
              >
                <div className="min-w-0">
                  <div className="font-semibold lexel-mono">{names[0]}</div>
                  <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                    Select one active variant from this rule group.
                  </div>
                </div>
                <select
                  aria-label={`Select option for ${names[0]}`}
                  value={current}
                  onChange={(e) => {
                    const chosen = e.target.value || null;
                    void onOneOfManyChange(names, chosen);
                  }}
                  className="rounded-[6px] border px-2.5 py-1 text-xs"
                  style={{
                    backgroundColor: 'var(--lx-bg)',
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
          const desc = ruleDescriptions[name] ? stripHtml(ruleDescriptions[name]) : '';
          const checked = resolveBoolState(name, state);
          return (
            <label
              key={`bool-${name}`}
              className="rounded-[6px] border px-3 py-2.5 flex items-start justify-between gap-4 text-xs"
              style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-surface)' }}
            >
              <div className="min-w-0">
                <div className="font-semibold lexel-mono">{label ?? name}</div>
                {label && label !== name ? (
                  <div className="text-[10px] lexel-mono" style={{ color: 'var(--lx-fg-muted)' }}>
                    {name}
                  </div>
                ) : null}
                {desc ? (
                  <div className="text-[11px] mt-0.5 leading-relaxed" style={{ color: 'var(--lx-fg-muted)' }}>
                    {desc}
                  </div>
                ) : null}
              </div>
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => void onRuleChange(name, e.target.checked)}
                className="mt-0.5"
              />
            </label>
          );
        })}
      </div>
    );
  }

  async function handleWeirpackUpload(file: File | undefined) {
    if (!file) return;
    setNotice(null);
    setErrorMsg(null);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const archive = unpackWeirpackBytes(buf);
      const ruleCount = [...archive.files.keys()].filter((k) => k.endsWith('.weir')).length;
      const failures = await onImportWeirpack(file.name, buf, ruleCount);
      if (failures && Object.keys(failures).length > 0) {
        const summary = Object.entries(failures)
          .map(([rule, cases]) => `${rule}: ${cases.length} failing case(s)`)
          .join('; ');
        setErrorMsg(`Weirpack tests failed (${summary}). Pack was not enabled.`);
        return;
      }
      setNotice(`Loaded "${file.name}" (${ruleCount} rule${ruleCount === 1 ? '' : 's'}) and verified embedded Weir tests.`);
    } catch (err) {
      setErrorMsg(`Invalid Weirpack archive: ${(err as Error).message}`);
    }
  }

  async function handleBuildWeirpack(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    setErrorMsg(null);
    const cleanName = weirRuleName.replace(/[^A-Za-z0-9_]/g, '') || 'CustomLexelRule';
    const rawExpr = weirExpr.trim();
    if (!rawExpr || !weirReplacement.trim()) {
      setErrorMsg('Provide both a target phrase and a replacement.');
      return;
    }
    const exprClause =
      rawExpr.includes(' ') && !rawExpr.startsWith('(') ? `(${rawExpr})` : rawExpr;
    const esc = (v: string) => v.replaceAll('"', '\\"');
    const lines = [
      `expr main ${exprClause}`,
      `let message "${esc(weirMessage.trim() || `Prefer ${weirReplacement.trim()}.`)}"`,
      `let description "Custom Lexel Weir rule"`,
      `let kind "Style"`,
      `let becomes "${esc(weirReplacement.trim())}"`,
      `let strategy "MatchCase"`,
    ];
    if (weirTestBad.trim() && weirTestGood.trim()) {
      lines.push(`test "${esc(weirTestBad.trim())}" "${esc(weirTestGood.trim())}"`);
    }
    try {
      const files = new Map<string, string>([
        [
          'manifest.json',
          JSON.stringify(
            {
              name: `${cleanName}.weirpack`,
              author: 'Lexel Lab User',
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
      const buf = packWeirpackFiles(files);
      const failures = await onImportWeirpack(`${cleanName}.weirpack`, buf, 1);
      if (failures && Object.keys(failures).length > 0) {
        const summary = Object.entries(failures)
          .map(([rule, cases]) => `${rule}: ${cases.length} failing case(s)`)
          .join('; ');
        setErrorMsg(`Weirpack tests failed (${summary}). Pack was not enabled.`);
        return;
      }
      setNotice(`Built and verified ${cleanName}.weirpack (embedded Weir tests passed).`);
    } catch (err) {
      setErrorMsg(`Failed to build Weirpack: ${(err as Error).message}`);
    }
  }

  function handleAddCustomSlop(e: React.FormEvent) {
    e.preventDefault();
    const cleaned = newSlopTerm.trim();
    if (!cleaned) return;
    if (!customSlopTerms.some((t) => t.toLowerCase() === cleaned.toLowerCase())) {
      onUpdateCustomSlop([...customSlopTerms, cleaned], disabledSlopTerms);
    }
    setNewSlopTerm('');
  }

  function toggleBuiltinSlop(term: string) {
    const lower = term.toLowerCase();
    if (disabledSet.has(lower)) {
      onUpdateCustomSlop(
        customSlopTerms,
        disabledSlopTerms.filter((t) => t.toLowerCase() !== lower),
      );
    } else {
      onUpdateCustomSlop(customSlopTerms, [...disabledSlopTerms, term]);
    }
  }

  function handleCreateSurface(e: React.FormEvent) {
    e.preventDefault();
    const rawId = surfaceIdDraft
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_');
    const label = surfaceLabelDraft.trim();
    if (!rawId || !label) {
      setErrorMsg('Provide both a surface ID slug and display label.');
      return;
    }
    setErrorMsg(null);
    const created: SurfaceProfile = {
      id: rawId,
      label,
      hostPatterns: [],
      register: 'custom',
      minChars: 1,
      maxChars: Math.max(40, surfaceMaxChars),
      allowLinks: surfaceAllowLinks,
      allowEmojis: surfaceAllowEmojis,
      allowHashtags: surfaceAllowHashtags,
      allowEmDashes: surfaceAllowEmDashes,
      bannedOpeners: [],
      promptDirective:
        surfaceDirective.trim() || `Write in clear, concise prose tailored to ${label}.`,
      quickActions: [
        { id: 'rewrite_surface', label: `Match ${label}` },
        { id: 'deslop', label: 'Remove AI slop' },
      ],
    };
    const next = [...customSurfaces.filter((s) => s.id !== created.id), created];
    onUpdateCustomSurfaces(next);
    setSurfaceIdDraft('');
    setSurfaceLabelDraft('');
    setSurfaceDirective('');
    setNotice(`Saved custom surface "${label}".`);
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-5xl mx-auto flex flex-col gap-5">
        <div
          className="flex flex-wrap items-end justify-between gap-3 pb-4 border-b"
          style={{ borderColor: 'var(--lx-border)' }}
        >
          <div>
            <h2 className="text-lg font-semibold tracking-tight m-0">Rules, Packs &amp; Surfaces</h2>
            <p className="text-xs m-0 mt-1" style={{ color: 'var(--lx-fg-muted)' }}>
              Configure grouped Harper rules, custom anti-slop terms, custom surfaces, and local .weirpack rule packs.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Rule catalog sections">
            {(
              [
                { id: 'grammar', label: `Grammar (${Object.keys(defaultRuleConfig).length})` },
                { id: 'slop', label: `Anti-Slop (${SLOP_TERMS.length + customSlopTerms.length})` },
                { id: 'surfaces', label: `Surfaces (${allSurfaces.length})` },
                { id: 'weirpacks', label: `Weirpacks (${weirpacks.length})` },
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

        {subTab === 'grammar' ? (
          <div className="flex flex-col gap-3">
            {onApplyRulePreset ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-medium mr-1" style={{ color: 'var(--lx-fg-muted)' }}>
                  Rule Presets:
                </span>
                {HARPER_RULE_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    title={preset.description}
                    onClick={() => {
                      void onApplyRulePreset(preset.id).then(() =>
                        setNotice(`Applied "${preset.label}" rule preset.`),
                      );
                    }}
                    className="rounded-[6px] border px-2.5 py-1 text-[11px] font-medium"
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
            ) : null}
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
                  placeholder="Search Harper categories and rules by name or description..."
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

            {structuredConfig ? (
              renderStructuredSettings(structuredConfig.settings) ?? (
                <div className="py-10 text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
                  No rule groups match that filter.
                </div>
              )
            ) : fallbackEntries.length === 0 ? (
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
                {fallbackEntries.map((rule) => (
                  <label
                    key={rule.id}
                    className="px-4 py-3 flex items-start justify-between gap-4 text-xs"
                    style={{ borderColor: 'var(--lx-border)' }}
                  >
                    <div className="min-w-0">
                      <div className="font-semibold lexel-mono">{rule.id}</div>
                      <div
                        className="text-[11px] mt-0.5 leading-relaxed"
                        style={{ color: 'var(--lx-fg-muted)' }}
                      >
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
          <div className="flex flex-col gap-4">
            <form onSubmit={handleAddCustomSlop} className="flex flex-wrap gap-2">
              <input
                type="text"
                value={newSlopTerm}
                onChange={(e) => setNewSlopTerm(e.target.value)}
                placeholder="Add custom banned phrase (e.g. circle back)"
                aria-label="Add custom banned phrase"
                className="flex-1 min-w-[220px] rounded-[6px] border px-3 py-1.5 text-xs"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-xs font-semibold"
                style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
              >
                <Plus className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
                <span>Add term</span>
              </button>
            </form>

            {customSlopTerms.length > 0 ? (
              <div className="flex flex-col gap-2">
                <div className="text-xs font-semibold">Custom Terms ({customSlopTerms.length})</div>
                <div className="flex flex-wrap gap-2">
                  {customSlopTerms.map((term) => (
                    <span
                      key={term}
                      className="inline-flex items-center gap-1.5 rounded-[4px] border px-2.5 py-1 text-xs lexel-mono"
                      style={{
                        backgroundColor: 'var(--lx-signal-bg)',
                        borderColor: 'var(--lx-signal)',
                        color: 'var(--lx-signal)',
                      }}
                    >
                      <span>{term}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${term}`}
                        onClick={() =>
                          onUpdateCustomSlop(
                            customSlopTerms.filter((t) => t !== term),
                            disabledSlopTerms,
                          )
                        }
                        className="opacity-80 hover:opacity-100"
                      >
                        <Trash2 className="w-3 h-3" strokeWidth={1.75} aria-hidden="true" />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex flex-col gap-2">
              <p className="text-xs m-0" style={{ color: 'var(--lx-fg-muted)' }}>
                Built-in terms from <span className="lexel-mono">rules/slop_terms.json</span>. Click any chip to mute or re-enable it.
              </p>
              <div className="flex flex-wrap gap-2">
                {SLOP_TERMS.map((term) => {
                  const muted = disabledSet.has(term.toLowerCase());
                  return (
                    <button
                      key={term}
                      type="button"
                      onClick={() => toggleBuiltinSlop(term)}
                      className="rounded-[4px] border px-2.5 py-1 text-xs lexel-mono"
                      style={{
                        backgroundColor: 'var(--lx-surface)',
                        borderColor: 'var(--lx-border)',
                        color: muted ? 'var(--lx-fg-muted)' : 'var(--lx-fg)',
                        textDecoration: muted ? 'line-through' : 'none',
                        opacity: muted ? 0.65 : 1,
                      }}
                    >
                      {term}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : null}

        {subTab === 'surfaces' ? (
          <div className="flex flex-col gap-4">
            <form
              onSubmit={handleCreateSurface}
              className="rounded-[8px] border p-4 flex flex-col gap-3"
              style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-card)' }}
            >
              <div className="text-xs font-semibold">Add Custom Surface Profile</div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                <input
                  type="text"
                  value={surfaceIdDraft}
                  onChange={(e) => setSurfaceIdDraft(e.target.value)}
                  placeholder="ID slug (e.g. changelog)"
                  aria-label="Custom surface ID"
                  className="rounded-[6px] border px-2.5 py-1.5 text-xs lexel-mono"
                  style={{
                    backgroundColor: 'var(--lx-surface)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
                <input
                  type="text"
                  value={surfaceLabelDraft}
                  onChange={(e) => setSurfaceLabelDraft(e.target.value)}
                  placeholder="Display label (e.g. Release Notes)"
                  aria-label="Custom surface label"
                  className="rounded-[6px] border px-2.5 py-1.5 text-xs"
                  style={{
                    backgroundColor: 'var(--lx-surface)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
                <input
                  type="number"
                  min={40}
                  max={20000}
                  value={surfaceMaxChars}
                  onChange={(e) => setSurfaceMaxChars(Number.parseInt(e.target.value || '1200', 10))}
                  aria-label="Max characters"
                  className="rounded-[6px] border px-2.5 py-1.5 text-xs lexel-mono"
                  style={{
                    backgroundColor: 'var(--lx-surface)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
              </div>
              <input
                type="text"
                value={surfaceDirective}
                onChange={(e) => setSurfaceDirective(e.target.value)}
                placeholder="Prompt & tone directive (optional)"
                aria-label="Custom surface directive"
                className="rounded-[6px] border px-2.5 py-1.5 text-xs"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
              <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="flex flex-wrap gap-4">
                  <label className="inline-flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={surfaceAllowLinks}
                      onChange={(e) => setSurfaceAllowLinks(e.target.checked)}
                    />
                    <span>Allow links</span>
                  </label>
                  <label className="inline-flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={surfaceAllowEmojis}
                      onChange={(e) => setSurfaceAllowEmojis(e.target.checked)}
                    />
                    <span>Allow emojis</span>
                  </label>
                  <label className="inline-flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={surfaceAllowHashtags}
                      onChange={(e) => setSurfaceAllowHashtags(e.target.checked)}
                    />
                    <span>Allow hashtags</span>
                  </label>
                  <label className="inline-flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={surfaceAllowEmDashes}
                      onChange={(e) => setSurfaceAllowEmDashes(e.target.checked)}
                    />
                    <span>Allow em dashes</span>
                  </label>
                </div>
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-xs font-semibold"
                  style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
                >
                  <Plus className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
                  <span>Save Surface</span>
                </button>
              </div>
            </form>

            <div
              className="rounded-[8px] border divide-y"
              style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-card)' }}
            >
              {allSurfaces.map((p) => (
                <div
                  key={p.id}
                  className="p-4 flex flex-col gap-1.5"
                  style={{ borderColor: 'var(--lx-border)' }}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{p.label}</span>
                      <span className="lexel-mono text-[11px]" style={{ color: 'var(--lx-signal)' }}>
                        {p.id}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="lexel-mono text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                        {p.minChars}-{p.maxChars} chars · links:{p.allowLinks ? 'yes' : 'no'} · emojis:
                        {p.allowEmojis ? 'yes' : 'no'} · hashtags:{p.allowHashtags ? 'yes' : 'no'} · em-dash:
                        {p.allowEmDashes ? 'yes' : 'no'}
                      </span>
                      {customIds.has(p.id) ? (
                        <button
                          type="button"
                          aria-label={`Delete surface ${p.label}`}
                          onClick={() =>
                            onUpdateCustomSurfaces(customSurfaces.filter((s) => s.id !== p.id))
                          }
                          className="rounded-[4px] border p-1"
                          style={{
                            borderColor: 'var(--lx-border)',
                            color: 'var(--lx-danger)',
                          }}
                        >
                          <Trash2 className="w-3 h-3" strokeWidth={1.75} aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <p className="text-xs m-0" style={{ color: 'var(--lx-fg-muted)' }}>
                    {p.promptDirective}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {subTab === 'weirpacks' ? (
          <div className="flex flex-col gap-4">
            <div
              className="rounded-[8px] border p-4 flex flex-wrap items-center justify-between gap-3"
              style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-card)' }}
            >
              <div>
                <div className="text-xs font-semibold flex items-center gap-1.5">
                  <PackagePlus className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
                  <span>Import Harper .weirpack Archive</span>
                </div>
                <p className="text-[11px] m-0 mt-1" style={{ color: 'var(--lx-fg-muted)' }}>
                  Upload local Weir rule packs. Lexel runs every embedded Weir unit test inside the pack before enabling it.
                </p>
              </div>
              <input
                ref={weirpackInputRef}
                type="file"
                accept=".weirpack,application/zip"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  void handleWeirpackUpload(file);
                  e.target.value = '';
                }}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => weirpackInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-xs font-semibold"
                style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
              >
                <Upload className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
                <span>Upload .weirpack</span>
              </button>
            </div>

            <form
              onSubmit={(e) => void handleBuildWeirpack(e)}
              className="rounded-[8px] border p-4 flex flex-col gap-3"
              style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-card)' }}
            >
              <div className="text-xs font-semibold">Build &amp; Verify Custom Weir Rule</div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                <input
                  type="text"
                  value={weirRuleName}
                  onChange={(e) => setWeirRuleName(e.target.value)}
                  placeholder="Rule ID (e.g. CustomAvoidSynergy)"
                  aria-label="Weir rule name"
                  className="rounded-[6px] border px-2.5 py-1.5 text-xs lexel-mono"
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
                  placeholder="Target phrase (e.g. delve into)"
                  aria-label="Weir target phrase"
                  className="rounded-[6px] border px-2.5 py-1.5 text-xs"
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
                  placeholder="Plain replacement"
                  aria-label="Weir replacement"
                  className="rounded-[6px] border px-2.5 py-1.5 text-xs"
                  style={{
                    backgroundColor: 'var(--lx-surface)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
              </div>
              <input
                type="text"
                value={weirMessage}
                onChange={(e) => setWeirMessage(e.target.value)}
                placeholder="Hint message"
                aria-label="Weir hint message"
                className="rounded-[6px] border px-2.5 py-1.5 text-xs"
                style={{
                  backgroundColor: 'var(--lx-surface)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                <input
                  type="text"
                  value={weirTestBad}
                  onChange={(e) => setWeirTestBad(e.target.value)}
                  placeholder="Embedded Weir test (before)"
                  aria-label="Weir test before"
                  className="rounded-[6px] border px-2.5 py-1.5 text-xs"
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
                  placeholder="Embedded Weir test (after)"
                  aria-label="Weir test after"
                  className="rounded-[6px] border px-2.5 py-1.5 text-xs"
                  style={{
                    backgroundColor: 'var(--lx-surface)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
              </div>
              <div className="flex justify-end">
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 rounded-[6px] border px-3 py-1.5 text-xs font-semibold"
                  style={{
                    backgroundColor: 'var(--lx-surface)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                >
                  <Plus className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
                  <span>Test &amp; Enable Weirpack</span>
                </button>
              </div>
            </form>

            {weirpacks.length === 0 ? (
              <div className="py-8 text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
                No custom Weirpacks installed yet.
              </div>
            ) : (
              <div
                className="rounded-[8px] border divide-y"
                style={{ borderColor: 'var(--lx-border)', backgroundColor: 'var(--lx-card)' }}
              >
                {weirpacks.map((pack) => (
                  <div
                    key={pack.name}
                    className="px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs"
                    style={{ borderColor: 'var(--lx-border)' }}
                  >
                    <div>
                      <div className="font-semibold lexel-mono">{pack.name}</div>
                      <div className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
                        {pack.ruleCount} Weir rule{pack.ruleCount === 1 ? '' : 's'}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <label className="inline-flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={pack.enabled}
                          onChange={(e) => onToggleWeirpack(pack.name, e.target.checked)}
                        />
                        <span>Enabled</span>
                      </label>
                      <button
                        type="button"
                        aria-label={`Remove ${pack.name}`}
                        onClick={() => onRemoveWeirpack(pack.name)}
                        className="rounded-[4px] border p-1"
                        style={{ borderColor: 'var(--lx-border)', color: 'var(--lx-danger)' }}
                      >
                        <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

import {
  EditableSurfaceCard,
  resetSurfaceOverride,
  type SurfaceProfile,
  upsertSurfaceOverride,
} from 'lexel-ui';
import type React from 'react';
import { useMemo, useState } from 'react';
import { BUILTIN_STARTER_SNIPPETS, expandContextSnippet } from '../lib/desktopClient';
import { mergeSurfaceCatalog } from '../lib/surfaces';
import type { ExtendedTextSnippet, UnifiedDaemonSettings } from '../lib/types';

interface SurfacesPaneProps {
  settings: UnifiedDaemonSettings;
  onPatchSettings: (patch: Partial<UnifiedDaemonSettings>) => Promise<void>;
}

export function SurfacesPane({ settings, onPatchSettings }: SurfacesPaneProps) {
  const [filter, setFilter] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newPrompt, setNewPrompt] = useState('');

  // Context-Aware Snippets Editor state
  const [snippetTrigger, setSnippetTrigger] = useState('');
  const [snippetLabel, setSnippetLabel] = useState('');
  const [snippetExpansion, setSnippetExpansion] = useState('');
  const [snippetSurfaceId, setSnippetSurfaceId] = useState<string>('');
  const [snippetAdapt, setSnippetAdapt] = useState(true);
  const [previewTrigger, setPreviewTrigger] = useState('/standup');
  const [previewSurfaceId, setPreviewSurfaceId] = useState('web_discord_slack');
  const [previewNotes, setPreviewNotes] = useState('Shipped hunk diff view');
  const [previewResult, setPreviewResult] = useState<string | null>(null);
  const [snippetError, setSnippetError] = useState<string | null>(null);

  const { surfaces, customOnlyIds } = useMemo(
    () => mergeSurfaceCatalog(settings.customSurfaces),
    [settings.customSurfaces],
  );

  const userSnippets: ExtendedTextSnippet[] = settings.snippets ?? [];
  const allSnippets = useMemo(() => {
    const userTriggers = new Set(userSnippets.map((s) => s.trigger));
    return [
      ...userSnippets,
      ...BUILTIN_STARTER_SNIPPETS.filter((b) => !userTriggers.has(b.trigger)),
    ];
  }, [userSnippets]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return surfaces;
    return surfaces.filter(
      (s) =>
        s.label.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        s.promptDirective.toLowerCase().includes(q),
    );
  }, [filter, surfaces]);

  async function handleSaveOverride(
    baseSurface: SurfaceProfile,
    patch: Partial<
      Pick<
        SurfaceProfile,
        | 'promptDirective'
        | 'maxChars'
        | 'allowLinks'
        | 'allowEmojis'
        | 'allowHashtags'
        | 'allowEmDashes'
      >
    >,
  ) {
    const next = upsertSurfaceOverride(settings.customSurfaces, baseSurface, patch);
    await onPatchSettings({ customSurfaces: next });
  }

  async function handleResetOrDelete(profile: SurfaceProfile, isCustomOnly: boolean) {
    const next = isCustomOnly
      ? settings.customSurfaces.filter((s) => s.id !== profile.id)
      : resetSurfaceOverride(settings.customSurfaces, profile.id);
    await onPatchSettings({ customSurfaces: next });
  }

  async function handleAddCustomSurface(e: React.FormEvent) {
    e.preventDefault();
    const label = newLabel.trim();
    const promptDirective = newPrompt.trim();
    if (!label || !promptDirective) return;

    const slug = `custom_${label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')}`;
    const created: SurfaceProfile = {
      id: slug,
      label,
      hostPatterns: [],
      register: 'custom',
      minChars: 0,
      maxChars: 2000,
      allowHashtags: true,
      allowEmojis: true,
      allowEmDashes: false,
      allowLinks: true,
      bannedOpeners: [],
      promptDirective,
      quickActions: [{ id: 'deslop', label: 'Deslop' }],
    };

    const next = upsertSurfaceOverride(settings.customSurfaces, created, {});
    await onPatchSettings({ customSurfaces: next });
    setNewLabel('');
    setNewPrompt('');
  }

  async function handleSaveSnippet(e: React.FormEvent) {
    e.preventDefault();
    setSnippetError(null);
    const rawTrigger = snippetTrigger.trim();
    const expansion = snippetExpansion.trim();
    if (rawTrigger.length < 2 || !expansion) {
      setSnippetError(
        'Trigger (at least 2 chars, e.g. /standup or ;lgtm) and expansion text are required.',
      );
      return;
    }
    const nextSnippet: ExtendedTextSnippet = {
      trigger: rawTrigger,
      expansion,
      label: snippetLabel.trim() || rawTrigger,
      surfaceId: snippetSurfaceId || null,
      adaptToSurface: snippetAdapt,
      builtIn: false,
    };
    const next = [...userSnippets.filter((s) => s.trigger !== rawTrigger), nextSnippet];
    await onPatchSettings({ snippets: next });
    setSnippetTrigger('');
    setSnippetLabel('');
    setSnippetExpansion('');
    setSnippetSurfaceId('');
    setPreviewTrigger(rawTrigger);
  }

  async function handlePreviewSnippet() {
    setSnippetError(null);
    try {
      const res = await expandContextSnippet({
        trigger: previewTrigger,
        surfaceId: previewSurfaceId,
        notes: previewNotes,
        adaptWithAi: false,
      });
      setPreviewResult(res.expandedText);
    } catch (err) {
      setSnippetError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.02em]">
            Surfaces &amp; Context-Aware Snippets
          </h1>
          <p className="mt-0.5 text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
            Manage slash snippets that adapt to the active surface and customize AI directives per
            platform.
          </p>
        </div>
      </header>

      {/* Context-Aware Snippets Editor */}
      <section
        aria-label="Context-Aware Snippets Editor"
        className="space-y-3 rounded-[8px] border p-4"
        style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
      >
        <div>
          <h2 className="text-[14px] font-semibold">
            Context-Aware Snippets ({allSnippets.length})
          </h2>
          <p className="mt-0.5 text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
            Type a trigger like <code className="lexel-mono">/standup</code>,{' '}
            <code className="lexel-mono">/lgtm</code>, or{' '}
            <code className="lexel-mono">/decline</code> then Space in Studio or any browser box.
            Placeholders: <code className="lexel-mono">{'{{date}}'}</code>,{' '}
            <code className="lexel-mono">{'{{surface}}'}</code>,{' '}
            <code className="lexel-mono">{'{{notes}}'}</code>.
          </p>
        </div>

        {snippetError ? (
          <div
            role="alert"
            className="rounded-[6px] border px-3 py-2 text-[12px]"
            style={{
              backgroundColor: 'var(--lx-danger-bg)',
              borderColor: 'var(--lx-danger)',
              color: 'var(--lx-danger)',
            }}
          >
            {snippetError}
          </div>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
          <form onSubmit={handleSaveSnippet} className="space-y-2.5">
            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <label
                  htmlFor="snippet-trigger-input"
                  className="mb-1 block text-[11px] font-medium"
                  style={{ color: 'var(--lx-fg-muted)' }}
                >
                  Trigger
                </label>
                <input
                  id="snippet-trigger-input"
                  type="text"
                  value={snippetTrigger}
                  onChange={(e) => setSnippetTrigger(e.target.value)}
                  placeholder="/standup or ;sig"
                  className="w-full rounded-[6px] border px-2.5 py-1.5 text-[12px] lexel-mono"
                  style={{
                    backgroundColor: 'var(--lx-surface)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
              </div>
              <div>
                <label
                  htmlFor="snippet-label-input"
                  className="mb-1 block text-[11px] font-medium"
                  style={{ color: 'var(--lx-fg-muted)' }}
                >
                  Label
                </label>
                <input
                  id="snippet-label-input"
                  type="text"
                  value={snippetLabel}
                  onChange={(e) => setSnippetLabel(e.target.value)}
                  placeholder="Daily standup"
                  className="w-full rounded-[6px] border px-2.5 py-1.5 text-[12px]"
                  style={{
                    backgroundColor: 'var(--lx-surface)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
              </div>
              <div>
                <label
                  htmlFor="snippet-surface-scope"
                  className="mb-1 block text-[11px] font-medium"
                  style={{ color: 'var(--lx-fg-muted)' }}
                >
                  Surface Scope
                </label>
                <select
                  id="snippet-surface-scope"
                  value={snippetSurfaceId}
                  onChange={(e) => setSnippetSurfaceId(e.target.value)}
                  className="w-full rounded-[6px] border px-2 py-1.5 text-[12px]"
                  style={{
                    backgroundColor: 'var(--lx-surface)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                >
                  <option value="">All surfaces</option>
                  {surfaces.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label
                htmlFor="snippet-body-input"
                className="mb-1 block text-[11px] font-medium"
                style={{ color: 'var(--lx-fg-muted)' }}
              >
                Template body
              </label>
              <textarea
                id="snippet-body-input"
                rows={3}
                value={snippetExpansion}
                onChange={(e) => setSnippetExpansion(e.target.value)}
                placeholder="Looks good to me. Ready to merge once CI is green."
                className="w-full rounded-[6px] border p-2.5 text-[12px] leading-relaxed"
                style={{
                  backgroundColor: 'var(--lx-bg)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="inline-flex items-center gap-2 text-[12px]">
                <input
                  type="checkbox"
                  checked={snippetAdapt}
                  onChange={(e) => setSnippetAdapt(e.target.checked)}
                />
                <span>Adapt wording to active surface</span>
              </label>
              <button
                type="submit"
                disabled={snippetTrigger.trim().length < 2 || !snippetExpansion.trim()}
                className="lx-pressable lx-btn-primary px-3 py-1.5 text-[12px] font-semibold"
              >
                Save Snippet
              </button>
            </div>
          </form>

          {/* Live Expansion Tester */}
          <div
            className="flex flex-col gap-2 rounded-[6px] border p-3"
            style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
          >
            <div className="text-[12px] font-semibold">Test Snippet Expansion</div>
            <div className="grid grid-cols-2 gap-2">
              <select
                aria-label="Snippet to test"
                value={previewTrigger}
                onChange={(e) => setPreviewTrigger(e.target.value)}
                className="rounded-[6px] border px-2 py-1 text-[12px] lexel-mono"
                style={{
                  backgroundColor: 'var(--lx-card)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              >
                {allSnippets.map((s) => (
                  <option key={s.trigger} value={s.trigger}>
                    {s.trigger}
                  </option>
                ))}
              </select>
              <select
                aria-label="Test surface"
                value={previewSurfaceId}
                onChange={(e) => setPreviewSurfaceId(e.target.value)}
                className="rounded-[6px] border px-2 py-1 text-[12px]"
                style={{
                  backgroundColor: 'var(--lx-card)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              >
                {surfaces.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <input
              type="text"
              value={previewNotes}
              onChange={(e) => setPreviewNotes(e.target.value)}
              placeholder="Optional {{notes}} text..."
              aria-label="Snippet notes value"
              className="rounded-[6px] border px-2.5 py-1 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-card)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            />
            <button
              type="button"
              onClick={() => void handlePreviewSnippet()}
              className="lx-pressable lx-btn-secondary self-start px-2.5 py-1 text-[12px] font-medium"
            >
              Preview Expansion
            </button>
            {previewResult !== null ? (
              <pre
                className="m-0 whitespace-pre-wrap rounded-[6px] border p-2 text-[12px] font-sans leading-relaxed"
                style={{
                  backgroundColor: 'var(--lx-bg)',
                  borderColor: 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              >
                {previewResult}
              </pre>
            ) : null}
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {allSnippets.map((snippet) => {
            const isUserOwned = userSnippets.some((u) => u.trigger === snippet.trigger);
            return (
              <div
                key={snippet.trigger}
                className="flex flex-col justify-between gap-2 rounded-[6px] border p-2.5 text-[12px]"
                style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
              >
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className="rounded-[4px] border px-1.5 py-0.5 text-[11px] font-medium lexel-mono"
                      style={{
                        backgroundColor: 'var(--lx-signal-bg)',
                        borderColor: 'var(--lx-signal)',
                        color: 'var(--lx-signal)',
                      }}
                    >
                      {snippet.trigger}
                    </span>
                    <span
                      className="text-[10px] lexel-mono"
                      style={{ color: 'var(--lx-fg-muted)' }}
                    >
                      {isUserOwned ? 'Custom' : 'Built-in'}
                    </span>
                  </div>
                  <div
                    className="line-clamp-3 whitespace-pre-wrap text-[11px]"
                    style={{ color: 'var(--lx-fg-muted)' }}
                  >
                    {snippet.expansion}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setSnippetTrigger(snippet.trigger);
                      setSnippetLabel(snippet.label ?? '');
                      setSnippetExpansion(snippet.expansion);
                      setSnippetSurfaceId(snippet.surfaceId ?? '');
                      setSnippetAdapt(snippet.adaptToSurface ?? true);
                    }}
                    className="lx-pressable lx-btn-secondary px-2 py-0.5 text-[11px]"
                  >
                    Edit
                  </button>
                  {isUserOwned ? (
                    <button
                      type="button"
                      onClick={() =>
                        void onPatchSettings({
                          snippets: userSnippets.filter((s) => s.trigger !== snippet.trigger),
                        })
                      }
                      className="lx-pressable rounded-[4px] px-1.5 py-0.5 text-[11px]"
                      style={{ color: 'var(--lx-danger)' }}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Surface Prompts Section */}
      <section aria-label="Surface Prompts" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-[16px] font-semibold">Surface AI Prompts ({surfaces.length})</h2>
            <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
              Saved to lexel.db and shared with the browser extension and CLI.
            </p>
          </div>
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter Reddit, LinkedIn, GitHub..."
            aria-label="Filter surfaces"
            className="w-64 rounded-[6px] border px-2.5 py-1.5 text-[12px]"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          />
        </div>

        <form
          onSubmit={handleAddCustomSurface}
          className="space-y-2 rounded-[8px] border p-3"
          style={{ backgroundColor: 'var(--lx-card)', borderColor: 'var(--lx-border)' }}
        >
          <div className="text-[12px] font-medium">Add Custom Surface Prompt</div>
          <div className="grid gap-2 sm:grid-cols-[200px_1fr_auto]">
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Name (e.g. Substack Notes)"
              aria-label="New surface name"
              className="rounded-[6px] border px-2.5 py-1.5 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            />
            <input
              type="text"
              value={newPrompt}
              onChange={(e) => setNewPrompt(e.target.value)}
              placeholder="AI prompt directive for this platform..."
              aria-label="New surface prompt"
              className="rounded-[6px] border px-2.5 py-1.5 text-[12px]"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            />
            <button
              type="submit"
              disabled={!newLabel.trim() || !newPrompt.trim()}
              className="lx-pressable lx-btn-primary px-3 py-1.5 text-[12px] font-semibold"
            >
              Add Surface
            </button>
          </div>
        </form>

        <div className="grid gap-3 md:grid-cols-2">
          {visible.map((surface) => (
            <EditableSurfaceCard
              key={surface.id}
              profile={surface}
              isCustomOnly={customOnlyIds.has(surface.id)}
              onSaveOverride={handleSaveOverride}
              onResetOrDelete={handleResetOrDelete}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

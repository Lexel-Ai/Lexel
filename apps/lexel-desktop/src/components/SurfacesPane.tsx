import {
  EditableSurfaceCard,
  resetSurfaceOverride,
  upsertSurfaceOverride,
  type SurfaceProfile,
} from 'lexel-ui';
import React, { useMemo, useState } from 'react';
import { mergeSurfaceCatalog } from '../lib/surfaces';
import type { UnifiedDaemonSettings } from '../lib/types';

interface SurfacesPaneProps {
  settings: UnifiedDaemonSettings;
  onPatchSettings: (patch: Partial<UnifiedDaemonSettings>) => Promise<void>;
}

export function SurfacesPane({ settings, onPatchSettings }: SurfacesPaneProps) {
  const [filter, setFilter] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newPrompt, setNewPrompt] = useState('');

  const { surfaces, customOnlyIds } = useMemo(
    () => mergeSurfaceCatalog(settings.customSurfaces),
    [settings.customSurfaces],
  );

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

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[18px] font-semibold">Surfaces &amp; AI Prompts ({surfaces.length})</h1>
          <p className="text-[12px]" style={{ color: 'var(--lx-fg-muted)' }}>
            Customize AI rewrite prompts per platform. Saved to lexel.db and shared with the browser extension.
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
      </header>

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
            className="rounded-[6px] px-3 py-1.5 text-[12px] font-semibold"
            style={{
              backgroundColor: 'var(--lx-accent)',
              color: 'var(--lx-on-accent)',
            }}
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
    </div>
  );
}

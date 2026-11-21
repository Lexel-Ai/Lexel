'use client';

import { BUILTIN_SURFACES, SurfaceBadge } from 'lexel-ui';
import { useState } from 'react';

export function SurfaceExplorer() {
  const [selectedId, setSelectedId] = useState<string>(BUILTIN_SURFACES[0].id);
  const selected =
    BUILTIN_SURFACES.find((surface) => surface.id === selectedId) ?? BUILTIN_SURFACES[0];

  return (
    <div
      className="grid gap-6 rounded-[8px] border p-4 sm:p-6 lg:grid-cols-[260px_1fr]"
      style={{
        backgroundColor: 'var(--lx-card)',
        borderColor: 'var(--lx-border)',
      }}
    >
      <div className="flex flex-wrap gap-1.5 lg:flex-col">
        {BUILTIN_SURFACES.map((surface) => {
          const active = surface.id === selected.id;
          return (
            <button
              key={surface.id}
              type="button"
              onClick={() => setSelectedId(surface.id)}
              aria-pressed={active}
              className="flex min-h-[44px] items-center justify-between gap-2 rounded-[6px] border px-3 py-2 text-left text-sm transition-colors"
              style={{
                backgroundColor: active ? 'var(--lx-accent)' : 'var(--lx-surface)',
                color: active ? 'var(--lx-on-accent)' : 'var(--lx-fg)',
                borderColor: active ? 'var(--lx-accent)' : 'var(--lx-border)',
              }}
            >
              <span className="font-medium">{surface.label}</span>
              <span
                className="lexel-mono text-xs"
                style={{
                  color: active ? 'var(--lx-on-accent)' : 'var(--lx-fg-muted)',
                  opacity: active ? 0.85 : 1,
                }}
              >
                {surface.maxChars}
              </span>
            </button>
          );
        })}
      </div>

      <div className="min-w-0 flex flex-col justify-between gap-5">
        <div className="space-y-4">
          <div
            className="flex flex-wrap items-center justify-between gap-2 border-b pb-3"
            style={{ borderColor: 'var(--lx-border)' }}
          >
            <div className="space-y-1">
              <h3 className="m-0 text-lg font-semibold" style={{ color: 'var(--lx-fg)' }}>
                {selected.label}
              </h3>
              <p className="m-0 lexel-mono text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
                id: {selected.id} | register: {selected.register}
              </p>
            </div>
            <SurfaceBadge
              label={selected.label}
              charCount={selected.minChars}
              maxChars={selected.maxChars}
            />
          </div>

          <p className="m-0 text-sm leading-relaxed" style={{ color: 'var(--lx-fg)' }}>
            {selected.promptDirective}
          </p>

          <dl className="m-0 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div
              className="rounded-[6px] border p-3"
              style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
            >
              <dt className="text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
                Max length
              </dt>
              <dd
                className="m-0 mt-1 lexel-mono text-sm font-semibold"
                style={{ color: 'var(--lx-fg)' }}
              >
                {selected.maxChars} chars
              </dd>
            </div>
            <div
              className="rounded-[6px] border p-3"
              style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
            >
              <dt className="text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
                Links
              </dt>
              <dd
                className="m-0 mt-1 lexel-mono text-sm font-semibold"
                style={{ color: 'var(--lx-fg)' }}
              >
                {selected.allowLinks ? 'Allowed' : 'Flagged'}
              </dd>
            </div>
            <div
              className="rounded-[6px] border p-3"
              style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
            >
              <dt className="text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
                Emojis
              </dt>
              <dd
                className="m-0 mt-1 lexel-mono text-sm font-semibold"
                style={{ color: 'var(--lx-fg)' }}
              >
                {selected.allowEmojis ? 'Allowed' : 'Flagged'}
              </dd>
            </div>
            <div
              className="rounded-[6px] border p-3"
              style={{ backgroundColor: 'var(--lx-surface)', borderColor: 'var(--lx-border)' }}
            >
              <dt className="text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
                Em dashes
              </dt>
              <dd
                className="m-0 mt-1 lexel-mono text-sm font-semibold"
                style={{ color: 'var(--lx-fg)' }}
              >
                {selected.allowEmDashes ? 'Allowed' : 'Banned'}
              </dd>
            </div>
          </dl>

          {selected.bannedOpeners.length > 0 ? (
            <div className="space-y-1.5">
              <p className="m-0 text-xs font-medium" style={{ color: 'var(--lx-fg-muted)' }}>
                Flagged openers on {selected.label}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {selected.bannedOpeners.map((opener) => (
                  <span
                    key={opener}
                    className="lexel-mono rounded-[4px] border px-2 py-0.5 text-xs"
                    style={{
                      backgroundColor: 'var(--lx-muted)',
                      borderColor: 'var(--lx-border)',
                      color: 'var(--lx-fg)',
                    }}
                  >
                    &ldquo;{opener}&rdquo;
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div
          className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs"
          style={{ borderColor: 'var(--lx-border)', color: 'var(--lx-fg-muted)' }}
        >
          <span>
            Host signals:{' '}
            <code className="lx-inline-code">
              {selected.hostPatterns.length > 0
                ? selected.hostPatterns.join(', ')
                : 'LSP language ID'}
            </code>
          </span>
          <span>Source: ml/personas/surfaces.json</span>
        </div>
      </div>
    </div>
  );
}

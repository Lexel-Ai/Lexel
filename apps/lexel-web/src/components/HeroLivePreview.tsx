'use client';

import { StatusPill, SurfaceBadge } from 'lexel-ui';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { analyzeTier0Client, applySafeTier0Fixes } from '@/lib/tier0Engine';

const DEFAULT_HERO_DRAFT =
  "In today's fast-paced landscape, we are delving into a game-changer — our Rust parser is seamlessly leveraging zero-copy buffers to cut p99 latency to 4ms. #Rust";

export function HeroLivePreview() {
  const [text, setText] = useState(DEFAULT_HERO_DRAFT);
  const [previousText, setPreviousText] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const analysis = useMemo(
    () =>
      analyzeTier0Client({
        text,
        surfaceId: 'web_reddit',
        dialect: 'American',
        crutchWords: [],
      }),
    [text],
  );

  const handleApplySafe = () => {
    const fixed = applySafeTier0Fixes(text, 'web_reddit');
    if (fixed.fixesApplied > 0) {
      setPreviousText(text);
      setText(fixed.text);
    }
  };

  const handleReset = () => {
    setText(previousText ?? DEFAULT_HERO_DRAFT);
    setPreviousText(null);
  };

  const topFindings = analysis.diagnostics.slice(0, 4);

  return (
    <div
      className="flex flex-col rounded-[8px] border"
      style={{
        backgroundColor: 'var(--lx-card)',
        borderColor: 'var(--lx-border)',
      }}
    >
      <div
        className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3"
        style={{
          backgroundColor: 'var(--lx-surface)',
          borderColor: 'var(--lx-border)',
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill state="ready" label="Tier 0 Live" />
          <SurfaceBadge
            label={analysis.surface.label}
            charCount={text.length}
            maxChars={analysis.surface.maxChars}
          />
        </div>
        <span className="lexel-mono text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
          {mounted ? `${analysis.elapsedMs} ms` : 'Local'} | 0 MB AI RAM
        </span>
      </div>

      <div className="space-y-3 p-4">
        <label
          htmlFor="hero-live-draft"
          className="block text-xs font-medium"
          style={{ color: 'var(--lx-fg-muted)' }}
        >
          Edit or paste sample text (runs locally in your browser)
        </label>
        <textarea
          id="hero-live-draft"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          className="w-full resize-y rounded-[6px] border p-3 text-sm leading-relaxed"
          style={{
            backgroundColor: 'var(--lx-bg)',
            borderColor: 'var(--lx-control-border)',
            color: 'var(--lx-fg)',
          }}
        />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleApplySafe}
              disabled={analysis.diagnostics.length === 0}
              className="lx-web-btn-primary text-xs"
            >
              Apply safe fixes
            </button>
            <button type="button" onClick={handleReset} className="lx-web-btn-secondary text-xs">
              {previousText ? 'Revert' : 'Reset sample'}
            </button>
          </div>
          <span className="lexel-mono text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
            Slop score: {analysis.slopMeter.score}/100 ({analysis.slopMeter.verdict})
          </span>
        </div>

        <div className="space-y-2 border-t pt-3" style={{ borderColor: 'var(--lx-border)' }}>
          {topFindings.length === 0 ? (
            <p className="m-0 text-xs font-medium" style={{ color: 'var(--lx-signal)' }}>
              Clean draft: zero slop phrases, em dashes, secrets, or Reddit surface issues detected.
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {topFindings.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-baseline justify-between gap-2 rounded-[6px] border px-2.5 py-1.5 text-xs"
                  style={{
                    backgroundColor: 'var(--lx-surface)',
                    borderColor: 'var(--lx-border)',
                  }}
                >
                  <span style={{ color: 'var(--lx-fg)' }}>
                    <strong className="lexel-mono font-medium" style={{ color: 'var(--lx-warn)' }}>
                      {item.ruleLabel}:
                    </strong>{' '}
                    {item.message}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center justify-between pt-1 text-xs">
            <span style={{ color: 'var(--lx-fg-muted)' }}>
              {analysis.diagnostics.length} total findings
            </span>
            <Link
              href="/playground/"
              className="font-medium no-underline hover:underline"
              style={{ color: 'var(--lx-signal)' }}
            >
              Open full Playground
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

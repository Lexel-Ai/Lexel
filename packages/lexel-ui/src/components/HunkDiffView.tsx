import React, { useEffect, useMemo, useState } from 'react';
import { composeHunkText, computeDiffHunks, type DiffHunk, summarizeHunkState } from './diffHunks';

export interface HunkDiffViewProps {
  original: string;
  suggestion: string;
  hunks?: DiffHunk[];
  onHunksChange?: (hunks: DiffHunk[], composedText: string) => void;
  compact?: boolean;
}

export function HunkDiffView({
  original,
  suggestion,
  hunks: controlledHunks,
  onHunksChange,
  compact = false,
}: HunkDiffViewProps) {
  const computedInitial = useMemo(
    () => computeDiffHunks(original, suggestion),
    [original, suggestion],
  );
  const [internalHunks, setInternalHunks] = useState<DiffHunk[]>(computedInitial);

  useEffect(() => {
    setInternalHunks(computedInitial);
  }, [computedInitial]);

  const hunks = controlledHunks ?? internalHunks;
  const summary = useMemo(() => summarizeHunkState(hunks), [hunks]);

  function updateHunks(next: DiffHunk[]) {
    if (!controlledHunks) {
      setInternalHunks(next);
    }
    onHunksChange?.(next, composeHunkText(next));
  }

  function toggleHunk(id: string) {
    const next = hunks.map((h) => (h.id === id ? { ...h, accepted: !h.accepted } : h));
    updateHunks(next);
  }

  function setAll(accepted: boolean) {
    const next = hunks.map((h) => (h.kind === 'change' ? { ...h, accepted } : h));
    updateHunks(next);
  }

  return (
    <div className="flex flex-col gap-2">
      {summary.totalChanges > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <span className="lexel-mono lx-tab-nums" style={{ color: 'var(--lx-fg-muted)' }}>
            {summary.acceptedChanges}/{summary.totalChanges} edit
            {summary.totalChanges === 1 ? '' : 's'} kept (click any edit to toggle)
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setAll(true)}
              disabled={summary.acceptedChanges === summary.totalChanges}
              className="lx-pressable rounded-[4px] border px-2 py-0.5 text-[11px] font-medium"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            >
              Keep all
            </button>
            <button
              type="button"
              onClick={() => setAll(false)}
              disabled={summary.acceptedChanges === 0}
              className="lx-pressable rounded-[4px] border px-2 py-0.5 text-[11px] font-medium"
              style={{
                backgroundColor: 'var(--lx-surface)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg-muted)',
              }}
            >
              Keep original
            </button>
          </div>
        </div>
      ) : null}

      <div
        className={`rounded-[6px] border leading-[1.65] whitespace-pre-wrap ${compact ? 'p-2 text-[12px]' : 'p-3 text-[13px]'}`}
        style={{
          backgroundColor: 'var(--lx-bg)',
          borderColor: 'var(--lx-border)',
          color: 'var(--lx-fg)',
        }}
      >
        {hunks.map((hunk) => {
          if (hunk.kind === 'equal') {
            return <React.Fragment key={hunk.id}>{hunk.original}</React.Fragment>;
          }

          const hasOriginal = hunk.original.trim().length > 0;
          const hasSuggested = hunk.suggested.trim().length > 0;

          return (
            <button
              key={hunk.id}
              type="button"
              aria-pressed={hunk.accepted}
              title={
                hunk.accepted
                  ? 'Accepted edit. Click to revert this span to original.'
                  : 'Kept original. Click to accept this edit.'
              }
              onClick={() => toggleHunk(hunk.id)}
              className="lx-pressable mx-0.5 inline rounded-[4px] border px-1 py-0.5 text-left align-baseline"
              style={{
                backgroundColor: hunk.accepted ? 'var(--lx-diff-add-bg)' : 'var(--lx-muted)',
                borderColor: hunk.accepted ? 'var(--lx-ok)' : 'var(--lx-border-strong)',
                color: 'var(--lx-fg)',
              }}
            >
              {hunk.accepted ? (
                <>
                  {hasOriginal ? (
                    <span
                      className="mr-1 line-through opacity-75"
                      style={{ color: 'var(--lx-diff-del-fg)' }}
                    >
                      {hunk.original}
                    </span>
                  ) : null}
                  {hasSuggested ? (
                    <span className="font-medium" style={{ color: 'var(--lx-diff-add-fg)' }}>
                      {hunk.suggested}
                    </span>
                  ) : (
                    <span
                      className="lexel-mono text-[10px]"
                      style={{ color: 'var(--lx-diff-del-fg)' }}
                    >
                      [removed]
                    </span>
                  )}
                </>
              ) : (
                <>
                  <span className="font-medium" style={{ color: 'var(--lx-fg)' }}>
                    {hasOriginal ? hunk.original : '[kept empty]'}
                  </span>
                  <span
                    className="ml-1 lexel-mono text-[10px]"
                    style={{ color: 'var(--lx-fg-muted)' }}
                  >
                    (original)
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

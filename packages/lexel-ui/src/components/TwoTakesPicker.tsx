import type React from 'react';
import { CheckIcon } from './Icons';
import type { GateCheckSummary } from './RewriteDiffCard';

export interface RewriteCandidate {
  label: string;
  suggestion: string;
  gates: GateCheckSummary;
  retried?: boolean;
}

export interface TwoTakesPickerProps {
  candidates: readonly RewriteCandidate[];
  activeIndex: number;
  onSelect: (index: number) => void;
  compact?: boolean;
}

export function TwoTakesPicker({
  candidates,
  activeIndex,
  onSelect,
  compact = false,
}: TwoTakesPickerProps) {
  if (candidates.length < 2) return null;

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      onSelect((activeIndex + 1) % candidates.length);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onSelect((activeIndex - 1 + candidates.length) % candidates.length);
    }
  }

  return (
    <div
      role="tablist"
      aria-label="Rewrite takes"
      onKeyDown={handleKeyDown}
      className={`grid gap-2 ${candidates.length === 2 ? 'grid-cols-2' : 'grid-cols-1 sm:grid-cols-2'}`}
    >
      {candidates.map((cand, idx) => {
        const selected = idx === activeIndex;
        const gatesClean =
          cand.gates.zeroSlop &&
          cand.gates.numbersPreserved &&
          cand.gates.tokensPreserved &&
          cand.gates.surfaceCompliant;

        return (
          <button
            key={`${cand.label}:${cand.suggestion.slice(0, 32)}`}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(idx)}
            className={`lx-pressable flex flex-col gap-1 rounded-[6px] border text-left ${compact ? 'p-2' : 'p-2.5'}`}
            style={{
              backgroundColor: selected ? 'var(--lx-signal-bg)' : 'var(--lx-surface)',
              borderColor: selected ? 'var(--lx-signal)' : 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-semibold">
                Take {idx + 1}: {cand.label}
              </span>
              <span
                className="inline-flex items-center gap-1 lexel-mono lx-tab-nums text-[10px]"
                style={{ color: gatesClean ? 'var(--lx-signal)' : 'var(--lx-warn)' }}
              >
                {gatesClean ? <CheckIcon className="h-3 w-3" /> : null}
                <span>{cand.suggestion.length} chars</span>
              </span>
            </div>
            <p
              className="m-0 line-clamp-2 text-[11px] leading-snug"
              style={{ color: 'var(--lx-fg-muted)' }}
            >
              {cand.suggestion}
            </p>
          </button>
        );
      })}
    </div>
  );
}

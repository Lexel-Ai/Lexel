import { useEffect, useMemo, useState } from 'react';
import { composeHunkText, computeDiffHunks, type DiffHunk, summarizeHunkState } from './diffHunks';
import { HunkDiffView } from './HunkDiffView';
import { CheckIcon } from './Icons';
import { type RewriteCandidate, TwoTakesPicker } from './TwoTakesPicker';

export interface GateCheckSummary {
  zeroSlop: boolean;
  numbersPreserved: boolean;
  tokensPreserved: boolean;
  surfaceCompliant: boolean;
  grammarClean?: boolean;
  secretsFree?: boolean;
  warnings: string[];
}

export interface RewriteApplyMeta {
  partial: boolean;
  acceptedHunks: number;
  totalHunks: number;
  candidateLabel?: string;
}

export interface RewriteDiffCardProps {
  original: string;
  suggestion: string;
  gates: GateCheckSummary;
  modelName: string;
  latencyMs: number;
  onApply?: () => void;
  onApplyComposed?: (composedText: string, meta: RewriteApplyMeta) => void;
  onCopy: () => void;
  onCopyComposed?: (composedText: string) => void;
  onRetry: () => void;
  onReject: () => void;
  copied?: boolean;
  fastPath?: boolean;
  retried?: boolean;
  failedConstraints?: string[];
  redactedCount?: number;
  restoredCleanly?: boolean;
  candidates?: readonly RewriteCandidate[];
  enableHunkDiff?: boolean;
  compact?: boolean;
}

function GateChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-0.5 text-[11px] lexel-mono"
      style={{
        backgroundColor: ok ? 'var(--lx-signal-bg)' : 'var(--lx-warn-bg)',
        borderColor: ok ? 'var(--lx-signal)' : 'var(--lx-warn)',
        color: ok ? 'var(--lx-signal)' : 'var(--lx-warn)',
      }}
    >
      {ok ? <CheckIcon className="w-3 h-3" /> : null}
      <span>{label}</span>
    </span>
  );
}

export function RewriteDiffCard({
  original,
  suggestion,
  gates,
  modelName,
  latencyMs,
  onApply,
  onApplyComposed,
  onCopy,
  onCopyComposed,
  onRetry,
  onReject,
  copied = false,
  fastPath = false,
  retried = false,
  failedConstraints = [],
  redactedCount = 0,
  restoredCleanly = true,
  candidates,
  enableHunkDiff = true,
  compact = false,
}: RewriteDiffCardProps) {
  const [activeCandidateIdx, setActiveCandidateIdx] = useState(0);

  useEffect(() => {
    setActiveCandidateIdx(0);
  }, []);

  const activeCandidate =
    candidates && candidates.length > 0 ? (candidates[activeCandidateIdx] ?? candidates[0]) : null;

  const activeSuggestion = activeCandidate?.suggestion ?? suggestion;
  const activeGates = activeCandidate?.gates ?? gates;
  const activeRetried = activeCandidate?.retried ?? retried;

  const initialHunks = useMemo(
    () => computeDiffHunks(original, activeSuggestion),
    [original, activeSuggestion],
  );
  const [hunks, setHunks] = useState<DiffHunk[]>(initialHunks);

  useEffect(() => {
    setHunks(initialHunks);
  }, [initialHunks]);

  const composedText = useMemo(() => composeHunkText(hunks), [hunks]);
  const hunkSummary = useMemo(() => summarizeHunkState(hunks), [hunks]);

  const canApply = Boolean(onApplyComposed || onApply);

  function handleApplyClick() {
    if (onApplyComposed) {
      onApplyComposed(composedText, {
        partial: hunkSummary.isPartial,
        acceptedHunks: hunkSummary.acceptedChanges,
        totalHunks: hunkSummary.totalChanges,
        candidateLabel: activeCandidate?.label,
      });
    } else if (onApply) {
      onApply();
    }
  }

  function handleCopyClick() {
    if (onCopyComposed) {
      onCopyComposed(composedText);
    } else {
      onCopy();
    }
  }

  return (
    <div
      className={`lx-surface-enter flex flex-col gap-2.5 rounded-[8px] border ${compact ? 'p-3' : 'p-3.5'}`}
      style={{
        backgroundColor: 'var(--lx-card)',
        borderColor: 'var(--lx-border)',
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className="text-[11px] font-medium lexel-mono lx-tab-nums"
            style={{ color: 'var(--lx-fg-muted)' }}
          >
            {modelName} · {latencyMs}ms
          </span>
          {fastPath ? (
            <span
              className="rounded-[4px] border px-1.5 py-0.5 text-[10px] font-medium lexel-mono"
              style={{
                backgroundColor: 'var(--lx-ok-bg)',
                borderColor: 'var(--lx-ok)',
                color: 'var(--lx-ok)',
              }}
            >
              Tier 0 fast path
            </span>
          ) : null}
          {activeRetried ? (
            <span
              className="rounded-[4px] border px-1.5 py-0.5 text-[10px] font-medium lexel-mono"
              style={{
                backgroundColor: 'var(--lx-signal-bg)',
                borderColor: 'var(--lx-signal)',
                color: 'var(--lx-signal)',
              }}
              title={
                failedConstraints.length > 0
                  ? `Repaired pass-1 issues: ${failedConstraints.join('; ')}`
                  : 'Tier 2 verifier triggered one repair pass'
              }
            >
              Auto-repaired
            </span>
          ) : null}
          {redactedCount > 0 ? (
            <span
              className="rounded-[4px] border px-1.5 py-0.5 text-[10px] font-medium lexel-mono"
              style={{
                backgroundColor: restoredCleanly ? 'var(--lx-ok-bg)' : 'var(--lx-warn-bg)',
                borderColor: restoredCleanly ? 'var(--lx-ok)' : 'var(--lx-warn)',
                color: restoredCleanly ? 'var(--lx-ok)' : 'var(--lx-warn)',
              }}
            >
              {redactedCount} secret{redactedCount === 1 ? '' : 's'}{' '}
              {restoredCleanly ? 'redacted & restored' : 'partially restored'}
            </span>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-1.5">
          <GateChip ok={activeGates.zeroSlop} label="Zero-Slop" />
          <GateChip ok={activeGates.numbersPreserved} label="Numbers" />
          <GateChip ok={activeGates.tokensPreserved} label="Code Tokens" />
          <GateChip ok={activeGates.surfaceCompliant} label="Surface Rules" />
          {typeof activeGates.secretsFree === 'boolean' ? (
            <GateChip ok={activeGates.secretsFree} label="Secrets Free" />
          ) : null}
        </div>
      </div>

      {candidates && candidates.length > 1 ? (
        <TwoTakesPicker
          candidates={candidates}
          activeIndex={activeCandidateIdx}
          onSelect={setActiveCandidateIdx}
          compact={compact}
        />
      ) : null}

      {activeGates.warnings.length > 0 ? (
        <ul
          className="rounded-[6px] border px-2.5 py-1.5 text-xs space-y-0.5"
          style={{
            backgroundColor: 'var(--lx-warn-bg)',
            borderColor: 'var(--lx-warn)',
            color: 'var(--lx-warn)',
          }}
        >
          {activeGates.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}

      {enableHunkDiff && original !== activeSuggestion ? (
        <HunkDiffView
          original={original}
          suggestion={activeSuggestion}
          hunks={hunks}
          onHunksChange={(next) => setHunks(next)}
          compact={compact}
        />
      ) : (
        <div
          className="rounded-[6px] border p-2.5 text-xs leading-relaxed whitespace-pre-wrap"
          style={{
            backgroundColor: 'var(--lx-bg)',
            borderColor: 'var(--lx-border)',
            color: 'var(--lx-fg)',
          }}
        >
          {activeSuggestion}
        </div>
      )}

      {enableHunkDiff && hunkSummary.isPartial ? (
        <div
          className="rounded-[6px] border px-2.5 py-2 text-[12px] leading-relaxed whitespace-pre-wrap"
          style={{
            backgroundColor: 'var(--lx-surface)',
            borderColor: 'var(--lx-border)',
            color: 'var(--lx-fg)',
          }}
        >
          <div
            className="mb-1 text-[10px] font-medium lexel-mono"
            style={{ color: 'var(--lx-fg-muted)' }}
          >
            Result preview ({hunkSummary.acceptedChanges}/{hunkSummary.totalChanges} edits kept)
          </div>
          {composedText}
        </div>
      ) : null}

      <details className="text-xs">
        <summary style={{ color: 'var(--lx-fg-muted)' }}>
          Original text ({original.length} chars)
        </summary>
        <p
          className="mt-1.5 rounded-[6px] border p-2 whitespace-pre-wrap"
          style={{
            backgroundColor: 'var(--lx-muted)',
            borderColor: 'var(--lx-border)',
            color: 'var(--lx-fg-muted)',
          }}
        >
          {original}
        </p>
      </details>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {canApply ? (
          <button
            type="button"
            onClick={handleApplyClick}
            className="lx-pressable lx-btn-primary px-3 py-1.5 text-xs font-semibold"
          >
            {hunkSummary.isPartial
              ? `Apply ${hunkSummary.acceptedChanges} of ${hunkSummary.totalChanges} edits`
              : 'Apply rewrite'}
          </button>
        ) : null}
        <button
          type="button"
          onClick={handleCopyClick}
          className="lx-pressable lx-btn-secondary px-2.5 py-1.5 text-xs font-medium"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          onClick={onRetry}
          className="lx-pressable rounded-[6px] border px-2.5 py-1.5 text-xs font-medium"
          style={{
            backgroundColor: 'var(--lx-card)',
            borderColor: 'var(--lx-border)',
            color: 'var(--lx-fg)',
          }}
        >
          Retry
        </button>
        <button
          type="button"
          onClick={onReject}
          className="lx-pressable lx-btn-ghost ml-auto px-2 py-1.5 text-xs font-medium"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

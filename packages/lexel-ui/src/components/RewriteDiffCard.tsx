import React from 'react';
import { CheckIcon } from './Icons';

export interface GateCheckSummary {
  zeroSlop: boolean;
  numbersPreserved: boolean;
  tokensPreserved: boolean;
  surfaceCompliant: boolean;
  warnings: string[];
}

export interface RewriteDiffCardProps {
  original: string;
  suggestion: string;
  gates: GateCheckSummary;
  modelName: string;
  latencyMs: number;
  onApply?: () => void;
  onCopy: () => void;
  onRetry: () => void;
  onReject: () => void;
  copied?: boolean;
}

function GateChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-0.5 text-[11px] lexel-mono"
      style={{
        backgroundColor: ok ? 'var(--lx-muted)' : 'var(--lx-warn-bg)',
        borderColor: ok ? 'var(--lx-border)' : 'var(--lx-warn)',
        color: ok ? 'var(--lx-accent)' : 'var(--lx-warn)',
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
  onCopy,
  onRetry,
  onReject,
  copied = false,
}: RewriteDiffCardProps) {
  return (
    <div
      className="flex flex-col gap-2.5 rounded-[8px] border p-3"
      style={{
        backgroundColor: 'var(--lx-card)',
        borderColor: 'var(--lx-border)',
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-medium lexel-mono" style={{ color: 'var(--lx-fg-muted)' }}>
          {modelName} · {latencyMs}ms
        </span>
        <div className="flex flex-wrap gap-1.5">
          <GateChip ok={gates.zeroSlop} label="Zero-Slop" />
          <GateChip ok={gates.numbersPreserved} label="Numbers" />
          <GateChip ok={gates.tokensPreserved} label="Code Tokens" />
          <GateChip ok={gates.surfaceCompliant} label="Surface Rules" />
        </div>
      </div>

      {gates.warnings.length > 0 ? (
        <ul
          className="rounded-[6px] border px-2.5 py-1.5 text-xs space-y-0.5"
          style={{
            backgroundColor: 'var(--lx-warn-bg)',
            borderColor: 'var(--lx-warn)',
            color: 'var(--lx-warn)',
          }}
        >
          {gates.warnings.map((w, idx) => (
            <li key={idx}>{w}</li>
          ))}
        </ul>
      ) : null}

      <div
        className="rounded-[6px] border p-2.5 text-xs leading-relaxed whitespace-pre-wrap"
        style={{
          backgroundColor: 'var(--lx-bg)',
          borderColor: 'var(--lx-border)',
          color: 'var(--lx-fg)',
        }}
      >
        {suggestion}
      </div>

      <details className="text-xs">
        <summary style={{ color: 'var(--lx-fg-muted)' }}>Original text ({original.length} chars)</summary>
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
        {onApply ? (
          <button
            type="button"
            onClick={onApply}
            className="rounded-[6px] px-3 py-1.5 text-xs font-semibold transition-colors"
            style={{
              backgroundColor: 'var(--lx-accent)',
              color: 'var(--lx-on-accent)',
            }}
          >
            Apply rewrite
          </button>
        ) : null}
        <button
          type="button"
          onClick={onCopy}
          className="rounded-[6px] border px-2.5 py-1.5 text-xs font-medium"
          style={{
            backgroundColor: 'var(--lx-muted)',
            borderColor: 'var(--lx-border)',
            color: 'var(--lx-fg)',
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-[6px] border px-2.5 py-1.5 text-xs font-medium"
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
          className="ml-auto rounded-[6px] px-2 py-1.5 text-xs font-medium"
          style={{ color: 'var(--lx-fg-muted)' }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

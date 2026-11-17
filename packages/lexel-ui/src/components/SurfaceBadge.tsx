import React from 'react';

export interface SurfaceBadgeProps {
  label: string;
  subcontext?: string | null;
  charCount?: number;
  maxChars?: number;
}

export function SurfaceBadge({ label, subcontext, charCount, maxChars }: SurfaceBadgeProps) {
  const overLimit =
    typeof charCount === 'number' && typeof maxChars === 'number' && charCount > maxChars;

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-[4px] border px-2 py-0.5 text-xs font-medium lexel-mono"
      style={{
        backgroundColor: overLimit ? 'var(--lx-danger-bg)' : 'var(--lx-muted)',
        borderColor: overLimit ? 'var(--lx-danger)' : 'var(--lx-border)',
        color: overLimit ? 'var(--lx-danger)' : 'var(--lx-fg)',
      }}
    >
      <span>{label}</span>
      {subcontext ? (
        <span style={{ color: 'var(--lx-fg-muted)' }}>/ {subcontext}</span>
      ) : null}
      {typeof charCount === 'number' && typeof maxChars === 'number' ? (
        <span style={{ color: overLimit ? 'var(--lx-danger)' : 'var(--lx-fg-muted)' }}>
          {charCount}/{maxChars}
        </span>
      ) : null}
    </span>
  );
}

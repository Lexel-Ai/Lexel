import React from 'react';

export type AiHealthState = 'ready' | 'loading' | 'offline' | 'error';

export interface StatusPillProps {
  state: AiHealthState;
  label: string;
}

export function StatusPill({ state, label }: StatusPillProps) {
  const dotColor =
    state === 'ready'
      ? 'var(--lx-signal)'
      : state === 'loading'
        ? 'var(--lx-warn)'
        : state === 'error'
          ? 'var(--lx-danger)'
          : 'var(--lx-fg-muted)';

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-[4px] border px-2 py-0.5 text-[11px] font-medium lexel-mono"
      style={{
        backgroundColor: 'var(--lx-card)',
        borderColor: 'var(--lx-border)',
        color: 'var(--lx-fg)',
      }}
    >
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: dotColor }}
        aria-hidden="true"
      />
      <span>{label}</span>
    </span>
  );
}

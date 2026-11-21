export interface StreamingTextViewProps {
  text: string;
  active: boolean;
  statusLabel?: string;
  onCancel?: () => void;
}

export function StreamingTextView({
  text,
  active,
  statusLabel = 'Streaming local rewrite',
  onCancel,
}: StreamingTextViewProps) {
  if (!active && !text) return null;

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <section
      aria-label="Streaming local AI draft"
      aria-busy={active}
      className="lx-surface-enter flex flex-col gap-2 rounded-[8px] border p-3.5"
      style={{
        backgroundColor: 'var(--lx-card)',
        borderColor: 'var(--lx-signal)',
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px] lexel-mono">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: 'var(--lx-signal)' }}
            aria-hidden="true"
          />
          <span style={{ color: 'var(--lx-signal)' }}>{statusLabel}</span>
          <span className="lx-tab-nums" style={{ color: 'var(--lx-fg-muted)' }}>
            {words} words · {text.length} chars
          </span>
        </div>
        {active && onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="lx-pressable lx-btn-secondary px-2 py-0.5 text-[11px] font-medium"
          >
            Stop
          </button>
        ) : null}
      </div>

      <div
        className="min-h-[64px] rounded-[6px] border p-3 text-[13px] leading-[1.6] whitespace-pre-wrap"
        style={{
          backgroundColor: 'var(--lx-bg)',
          borderColor: 'var(--lx-border)',
          color: 'var(--lx-fg)',
        }}
      >
        {text || (
          <span style={{ color: 'var(--lx-fg-muted)' }}>
            Waiting for first token from local runtime...
          </span>
        )}
        {active ? (
          <span
            aria-hidden="true"
            className="ml-0.5 inline-block h-[14px] w-[2px] align-middle"
            style={{ backgroundColor: 'var(--lx-signal)' }}
          />
        ) : null}
      </div>
    </section>
  );
}

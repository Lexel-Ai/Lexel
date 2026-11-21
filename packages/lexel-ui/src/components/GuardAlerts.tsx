import { AlertIcon, CheckIcon, LockIcon } from './Icons';

export type GuardAlertKind =
  | 'consistency'
  | 'bluf'
  | 'regret'
  | 'crutch'
  | 'secret'
  | 'surface'
  | 'invisible';

export interface GuardAlertItem {
  id: string;
  kind: GuardAlertKind;
  severity: 'info' | 'warn' | 'danger';
  title: string;
  detail: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryLabel?: string;
  onSecondaryAction?: () => void;
}

export interface GuardAlertsProps {
  items: readonly GuardAlertItem[];
  emptyMessage?: string;
  compact?: boolean;
}

const KIND_LABELS: Record<GuardAlertKind, string> = {
  consistency: 'Consistency',
  bluf: 'BLUF',
  regret: 'Regret Shield',
  crutch: 'Crutch Word',
  secret: 'Secret Guard',
  surface: 'Surface Rule',
  invisible: 'Hidden Char',
};

export function GuardAlerts({ items, emptyMessage, compact = false }: GuardAlertsProps) {
  if (items.length === 0) {
    if (!emptyMessage) return null;
    return (
      <div
        className="flex items-center gap-2 rounded-[6px] border px-3 py-2 text-[12px]"
        style={{
          backgroundColor: 'var(--lx-surface)',
          borderColor: 'var(--lx-border)',
          color: 'var(--lx-fg-muted)',
        }}
      >
        <CheckIcon className="h-3.5 w-3.5 shrink-0" />
        <span>{emptyMessage}</span>
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-2" aria-label="Writing guard warnings">
      {items.map((item) => {
        const bg =
          item.severity === 'danger'
            ? 'var(--lx-danger-bg)'
            : item.severity === 'warn'
              ? 'var(--lx-warn-bg)'
              : 'var(--lx-signal-bg)';
        const border =
          item.severity === 'danger'
            ? 'var(--lx-danger)'
            : item.severity === 'warn'
              ? 'var(--lx-warn)'
              : 'var(--lx-signal)';
        const fg = border;

        return (
          <div
            key={item.id}
            role={item.severity === 'danger' ? 'alert' : 'status'}
            className={`flex flex-wrap items-start justify-between gap-2.5 rounded-[6px] border ${
              compact ? 'px-2.5 py-2' : 'px-3 py-2.5'
            }`}
            style={{
              backgroundColor: bg,
              borderColor: border,
            }}
          >
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <span className="mt-0.5 shrink-0" style={{ color: fg }}>
                {item.kind === 'secret' ? (
                  <LockIcon className="h-3.5 w-3.5" />
                ) : (
                  <AlertIcon className="h-3.5 w-3.5" />
                )}
              </span>
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className="rounded-[4px] border px-1.5 py-0.5 text-[10px] font-medium lexel-mono"
                    style={{
                      borderColor: border,
                      color: fg,
                    }}
                  >
                    {KIND_LABELS[item.kind]}
                  </span>
                  <span className="text-[12px] font-semibold" style={{ color: 'var(--lx-fg)' }}>
                    {item.title}
                  </span>
                </div>
                <p className="m-0 text-[12px] leading-snug" style={{ color: 'var(--lx-fg-muted)' }}>
                  {item.detail}
                </p>
              </div>
            </div>

            {item.actionLabel || item.secondaryLabel ? (
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                {item.actionLabel && item.onAction ? (
                  <button
                    type="button"
                    onClick={item.onAction}
                    className="lx-pressable lx-btn-primary px-2.5 py-1 text-[11px] font-semibold"
                  >
                    {item.actionLabel}
                  </button>
                ) : null}
                {item.secondaryLabel && item.onSecondaryAction ? (
                  <button
                    type="button"
                    onClick={item.onSecondaryAction}
                    className="lx-pressable lx-btn-secondary px-2 py-1 text-[11px] font-medium"
                  >
                    {item.secondaryLabel}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

import { useEffect, useRef, useState } from 'react';
import { CloseIcon, UndoIcon } from './Icons';

export interface UndoToastProps {
  open: boolean;
  message: string;
  durationMs?: number;
  onUndo: () => void;
  onDismiss: () => void;
  undoLabel?: string;
}

export function UndoToast({
  open,
  message,
  durationMs = 10_000,
  onUndo,
  onDismiss,
  undoLabel = 'Revert to original',
}: UndoToastProps) {
  const [remainingMs, setRemainingMs] = useState(durationMs);
  const [paused, setPaused] = useState(false);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!open) return;
    setRemainingMs(durationMs);
  }, [open, durationMs]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onDismissRef.current();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  useEffect(() => {
    if (!open || paused) return;

    let lastTick = Date.now();
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) {
        lastTick = Date.now();
        return;
      }
      const now = Date.now();
      const delta = now - lastTick;
      lastTick = now;
      setRemainingMs((prev) => {
        const next = Math.max(0, prev - delta);
        if (next === 0) {
          onDismissRef.current();
        }
        return next;
      });
    }, 100);

    return () => window.clearInterval(timer);
  }, [open, paused]);

  if (!open) return null;

  const pct = durationMs > 0 ? Math.max(0, Math.min(100, (remainingMs / durationMs) * 100)) : 0;
  const secondsLeft = Math.ceil(remainingMs / 1000);

  return (
    <div
      role="status"
      aria-live="polite"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className="lx-surface-enter lx-elevated fixed right-4 bottom-4 z-50 w-[min(420px,calc(100vw-2rem))] overflow-hidden rounded-[8px] border"
      style={{
        backgroundColor: 'var(--lx-card)',
        borderColor: 'var(--lx-border-strong)',
        color: 'var(--lx-fg)',
      }}
    >
      <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
        <div className="min-w-0">
          <div className="text-[12px] font-medium">{message}</div>
          <div
            className="lexel-mono lx-tab-nums text-[10px]"
            style={{ color: 'var(--lx-fg-muted)' }}
          >
            {paused ? 'Timer paused' : `Auto-dismisses in ${secondsLeft}s`}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onUndo}
            className="lx-pressable lx-btn-primary inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold"
          >
            <UndoIcon className="h-3 w-3" />
            <span>{undoLabel}</span>
          </button>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss notification"
            className="lx-pressable lx-btn-ghost inline-flex h-7 w-7 items-center justify-center"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="h-[2px] w-full" style={{ backgroundColor: 'var(--lx-muted)' }}>
        <div
          className="h-full"
          style={{
            width: `${pct}%`,
            backgroundColor: 'var(--lx-signal)',
            transition: 'width 100ms linear',
          }}
        />
      </div>
    </div>
  );
}

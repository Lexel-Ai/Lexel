import { CloseIcon, NibIcon } from 'lexel-ui';
import { useEffect, useState } from 'react';
import type { PastedAiCheck } from '../shared/types';
import type { ActiveFieldHandle } from './AiFloatingPill';

export interface PastedDeslopPillProps {
  field: ActiveFieldHandle | null;
  check: PastedAiCheck | null;
  theme: 'dark' | 'light';
  busy?: boolean;
  onHumanize: () => void;
  onDismiss: () => void;
}

export function PastedDeslopPill({
  field,
  check,
  theme,
  busy = false,
  onHumanize,
  onDismiss,
}: PastedDeslopPillProps) {
  const [coords, setCoords] = useState<{ top: number; left: number; visible: boolean }>({
    top: 12,
    left: 12,
    visible: false,
  });

  useEffect(() => {
    if (!field || !check?.shouldOffer) {
      setCoords((prev) => ({ ...prev, visible: false }));
      return;
    }

    const update = () => {
      const rect = field.element.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 14) {
        setCoords((prev) => ({ ...prev, visible: false }));
        return;
      }
      const pillWidth = 310;
      const left = Math.max(12, Math.min(window.innerWidth - pillWidth - 12, rect.left));
      const aboveTop = rect.top - 44;
      const top = aboveTop >= 12 ? aboveTop : Math.min(window.innerHeight - 52, rect.bottom + 46);
      setCoords({ top, left, visible: true });
    };

    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [field, check]);

  useEffect(() => {
    if (!check?.shouldOffer) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onDismiss();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [check, onDismiss]);

  if (!field || !check?.shouldOffer || !coords.visible) {
    return null;
  }

  return (
    <div
      data-theme={theme}
      role="status"
      aria-live="polite"
      className="lexel-root lx-surface-enter lx-elevated"
      style={{
        position: 'fixed',
        top: `${coords.top}px`,
        left: `${coords.left}px`,
        zIndex: 2147483646,
        pointerEvents: 'auto',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        padding: '5px 8px 5px 10px',
        borderRadius: '6px',
        border: '1px solid var(--lx-warn)',
        backgroundColor: 'var(--lx-card)',
        color: 'var(--lx-fg)',
        maxWidth: 'calc(100vw - 24px)',
      }}
    >
      <NibIcon className="w-3.5 h-3.5 shrink-0" />
      <span
        className="lexel-mono lx-tab-nums text-[11px]"
        style={{ color: 'var(--lx-warn)' }}
        title={check.reason}
      >
        Slop {check.score}/100
      </span>
      <button
        type="button"
        disabled={busy}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onHumanize}
        className="lx-pressable lx-btn-primary px-2.5 py-1 text-[11px] font-semibold"
      >
        {busy ? 'Humanizing...' : 'Humanize pasted text'}
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onDismiss}
        aria-label="Dismiss pasted text notice"
        className="lx-pressable lx-btn-ghost inline-flex h-6 w-6 items-center justify-center"
      >
        <CloseIcon className="w-3 h-3" />
      </button>
    </div>
  );
}

import { CloseIcon } from 'lexel-ui';
import { useEffect, useState } from 'react';
import type { ActiveFieldHandle } from './AiFloatingPill';

export interface GhostTextOverlayProps {
  field: ActiveFieldHandle | null;
  completion: string | null;
  modelName?: string;
  theme: 'dark' | 'light';
  onAccept: () => void;
  onDismiss: () => void;
}

/**
 * Quiet opt-in ghost-text continuation bar anchored to the active composer.
 * Accepts on Tab (or click) and dismisses on Esc (or click).
 */
export function GhostTextOverlay({
  field,
  completion,
  modelName,
  theme,
  onAccept,
  onDismiss,
}: GhostTextOverlayProps) {
  const [coords, setCoords] = useState<{ top: number; left: number; visible: boolean }>({
    top: 12,
    left: 12,
    visible: false,
  });

  useEffect(() => {
    if (!field || !completion) {
      setCoords((prev) => ({ ...prev, visible: false }));
      return;
    }

    const update = () => {
      const rect = field.element.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 14) {
        setCoords((prev) => ({ ...prev, visible: false }));
        return;
      }
      const maxWidth = Math.min(420, Math.max(240, rect.width));
      const left = Math.max(12, Math.min(window.innerWidth - maxWidth - 12, rect.left));
      const top = Math.max(12, Math.min(window.innerHeight - 54, rect.bottom + 6));
      setCoords({ top, left, visible: true });
    };

    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [field, completion]);

  if (!field || !completion || !coords.visible) {
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
        zIndex: 2147483645,
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        maxWidth: 'min(420px, calc(100vw - 24px))',
        padding: '6px 10px',
        borderRadius: '6px',
        border: '1px solid var(--lx-border-strong)',
        backgroundColor: 'var(--lx-card)',
        color: 'var(--lx-fg)',
      }}
    >
      <span
        className="text-[12px] truncate"
        style={{ color: 'var(--lx-fg-muted)' }}
        title={completion}
      >
        ...{completion}
      </span>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onAccept}
        className="lx-pressable lx-btn-secondary shrink-0 px-2 py-0.5 text-[11px] font-medium lexel-mono"
        title={modelName ? `Local completion (${modelName})` : 'Accept completion'}
      >
        Tab
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onDismiss}
        aria-label="Dismiss completion"
        className="lx-pressable lx-btn-ghost shrink-0 inline-flex h-6 w-6 items-center justify-center"
      >
        <CloseIcon className="w-3 h-3" />
      </button>
    </div>
  );
}

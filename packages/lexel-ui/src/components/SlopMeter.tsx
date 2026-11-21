import { CheckIcon } from './Icons';

export interface SlopMeterBreakdown {
  clicheCount: number;
  emDashCount: number;
  fillerOpenerCount: number;
  flatRhythm?: boolean;
}

export interface SlopMeterProps {
  /** 0 = clean human prose, 100 = dense AI slop. */
  score: number;
  /** Optional explicit human-readable rating label; auto-derived from score if omitted. */
  label?: string;
  breakdown?: SlopMeterBreakdown;
  wordCount?: number;
  onDeSlop?: () => void;
  busy?: boolean;
  compact?: boolean;
}

function deriveSlopLabel(score: number): { text: string; tone: 'ok' | 'warn' | 'danger' } {
  if (score <= 15) return { text: 'Natural voice', tone: 'ok' };
  if (score <= 45) return { text: 'Mild AI tells', tone: 'warn' };
  return { text: 'High AI slop', tone: 'danger' };
}

export function SlopMeter({
  score,
  label,
  breakdown,
  wordCount,
  onDeSlop,
  busy = false,
  compact = false,
}: SlopMeterProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const rating = deriveSlopLabel(clamped);
  const toneColor =
    rating.tone === 'ok'
      ? 'var(--lx-ok)'
      : rating.tone === 'warn'
        ? 'var(--lx-warn)'
        : 'var(--lx-danger)';

  const hasWords = typeof wordCount !== 'number' || wordCount > 0;
  const displayLabel = !hasWords ? 'Waiting for text' : (label ?? rating.text);

  return (
    <div
      className={`rounded-[8px] border ${compact ? 'p-2.5' : 'p-3'}`}
      style={{
        backgroundColor: 'var(--lx-card)',
        borderColor: 'var(--lx-border)',
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold">Slop Meter</span>
          <span
            className="inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-0.5 text-[11px] font-medium lexel-mono lx-tab-nums"
            style={{
              backgroundColor: !hasWords
                ? 'var(--lx-muted)'
                : rating.tone === 'ok'
                  ? 'var(--lx-ok-bg)'
                  : rating.tone === 'warn'
                    ? 'var(--lx-warn-bg)'
                    : 'var(--lx-danger-bg)',
              borderColor: !hasWords ? 'var(--lx-border)' : toneColor,
              color: !hasWords ? 'var(--lx-fg-muted)' : toneColor,
            }}
          >
            {hasWords && rating.tone === 'ok' ? <CheckIcon className="h-3 w-3" /> : null}
            <span>{hasWords ? `${clamped}/100 · ${displayLabel}` : displayLabel}</span>
          </span>
        </div>

        {onDeSlop && hasWords && clamped > 15 ? (
          <button
            type="button"
            disabled={busy}
            onClick={onDeSlop}
            className="lx-pressable lx-btn-primary px-2.5 py-1 text-[11px] font-semibold"
          >
            {busy ? 'Cleaning...' : 'De-AI this'}
          </button>
        ) : null}
      </div>

      <div
        role="progressbar"
        aria-label="AI slop density score"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={hasWords ? clamped : 0}
        className="mt-2 h-1.5 w-full overflow-hidden rounded-[4px]"
        style={{ backgroundColor: 'var(--lx-muted)' }}
      >
        <div
          className="h-full"
          style={{
            width: `${hasWords ? Math.max(clamped, 3) : 0}%`,
            backgroundColor: toneColor,
            transition: 'width 180ms var(--lx-ease-out), background-color 180ms ease',
          }}
        />
      </div>

      {breakdown && hasWords ? (
        <div
          className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] lexel-mono lx-tab-nums"
          style={{ color: 'var(--lx-fg-muted)' }}
        >
          <span>Cliches: {breakdown.clicheCount}</span>
          <span>Em dashes: {breakdown.emDashCount}</span>
          <span>Filler openers: {breakdown.fillerOpenerCount}</span>
          {breakdown.flatRhythm ? (
            <span style={{ color: 'var(--lx-warn)' }}>Flat rhythm</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

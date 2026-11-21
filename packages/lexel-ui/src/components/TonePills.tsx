export type TonePillId =
  | 'fix_grammar_flow'
  | 'shorten'
  | 'direct'
  | 'softer'
  | 'deslop'
  | 'bluf'
  | 'natural_english'
  | 'rewrite_surface'
  | 'reply_draft';

export interface TonePillDef {
  id: TonePillId;
  label: string;
  hint: string;
}

export const DEFAULT_TONE_PILLS: readonly TonePillDef[] = [
  {
    id: 'fix_grammar_flow',
    label: 'Fix only',
    hint: 'Fix grammar and clarity without changing voice',
  },
  { id: 'shorten', label: 'Shorter', hint: 'Cut filler and tighten word count' },
  { id: 'direct', label: 'Direct', hint: 'Lead with the point and cut hedging' },
  { id: 'softer', label: 'Softer', hint: 'Keep the point while easing sharp edges' },
  { id: 'deslop', label: 'De-slop', hint: 'Strip AI buzzwords and em dashes' },
];

export const EXTENDED_TONE_PILLS: readonly TonePillDef[] = [
  ...DEFAULT_TONE_PILLS,
  { id: 'bluf', label: 'Lead with ask', hint: 'Put the question or decision first' },
  {
    id: 'natural_english',
    label: 'Natural English',
    hint: 'Smooth rough phrasing into natural prose',
  },
  { id: 'rewrite_surface', label: 'Match surface', hint: 'Adapt register to the target platform' },
  { id: 'reply_draft', label: 'Draft reply', hint: 'Write a concise response from thread context' },
];

export interface TonePillsProps {
  value?: TonePillId;
  pills?: readonly TonePillDef[];
  onSelect: (id: TonePillId) => void;
  disabled?: boolean;
  compact?: boolean;
  ariaLabel?: string;
}

export function TonePills({
  value,
  pills = DEFAULT_TONE_PILLS,
  onSelect,
  disabled = false,
  compact = false,
  ariaLabel = 'Rewrite tone and length actions',
}: TonePillsProps) {
  return (
    <fieldset
      aria-label={ariaLabel}
      className="m-0 flex flex-wrap items-center gap-1.5 border-0 p-0"
    >
      {pills.map((pill) => {
        const active = value === pill.id;
        return (
          <button
            key={pill.id}
            type="button"
            disabled={disabled}
            aria-pressed={value !== undefined ? active : undefined}
            title={pill.hint}
            onClick={() => onSelect(pill.id)}
            className={`lx-pressable rounded-[6px] border font-medium ${
              compact ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-[12px]'
            }`}
            style={{
              backgroundColor: active ? 'var(--lx-accent)' : 'var(--lx-surface)',
              borderColor: active ? 'var(--lx-accent)' : 'var(--lx-border)',
              color: active ? 'var(--lx-on-accent)' : 'var(--lx-fg)',
            }}
          >
            {pill.label}
          </button>
        );
      })}
    </fieldset>
  );
}

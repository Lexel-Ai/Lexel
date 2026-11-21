import { LockIcon } from './Icons';

export interface PrivacyProofBadgeProps {
  localOnly: boolean;
  blockedSecretsCount?: number;
  redactEnabled?: boolean;
  compact?: boolean;
}

export function PrivacyProofBadge({
  localOnly,
  blockedSecretsCount,
  redactEnabled = false,
  compact = false,
}: PrivacyProofBadgeProps) {
  const hasSecretCount = typeof blockedSecretsCount === 'number' && blockedSecretsCount >= 0;

  return (
    <div
      className={`inline-flex flex-wrap items-center gap-1.5 rounded-[4px] border lexel-mono lx-tab-nums ${
        compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-[11px]'
      }`}
      style={{
        backgroundColor: localOnly ? 'var(--lx-card)' : 'var(--lx-muted)',
        borderColor: 'var(--lx-border)',
        color: 'var(--lx-fg)',
      }}
      title={
        localOnly
          ? 'All grammar checks, voice memory, and local AI inference run on your machine with zero cloud API calls.'
          : 'Browser preview mode running local deterministic checks.'
      }
    >
      <span style={{ color: localOnly ? 'var(--lx-ok)' : 'var(--lx-fg-muted)' }}>
        <LockIcon className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
      </span>
      <span className="font-medium">{localOnly ? '0 bytes sent' : 'Local preview'}</span>
      {redactEnabled ? (
        <span
          className="border-l pl-1.5"
          style={{ borderColor: 'var(--lx-border)', color: 'var(--lx-signal)' }}
        >
          Redact-and-restore on
        </span>
      ) : null}
      {hasSecretCount ? (
        <span
          className="border-l pl-1.5"
          style={{
            borderColor: 'var(--lx-border)',
            color: blockedSecretsCount > 0 ? 'var(--lx-warn)' : 'var(--lx-fg-muted)',
          }}
        >
          {blockedSecretsCount} secret{blockedSecretsCount === 1 ? '' : 's'} blocked
        </span>
      ) : null}
    </div>
  );
}

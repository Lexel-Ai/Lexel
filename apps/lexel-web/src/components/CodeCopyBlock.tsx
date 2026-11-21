'use client';

import { CheckIcon } from 'lexel-ui';
import { useState } from 'react';

export interface CodeCopyBlockProps {
  code: string;
  label: string;
  languageLabel?: string;
}

export function CodeCopyBlock({ code, label, languageLabel }: CodeCopyBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className="overflow-hidden rounded-[8px] border"
      style={{
        backgroundColor: 'var(--lx-surface)',
        borderColor: 'var(--lx-border)',
      }}
    >
      <div
        className="flex items-center justify-between gap-3 border-b px-3.5 py-2"
        style={{ borderColor: 'var(--lx-border)' }}
      >
        <span className="lexel-mono text-xs" style={{ color: 'var(--lx-fg-muted)' }}>
          {languageLabel ?? label}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={`Copy ${label}`}
          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-[4px] border px-2.5 text-xs font-medium transition-colors"
          style={{
            backgroundColor: 'var(--lx-card)',
            borderColor: 'var(--lx-control-border)',
            color: copied ? 'var(--lx-signal)' : 'var(--lx-fg)',
          }}
        >
          {copied ? <CheckIcon className="h-3.5 w-3.5" /> : null}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre
        className="m-0 overflow-x-auto p-4 text-xs leading-relaxed lexel-mono"
        style={{ color: 'var(--lx-fg)' }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}

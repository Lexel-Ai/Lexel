import React from 'react';
import { MoonIcon, SunIcon } from './Icons';

export interface ThemeToggleProps {
  theme: 'dark' | 'light';
  onToggle: () => void;
}

export function ThemeToggle({ theme, onToggle }: ThemeToggleProps) {
  const nextLabel = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={nextLabel}
      title={nextLabel}
      className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] border transition-colors"
      style={{
        backgroundColor: 'var(--lx-muted)',
        borderColor: 'var(--lx-border)',
        color: 'var(--lx-fg)',
      }}
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

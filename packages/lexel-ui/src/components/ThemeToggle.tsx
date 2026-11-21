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
      className="lx-pressable lx-btn-secondary inline-flex h-8 w-8 items-center justify-center"
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

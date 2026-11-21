export type ResolvedTheme = 'light' | 'dark';

export const COLOR_SCHEME_STORAGE_KEY = 'lexel-color-scheme';

export function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function readStoredScheme(): ResolvedTheme | null {
  try {
    const raw = window.localStorage.getItem(COLOR_SCHEME_STORAGE_KEY);
    if (raw === 'light' || raw === 'dark') return raw;
    return null;
  } catch {
    return null;
  }
}

export function applySchemeToDocument(stored: ResolvedTheme | null): ResolvedTheme {
  const resolved: ResolvedTheme = stored ?? getSystemTheme();
  if (typeof document !== 'undefined') {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
    if (meta) {
      meta.content = stored ?? 'light dark';
    }
    if (stored) {
      document.documentElement.dataset.theme = stored;
    } else {
      delete document.documentElement.dataset.theme;
    }
  }
  return resolved;
}

/**
 * Two-state theme toggle following modern-web-guidance `dark-mode-toggle`:
 * - Target is always the opposite of the currently rendered theme.
 * - If target differs from system preference, persist literally (`light` or `dark`).
 * - If target matches system preference, remove stored override so the page follows OS changes again.
 */
export function toggleThemeScheme(): ResolvedTheme {
  const currentStored = readStoredScheme();
  const system = getSystemTheme();
  const rendered: ResolvedTheme = currentStored ?? system;
  const target: ResolvedTheme = rendered === 'dark' ? 'light' : 'dark';

  try {
    if (target === system) {
      window.localStorage.removeItem(COLOR_SCHEME_STORAGE_KEY);
      return applySchemeToDocument(null);
    }
    window.localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, target);
    return applySchemeToDocument(target);
  } catch {
    return applySchemeToDocument(target);
  }
}

/**
 * Tiny inline FOUC-prevention script placed right after `<meta name="color-scheme">`.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var s=localStorage.getItem('${COLOR_SCHEME_STORAGE_KEY}');if(s==='light'||s==='dark'){var m=document.querySelector('meta[name="color-scheme"]');if(m)m.content=s;document.documentElement.dataset.theme=s;}}catch(e){}})();`;

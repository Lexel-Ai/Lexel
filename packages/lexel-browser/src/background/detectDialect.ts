import { Dialect } from 'harper.js';

export function detectBrowserDialect(): Dialect {
  const langs = navigator.languages ?? [navigator.language];
  for (const lang of langs) {
    const norm = lang.toLowerCase();
    if (norm.startsWith('en-gb')) return Dialect.British;
    if (norm.startsWith('en-ca')) return Dialect.Canadian;
    if (norm.startsWith('en-au')) return Dialect.Australian;
    if (norm.startsWith('en-us') || norm === 'en') return Dialect.American;
  }
  return Dialect.American;
}

import surfacesData from '../../../../ml/personas/surfaces.json';
import type { DetectedSurfaceContext, SurfaceId, SurfaceProfile } from './types';

export const SURFACE_PROFILES: SurfaceProfile[] = surfacesData.surfaces as SurfaceProfile[];

const PROFILE_MAP = new Map<SurfaceId, SurfaceProfile>(
  SURFACE_PROFILES.map((profile) => [profile.id, profile]),
);

export const DEFAULT_PRIVACY_DOMAINS = [
  '*.bankofamerica.com',
  '*.chase.com',
  '*.wellsfargo.com',
  '*.paypal.com',
  '*.stripe.com',
  '1password.com',
  'vault.bitwarden.com',
];

export function listSurfaceProfiles(customSurfaces?: SurfaceProfile[]): SurfaceProfile[] {
  if (!customSurfaces || customSurfaces.length === 0) return SURFACE_PROFILES;
  const merged = new Map<string, SurfaceProfile>(
    SURFACE_PROFILES.map((profile) => [profile.id, profile]),
  );
  for (const custom of customSurfaces) {
    if (custom?.id) merged.set(custom.id, custom);
  }
  return [...merged.values()];
}

export function resolveSurfaceProfile(
  surfaceId: SurfaceId,
  customSurfaces?: SurfaceProfile[],
): SurfaceProfile {
  const customMatch = customSurfaces?.find((s) => s.id === surfaceId);
  if (customMatch) return customMatch;
  return PROFILE_MAP.get(surfaceId) ?? PROFILE_MAP.get('general')!;
}

export function getSurfaceProfile(
  surfaceId: SurfaceId,
  customSurfaces?: SurfaceProfile[],
): SurfaceProfile {
  return resolveSurfaceProfile(surfaceId, customSurfaces);
}

export function matchHostPattern(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase();
  const pat = pattern.toLowerCase().trim();
  if (!pat) return false;
  if (pat === '*') return true;
  if (pat.startsWith('*.')) {
    const suffix = pat.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === pat;
}

export function isDomainBlocked(hostname: string, blocklist: string[]): boolean {
  return blocklist.some((pattern) => matchHostPattern(hostname, pattern));
}

export function isSensitiveElement(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase();
    if (type === 'password' || type === 'hidden' || type === 'email' || type === 'tel') {
      return type === 'password' || type === 'hidden';
    }
    const ac = (el.getAttribute('autocomplete') ?? '').toLowerCase();
    if (ac.includes('cc-') || ac.includes('password') || ac.includes('one-time-code')) {
      return true;
    }
  }
  if (el.getAttribute('data-lexel-ignore') === 'true') {
    return true;
  }
  return false;
}

export function detectComposerKind(
  el: Element | null,
  pathname: string,
): 'reply' | 'post' | 'editor' {
  const aria = (el?.getAttribute('aria-label') ?? '').toLowerCase();
  const placeholder = (el?.getAttribute('placeholder') ?? '').toLowerCase();
  const combined = `${aria} ${placeholder}`;

  if (
    combined.includes('reply') ||
    combined.includes('comment') ||
    pathname.includes('/comments/') ||
    pathname.includes('/pull/') ||
    pathname.includes('/issues/')
  ) {
    return 'reply';
  }
  if (
    combined.includes('post') ||
    combined.includes('what is happening') ||
    pathname.includes('/submit')
  ) {
    return 'post';
  }
  return 'editor';
}

export function detectDomPlatformHint(doc?: Document): string | null {
  if (!doc) return null;
  if (doc.querySelector('meta[name="generator"][content*="WordPress"]')) return 'wordpress';
  if (doc.querySelector('link[rel="preconnect"][href*="substackcdn.com"]')) return 'substack';
  if (doc.querySelector('meta[name="generator"][content*="Discourse"]')) return 'discourse';
  if (doc.querySelector('meta[property="og:site_name"][content="GitLab"]')) return 'gitlab';
  return null;
}

export function detectSurfaceFromLocation(
  urlStr: string,
  options?: {
    blocklist?: string[];
    overrideSurface?: SurfaceId | null;
    focusedElement?: Element | null;
    doc?: Document;
    customSurfaces?: SurfaceProfile[];
  },
): DetectedSurfaceContext {
  let hostname = '';
  let pathname = '/';
  try {
    const parsed = new URL(urlStr);
    hostname = parsed.hostname.toLowerCase();
    pathname = parsed.pathname;
  } catch {
    hostname = urlStr.toLowerCase();
  }

  const blocklist = options?.blocklist ?? DEFAULT_PRIVACY_DOMAINS;
  if (isDomainBlocked(hostname, blocklist)) {
    return {
      surfaceId: 'general',
      label: 'Blocked',
      subcontext: null,
      composerKind: 'editor',
      domain: hostname,
      isBlocked: true,
      blockReason: 'Domain is on the local privacy blocklist',
    };
  }

  if (options?.focusedElement && isSensitiveElement(options.focusedElement)) {
    return {
      surfaceId: 'general',
      label: 'Protected Field',
      subcontext: null,
      composerKind: 'editor',
      domain: hostname,
      isBlocked: true,
      blockReason: 'Sensitive password or payment input excluded',
    };
  }

  const composerKind = detectComposerKind(options?.focusedElement ?? null, pathname);

  if (options?.overrideSurface) {
    const profile = getSurfaceProfile(options.overrideSurface, options.customSurfaces);
    return {
      surfaceId: profile.id,
      label: profile.label,
      subcontext: extractSubcontext(profile, pathname),
      composerKind,
      domain: hostname,
      isBlocked: false,
    };
  }

  for (const profile of listSurfaceProfiles(options?.customSurfaces)) {
    if (profile.id === 'general') continue;
    if (profile.hostPatterns.some((pat) => matchHostPattern(hostname, pat))) {
      return {
        surfaceId: profile.id,
        label: profile.label,
        subcontext: extractSubcontext(profile, pathname),
        composerKind,
        domain: hostname,
        isBlocked: false,
      };
    }
  }

  const domHint = detectDomPlatformHint(options?.doc);
  if (domHint === 'gitlab') {
    const gh = getSurfaceProfile('web_github_pr');
    return {
      surfaceId: gh.id,
      label: 'GitLab',
      subcontext: extractSubcontext(gh, pathname),
      composerKind,
      domain: hostname,
      isBlocked: false,
    };
  }
  if (domHint === 'substack' || domHint === 'wordpress' || domHint === 'discourse') {
    const mapped = getSurfaceProfile(`web_${domHint}`);
    return {
      surfaceId: mapped.id,
      label: mapped.label,
      subcontext: null,
      composerKind,
      domain: hostname,
      isBlocked: false,
    };
  }

  return {
    surfaceId: 'general',
    label: domHint ? domHint[0].toUpperCase() + domHint.slice(1) : 'General',
    subcontext: null,
    composerKind,
    domain: hostname,
    isBlocked: false,
  };
}

function extractSubcontext(profile: SurfaceProfile, pathname: string): string | null {
  if (!profile.pathRegex) return null;
  const match = pathname.match(new RegExp(profile.pathRegex, 'i'));
  if (!match || !match[1]) return null;
  if (profile.id === 'web_reddit') {
    return `r/${match[1]}`;
  }
  return match[1];
}

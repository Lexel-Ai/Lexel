import surfacesData from '../../../../ml/personas/surfaces.json';
import type { SurfaceId, SurfaceProfile } from './types';

export const SURFACE_PROFILES: SurfaceProfile[] = surfacesData.surfaces as SurfaceProfile[];

const PROFILE_MAP = new Map<SurfaceId, SurfaceProfile>(
  SURFACE_PROFILES.map((profile) => [profile.id, profile]),
);

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

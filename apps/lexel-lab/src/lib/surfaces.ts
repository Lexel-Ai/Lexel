import surfacesData from '../../../../ml/personas/surfaces.json';
import type { SurfaceId, SurfaceProfile } from './types';

export const SURFACE_PROFILES: SurfaceProfile[] = surfacesData.surfaces as SurfaceProfile[];

const PROFILE_MAP = new Map<SurfaceId, SurfaceProfile>(
  SURFACE_PROFILES.map((profile) => [profile.id, profile]),
);

export function getSurfaceProfile(surfaceId: SurfaceId): SurfaceProfile {
  return PROFILE_MAP.get(surfaceId) ?? PROFILE_MAP.get('general')!;
}

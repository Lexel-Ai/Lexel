import { BUILTIN_SURFACES, resolveSurfaceProfileShared, type SurfaceProfile } from 'lexel-ui';

/** Merge built-in surface profiles with persisted overrides and custom entries from `lexel.db`. */
export function mergeSurfaceCatalog(customSurfaces: SurfaceProfile[] = []): {
  surfaces: SurfaceProfile[];
  customOnlyIds: Set<string>;
} {
  const builtinIds = new Set(BUILTIN_SURFACES.map((s) => s.id));
  const mergedBuiltins = BUILTIN_SURFACES.map((b) =>
    resolveSurfaceProfileShared(b.id, customSurfaces),
  );
  const customOnly = customSurfaces.filter((s) => !builtinIds.has(s.id));
  return {
    surfaces: [...mergedBuiltins, ...customOnly],
    customOnlyIds: new Set(customOnly.map((s) => s.id)),
  };
}

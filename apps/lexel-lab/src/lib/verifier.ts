import type { UnpackedLint } from 'lint-framework';
import {
  SLOP_TERMS,
  applySafeDeterministicFixesShared,
  extractCodeAndUrlTokens,
  extractUnitBoundMetrics,
  findSlopMatches,
  hasSecrets,
  resolveSurfaceProfileShared,
  sanitizeModelOutput,
  scanSecretsAndPii,
  scanTier0DiagnosticsShared,
  verifyAiRewriteShared,
  type GateCheckSummary,
  type SafeFixResult,
  type SecretMatch,
  type SlopHit,
  type Tier0Options,
  type UnitBoundMetric,
} from 'lexel-ui';
import { getSurfaceProfile } from './surfaces';
import type { SurfaceId, SurfaceProfile } from './types';

export {
  SLOP_TERMS,
  extractCodeAndUrlTokens,
  extractUnitBoundMetrics,
  findSlopMatches,
  hasSecrets,
  sanitizeModelOutput,
  scanSecretsAndPii,
};
export type { SafeFixResult, SecretMatch, SlopHit, Tier0Options, UnitBoundMetric };

function resolveProfile(
  surfaceOrId: SurfaceId | SurfaceProfile,
  customSurfaces?: SurfaceProfile[],
): SurfaceProfile {
  if (typeof surfaceOrId !== 'string') return surfaceOrId;
  return (
    customSurfaces?.find((s) => s.id === surfaceOrId) ??
    getSurfaceProfile(surfaceOrId) ??
    resolveSurfaceProfileShared(surfaceOrId, customSurfaces)
  );
}

export function scanTier0Diagnostics(
  text: string,
  surfaceOrId: SurfaceId | SurfaceProfile,
  options?: Tier0Options,
): {
  slopLints: UnpackedLint[];
  surfaceLints: UnpackedLint[];
  secretLints: UnpackedLint[];
  secrets: SecretMatch[];
} {
  const profile = resolveProfile(surfaceOrId, options?.customSurfaces);
  return scanTier0DiagnosticsShared(text, profile, options) as {
    slopLints: UnpackedLint[];
    surfaceLints: UnpackedLint[];
    secretLints: UnpackedLint[];
    secrets: SecretMatch[];
  };
}

export function applySafeDeterministicFixes(
  text: string,
  surfaceOrId: SurfaceId | SurfaceProfile,
  options?: Tier0Options,
): SafeFixResult {
  const profile = resolveProfile(surfaceOrId, options?.customSurfaces);
  return applySafeDeterministicFixesShared(text, profile, options);
}

export function verifyAiRewrite(
  source: string,
  candidate: string,
  surfaceId: SurfaceId,
  options?: Tier0Options,
): GateCheckSummary {
  const profile = resolveProfile(surfaceId, options?.customSurfaces);
  return verifyAiRewriteShared(source, candidate, profile, options);
}

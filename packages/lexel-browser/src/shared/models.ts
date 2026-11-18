import manifestData from '../../../../models/manifest.json';

export type MainModelTier = 'lexel-0.5b' | 'lexel-1.5b' | 'custom';
export type RuntimeKind = 'auto' | 'llama_server' | 'ollama' | 'openai_compat';

export interface ManifestModelSpec {
  id: 'lexel-0.5b' | 'lexel-1.5b';
  tier: 'lite' | 'standard';
  label: string;
  description: string;
  ollamaTag: string;
  ggufRepo: string;
  ggufFilename: string;
  ggufUrl: string;
  sha256: string;
  sizeBytes: number;
  approxRamMb: number;
}

export const MODEL_MANIFEST_SPECS = manifestData.models as ManifestModelSpec[];
export const DEFAULT_MAIN_MODEL_ID = manifestData.defaultMainModel as 'lexel-0.5b' | 'lexel-1.5b';

export function resolveModelNameForTier(tier: MainModelTier, customModel: string): string {
  if (tier === 'lexel-0.5b') return 'qwen2.5:0.5b';
  if (tier === 'lexel-1.5b') return 'qwen2.5:1.5b';
  const trimmed = customModel.trim();
  return trimmed || 'qwen2.5:1.5b';
}

export function inferTierFromModelName(model: string): MainModelTier {
  const norm = model.trim().toLowerCase();
  if (norm === '0.5b' || norm === 'lexel-0.5b' || norm === 'qwen2.5:0.5b') {
    return 'lexel-0.5b';
  }
  if (norm === '1.5b' || norm === 'lexel-1.5b' || norm === 'qwen2.5:1.5b') {
    return 'lexel-1.5b';
  }
  return 'custom';
}

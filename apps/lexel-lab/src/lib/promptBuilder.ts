import {
  buildRewriteMessagesShared,
  selectRelevantVoiceExamplesShared,
} from 'lexel-ui';
import type { AiTaskId, SurfaceId, SurfaceProfile, VoiceExample } from './types';

export function selectRelevantVoiceExamples(
  examples: VoiceExample[],
  surfaceId: SurfaceId,
  sourceText: string,
  limit = 2,
): VoiceExample[] {
  return selectRelevantVoiceExamplesShared(examples, surfaceId, sourceText, limit);
}

export function buildRewriteMessages(params: {
  text: string;
  task: AiTaskId;
  surfaceId: SurfaceId;
  subcontext: string | null;
  threadContext?: string;
  voiceExamples: VoiceExample[];
  customSurfaces?: SurfaceProfile[];
}): Array<{ role: 'system' | 'user'; content: string }> {
  return buildRewriteMessagesShared(params);
}

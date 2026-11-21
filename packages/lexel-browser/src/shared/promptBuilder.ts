import {
  buildRewriteMessagesShared,
  type AiTaskId as SharedAiTaskId,
  selectRelevantVoiceExamplesShared,
} from 'lexel-ui';
import type { AiTaskId, SurfaceId, SurfaceProfile, VoiceExample } from './types';

const EXTRA_TASK_DIRECTIVES: Partial<Record<AiTaskId, string>> = {
  direct:
    'Task: Rewrite to be direct and clear. Lead with the main point, remove hedging, and preserve every fact, number, URL, and code token.',
  softer:
    'Task: Keep the core point direct and honest, but remove sharp, impatient, or abrasive edges so it lands constructively.',
  bluf: 'Task: Bottom Line Up Front (BLUF). Put the core ask, decision, or question in the first sentence, then keep supporting details brief.',
  natural_english:
    'Task: Smooth rough or non-native English into natural, idiomatic human prose without corporate jargon, em dashes, or losing technical specifics.',
};

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
  const extraDirective = EXTRA_TASK_DIRECTIVES[params.task];
  const baseTask: SharedAiTaskId = extraDirective
    ? 'rewrite_surface'
    : (params.task as SharedAiTaskId);

  const messages = buildRewriteMessagesShared({
    ...params,
    task: baseTask,
  });

  if (extraDirective && messages[0]?.role === 'system') {
    messages[0] = {
      ...messages[0],
      content: `${messages[0].content}\n${extraDirective}`,
    };
  }
  return messages;
}

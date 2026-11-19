import type { AiTaskId, SurfaceId, SurfaceProfile, UnitBoundMetric } from './types';
import { BUILTIN_SURFACES, resolveSurfaceProfileShared } from './verifierCore';

export interface VoicePromptExample {
  surfaceId: SurfaceId;
  original: string;
  rewritten: string;
  createdAt: number;
}

const TASK_INSTRUCTIONS: Record<AiTaskId, string> = {
  fix_grammar_flow:
    'Fix grammar, spelling, and awkward phrasing with minimal edits. Keep the author voice intact.',
  deslop:
    'Remove AI buzzwords, corporate padding, filler openers, and em dashes. Make every sentence direct and human.',
  rewrite_surface:
    'Rewrite the text to fit the target platform register and length rules naturally.',
  shorten:
    'Shorten by 30 to 50 percent while preserving every key fact, number, URL, and code token.',
  reply_draft:
    'Draft a concise, grounded reply based only on the author draft/notes and the provided thread context. Do not invent facts.',
};

function tokenizeWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length >= 3),
  );
}

export function selectRelevantVoiceExamplesShared<T extends VoicePromptExample>(
  examples: T[],
  surfaceId: SurfaceId,
  sourceText: string,
  limit = 2,
): T[] {
  const queryWords = tokenizeWords(sourceText);
  return examples
    .filter((ex) => ex.surfaceId === surfaceId || ex.surfaceId === 'general')
    .map((ex) => {
      let score = ex.surfaceId === surfaceId ? 10 : 1;
      const exWords = tokenizeWords(`${ex.original} ${ex.rewritten}`);
      for (const word of queryWords) {
        if (exWords.has(word)) score += 2;
      }
      return { ex, score, createdAt: ex.createdAt };
    })
    .sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
    .slice(0, limit)
    .map((item) => item.ex);
}

export function buildRewriteMessagesShared(params: {
  text: string;
  task: AiTaskId;
  surfaceId: SurfaceId;
  subcontext: string | null;
  threadContext?: string;
  voiceExamples: VoicePromptExample[];
  customSurfaces?: SurfaceProfile[];
}): Array<{ role: 'system' | 'user'; content: string }> {
  const profile = resolveSurfaceProfileShared(params.surfaceId, params.customSurfaces);
  const examples = selectRelevantVoiceExamplesShared(
    params.voiceExamples,
    params.surfaceId,
    params.text,
  );

  const systemLines = [
    'You are Lexel, a precise human writing editor.',
    'Rules:',
    '- Output ONLY the rewritten text. No preamble, no quotes, no explanation.',
    '- Preserve every number, metric, ID (#42), URL, and `code` token exactly.',
    '- Never use em dashes (—) or AI buzzwords (delve, tapestry, seamless, leverage, game-changer, unlock, pivotal).',
    `- Surface: ${profile.label} (${profile.id})`,
    ...(params.subcontext ? [`- Subcontext: ${params.subcontext}`] : []),
    `- Platform style: ${profile.promptDirective}`,
    `- Max characters: ${profile.maxChars}`,
    `- Task: ${TASK_INSTRUCTIONS[params.task]}`,
  ];

  if (examples.length > 0) {
    systemLines.push('<voice_examples>');
    for (const ex of examples) {
      systemLines.push(`- ${ex.rewritten.replace(/\s+/g, ' ').trim()}`);
    }
    systemLines.push('</voice_examples>');
  }

  const userParts: string[] = [];
  if (params.threadContext && params.threadContext.trim().length > 0) {
    userParts.push(
      `<thread_context>\n${params.threadContext.trim().slice(0, 1200)}\n</thread_context>`,
    );
  }
  userParts.push(`<source>\n${params.text.trim()}\n</source>`);

  return [
    { role: 'system', content: systemLines.join('\n') },
    { role: 'user', content: userParts.join('\n\n') },
  ];
}

export function getBuiltinSurfaceDefault(id: SurfaceId): SurfaceProfile | undefined {
  return BUILTIN_SURFACES.find((s) => s.id === id);
}

export function isSurfaceProfileCustomized(
  base: SurfaceProfile | undefined,
  current: SurfaceProfile,
): boolean {
  if (!base) return true;
  return (
    base.promptDirective !== current.promptDirective ||
    base.maxChars !== current.maxChars ||
    base.allowLinks !== current.allowLinks ||
    base.allowEmojis !== current.allowEmojis ||
    base.allowHashtags !== current.allowHashtags ||
    base.allowEmDashes !== current.allowEmDashes
  );
}

/**
 * Store or clear an edited override for a built-in or custom surface.
 * When a built-in surface matches its shipped defaults again, its override entry is pruned cleanly.
 */
export function upsertSurfaceOverride(
  customSurfaces: SurfaceProfile[],
  baseSurface: SurfaceProfile,
  patch: Partial<
    Pick<
      SurfaceProfile,
      | 'promptDirective'
      | 'maxChars'
      | 'allowLinks'
      | 'allowEmojis'
      | 'allowHashtags'
      | 'allowEmDashes'
    >
  >,
): SurfaceProfile[] {
  const builtin = getBuiltinSurfaceDefault(baseSurface.id);
  const next: SurfaceProfile = {
    ...baseSurface,
    ...patch,
    promptDirective:
      (patch.promptDirective ?? baseSurface.promptDirective).trim() ||
      (builtin?.promptDirective ?? baseSurface.promptDirective),
    maxChars: Math.max(40, patch.maxChars ?? baseSurface.maxChars),
  };

  const withoutId = customSurfaces.filter((s) => s.id !== baseSurface.id);
  if (builtin && !isSurfaceProfileCustomized(builtin, next)) {
    return withoutId;
  }
  return [...withoutId, next];
}

export function resetSurfaceOverride(
  customSurfaces: SurfaceProfile[],
  id: SurfaceId,
): SurfaceProfile[] {
  return customSurfaces.filter((s) => s.id !== id);
}

export type { UnitBoundMetric };

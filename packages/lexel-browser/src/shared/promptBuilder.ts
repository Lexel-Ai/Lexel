import { getSurfaceProfile } from './surfaceDetector';
import type { AiTaskId, SurfaceId, VoiceExample } from './types';

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

export function selectRelevantVoiceExamples(
  examples: VoiceExample[],
  surfaceId: SurfaceId,
  sourceText: string,
  limit = 2,
): VoiceExample[] {
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

export function buildRewriteMessages(params: {
  text: string;
  task: AiTaskId;
  surfaceId: SurfaceId;
  subcontext: string | null;
  threadContext?: string;
  voiceExamples: VoiceExample[];
}): Array<{ role: 'system' | 'user'; content: string }> {
  const profile = getSurfaceProfile(params.surfaceId);
  const examples = selectRelevantVoiceExamples(params.voiceExamples, params.surfaceId, params.text);

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
    userParts.push(`<thread_context>\n${params.threadContext.trim().slice(0, 1200)}\n</thread_context>`);
  }
  userParts.push(`<source>\n${params.text.trim()}\n</source>`);

  return [
    { role: 'system', content: systemLines.join('\n') },
    { role: 'user', content: userParts.join('\n\n') },
  ];
}

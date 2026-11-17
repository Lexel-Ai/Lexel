import { describe, expect, it } from 'vitest';
import { buildRewriteMessages, selectRelevantVoiceExamples } from '../src/shared/promptBuilder';
import type { VoiceExample } from '../src/shared/types';

describe('promptBuilder', () => {
  const sampleVoice: VoiceExample[] = [
    {
      id: '1',
      surfaceId: 'web_reddit',
      subcontext: 'r/rust',
      original: 'I think maybe tokio is good',
      rewritten: 'Tokio works well here, though watch allocator overhead past 10k req/s.',
      action: 'accepted',
      createdAt: 100,
    },
    {
      id: '2',
      surfaceId: 'web_email',
      subcontext: null,
      original: 'Hello',
      rewritten: 'Quick update on Tuesday release.',
      action: 'accepted',
      createdAt: 200,
    },
  ];

  it('prefers surface-matched and keyword-matched local voice examples', () => {
    const picked = selectRelevantVoiceExamples(
      sampleVoice,
      'web_reddit',
      'We tested tokio under heavy load.',
      2,
    );
    expect(picked[0]?.id).toBe('1');
  });

  it('builds structured surface prompt with voice examples and thread context', () => {
    const messages = buildRewriteMessages({
      text: 'tokio is seamless and great',
      task: 'rewrite_surface',
      surfaceId: 'web_reddit',
      subcontext: 'r/rust',
      threadContext: 'How does tokio scale?',
      voiceExamples: sampleVoice,
    });
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain('Surface: Reddit (web_reddit)');
    expect(messages[0].content).toContain('Subcontext: r/rust');
    expect(messages[0].content).toContain('<voice_examples>');
    expect(messages[1].content).toContain('<thread_context>');
    expect(messages[1].content).toContain('<source>');
  });
});

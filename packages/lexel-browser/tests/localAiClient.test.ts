import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertLocalEndpoint, checkLocalAiHealth } from '../src/shared/localAiClient';
import { DEFAULT_AI_SETTINGS } from '../src/shared/storage';

describe('localAiClient privacy boundary & health checks', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('allows loopback hosts and rejects remote hosts', () => {
    expect(assertLocalEndpoint('http://127.0.0.1:11434').hostname).toBe('127.0.0.1');
    expect(assertLocalEndpoint('http://localhost:8080').hostname).toBe('localhost');
    expect(() => assertLocalEndpoint('https://api.openai.com/v1')).toThrow(/not local/i);
  });

  it('reports 403 origin blocks with OLLAMA_ORIGINS instructions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Forbidden', { status: 403 })),
    );
    const res = await checkLocalAiHealth(DEFAULT_AI_SETTINGS);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('OLLAMA_ORIGINS');
  });

  it('detects when Ollama is reachable but configured model is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ models: [{ name: 'llama3.2:1b' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    const res = await checkLocalAiHealth(DEFAULT_AI_SETTINGS);
    expect(res.ok).toBe(true);
    expect(res.modelAvailable).toBe(false);
    expect(res.error).toContain('qwen2.5:1.5b');
  });

  it('marks modelAvailable true when configured model is present', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ models: [{ name: 'qwen2.5:1.5b' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    const res = await checkLocalAiHealth(DEFAULT_AI_SETTINGS);
    expect(res.ok).toBe(true);
    expect(res.modelAvailable).toBe(true);
    expect(res.error).toBeUndefined();
  });
});

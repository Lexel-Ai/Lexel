import { describe, expect, it } from 'vitest';
import { assertLocalEndpoint } from '../src/shared/localAiClient';

describe('localAiClient privacy boundary', () => {
  it('allows loopback hosts and rejects remote hosts', () => {
    expect(assertLocalEndpoint('http://127.0.0.1:11434').hostname).toBe('127.0.0.1');
    expect(assertLocalEndpoint('http://localhost:8080').hostname).toBe('localhost');
    expect(() => assertLocalEndpoint('https://api.openai.com/v1')).toThrow(/not local/i);
  });
});

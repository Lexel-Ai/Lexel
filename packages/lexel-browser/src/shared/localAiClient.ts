import type { AiSettings } from './types';

export interface LocalAiHealth {
  ok: boolean;
  models: string[];
  error?: string;
}

export function assertLocalEndpoint(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid AI endpoint URL.');
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
    throw new Error(
      `Privacy block: endpoint host "${host}" is not local. Only 127.0.0.1 or localhost is permitted.`,
    );
  }
  return parsed;
}

function normalizeEndpoint(endpoint: string): string {
  return assertLocalEndpoint(endpoint).toString().replace(/\/+$/, '');
}

export async function checkLocalAiHealth(settings: AiSettings): Promise<LocalAiHealth> {
  if (!settings.enabled) {
    return { ok: false, models: [], error: 'Local AI is disabled in settings.' };
  }

  let base: string;
  try {
    base = normalizeEndpoint(settings.endpoint);
  } catch (err) {
    return { ok: false, models: [], error: (err as Error).message };
  }

  try {
    if (settings.provider === 'ollama') {
      const res = await fetch(`${base}/api/tags`, { method: 'GET' });
      if (!res.ok) {
        return {
          ok: false,
          models: [],
          error:
            res.status === 403
              ? 'Ollama blocked extension origin (403). Start Ollama with: OLLAMA_ORIGINS="chrome-extension://*" ollama serve'
              : `Ollama returned HTTP ${res.status}`,
        };
      }
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      const models = (data.models ?? []).map((m) => m.name);
      return { ok: true, models };
    }

    const res = await fetch(`${base}/v1/models`, { method: 'GET' });
    if (!res.ok) {
      return { ok: false, models: [], error: `Local server returned HTTP ${res.status}` };
    }
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const models = (data.data ?? []).map((m) => m.id);
    return { ok: true, models };
  } catch {
    return {
      ok: false,
      models: [],
      error:
        settings.provider === 'ollama'
          ? `Cannot reach Ollama at ${base}. Run: OLLAMA_ORIGINS="chrome-extension://*" ollama serve`
          : `Cannot reach local AI server at ${base}.`,
    };
  }
}

export async function generateLocalRewrite(
  settings: AiSettings,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
): Promise<string> {
  if (!settings.enabled) {
    throw new Error('Local AI is disabled. Enable it in Lexel Settings.');
  }

  const base = normalizeEndpoint(settings.endpoint);

  if (settings.provider === 'ollama') {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        messages,
        stream: false,
        options: {
          temperature: settings.temperature,
          num_predict: settings.maxTokens,
        },
      }),
    });

    if (!res.ok) {
      if (res.status === 403) {
        throw new Error(
          'Ollama rejected the extension request (403). Restart Ollama with: OLLAMA_ORIGINS="chrome-extension://*" ollama serve',
        );
      }
      if (res.status === 404) {
        throw new Error(`Model "${settings.model}" not found. Run: ollama pull ${settings.model}`);
      }
      const body = await res.text();
      throw new Error(`Ollama error (${res.status}): ${body.slice(0, 160)}`);
    }

    const payload = (await res.json()) as { message?: { content?: string } };
    const content = payload.message?.content ?? '';
    if (!content.trim()) {
      throw new Error('Local model returned an empty response.');
    }
    return content;
  }

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.model,
      messages,
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
      stream: false,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Local AI server error (${res.status}): ${body.slice(0, 160)}`);
  }

  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content ?? '';
  if (!content.trim()) {
    throw new Error('Local model returned an empty response.');
  }
  return content;
}

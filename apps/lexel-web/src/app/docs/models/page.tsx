import type { Metadata } from 'next';
import { DocsShell } from '@/components/DocsShell';
import { formatMegabytes, MODEL_SPECS } from '@/lib/siteData';

export const metadata: Metadata = {
  title: 'Model Tiers & Runtimes',
  description:
    'Local quantized GGUF models in models/manifest.json (Lexel 0.5B Lite and Lexel 1.5B Standard), SHA-256 verification, lazy loading, and idle auto-unload.',
};

export default function DocsModelsPage() {
  return (
    <DocsShell
      title="Model Tiers & Runtimes"
      description="Optional local GGUF models run on demand via llama-server or Ollama on 127.0.0.1, stay verified by SHA-256, and unload automatically when idle."
    >
      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          Official manifest tiers
        </h2>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable table region requires keyboard focus per WCAG 2.1.1 */}
        <section tabIndex={0} aria-labelledby="models-table-caption" className="lx-table-region">
          <table className="lx-table">
            <caption
              id="models-table-caption"
              className="border-b px-4 py-3 text-left text-xs font-medium"
              style={{ borderColor: 'var(--lx-border)', color: 'var(--lx-fg-muted)' }}
            >
              Artifacts declared in models/manifest.json
            </caption>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Tier</th>
                <th scope="col">Download Size</th>
                <th scope="col">Approx RAM</th>
                <th scope="col">GGUF Filename</th>
                <th scope="col">Ollama Tag</th>
              </tr>
            </thead>
            <tbody>
              {MODEL_SPECS.map((model) => (
                <tr key={model.id}>
                  <th scope="row">{model.label}</th>
                  <td data-label="Tier" className="lexel-mono text-xs">
                    {model.tier}
                  </td>
                  <td data-label="Download Size" className="lexel-mono text-xs">
                    {formatMegabytes(model.sizeBytes)}
                  </td>
                  <td data-label="Approx RAM" className="lexel-mono text-xs">
                    ~{model.approxRamMb} MB
                  </td>
                  <td data-label="GGUF Filename" className="lexel-mono text-xs">
                    {model.ggufFilename}
                  </td>
                  <td data-label="Ollama Tag" className="lexel-mono text-xs">
                    {model.ollamaTag}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </section>

      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          Lifecycle and memory safeguards
        </h2>
        <ul className="m-0 space-y-2 pl-5" style={{ color: 'var(--lx-fg)' }}>
          <li>
            <strong>Cold boot:</strong> When idle,{' '}
            <code className="lx-inline-code">lexel-daemon</code> holds no LLM weights in memory.
            Tier 0 handles passive typing checks at 0 MB AI RAM.
          </li>
          <li>
            <strong>Tier 0 fast-path bypass:</strong> If you trigger <em>Fix grammar</em> or{' '}
            <em>De-slop</em> and deterministic fixes resolve every detected issue, Lexel returns
            immediately without waking the local LLM.
          </li>
          <li>
            <strong>
              Speed multipliers in <code className="lx-inline-code">llama-server</code>:
            </strong>{' '}
            Uses KV prompt prefix caching (
            <code className="lx-inline-code">cache_prompt: true</code>), prompt-lookup n-gram
            speculative decoding when supported by your installed{' '}
            <code className="lx-inline-code">llama-server</code> build, and sampler{' '}
            <code className="lx-inline-code">logit_bias</code> to suppress em dashes during
            generation.
          </li>
          <li>
            <strong>Idle auto-unload:</strong> After the configurable idle TTL (default 3 minutes),
            the daemon drops model memory back to the OS. Machines with 16+ GB RAM can optionally
            keep weights warm.
          </li>
          <li>
            <strong>SHA-256 verification:</strong> Downloads resume over HTTP Range into a{' '}
            <code className="lx-inline-code">.part</code> file and check exact byte length plus
            SHA-256 before moving into <code className="lx-inline-code">models/</code>.
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          Bring your own local runtime
        </h2>
        <p className="m-0" style={{ color: 'var(--lx-fg-muted)' }}>
          Lexel works with <code className="lx-inline-code">llama-server</code> (from{' '}
          <code className="lx-inline-code">llama.cpp</code>), Ollama on{' '}
          <code className="lx-inline-code">127.0.0.1:11434</code>, or any local OpenAI-compatible
          loopback server. You can also configure an optional local{' '}
          <code className="lx-inline-code">whisper-cli</code> binary and GGML model in{' '}
          <code className="lx-inline-code">models/whisper/</code> for 100% offline dictation.
        </p>
      </section>
    </DocsShell>
  );
}

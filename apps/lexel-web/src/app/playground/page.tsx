import type { Metadata } from 'next';
import { PlaygroundWorkspace } from '@/components/PlaygroundWorkspace';

export const metadata: Metadata = {
  title: 'Tier 0 Playground',
  description:
    'Run Lexel Tier 0 checks directly in your browser: anti-slop meter, surface policies, document consistency, BLUF and regret shield guards, and Secrets Guard. Zero server calls.',
};

export default function PlaygroundPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-6 space-y-2 border-b pb-5" style={{ borderColor: 'var(--lx-border)' }}>
        <h1 className="lx-section-title m-0" style={{ color: 'var(--lx-fg)' }}>
          Client-Side Tier 0 Playground
        </h1>
        <p className="m-0 max-w-2xl text-sm sm:text-base" style={{ color: 'var(--lx-fg-muted)' }}>
          Paste any draft to run deterministic anti-slop scoring, platform surface checks,
          consistency analysis, writing guards, and Secrets Guard locally in your browser with zero
          network requests.
        </p>
      </header>

      <PlaygroundWorkspace />
    </div>
  );
}

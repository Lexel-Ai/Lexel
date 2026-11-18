import type { SurfaceId } from './types';

export interface LabPreset {
  id: string;
  label: string;
  surfaceId: SurfaceId;
  subcontext: string;
  text: string;
  threadContext?: string;
}

export const LAB_PRESETS: LabPreset[] = [
  {
    id: 'reddit_slop',
    label: 'Reddit + AI Slop + Link',
    surfaceId: 'web_reddit',
    subcontext: 'r/rust',
    text: 'In todays fast-paced landscape, I wanted to delve into why our Rust service is seamlessly leveraging tokio for 42ms p99 latency — its truly a game-changer! Check https://example.com #rust 🚀',
  },
  {
    id: 'github_pr',
    label: 'GitHub PR + Typos + Code Tokens',
    surfaceId: 'web_github_pr',
    subcontext: 'Lexel-Ai/Lexel#42',
    text: 'Great job! This PR leverages `LexelLintController` to fix teh hover delay of 160ms on #42. Furthermore, we should verify `computeLintBoxes` doesnt regress.',
  },
  {
    id: 'x_limit',
    label: 'X Post Over 280 Chars + Hashtags',
    surfaceId: 'web_x',
    subcontext: '',
    text: 'We just shipped a local grammar and anti-slop engine that runs inside the browser in under 5ms without sending a single keystroke to any cloud server. It checks typos, strips AI buzzwords, and keeps technical metrics like 42ms and #42 intact across every surface! #AI #Rust #LocalFirst',
  },
  {
    id: 'linkedin_opener',
    label: 'LinkedIn Corporate Padding',
    surfaceId: 'web_linkedin',
    subcontext: '',
    text: "Thanks for sharing! I'm thrilled to announce that our team embarked on a transformative journey to unlock robust synergy across our platform — elevating productivity to the next level. 🚀",
  },
  {
    id: 'reply_notes',
    label: 'Reply Draft (Use Thread Context)',
    surfaceId: 'web_reddit',
    subcontext: 'r/programming',
    text: 'agree on wasm cold start. we moved dictionary init to lazy worker, kept typing under 4ms, 1.5b model stays unloaded until alt+l',
    threadContext:
      'Comment by u/dev_user: Running a 1.5B model in the browser slows down typing on 8GB laptops, and loading a 5MB WASM grammar dictionary on startup feels heavy.',
  },
  {
    id: 'clean_start',
    label: 'Empty Draft',
    surfaceId: 'general',
    subcontext: '',
    text: '',
  },
];

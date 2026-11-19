import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRIVACY_DOMAINS,
  detectSurfaceFromLocation,
  isDomainBlocked,
} from '../src/shared/surfaceDetector';

describe('surfaceDetector', () => {
  it('detects Reddit and extracts subreddit subcontext', () => {
    const ctx = detectSurfaceFromLocation('https://www.reddit.com/r/rust/comments/12345/tokio/');
    expect(ctx.surfaceId).toBe('web_reddit');
    expect(ctx.subcontext).toBe('r/rust');
    expect(ctx.composerKind).toBe('reply');
    expect(ctx.isBlocked).toBe(false);
  });

  it('detects GitHub PR and extracts owner/repo', () => {
    const ctx = detectSurfaceFromLocation('https://github.com/automattic/harper/pull/42');
    expect(ctx.surfaceId).toBe('web_github_pr');
    expect(ctx.subcontext).toBe('automattic/harper');
    expect(ctx.composerKind).toBe('reply');
  });

  it('detects X, LinkedIn, Discord, and Gmail', () => {
    expect(detectSurfaceFromLocation('https://x.com/home').surfaceId).toBe('web_x');
    expect(detectSurfaceFromLocation('https://www.linkedin.com/feed/').surfaceId).toBe(
      'web_linkedin',
    );
    expect(detectSurfaceFromLocation('https://discord.com/channels/1/2').surfaceId).toBe(
      'web_discord_slack',
    );
    expect(detectSurfaceFromLocation('https://mail.google.com/mail/u/0/#inbox').surfaceId).toBe(
      'web_email',
    );
  });

  it('blocks privacy-sensitive domains and password inputs', () => {
    expect(isDomainBlocked('online.chase.com', DEFAULT_PRIVACY_DOMAINS)).toBe(true);
    const blocked = detectSurfaceFromLocation('https://online.chase.com/login');
    expect(blocked.isBlocked).toBe(true);

    const input = document.createElement('input');
    input.type = 'password';
    const sensitive = detectSurfaceFromLocation('https://example.com', { focusedElement: input });
    expect(sensitive.isBlocked).toBe(true);
  });

  it('respects manual surface overrides', () => {
    const ctx = detectSurfaceFromLocation('https://example.com/notes', {
      overrideSurface: 'web_x',
    });
    expect(ctx.surfaceId).toBe('web_x');
  });
});

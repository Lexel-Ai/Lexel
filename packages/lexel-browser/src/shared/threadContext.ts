import type { ScopedThreadContext } from './types';

const MAX_EXTRACTED_CHARS = 1600;
const CHARS_PER_TOKEN = 4;

function cleanBlockText(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.length / CHARS_PER_TOKEN));
}

function tokenizeKeywords(text: string): Set<string> {
  const matches = text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
  return new Set(matches);
}

/**
 * Extract only the immediately relevant parent comment, email message, or PR diff hunk
 * around `el`. MUST ONLY be called on an explicit user action (never passively in background).
 */
export function extractSmartThreadContext(
  el: HTMLElement | null,
  doc: Document = document,
  hostname: string = typeof window !== 'undefined' ? window.location.hostname : '',
): { rawContext: string; sourceHint: string } {
  const host = hostname.toLowerCase();
  const blocks: string[] = [];
  let sourceHint = 'Page context';

  const heading = cleanBlockText(
    doc.querySelector('h1, [data-testid="issue-title"], .gh-header-title')?.textContent,
  );

  // GitHub / GitLab PR diff hunk or immediate review comment
  if (host.includes('github.com') || host.includes('gitlab.com')) {
    sourceHint = 'PR diff & parent comment';
    if (heading) blocks.push(`Title: ${heading.slice(0, 180)}`);

    const reviewThread = el?.closest(
      '.review-thread-component, .inline-comments, .discussion-item',
    );
    if (reviewThread) {
      const diffTable = reviewThread.previousElementSibling?.closest('table, .file, .diff-table');
      const diffLines = diffTable
        ? Array.from(
            diffTable.querySelectorAll(
              '.blob-code-addition, .blob-code-deletion, .blob-code-context',
            ),
          )
            .slice(-10)
            .map((n) => cleanBlockText(n.textContent))
            .filter(Boolean)
        : [];
      if (diffLines.length > 0) {
        blocks.push(`Diff hunk:\n${diffLines.join('\n')}`);
      }
      const parentComment = cleanBlockText(
        reviewThread.querySelector('.comment-body, .markdown-body')?.textContent,
      );
      if (parentComment) {
        blocks.push(`Parent comment:\n${parentComment.slice(0, 700)}`);
      }
    }

    if (blocks.length <= 1) {
      const comments = Array.from(
        doc.querySelectorAll('.timeline-comment .comment-body, .note-text'),
      );
      const latest = comments[comments.length - 1];
      const latestText = cleanBlockText(latest?.textContent);
      if (latestText) {
        blocks.push(`Latest comment:\n${latestText.slice(0, 800)}`);
      }
    }
  } else if (host.includes('mail.google.com') || host.includes('outlook.')) {
    sourceHint = 'Parent email message';
    const subject = cleanBlockText(doc.querySelector('h2.hP, [aria-label="Subject"]')?.textContent);
    if (subject) blocks.push(`Subject: ${subject.slice(0, 160)}`);
    const messages = Array.from(
      doc.querySelectorAll('.a3s.aiL, [data-message-id] .a3s, [role="document"]'),
    );
    const latest = messages[messages.length - 1];
    const bodyText = cleanBlockText(latest?.textContent);
    if (bodyText) {
      blocks.push(`Parent email:\n${bodyText.slice(0, 900)}`);
    }
  } else if (host.includes('reddit.com')) {
    sourceHint = 'Parent Reddit comment';
    if (heading) blocks.push(`Post: ${heading.slice(0, 180)}`);
    const parentComment =
      el
        ?.closest('shreddit-comment, [data-testid="comment"], .Comment')
        ?.querySelector('[slot="comment"], p') ?? el?.closest('article');
    const commentText = cleanBlockText(parentComment?.textContent);
    if (commentText) {
      blocks.push(`Parent comment:\n${commentText.slice(0, 800)}`);
    }
  } else if (host.includes('x.com') || host.includes('twitter.com')) {
    sourceHint = 'Parent post';
    const tweet = doc.querySelector('article[data-testid="tweet"] [data-testid="tweetText"]');
    const tweetText = cleanBlockText(tweet?.textContent);
    if (tweetText) {
      blocks.push(`Parent post:\n${tweetText.slice(0, 500)}`);
    }
  } else if (host.includes('slack.com') || host.includes('discord.com')) {
    sourceHint = 'Recent thread messages';
    const container =
      el?.closest('[role="complementary"], [data-qa="threads_flexpane"], main') ?? doc.body;
    const msgs = Array.from(
      container.querySelectorAll('[data-qa="message-text"], [id^="message-content-"]'),
    )
      .slice(-3)
      .map((n) => cleanBlockText(n.textContent))
      .filter(Boolean);
    if (msgs.length > 0) {
      blocks.push(msgs.join('\n\n'));
    }
  } else {
    if (heading) blocks.push(`Title: ${heading.slice(0, 180)}`);
    const parent = el?.closest('[data-testid="comment"], .Comment, .comment, article');
    if (parent && parent !== el && !el?.contains(parent)) {
      const cloneText = cleanBlockText(parent.textContent);
      if (cloneText) {
        blocks.push(cloneText.slice(0, 900));
      }
    }
  }

  const combined = blocks.filter(Boolean).join('\n\n').slice(0, MAX_EXTRACTED_CHARS).trim();
  return { rawContext: combined, sourceHint };
}

/**
 * Deterministic client-side thread context scoper mirroring engine's ~300-token scoper
 * so browser-side previews and offline/direct modes stay tightly bounded.
 */
export function scopeThreadContextLocally(
  source: string,
  threadContext: string,
  maxTokens = 300,
): ScopedThreadContext {
  const cleaned = cleanBlockText(threadContext);
  if (!cleaned) {
    return {
      scopedText: '',
      estimatedTokens: 0,
      originalTokens: 0,
      truncated: false,
      keptBlocks: 0,
      totalBlocks: 0,
    };
  }

  const originalTokens = estimateTokens(cleaned);
  const rawBlocks = cleaned
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  if (originalTokens <= maxTokens) {
    return {
      scopedText: cleaned,
      estimatedTokens: originalTokens,
      originalTokens,
      truncated: false,
      keptBlocks: rawBlocks.length,
      totalBlocks: rawBlocks.length,
    };
  }

  const sourceTerms = tokenizeKeywords(source);
  const scored = rawBlocks.map((block, index) => {
    const terms = tokenizeKeywords(block);
    let overlap = 0;
    for (const t of terms) {
      if (sourceTerms.has(t)) overlap += 1;
    }
    const positionBoost = index === 0 ? 1.5 : index === rawBlocks.length - 1 ? 1.0 : 0;
    return { index, block, score: overlap * 2 + positionBoost, tokens: estimateTokens(block) };
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  const chosen: Array<{ index: number; block: string }> = [];
  let usedTokens = 0;
  for (const item of scored) {
    if (usedTokens + item.tokens <= maxTokens || chosen.length === 0) {
      const budgetChars = Math.max(120, (maxTokens - usedTokens) * CHARS_PER_TOKEN);
      const clipped =
        item.block.length > budgetChars
          ? `${item.block.slice(0, budgetChars - 1).trimEnd()}...`
          : item.block;
      chosen.push({ index: item.index, block: clipped });
      usedTokens += estimateTokens(clipped);
      if (usedTokens >= maxTokens) break;
    }
  }

  chosen.sort((a, b) => a.index - b.index);
  const scopedText = chosen.map((c) => c.block).join('\n\n');
  return {
    scopedText,
    estimatedTokens: estimateTokens(scopedText),
    originalTokens,
    truncated: true,
    keptBlocks: chosen.length,
    totalBlocks: rawBlocks.length,
  };
}

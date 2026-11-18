import type { UnpackedLint } from 'lint-framework';
import { describe, expect, it } from 'vitest';
import { parseSafeLintParagraphs } from '../src/contentScript/LexelSuggestionPopover';
import {
  computeSingleTextEdit,
  remapLintToCurrentSource,
} from '../src/contentScript/lintSpanMapping';

describe('lintSpanMapping', () => {
  it('shifts spans after an insertion and rejects overlapping edits', () => {
    const source = 'Hello wrld today.';
    const lint: UnpackedLint = {
      span: { start: 6, end: 10 },
      message_html: '<p>Typo</p>',
      problem_text: 'wrld',
      lint_kind: 'Spelling',
      lint_kind_pretty: 'Spelling',
      suggestions: [],
      context_hash: '1',
      source,
    };

    const prepended = 'Well, Hello wrld today.';
    const edit = computeSingleTextEdit(source, prepended);
    expect(edit?.delta).toBe(6);

    const remapped = remapLintToCurrentSource(lint, prepended);
    expect(remapped?.span).toEqual({ start: 12, end: 16 });

    const editedInside = 'Hello world today.';
    expect(remapLintToCurrentSource(lint, editedInside)).toBeNull();
  });
});

describe('parseSafeLintParagraphs', () => {
  it('preserves code segments and ignores unsafe tags', () => {
    const paragraphs = parseSafeLintParagraphs(
      '<p>Did you mean <code>their</code> instead?<script>alert(1)</script></p>',
    );
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]).toEqual([
      { type: 'text', text: 'Did you mean ' },
      { type: 'code', text: 'their' },
      { type: 'text', text: ' instead?' },
    ]);
  });
});

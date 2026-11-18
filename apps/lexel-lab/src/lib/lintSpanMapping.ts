import type { UnpackedLint, UnpackedSpan } from 'lint-framework';

export interface SingleTextEdit {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  delta: number;
}

export function computeSingleTextEdit(previous: string, current: string): SingleTextEdit | null {
  if (previous === current) return null;

  let prefixLength = 0;
  const shortestLength = Math.min(previous.length, current.length);
  while (prefixLength < shortestLength && previous[prefixLength] === current[prefixLength]) {
    prefixLength++;
  }

  let suffixLength = 0;
  while (
    suffixLength < previous.length - prefixLength &&
    suffixLength < current.length - prefixLength &&
    previous[previous.length - 1 - suffixLength] === current[current.length - 1 - suffixLength]
  ) {
    suffixLength++;
  }

  const oldStart = prefixLength;
  const oldEnd = previous.length - suffixLength;
  const newStart = prefixLength;
  const newEnd = current.length - suffixLength;

  return {
    oldStart,
    oldEnd,
    newStart,
    newEnd,
    delta: newEnd - newStart - (oldEnd - oldStart),
  };
}

export function remapSpanForTextEdit(
  span: UnpackedSpan,
  edit: SingleTextEdit | null,
): UnpackedSpan | null {
  if (edit == null) return { ...span };
  if (span.end <= edit.oldStart) return { ...span };
  if (span.start >= edit.oldEnd) {
    return {
      start: span.start + edit.delta,
      end: span.end + edit.delta,
    };
  }
  return null;
}

export function remapLintToCurrentSource(
  lint: UnpackedLint,
  currentSource: string,
): UnpackedLint | null {
  if (lint.source === currentSource) return lint;
  const span = remapSpanForTextEdit(lint.span, computeSingleTextEdit(lint.source, currentSource));
  if (span == null) return null;
  if (currentSource.slice(span.start, span.end) !== lint.problem_text) return null;
  return { ...lint, span, source: currentSource };
}

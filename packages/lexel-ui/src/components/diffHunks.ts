export interface DiffHunk {
  id: string;
  kind: 'equal' | 'change';
  original: string;
  suggested: string;
  accepted: boolean;
}

/** Tokenize text while preserving whitespace runs so reconstruction is lossless. */
function tokenize(text: string): string[] {
  if (!text) return [];
  return text.match(/\s+|[^\s]+/g) ?? [text];
}

/**
 * Compute word-level diff hunks using LCS, grouping adjacent edits into cohesive
 * toggleable hunks so users can accept or reject phrase-level changes independently.
 */
export function computeDiffHunks(original: string, suggested: string): DiffHunk[] {
  if (original === suggested) {
    return original ? [{ id: 'hunk-0', kind: 'equal', original, suggested, accepted: true }] : [];
  }

  const a = tokenize(original);
  const b = tokenize(suggested);

  // Guard against quadratic DP on very large drafts by falling back to paragraph diff.
  if (a.length * b.length > 180_000) {
    return computeParagraphHunks(original, suggested);
  }

  const m = a.length;
  const n = b.length;
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));

  for (let i = m - 1; i >= 0; i--) {
    const row = dp[i];
    const nextRow = dp[i + 1];
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        row[j] = nextRow[j + 1] + 1;
      } else {
        row[j] = Math.max(nextRow[j], row[j + 1]);
      }
    }
  }

  type Op = { kind: 'equal' | 'del' | 'add'; text: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'equal', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: 'del', text: a[i] });
      i++;
    } else {
      ops.push({ kind: 'add', text: b[j] });
      j++;
    }
  }
  while (i < m) {
    ops.push({ kind: 'del', text: a[i++] });
  }
  while (j < n) {
    ops.push({ kind: 'add', text: b[j++] });
  }

  // Merge adjacent del/add (and tiny whitespace-only equal bridges between edits) into phrase hunks.
  const hunks: DiffHunk[] = [];
  let idx = 0;
  let hunkSeq = 0;

  while (idx < ops.length) {
    if (ops[idx].kind === 'equal') {
      let equalBuf = '';
      while (idx < ops.length && ops[idx].kind === 'equal') {
        equalBuf += ops[idx].text;
        idx++;
      }
      // If a single space separates two changes, absorb it only when already inside a change.
      hunks.push({
        id: `hunk-${hunkSeq++}`,
        kind: 'equal',
        original: equalBuf,
        suggested: equalBuf,
        accepted: true,
      });
    } else {
      let delBuf = '';
      let addBuf = '';
      while (idx < ops.length && ops[idx].kind !== 'equal') {
        if (ops[idx].kind === 'del') {
          delBuf += ops[idx].text;
        } else {
          addBuf += ops[idx].text;
        }
        idx++;
      }
      hunks.push({
        id: `hunk-${hunkSeq++}`,
        kind: 'change',
        original: delBuf,
        suggested: addBuf,
        accepted: true,
      });
    }
  }

  // Coalesce `change -> whitespace-only equal -> change` into a single cleaner phrase hunk.
  const merged: DiffHunk[] = [];
  for (let k = 0; k < hunks.length; k++) {
    const curr = hunks[k];
    const prev = merged[merged.length - 1];
    const next = hunks[k + 1];
    if (
      curr.kind === 'equal' &&
      /^[ \t]+$/.test(curr.original) &&
      prev?.kind === 'change' &&
      next?.kind === 'change'
    ) {
      prev.original += curr.original + next.original;
      prev.suggested += curr.suggested + next.suggested;
      k++;
    } else {
      merged.push(curr);
    }
  }

  return merged.map((h, index) => ({ ...h, id: `hunk-${index}` }));
}

function computeParagraphHunks(original: string, suggested: string): DiffHunk[] {
  const a = original.split(/(\n\n+)/);
  const b = suggested.split(/(\n\n+)/);
  const maxLen = Math.max(a.length, b.length);
  const hunks: DiffHunk[] = [];
  for (let i = 0; i < maxLen; i++) {
    const orig = a[i] ?? '';
    const sugg = b[i] ?? '';
    if (orig === sugg) {
      hunks.push({
        id: `hunk-${i}`,
        kind: 'equal',
        original: orig,
        suggested: sugg,
        accepted: true,
      });
    } else {
      hunks.push({
        id: `hunk-${i}`,
        kind: 'change',
        original: orig,
        suggested: sugg,
        accepted: true,
      });
    }
  }
  return hunks;
}

/** Compose final text from the current accept/reject state of each hunk. */
export function composeHunkText(hunks: readonly DiffHunk[]): string {
  return hunks.map((h) => (h.kind === 'equal' || h.accepted ? h.suggested : h.original)).join('');
}

export function summarizeHunkState(hunks: readonly DiffHunk[]): {
  totalChanges: number;
  acceptedChanges: number;
  isPartial: boolean;
} {
  let totalChanges = 0;
  let acceptedChanges = 0;
  for (const h of hunks) {
    if (h.kind === 'change') {
      totalChanges += 1;
      if (h.accepted) acceptedChanges += 1;
    }
  }
  return {
    totalChanges,
    acceptedChanges,
    isPartial: totalChanges > 0 && acceptedChanges > 0 && acceptedChanges < totalChanges,
  };
}

export type DiffOp = 'equal' | 'insert' | 'delete';

export interface DiffChunk {
  op: DiffOp;
  text: string;
}

/**
 * Word diff (CONV-14): Myers' O((N+M)·D) algorithm over interned word ids in
 * typed arrays, run in the `cv` worker (`workers/cv.worker.ts`) by both the
 * Compare view and the text-diff export — never on the main thread.
 *
 * It replaced an `(n+1)×(m+1)` LCS table of JS numbers: about 217 ms and
 * 132 MB on the main thread per Compare page switch at the old 4,000-word cap.
 * Myers' cost grows with the number of *differences* D, not the product of the
 * lengths, so near-identical pages of any length are cheap.
 *
 * Bounds: past {@link MAX_DIFF_WORDS} words on either side, `diffText` goes
 * straight to {@link coarseDiff}. When D exceeds the Myers budget below — two
 * texts that differ a lot — the differing middle is still diffed word-precisely
 * by Hirschberg's linear-space LCS as long as its cell count fits
 * {@link MAX_LCS_CELLS} (R-CONV-8: two quite different 3,500-word pages used to
 * come back as one delete block and one insert block). Only past that does it
 * fall back to {@link coarseDiff}, a linear scan that reports the differing
 * middle as one insert run and one delete run. Neither fallback can stall or
 * run out of memory.
 */
export const MAX_DIFF_WORDS = 200_000;

/** Upper bound on D (edit distance, in words) the precise diff will search. */
export const MAX_DIFF_EDITS = 2_500;
/**
 * Upper bound on (N+M)·D work. Keeps the worst case around a second even for
 * two 100k-word documents, by lowering the D cap as the inputs grow.
 */
const MAX_DIFF_WORK = 200_000_000;

/**
 * Largest differing middle (old words × new words) the Hirschberg LCS fallback
 * takes on. It visits each cell about twice with O(N + M) memory, so 25 M
 * cells — e.g. two 5,000-word pages with nothing in common — is roughly
 * 100–200 ms in the cv worker.
 */
export const MAX_LCS_CELLS = 25_000_000;

export function diffText(oldText: string, newText: string): DiffChunk[] {
  const oldWords = oldText.split(/\s+/).filter(w => w.length > 0);
  const newWords = newText.split(/\s+/).filter(w => w.length > 0);

  if (oldWords.length > MAX_DIFF_WORDS || newWords.length > MAX_DIFF_WORDS) {
    return coarseDiff(oldWords, newWords);
  }

  // Common prefix and suffix are equal runs whatever happens in between, and
  // trimming them first keeps the search to the region that actually differs.
  const n = oldWords.length;
  const m = newWords.length;
  let start = 0;
  while (start < n && start < m && oldWords[start] === newWords[start]) start++;
  let endOld = n;
  let endNew = m;
  while (endOld > start && endNew > start && oldWords[endOld - 1] === newWords[endNew - 1]) {
    endOld--;
    endNew--;
  }

  const ids = new Map<string, number>();
  const intern = (words: string[], from: number, to: number) => {
    const out = new Int32Array(to - from);
    for (let i = from; i < to; i++) {
      let id = ids.get(words[i]);
      if (id === undefined) {
        id = ids.size;
        ids.set(words[i], id);
      }
      out[i - from] = id;
    }
    return out;
  };
  const a = intern(oldWords, start, endOld);
  const b = intern(newWords, start, endNew);

  const size = a.length + b.length;
  const maxD = Math.min(MAX_DIFF_EDITS, size, Math.floor(MAX_DIFF_WORK / Math.max(1, size)));
  const middle =
    myers(a, b, maxD) ?? (a.length * b.length <= MAX_LCS_CELLS ? hirschbergScript(a, b) : null);
  if (!middle) return coarseDiff(oldWords, newWords);

  const result: DiffChunk[] = [];
  for (let i = 0; i < start; i++) result.push({ op: 'equal', text: oldWords[i] });
  // Within each run of changes, insertions are listed before deletions — the
  // order the previous LCS implementation produced, which the export's
  // rendering and its tests were written against.
  let inserts: DiffChunk[] = [];
  let deletes: DiffChunk[] = [];
  const flush = () => {
    for (const c of inserts) result.push(c);
    for (const c of deletes) result.push(c);
    inserts = [];
    deletes = [];
  };
  for (const [op, index] of middle) {
    if (op === 'equal') {
      flush();
      result.push({ op, text: oldWords[start + index] });
    } else if (op === 'insert') {
      inserts.push({ op, text: newWords[start + index] });
    } else {
      deletes.push({ op, text: oldWords[start + index] });
    }
  }
  flush();
  for (let i = endOld; i < n; i++) result.push({ op: 'equal', text: oldWords[i] });
  return result;
}

/**
 * Myers' greedy forward search with a snapshot of the V array per D step
 * (O(D²) memory, bounded by `maxD`), then a backtrack. Returns the edit script
 * as [op, index] pairs — the index into `a` for equal/delete, into `b` for
 * insert — or null when the edit distance exceeds `maxD`.
 */
function myers(a: Int32Array, b: Int32Array, maxD: number): [DiffOp, number][] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  const offset = maxD + 1;
  const v = new Int32Array(2 * maxD + 3);
  const trace: Int32Array[] = [];
  let found = -1;

  search: for (let d = 0; d <= maxD; d++) {
    // Snapshot of k ∈ [-(d+1), d+1] as it stood after step d-1.
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break search;
      }
    }
  }
  if (found < 0) return null;

  const script: [DiffOp, number][] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const at = (k: number) => prev[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      script.push(['equal', x]);
    }
    if (x === prevX) {
      y--;
      script.push(['insert', y]);
    } else {
      x--;
      script.push(['delete', x]);
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    script.push(['equal', x]);
  }
  return script.reverse();
}

/**
 * An optimal (longest-common-subsequence) edit script by Hirschberg's
 * divide-and-conquer: O(N·M) time, O(N + M) memory, the same [op, index]
 * shape {@link myers} returns. Used when the edit distance is past Myers'
 * budget but the middle is small enough to afford N·M.
 */
function hirschbergScript(a: Int32Array, b: Int32Array): [DiffOp, number][] {
  const script: [DiffOp, number][] = [];
  const forward = new Int32Array(b.length + 1);
  const backward = new Int32Array(b.length + 1);

  /** LCS lengths of a[aLo, aHi) against every prefix of b[bLo, bHi), into `row`. */
  const prefixLengths = (aLo: number, aHi: number, bLo: number, bHi: number, row: Int32Array) => {
    const m = bHi - bLo;
    row.fill(0, 0, m + 1);
    for (let i = aLo; i < aHi; i++) {
      let diagonal = 0;
      const ai = a[i];
      for (let j = 1; j <= m; j++) {
        const up = row[j];
        row[j] = ai === b[bLo + j - 1] ? diagonal + 1 : up > row[j - 1] ? up : row[j - 1];
        diagonal = up;
      }
    }
  };
  /** The same from the other end: LCS of a[aLo, aHi) against every suffix of b. */
  const suffixLengths = (aLo: number, aHi: number, bLo: number, bHi: number, row: Int32Array) => {
    const m = bHi - bLo;
    row.fill(0, 0, m + 1);
    for (let i = aHi - 1; i >= aLo; i--) {
      let diagonal = 0;
      const ai = a[i];
      for (let j = 1; j <= m; j++) {
        const up = row[j];
        row[j] = ai === b[bHi - j] ? diagonal + 1 : up > row[j - 1] ? up : row[j - 1];
        diagonal = up;
      }
    }
  };

  const solve = (aLo: number, aHi: number, bLo: number, bHi: number): void => {
    if (aLo === aHi) {
      for (let j = bLo; j < bHi; j++) script.push(['insert', j]);
      return;
    }
    if (bLo === bHi) {
      for (let i = aLo; i < aHi; i++) script.push(['delete', i]);
      return;
    }
    if (aHi - aLo === 1) {
      const at = b.subarray(bLo, bHi).indexOf(a[aLo]);
      if (at < 0) {
        script.push(['delete', aLo]);
        for (let j = bLo; j < bHi; j++) script.push(['insert', j]);
        return;
      }
      for (let j = bLo; j < bLo + at; j++) script.push(['insert', j]);
      script.push(['equal', aLo]);
      for (let j = bLo + at + 1; j < bHi; j++) script.push(['insert', j]);
      return;
    }
    const mid = (aLo + aHi) >>> 1;
    const m = bHi - bLo;
    prefixLengths(aLo, mid, bLo, bHi, forward);
    suffixLengths(mid, aHi, bLo, bHi, backward);
    let split = 0;
    let best = -1;
    for (let j = 0; j <= m; j++) {
      const total = forward[j] + backward[m - j];
      if (total > best) {
        best = total;
        split = j;
      }
    }
    solve(aLo, mid, bLo, bLo + split);
    solve(mid, aHi, bLo + split, bHi);
  };

  solve(0, a.length, 0, b.length);
  return script;
}

/**
 * Linear-time, linear-memory fallback for documents too large or too different
 * to diff precisely. Trims the matching prefix and suffix, then reports the
 * entire differing middle as one inserted run followed by one deleted run —
 * coarser (it won't find matches *inside* the changed region), but it can't
 * OOM or stall on any input size.
 */
export function coarseDiff(oldWords: string[], newWords: string[]): DiffChunk[] {
  const n = oldWords.length;
  const m = newWords.length;

  let start = 0;
  while (start < n && start < m && oldWords[start] === newWords[start]) start++;

  let endOld = n;
  let endNew = m;
  while (endOld > start && endNew > start && oldWords[endOld - 1] === newWords[endNew - 1]) {
    endOld--;
    endNew--;
  }

  const result: DiffChunk[] = [];
  for (let i = 0; i < start; i++) result.push({ op: 'equal', text: oldWords[i] });
  for (let j = start; j < endNew; j++) result.push({ op: 'insert', text: newWords[j] });
  for (let i = start; i < endOld; i++) result.push({ op: 'delete', text: oldWords[i] });
  for (let i = endOld; i < n; i++) result.push({ op: 'equal', text: oldWords[i] });
  return result;
}

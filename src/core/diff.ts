export type DiffOp = 'equal' | 'insert' | 'delete';

export interface DiffChunk {
  op: DiffOp;
  text: string;
}

/**
 * The LCS table below is `(n+1)×(m+1)` numbers — quadratic in word count. Two
 * 50,000-word documents would be a ~2.5-billion-cell array, well past what any
 * tab can allocate. Past this many words on either side, `diffText` falls back
 * to `coarseDiff`, a linear scan that only distinguishes "byte-identical" runs
 * from "differs somewhere in this stretch" rather than word-precise LCS.
 */
const MAX_LCS_WORDS = 4000;

/**
 * A basic word-based diff using Longest Common Subsequence.
 */
export function diffText(oldText: string, newText: string): DiffChunk[] {
  const oldWords = oldText.split(/\s+/).filter(w => w.length > 0);
  const newWords = newText.split(/\s+/).filter(w => w.length > 0);

  if (oldWords.length > MAX_LCS_WORDS || newWords.length > MAX_LCS_WORDS) {
    return coarseDiff(oldWords, newWords);
  }

  const n = oldWords.length;
  const m = newWords.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldWords[i - 1] === newWords[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const result: DiffChunk[] = [];
  let i = n,
    j = m;

  while (i > 0 && j > 0) {
    if (oldWords[i - 1] === newWords[j - 1]) {
      result.push({ op: 'equal', text: oldWords[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      result.push({ op: 'delete', text: oldWords[i - 1] });
      i--;
    } else {
      result.push({ op: 'insert', text: newWords[j - 1] });
      j--;
    }
  }

  while (i > 0) {
    result.push({ op: 'delete', text: oldWords[i - 1] });
    i--;
  }

  while (j > 0) {
    result.push({ op: 'insert', text: newWords[j - 1] });
    j--;
  }

  return result.reverse();
}

/**
 * Linear-time, linear-memory fallback for documents too large to LCS-diff.
 * Trims the matching prefix and suffix, then reports the entire differing
 * middle as one deleted run followed by one inserted run — coarser than the
 * word-level LCS (it won't find matches *inside* the changed region), but it
 * can't OOM or stall the main thread on any input size.
 */
function coarseDiff(oldWords: string[], newWords: string[]): DiffChunk[] {
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
  for (let i = start; i < endOld; i++) result.push({ op: 'delete', text: oldWords[i] });
  for (let j = start; j < endNew; j++) result.push({ op: 'insert', text: newWords[j] });
  for (let i = endOld; i < n; i++) result.push({ op: 'equal', text: oldWords[i] });
  return result;
}

export type DiffOp = 'equal' | 'insert' | 'delete';

export interface DiffChunk {
  op: DiffOp;
  text: string;
}

/**
 * A basic word-based diff using Longest Common Subsequence.
 */
export function diffText(oldText: string, newText: string): DiffChunk[] {
  const oldWords = oldText.split(/\s+/).filter(w => w.length > 0);
  const newWords = newText.split(/\s+/).filter(w => w.length > 0);

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

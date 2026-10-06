/**
 * "Never larger than the input" — one rule for every size-reducing tool
 * (audit pattern 2: IMG-1, OPS-19's grayscale-as-compress, IMG-5).
 *
 * Compress, Image to size and Grayscale each used to guard this their own way,
 * and only Compress did it fully. The decision is small but easy to get wrong
 * in two directions, so it lives here once:
 *
 *  - a result that is smaller is always the one to save;
 *  - a result that is not smaller loses to the original **only when the
 *    original already satisfies the request** — fits every limit, is in the
 *    format asked for, has the orientation asked for. A colour PDF does not
 *    satisfy "make it grey", and a HEIC does not satisfy "a JPEG under 50 KB",
 *    however small it is;
 *  - otherwise the result is larger than the input and the caller must not
 *    save it silently: it has to say so and let the person choose.
 */

export type SizeChoice =
  /** Save the result: it is strictly smaller than the original. */
  | 'result'
  /** Keep the original: it already does the job and the result is no smaller. */
  | 'original'
  /** The result is the only thing that does the job, and it is the bigger file. */
  | 'larger'
  /** The result does the job and is exactly the original's size. */
  | 'same';

export function chooseSmaller(input: {
  originalBytes: number;
  resultBytes: number;
  /** True only when the original, unchanged, meets every part of the request. */
  originalSatisfies: boolean;
}): SizeChoice {
  const { originalBytes, resultBytes, originalSatisfies } = input;
  if (resultBytes < originalBytes) return 'result';
  if (originalSatisfies) return 'original';
  return resultBytes > originalBytes ? 'larger' : 'same';
}

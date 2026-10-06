/**
 * OPS-19 — grey and black-and-white as a compression lever (mainly for scans).
 *
 * Compress first, then convert, through the one grayscale pipeline
 * (`grayscaleDocument`), not the other way round:
 *
 *  - Converting first would hand Compress a B&W document whose scan pages its
 *    raster route re-renders to an RGB JPEG — throwing away the 1-bit encoding
 *    that is the whole saving, and leaving pages that are no longer verified
 *    grey (or no longer black and white at all).
 *  - Converting last means the bytes the grey pass verifies (its re-read for
 *    leftover colour) are the bytes that get written, and B&W stays 1-bit.
 *
 * The size decision is `chooseSmaller` with `originalSatisfies: true`: this is
 * a *compress* request with grey as the means, so an original that is already
 * smaller than the converted result does the job, and is what is kept
 * (OPS-19 AC: "a compress use never outputs a file larger than its input").
 * The Grayscale tool asks the opposite question and passes `false`.
 */
import { grayscaleDocument, type GrayscaleResult } from './operations';
import { chooseSmaller } from './size-guard';
import type { JobOptions } from './workers/protocol';

/** `keep` is the default: Compress never changes colours unless asked. */
export type CompressColour = 'keep' | 'gray' | 'bw';

/**
 * A page the grey pass left (partly) in colour. The Grayscale tool saves such a
 * conversion and lists these in its panel; Compress saves it too, and must say
 * which pages and why rather than claim the whole file was converted.
 */
export interface GreyGap {
  /** 0-based. */
  pageIndex: number;
  /** Why the converter could not convert the page (route 'failed'). Translated. */
  reasons: string[];
  /** Colour images on the page in an encoding that cannot be decoded here (JPX, JBIG2). */
  undecodableImages: number;
}

export type GrayLeverOutcome =
  /**
   * The converted file is strictly smaller than the original: save `bytes`.
   * `gaps` lists the pages left in colour (empty when every page converted).
   */
  | {
      kind: 'smaller';
      bytes: Uint8Array;
      result: GrayscaleResult;
      rasterPages: number;
      gaps: GreyGap[];
    }
  /** Converted, but not smaller than the original — keep the original, write nothing. */
  | { kind: 'not-smaller'; resultBytes: number; result: GrayscaleResult }
  /** Nothing carried colour; the compressed bytes are unchanged by this step. */
  | { kind: 'already-grey' }
  /** The re-read still found colour on these pages (0-based); write nothing. */
  | { kind: 'unverified'; colourLeft: number[] };

/**
 * Converts every page of `compressed` (Compress's output, or the original when
 * Compress kept it) and decides against the size of `originalBytes`, the file
 * the person opened.
 */
export async function applyGrayLever(input: {
  compressed: Uint8Array;
  originalBytes: number;
  pageCount: number;
  mode: Exclude<CompressColour, 'keep'>;
  /** Compress's "Scanned-page resolution", reused for pages grey has to render. */
  rasterDpi: number;
  job?: JobOptions;
}): Promise<GrayLeverOutcome> {
  const { compressed, originalBytes, pageCount, mode, rasterDpi, job = {} } = input;
  const pages = Array.from({ length: pageCount }, (_, index) => index);
  const result = await grayscaleDocument(compressed, pages, pageCount, { mode, rasterDpi }, job);
  if (result.nothingToDo) return { kind: 'already-grey' };
  if (result.colourLeft.length > 0) return { kind: 'unverified', colourLeft: result.colourLeft };
  const choice = chooseSmaller({
    originalBytes,
    resultBytes: result.bytes.byteLength,
    originalSatisfies: true
  });
  if (choice !== 'result') {
    return { kind: 'not-smaller', resultBytes: result.bytes.byteLength, result };
  }
  return {
    kind: 'smaller',
    bytes: result.bytes,
    result,
    rasterPages: result.pages.filter(page => page.route === 'raster').length,
    gaps: greyGaps(result)
  };
}

/** Pages `result` left in colour — failed pages and undecodable images — in page order. */
export function greyGaps(result: GrayscaleResult): GreyGap[] {
  const gaps = new Map<number, GreyGap>();
  const gap = (pageIndex: number) => {
    let entry = gaps.get(pageIndex);
    if (!entry) {
      entry = { pageIndex, reasons: [], undecodableImages: 0 };
      gaps.set(pageIndex, entry);
    }
    return entry;
  };
  for (const page of result.pages) {
    if (page.route === 'failed') gap(page.pageIndex).reasons.push(...page.reasons);
  }
  for (const u of result.undecodable) gap(u.pageIndex).undecodableImages += u.count;
  return [...gaps.values()].sort((a, b) => a.pageIndex - b.pageIndex);
}

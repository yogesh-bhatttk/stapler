/**
 * OCR-01 — the shapes that cross the worker boundary.
 *
 * Kept in their own module so the OCR worker, the pdf-lib worker, and the main
 * thread can all name them without any of them importing another worker's module
 * (which would pull tesseract.js or pdf-lib into the wrong bundle).
 */

/** Axis-aligned box in the OCR bitmap's pixel space; y grows downward. */
export interface OcrBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * One recognised word. Word-level granularity is all a searchable text layer
 * needs, and it is what tesseract reports natively — reconstructing lines or
 * paragraphs beyond that would be inventing structure the engine did not measure.
 */
export interface OcrWord {
  text: string;
  /** In the bitmap's pixel space. */
  bbox: OcrBox;
  /** 0..100, straight from tesseract. Low-confidence words are still emitted. */
  confidence: number;
  /**
   * y of the line's baseline in bitmap pixels, when tesseract measured one.
   * Undefined falls back to the bottom of the word's own box, which sits a
   * descender too low but never misplaces the word.
   */
  baselineY?: number;
}

export interface OcrPageResult {
  words: OcrWord[];
  /** Whole-page text, in tesseract's reading order. */
  text: string;
}

/**
 * What `addOcrTextLayer` needs per page: the words plus the exact bitmap geometry
 * they were measured in, so the mapping back to PDF points is arithmetic rather
 * than a guess. `dpi` is the resolution the page was rasterised at.
 */
export interface OcrPageLayer {
  pageIndex: number;
  bitmapWidth: number;
  bitmapHeight: number;
  dpi: number;
  words: OcrWord[];
}

export interface OcrLayerReport {
  /** Words written into the invisible text layer. */
  wordsAdded: number;
  /**
   * Words dropped because the standard font cannot encode them. Reported rather
   * than silently swallowed — a page whose text is mostly unencodable is a page
   * whose OCR result the user should not trust.
   */
  wordsSkipped: number;
  pagesTouched: number;
}

/**
 * The page *as the user saw it* — one frame for every placement path (audit
 * 2026-09-25, root cause M2).
 *
 * Every UI overlay in Stapler (crop, sign, annotate, watermark preview, form
 * field placement) is drawn over a pdf.js render, and pdf.js renders the page's
 * **view box** — `/CropBox` intersected with `/MediaBox`, falling back to the
 * `/MediaBox` — turned by `/Rotate`, with its origin at the top-left. pdf-lib's
 * `getSize()` is the raw, unrotated `/MediaBox` with no origin at all.
 *
 * Placing UI coordinates against `getSize()` was right only for an uncropped,
 * unrotated page whose MediaBox starts at (0, 0). On anything else — a scan
 * with a crop, a print file with bleed, a MediaBox of `[100 100 712 892]`, a
 * `/Rotate 90` phone scan — signatures landed outside the visible page,
 * whiteout covered the wrong corner, and the raster compressor stretched a
 * cropped scan back over its margins. This module is the single place that
 * reproduces pdf.js's view box, so every tool maps through the same frame.
 */
import { PDFArray, PDFNumber, PDFRef, type PDFPage } from 'pdf-lib';
import { displayFrame, type DisplayFrame } from '../rotation';

export interface PageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** pdf.js's own fallback when a page has no usable `/MediaBox`. */
const LETTER: PageBox = { x: 0, y: 0, width: 612, height: 792 };

/**
 * A box array as pdf.js reads it: four numbers, normalised so the corners may be
 * written in any order, and rejected (`null`) if it has no area.
 */
function readBox(page: PDFPage, array: PDFArray | undefined): PageBox | null {
  if (!array || array.size() !== 4) return null;
  const values: number[] = [];
  for (let i = 0; i < 4; i++) {
    const raw = array.get(i);
    const entry = raw instanceof PDFRef ? page.doc.context.lookup(raw) : raw;
    if (!(entry instanceof PDFNumber)) return null;
    const value = entry.asNumber();
    if (!Number.isFinite(value)) return null;
    values.push(value);
  }
  const x0 = Math.min(values[0], values[2]);
  const x1 = Math.max(values[0], values[2]);
  const y0 = Math.min(values[1], values[3]);
  const y1 = Math.max(values[1], values[3]);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function lookupBox(page: PDFPage, which: 'MediaBox' | 'CropBox'): PageBox | null {
  try {
    // Both are inheritable; pdf-lib's accessors walk the page tree for them.
    const array = which === 'MediaBox' ? page.node.MediaBox() : page.node.CropBox();
    return readBox(page, array);
  } catch {
    // `MediaBox()` throws when the entry is missing entirely.
    return null;
  }
}

/**
 * The page's visible box in raw (unrotated) user space, exactly as pdf.js's
 * `PDFPage.view` computes it: `/CropBox ∩ /MediaBox`, or the `/MediaBox` when
 * there is no CropBox or the intersection is empty.
 */
export function visiblePageBox(page: PDFPage): PageBox {
  const media = lookupBox(page, 'MediaBox') ?? LETTER;
  const crop = lookupBox(page, 'CropBox');
  if (!crop) return media;
  const x0 = Math.max(media.x, crop.x);
  const y0 = Math.max(media.y, crop.y);
  const x1 = Math.min(media.x + media.width, crop.x + crop.width);
  const y1 = Math.min(media.y + media.height, crop.y + crop.height);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return media;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * The display frame for a page: its visible box, with origin, turned by
 * `rotation` (the page's own `/Rotate` when omitted).
 *
 * Feed the result to `displayPointToPage` / `placeDisplayBox` to turn a UI
 * coordinate (top-left origin, pdf.js viewport space) into PDF user space.
 */
export function pageDisplayFrame(page: PDFPage, rotation?: number): DisplayFrame {
  const box = visiblePageBox(page);
  return displayFrame(box.width, box.height, rotation ?? page.getRotation().angle, box.x, box.y);
}

/**
 * A point in raw page space (PDF user space, bottom-left origin) → the same
 * point in display space (top-left origin, `/Rotate` applied). The exact inverse
 * of `displayPointToPage` for the same frame.
 */
export function pagePointToDisplay(
  frame: DisplayFrame,
  pageX: number,
  pageY: number
): { x: number; y: number } {
  const { rawWidth: w, rawHeight: h, originX, originY } = frame;
  const dx = pageX - originX;
  const dy = pageY - originY;
  switch (frame.rotation) {
    case 90:
      return { x: dy, y: dx };
    case 180:
      return { x: w - dx, y: dy };
    case 270:
      return { x: h - dy, y: w - dx };
    default:
      return { x: dx, y: h - dy };
  }
}

/**
 * HRD-42 — reading geometry *back* into the UI (M2's reverse direction). A
 * rectangle in raw page space, such as a widget's `/Rect`, as top-left
 * fractions of the page as pdf.js displays it: relative to the visible box
 * (CropBox ∩ MediaBox, with its origin) and turned by `/Rotate`. This is what
 * pdf.js's `viewport.convertToViewportRectangle` gives, divided by the
 * viewport's size. Not clipped: a widget hanging over the crop edge reports the
 * part outside as fractions below 0 or above 1, just as pdf.js places it.
 */
export function pageRectToDisplayFractions(
  frame: DisplayFrame,
  rect: PageBox
): { x: number; y: number; width: number; height: number } {
  const corners = [
    pagePointToDisplay(frame, rect.x, rect.y),
    pagePointToDisplay(frame, rect.x + rect.width, rect.y + rect.height)
  ];
  const x0 = Math.min(corners[0].x, corners[1].x);
  const x1 = Math.max(corners[0].x, corners[1].x);
  const y0 = Math.min(corners[0].y, corners[1].y);
  const y1 = Math.max(corners[0].y, corners[1].y);
  return {
    x: x0 / frame.displayWidth,
    y: y0 / frame.displayHeight,
    width: (x1 - x0) / frame.displayWidth,
    height: (y1 - y0) / frame.displayHeight
  };
}

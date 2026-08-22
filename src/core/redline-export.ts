import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { encodePng } from './png';
import { pixelDiff } from './pixel-diff';
import type { StaplerDoc } from './store';
import { composeDocument } from './operations';
import { renderWorker } from './workers';
import { internal, cancelled } from './errors';
import {
  REDLINE_BANNER_BG_RGB,
  REDLINE_BANNER_TEXT_RGB,
  REDLINE_PLACEHOLDER_BORDER_RGB
} from './doc-colors';

export interface ExportRedlineOptions {
  sensitivity?: number;
  /** AC: unchanged pages are either skipped or clearly marked, per this option. */
  unchangedPages?: 'skip' | 'mark';
  signal?: AbortSignal;
}

/**
 * ANN-06 — rendered at this DPI-equivalent multiplier over each page's real
 * point size, the same relationship ANN-05's `exportVisualDiff` uses. Dividing
 * a rendered image's pixel dimensions by this constant recovers its true point
 * size, which is how both panes end up "at matching scale" without either
 * being stretched to fit the other: a page whose size genuinely changed
 * between before and after renders at its own true size, not a forced one.
 */
const RENDER_SCALE = 1.5;
const MARGIN_PT = 24;
const GUTTER_PT = 24;
const LABEL_BAND_PT = 20;
const PLACEHOLDER_W_PT = 300;
const PLACEHOLDER_H_PT = 400;

/**
 * Always composes, never reads a source's raw bytes directly. A `StaplerDoc`
 * is a *view* — `pages[i].sourceIndex` is only `i` for an untouched,
 * single-source document — so a shortcut that read `pages[0]`'s source
 * directly and then rendered its own page `i` silently rendered the wrong
 * page (or threw entirely) the moment a page was deleted, reordered, or
 * pulled in from a second source, and ignored any rotation the workspace
 * had applied. `composeDocument` builds real output bytes where page `i`
 * *is* `doc.pages[i]`, rotation included, so no index translation is needed
 * anywhere below this point.
 */
async function loadDocBytes(doc: StaplerDoc): Promise<Uint8Array> {
  return composeDocument({ pages: doc.pages, annotations: doc.annotations });
}

/** Renders every page of `bytes` once, loading the document a single time. */
async function renderAllPages(
  bytes: Uint8Array,
  pageCount: number,
  signal?: AbortSignal
): Promise<(ImageData | undefined)[]> {
  const images: (ImageData | undefined)[] = [];
  await renderWorker.lease(async api => {
    const { handle } = await api.loadDocument(bytes);
    try {
      for (let i = 0; i < pageCount; i++) {
        if (signal?.aborted) throw cancelled();
        const bitmap = await api.renderPage(handle, i, RENDER_SCALE);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx?.drawImage(bitmap, 0, 0);
        bitmap.close();
        images.push(ctx ? ctx.getImageData(0, 0, canvas.width, canvas.height) : undefined);
      }
    } finally {
      await api.closeDocument(handle).catch(() => {});
    }
  });
  return images;
}

/** A page missing on one side, or resized, or containing any diff pixel all count as changed. */
function pageHasChanges(
  a: ImageData | undefined,
  b: ImageData | undefined,
  sensitivity: number
): boolean {
  if (!a || !b) return true;
  if (a.width !== b.width || a.height !== b.height) return true;
  const diff = pixelDiff(a, b, sensitivity);
  const data = diff.data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) return true;
  }
  return false;
}

function imageDataToPng(img: ImageData): Uint8Array {
  const { width, height, data } = img;
  const samples = new Uint8Array(width * height * 3);
  for (let p = 0; p < width * height; p++) {
    samples[p * 3] = data[p * 4];
    samples[p * 3 + 1] = data[p * 4 + 1];
    samples[p * 3 + 2] = data[p * 4 + 2];
  }
  return encodePng({ width, height, bitDepth: 8, colorType: 2, samples });
}

/**
 * Pre-rendered page images, one array per document. Lets a caller — in
 * practice, a unit test — supply known pixels directly instead of routing
 * through the render worker, the same seam `exportVisualDiff`'s `diffResults`
 * parameter gives ANN-05.
 */
export interface RedlineRenderedPages {
  a: (ImageData | undefined)[];
  b: (ImageData | undefined)[];
}

/**
 * ANN-06 — a print-ready before/after redline PDF, one output page per input
 * page pair, source and comparison rendered side by side. Distinct from
 * ANN-05's `exportVisualDiff`, which overlays a single merged page instead.
 */
export async function exportRedlinePdf(
  docA: StaplerDoc,
  docB: StaplerDoc,
  options: ExportRedlineOptions = {},
  rendered?: RedlineRenderedPages
): Promise<Uint8Array> {
  const sensitivity = options.sensitivity ?? 10;
  const unchangedMode = options.unchangedPages ?? 'mark';
  const totalPages = Math.max(docA.pages.length, docB.pages.length);
  if (totalPages === 0) throw internal('There are no pages to export.');

  let imagesA: (ImageData | undefined)[];
  let imagesB: (ImageData | undefined)[];
  if (rendered) {
    imagesA = rendered.a;
    imagesB = rendered.b;
  } else {
    const [bytesA, bytesB] = await Promise.all([loadDocBytes(docA), loadDocBytes(docB)]);
    [imagesA, imagesB] = await Promise.all([
      renderAllPages(bytesA, docA.pages.length, options.signal),
      renderAllPages(bytesB, docB.pages.length, options.signal)
    ]);
  }

  const pdfDoc = await PDFDocument.create();
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  for (let i = 0; i < totalPages; i++) {
    // `break` would exit quietly with whatever pages were already built and
    // save that as if the export had finished — a truncated PDF with no
    // error, indistinguishable from a genuinely short document. Cancellation
    // has to fail loudly instead, the same way `renderAllPages` already does.
    if (options.signal?.aborted) throw cancelled();

    const imgA = imagesA[i];
    const imgB = imagesB[i];
    const changed = pageHasChanges(imgA, imgB, sensitivity);
    if (!changed && unchangedMode === 'skip') continue;

    const wA = imgA
      ? imgA.width / RENDER_SCALE
      : (imgB?.width ?? 0) / RENDER_SCALE || PLACEHOLDER_W_PT;
    const hA = imgA
      ? imgA.height / RENDER_SCALE
      : (imgB?.height ?? 0) / RENDER_SCALE || PLACEHOLDER_H_PT;
    const wB = imgB ? imgB.width / RENDER_SCALE : wA;
    const hB = imgB ? imgB.height / RENDER_SCALE : hA;

    const paneHeight = Math.max(hA, hB);
    const bannerBand = changed ? 0 : LABEL_BAND_PT;
    const pageWidth = MARGIN_PT * 2 + wA + GUTTER_PT + wB;
    const pageHeight = MARGIN_PT * 2 + bannerBand + LABEL_BAND_PT + paneHeight;

    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    const imagesY = MARGIN_PT;
    const captionY = imagesY + paneHeight;
    const bxA = MARGIN_PT;
    const bxB = MARGIN_PT + wA + GUTTER_PT;

    if (!changed) {
      const bannerY = captionY + LABEL_BAND_PT;
      page.drawRectangle({
        x: 0,
        y: bannerY,
        width: pageWidth,
        height: LABEL_BAND_PT,
        color: rgb(...REDLINE_BANNER_BG_RGB)
      });
      page.drawText('UNCHANGED', {
        x: MARGIN_PT,
        y: bannerY + 5,
        size: 11,
        font: boldFont,
        color: rgb(...REDLINE_BANNER_TEXT_RGB)
      });
    }

    page.drawText('Before', { x: bxA, y: captionY + 5, size: 11, font: boldFont });
    page.drawText('After', { x: bxB, y: captionY + 5, size: 11, font: boldFont });

    if (imgA) {
      const embedded = await pdfDoc.embedPng(imageDataToPng(imgA));
      page.drawImage(embedded, { x: bxA, y: imagesY, width: wA, height: hA });
    } else {
      page.drawRectangle({
        x: bxA,
        y: imagesY,
        width: wA,
        height: hA,
        borderColor: rgb(...REDLINE_PLACEHOLDER_BORDER_RGB),
        borderWidth: 1
      });
      page.drawText('No corresponding page', { x: bxA + 8, y: imagesY + hA / 2, size: 10 });
    }

    if (imgB) {
      const embedded = await pdfDoc.embedPng(imageDataToPng(imgB));
      page.drawImage(embedded, { x: bxB, y: imagesY, width: wB, height: hB });
    } else {
      page.drawRectangle({
        x: bxB,
        y: imagesY,
        width: wB,
        height: hB,
        borderColor: rgb(...REDLINE_PLACEHOLDER_BORDER_RGB),
        borderWidth: 1
      });
      page.drawText('No corresponding page', { x: bxB + 8, y: imagesY + hB / 2, size: 10 });
    }
  }

  if (pdfDoc.getPageCount() === 0) {
    const page = pdfDoc.addPage([PLACEHOLDER_W_PT, 100]);
    page.drawText('No differences were found between the two documents.', {
      x: MARGIN_PT,
      y: 50,
      size: 11,
      font: boldFont
    });
  }

  return pdfDoc.save();
}

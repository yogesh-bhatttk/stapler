import * as Comlink from 'comlink';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { StaplerDoc } from './store';
import { composeDocument } from './operations';
import { cvWorker, renderWorker } from './workers';
import { internal, cancelled } from './errors';
import { translate } from './i18n';
import {
  drawImageRef,
  embedFlateRaster,
  redlinePageRaster,
  type RedlinePageRaster
} from './compare-raster';
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
  /** X-6 — determinate progress, one step per page pair. */
  onProgress?: (fraction: number | null, label: string) => void;
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
async function loadDocBytes(doc: StaplerDoc, signal?: AbortSignal): Promise<Uint8Array> {
  return composeDocument({ pages: doc.pages, annotations: doc.annotations }, { signal });
}

type PageSize = { width: number; height: number };

/** A composed document, loaded once into its own pinned render-worker instance. */
interface OpenedDoc {
  client: ReturnType<typeof renderWorker.pin>;
  handle: string;
  pageSizes: PageSize[];
}

async function openDoc(doc: StaplerDoc, signal?: AbortSignal): Promise<OpenedDoc | null> {
  if (doc.pages.length === 0) return null;
  const bytes = await loadDocBytes(doc, signal);
  const client = renderWorker.pin();
  try {
    const info = await client.lease(api => api.loadDocument(bytes));
    return { client, handle: info.handle, pageSizes: info.pageSizes };
  } catch (error) {
    client.release();
    throw error;
  }
}

async function closeDoc(opened: OpenedDoc | null): Promise<void> {
  if (!opened) return;
  await opened.client.lease(api => api.closeDocument(opened.handle)).catch(() => {});
  opened.client.release();
}

async function renderOne(opened: OpenedDoc | null, i: number): Promise<ImageBitmap | null> {
  if (!opened || i >= opened.pageSizes.length) return null;
  return opened.client.lease(api => api.renderPage(opened.handle, i, RENDER_SCALE));
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

  const pdfDoc = await PDFDocument.create();
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // X-5 — page by page: each pair is rendered, compared, compressed and
  // embedded before the next is rendered, so memory holds one pair, not every
  // page of both documents (about 1.7 GB for a 200-page pair).
  let openedA: OpenedDoc | null = null;
  let openedB: OpenedDoc | null = null;
  try {
    if (!rendered) {
      openedA = await openDoc(docA, options.signal);
      if (options.signal?.aborted) throw cancelled();
      openedB = await openDoc(docB, options.signal);
    }

    for (let i = 0; i < totalPages; i++) {
      // `break` would exit quietly with whatever pages were already built and
      // save that as if the export had finished — a truncated PDF with no
      // error, indistinguishable from a genuinely short document. Cancellation
      // has to fail loudly instead.
      if (options.signal?.aborted) throw cancelled();
      options.onProgress?.(
        i / totalPages,
        translate('Comparing page {page} of {total}', { page: i + 1, total: totalPages })
      );

      let pair: RedlinePageRaster;
      let sizeA: PageSize | undefined;
      let sizeB: PageSize | undefined;
      if (rendered) {
        const imgA = rendered.a[i];
        const imgB = rendered.b[i];
        pair = redlinePageRaster(imgA, imgB, sensitivity, unchangedMode);
        sizeA = imgA && { width: imgA.width / RENDER_SCALE, height: imgA.height / RENDER_SCALE };
        sizeB = imgB && { width: imgB.width / RENDER_SCALE, height: imgB.height / RENDER_SCALE };
      } else {
        const [bitmapA, bitmapB] = await Promise.all([
          renderOne(openedA, i),
          renderOne(openedB, i)
        ]);
        if (options.signal?.aborted) {
          bitmapA?.close();
          bitmapB?.close();
          throw cancelled();
        }
        const transfers = [bitmapA, bitmapB].filter((b): b is ImageBitmap => b !== null);
        // X-6 — the diff and the compression run in the cv worker.
        pair = await cvWorker.lease(api =>
          api.redlinePage(
            Comlink.transfer({ a: bitmapA, b: bitmapB }, transfers),
            sensitivity,
            unchangedMode
          )
        );
        // The real page size (CropBox, rotation applied), not the bitmap's
        // pixels over the scale — which a clamped render would shrink.
        sizeA = bitmapA ? openedA?.pageSizes[i] : undefined;
        sizeB = bitmapB ? openedB?.pageSizes[i] : undefined;
      }
      const changed = pair.changed;
      if (!changed && unchangedMode === 'skip') continue;
      const imgA = pair.a;
      const imgB = pair.b;

      const wA = sizeA?.width ?? sizeB?.width ?? PLACEHOLDER_W_PT;
      const hA = sizeA?.height ?? sizeB?.height ?? PLACEHOLDER_H_PT;
      const wB = sizeB?.width ?? wA;
      const hB = sizeB?.height ?? hA;

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
        drawImageRef(page, embedFlateRaster(pdfDoc, imgA), {
          x: bxA,
          y: imagesY,
          width: wA,
          height: hA
        });
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
        drawImageRef(page, embedFlateRaster(pdfDoc, imgB), {
          x: bxB,
          y: imagesY,
          width: wB,
          height: hB
        });
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
  } finally {
    await Promise.all([closeDoc(openedA), closeDoc(openedB)]);
  }

  if (options.signal?.aborted) throw cancelled();
  options.onProgress?.(1, translate('Saving the comparison'));

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

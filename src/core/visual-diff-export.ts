import * as Comlink from 'comlink';
import { PDFDocument } from 'pdf-lib';
import { type StaplerDoc } from './store';
import {
  closeOpenedDocument,
  openComposedDocument,
  type OpenedDoc,
  type PageSize
} from './compare-documents';
import { cvWorker } from './workers';
import { cancelled, internal, isCancellation } from './errors';
import { translate } from './i18n';
import {
  deflateRaster,
  drawImageRef,
  embedFlateRaster,
  visualDiffRaster,
  type FlateRaster
} from './compare-raster';

export interface PageDiffResult {
  pageIndex: number;
  diffImage?: ImageData;
  baseImage?: ImageData;
  compareImage?: ImageData;
  diffPixelCount?: number;
  hasChanges?: boolean;
}

export interface ExportVisualDiffOptions {
  sensitivity?: number;
  signal?: AbortSignal;
  /** X-6 — determinate progress, one step per output page. */
  onProgress?: (fraction: number | null, label: string) => void;
}

/** The render scale over each page's point size. */
const RENDER_SCALE = 1.5;
/** Used only when nothing better is known about a page (a test's bare overlay). */
const FALLBACK_SIZE = { width: 612, height: 792 };

/**
 * X-2 — a page's real size in points: the composed page's CropBox with its
 * rotation applied, as pdf.js reports it — not a hard-coded US Letter, which
 * distorted A4 pages and squashed landscape ones.
 */
function sizeFromImage(image: ImageData | undefined): PageSize | undefined {
  return image
    ? { width: image.width / RENDER_SCALE, height: image.height / RENDER_SCALE }
    : undefined;
}

/**
 * ANN-05: Renders visual diff overlays onto page images and embeds them into a new PDF document.
 *
 * `diffResults` lets a caller (in practice, a unit test) supply known pixels
 * for a page instead of rendering it.
 */
export async function exportVisualDiff(
  docA: StaplerDoc,
  docB: StaplerDoc,
  diffResults: PageDiffResult[] = [],
  options: ExportVisualDiffOptions = {}
): Promise<Uint8Array> {
  const sensitivity = options.sensitivity ?? 10;
  const pageCountA = docA.pages.length;
  const pageCountB = docB.pages.length;
  const totalPages = Math.max(pageCountA, pageCountB);

  if (totalPages === 0) {
    throw internal(translate('There are no pages to export.'));
  }

  const pdfDoc = await PDFDocument.create();
  const suppliedFor = (i: number): PageDiffResult | undefined =>
    diffResults.find(d => d.pageIndex === i) ?? diffResults[i];
  const needsRender = Array.from({ length: totalPages }, (_, i) => !suppliedFor(i)?.diffImage).some(
    Boolean
  );

  let openedA: OpenedDoc | null = null;
  let openedB: OpenedDoc | null = null;
  try {
    // Opened only when some page has to be rendered, and then once each.
    if (needsRender) {
      openedA = await openComposedDocument(docA, options.signal);
      if (options.signal?.aborted) throw cancelled();
      openedB = await openComposedDocument(docB, options.signal);
    }

    for (let i = 0; i < totalPages; i++) {
      // X-1 — fail loudly: a `break` here saved the pages built so far as if
      // the export had finished.
      if (options.signal?.aborted) throw cancelled();
      options.onProgress?.(
        i / totalPages,
        translate('Comparing page {page} of {total}', { page: i + 1, total: totalPages })
      );

      const supplied = suppliedFor(i);
      let raster: FlateRaster;
      let size: PageSize | undefined;

      if (supplied?.diffImage) {
        // A caller already has the overlay: an honest diff page needs nothing more.
        const built = visualDiffRaster(
          supplied.baseImage,
          supplied.compareImage,
          sensitivity,
          supplied.diffImage
        );
        raster = deflateRaster(built);
        size = sizeFromImage(supplied.baseImage ?? supplied.compareImage);
      } else {
        try {
          const [bitmapA, bitmapB] = await Promise.all([
            openedA && i < pageCountA
              ? openedA.client.lease(api => api.renderPage(openedA!.handle, i, RENDER_SCALE))
              : Promise.resolve(null),
            openedB && i < pageCountB
              ? openedB.client.lease(api => api.renderPage(openedB!.handle, i, RENDER_SCALE))
              : Promise.resolve(null)
          ]);
          if (options.signal?.aborted) {
            bitmapA?.close();
            bitmapB?.close();
            throw cancelled();
          }
          const transfers = [bitmapA, bitmapB].filter((b): b is ImageBitmap => b !== null);
          // X-6 — the diff, the sample packing and the compression run in the
          // cv worker; the bitmaps move there without a copy.
          raster = await cvWorker.lease(api =>
            api.visualDiffPage(Comlink.transfer({ a: bitmapA, b: bitmapB }, transfers), sensitivity)
          );
        } catch (error) {
          if (isCancellation(error)) throw error;
          throw internal(
            translate('Could not render page {page} for visual-diff export: {message}', {
              page: i + 1,
              message: error instanceof Error ? error.message : String(error)
            })
          );
        }
        // The diff is drawn at the "before" page's size when there is one.
        size = (i < pageCountA ? openedA?.pageSizes[i] : undefined) ?? openedB?.pageSizes[i];
      }

      const pageSize = size ?? FALLBACK_SIZE;
      const pdfPage = pdfDoc.addPage([pageSize.width, pageSize.height]);
      drawImageRef(pdfPage, embedFlateRaster(pdfDoc, raster), {
        x: 0,
        y: 0,
        width: pageSize.width,
        height: pageSize.height
      });
    }
  } finally {
    await Promise.all([closeOpenedDocument(openedA), closeOpenedDocument(openedB)]);
  }

  if (options.signal?.aborted) throw cancelled();
  options.onProgress?.(1, translate('Saving the comparison'));
  return pdfDoc.save();
}

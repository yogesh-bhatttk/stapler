import { PDFDocument } from 'pdf-lib';
import { encodePng } from './png';
import { pixelDiff } from './pixel-diff';
import { type StaplerDoc } from './store';
import { composeDocument } from './operations';
import { renderWorker } from './workers';
import { internal } from './errors';
import { translate } from './i18n';

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
}

/**
 * ANN-05: Renders visual diff overlays onto page images and embeds them into a new PDF document.
 */
export async function exportVisualDiff(
  docA: StaplerDoc,
  docB: StaplerDoc,
  diffResults: PageDiffResult[] = [],
  options: ExportVisualDiffOptions = {}
): Promise<Uint8Array> {
  const sensitivity = options.sensitivity ?? 10;
  const pdfDoc = await PDFDocument.create();

  const pageCountA = docA.pages.length;
  const pageCountB = docB.pages.length;
  const totalPages = Math.max(pageCountA, pageCountB);

  if (totalPages === 0) {
    throw internal(translate('There are no pages to export.'));
  }

  // Compose documents to include user edits (reorder, rotation, annotations, etc.)
  const composedBytesA =
    docA.pages.length > 0
      ? await composeDocument({ pages: docA.pages, annotations: docA.annotations ?? [] })
      : null;
  const composedBytesB =
    docB.pages.length > 0
      ? await composeDocument({ pages: docB.pages, annotations: docB.annotations ?? [] })
      : null;

  for (let i = 0; i < totalPages; i++) {
    if (options.signal?.aborted) break;

    const pageDiff = diffResults.find(d => d.pageIndex === i) ?? diffResults[i];

    // Page sizes from the composed documents (pages are in sequential order)
    const sizeA = i < pageCountA ? { width: 612, height: 792 } : undefined;
    const sizeB = i < pageCountB ? { width: 612, height: 792 } : undefined;
    const pageWidthPt = sizeA?.width ?? sizeB?.width ?? 612;
    const pageHeightPt = sizeA?.height ?? sizeB?.height ?? 792;

    let diffImg = pageDiff?.diffImage;
    let baseImg = pageDiff?.baseImage;
    let compareImg = pageDiff?.compareImage;

    // A caller may already have rendered just the overlay. That is sufficient
    // to make an honest diff page; do not invoke the worker merely to obtain a
    // background we do not need.
    if (!diffImg) {
      try {
        const bytesA = composedBytesA!;
        const bytesB = composedBytesB!;

        await renderWorker.lease(async api => {
          let handleA: string | undefined;
          let handleB: string | undefined;
          try {
            if (i < pageCountA) {
              const hInfoA = await api.loadDocument(bytesA);
              handleA = hInfoA.handle;
            }
            if (i < pageCountB) {
              const hInfoB = await api.loadDocument(bytesB);
              handleB = hInfoB.handle;
            }

            const scale = 1.5;
            if (handleA && !baseImg) {
              const bitmapA = await api.renderPage(handleA, i, scale);
              const canvasA = document.createElement('canvas');
              canvasA.width = bitmapA.width;
              canvasA.height = bitmapA.height;
              const ctxA = canvasA.getContext('2d', { willReadFrequently: true });
              ctxA?.drawImage(bitmapA, 0, 0);
              bitmapA.close();
              if (ctxA) {
                baseImg = ctxA.getImageData(0, 0, canvasA.width, canvasA.height);
              }
            }

            if (handleB && !compareImg) {
              const bitmapB = await api.renderPage(handleB, i, scale);
              const canvasB = document.createElement('canvas');
              canvasB.width = bitmapB.width;
              canvasB.height = bitmapB.height;
              const ctxB = canvasB.getContext('2d', { willReadFrequently: true });
              ctxB?.drawImage(bitmapB, 0, 0);
              bitmapB.close();
              if (ctxB) {
                compareImg = ctxB.getImageData(0, 0, canvasB.width, canvasB.height);
              }
            }

            if (!diffImg && baseImg && compareImg) {
              diffImg = pixelDiff(baseImg, compareImg, sensitivity);
            }
          } finally {
            if (handleA) await api.closeDocument(handleA).catch(() => {});
            if (handleB) await api.closeDocument(handleB).catch(() => {});
          }
        });
      } catch (error) {
        throw internal(
          translate('Could not render page {page} for visual-diff export: {message}', {
            page: i + 1,
            message: error instanceof Error ? error.message : String(error)
          })
        );
      }
    }

    const w = diffImg?.width ?? baseImg?.width ?? compareImg?.width ?? 612;
    const h = diffImg?.height ?? baseImg?.height ?? compareImg?.height ?? 792;
    const pixelCount = w * h;
    const rgbSamples = new Uint8Array(pixelCount * 3);

    const bgData = compareImg?.data ?? baseImg?.data;
    const diffData = diffImg?.data;

    for (let p = 0; p < pixelCount; p++) {
      const idx = p * 4;
      const rgbIdx = p * 3;

      let isDiff = false;
      if (diffData) {
        const r = diffData[idx];
        const g = diffData[idx + 1];
        const b = diffData[idx + 2];
        const a = diffData[idx + 3];
        if (a > 0 && r === 255 && g === 0 && b === 0) {
          isDiff = true;
        }
      }

      if (isDiff) {
        rgbSamples[rgbIdx] = 255;
        rgbSamples[rgbIdx + 1] = 0;
        rgbSamples[rgbIdx + 2] = 0;
      } else if (bgData && bgData.length > idx + 3) {
        rgbSamples[rgbIdx] = bgData[idx];
        rgbSamples[rgbIdx + 1] = bgData[idx + 1];
        rgbSamples[rgbIdx + 2] = bgData[idx + 2];
      } else if (diffData && diffData.length > idx + 3 && diffData[idx + 3] > 0) {
        rgbSamples[rgbIdx] = diffData[idx];
        rgbSamples[rgbIdx + 1] = diffData[idx + 1];
        rgbSamples[rgbIdx + 2] = diffData[idx + 2];
      } else {
        rgbSamples[rgbIdx] = 255;
        rgbSamples[rgbIdx + 1] = 255;
        rgbSamples[rgbIdx + 2] = 255;
      }
    }

    const pngBytes = encodePng({
      width: w,
      height: h,
      bitDepth: 8,
      colorType: 2,
      samples: rgbSamples
    });

    const embeddedImage = await pdfDoc.embedPng(pngBytes);
    const pdfPage = pdfDoc.addPage([pageWidthPt, pageHeightPt]);
    pdfPage.drawImage(embeddedImage, {
      x: 0,
      y: 0,
      width: pageWidthPt,
      height: pageHeightPt
    });
  }

  return pdfDoc.save();
}

/**
 * UX-02 — renders two documents' pages as images for the pre-export review
 * step (`ExportReviewModal`). Reuses the exact render-worker call shape
 * `visual-diff-export.ts` (ANN-05) already uses — load both documents in one
 * lease, render the target page from each, close both handles — but returns
 * image data for on-screen display instead of baking a diff into a new PDF.
 */
import { renderWorker } from './workers';
import { pixelDiff } from './pixel-diff';

const SCALE = 1.25;
const SENSITIVITY = 60;

async function toImageData(bitmap: ImageBitmap): Promise<ImageData | null> {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null;
}

/** The after-document's page count — used to size the review UI's page navigator. */
export async function documentPageCount(bytes: Uint8Array): Promise<number> {
  return renderWorker.lease(async api => {
    const { handle, pageCount } = await api.loadDocument(bytes);
    await api.closeDocument(handle).catch(() => {});
    return pageCount;
  });
}

export interface PageDiff {
  before: ImageData | null;
  after: ImageData | null;
  /** Highlighted-changes mask, or `null` when there is nothing to compare it against. */
  diff: ImageData | null;
  /** False when the two pages render at different sizes (e.g. crop, N-up) — no diff mask, before/after only. */
  comparable: boolean;
}

/**
 * Renders `pageIndex` from both `beforeBytes` and `afterBytes` and diffs them.
 * Either side may be shorter than `pageIndex` (a page was added or removed) —
 * that side simply comes back `null`, and the caller falls back to whichever
 * side rendered.
 */
export async function diffPage(
  beforeBytes: Uint8Array,
  afterBytes: Uint8Array,
  pageIndex: number
): Promise<PageDiff> {
  const { before, after } = await renderWorker.lease(async api => {
    let beforeHandle: string | undefined;
    let afterHandle: string | undefined;
    try {
      const [infoBefore, infoAfter] = await Promise.all([
        api.loadDocument(beforeBytes),
        api.loadDocument(afterBytes)
      ]);
      beforeHandle = infoBefore.handle;
      afterHandle = infoAfter.handle;

      const renderOne = async (handle: string, pageCount: number) => {
        if (pageIndex < 0 || pageIndex >= pageCount) return null;
        const bitmap = await api.renderPage(handle, pageIndex, SCALE);
        return toImageData(bitmap);
      };

      const [before, after] = await Promise.all([
        renderOne(beforeHandle, infoBefore.pageCount),
        renderOne(afterHandle, infoAfter.pageCount)
      ]);
      return { before, after };
    } finally {
      if (beforeHandle) await api.closeDocument(beforeHandle).catch(() => {});
      if (afterHandle) await api.closeDocument(afterHandle).catch(() => {});
    }
  });

  if (!before || !after) return { before, after, diff: null, comparable: false };
  const comparable = before.width === after.width && before.height === after.height;
  return {
    before,
    after,
    diff: comparable ? pixelDiff(before, after, SENSITIVITY) : null,
    comparable
  };
}

/** Renders a single page (no comparison) — used for zip members' after-only preview. */
export async function renderPage(bytes: Uint8Array, pageIndex: number): Promise<ImageData | null> {
  return renderWorker.lease(async api => {
    const { handle, pageCount } = await api.loadDocument(bytes);
    try {
      if (pageIndex < 0 || pageIndex >= pageCount) return null;
      const bitmap = await api.renderPage(handle, pageIndex, SCALE);
      return toImageData(bitmap);
    } finally {
      await api.closeDocument(handle).catch(() => {});
    }
  });
}

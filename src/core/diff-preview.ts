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
  const imageData = ctx ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null;
  // This canvas is never attached to the DOM, so nothing keeps it visible —
  // but its GPU-backed 2D backing store is not guaranteed to be freed the
  // moment it becomes unreachable; some engines only reclaim it on the next
  // GC pass, which for repeated page-by-page review comparisons can mean many
  // full-size backing stores alive at once. Zeroing the dimensions forces an
  // immediate release instead of waiting on that.
  canvas.width = 0;
  canvas.height = 0;
  return imageData;
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
 * Renders `beforeIndex` from `beforeBytes` and `afterIndex` from `afterBytes`
 * and diffs them. The two indices are independent — a reordered page is at a
 * different position on each side — rather than one shared `pageIndex`, so a
 * caller with page-alignment info (`page-alignment.ts`) can pass each page's
 * true counterpart instead of assuming position N on one side is position N
 * on the other. `beforeIndex: null` means this page has no baseline
 * counterpart (new/duplicated) — the before side is skipped entirely, not
 * just rendered blank, so a new page costs one document load, not two.
 *
 * `beforeRotationOverride`, when given, is the rotation the *before* page is
 * rendered at instead of its own — pass the current page's own rotation
 * (`PageAlignEntry.afterRotation`) so a page that was only rotated renders
 * both sides at the same orientation and compares as identical, rather than
 * "changed size" (a 90/270° rotation swaps rendered width and height) purely
 * from the rotation itself, which would otherwise also mask any real edit
 * (crop, watermark) made on top of it — non-comparable suppresses the
 * pixel-diff mask entirely.
 */
export async function diffPage(
  beforeBytes: Uint8Array,
  afterBytes: Uint8Array,
  beforeIndex: number | null,
  afterIndex: number,
  beforeRotationOverride?: number
): Promise<PageDiff> {
  const { before, after } = await renderWorker.lease(async api => {
    let beforeHandle: string | undefined;
    let afterHandle: string | undefined;
    try {
      const renderOne = async (
        handle: string,
        pageCount: number,
        index: number,
        rotationOverride?: number
      ) => {
        if (index < 0 || index >= pageCount) return null;
        const bitmap = await api.renderPage(handle, index, SCALE, rotationOverride);
        return toImageData(bitmap);
      };

      // Each load's handle is captured off its own `.then`, not off the
      // combined `Promise.all` result — if the *before* load rejects,
      // `Promise.all` rejects before ever reaching a destructuring
      // assignment made from its resolved value, which would otherwise skip
      // recording a handle for an *after* load that succeeded just fine,
      // leaking it (the `finally` below only closes handles it knows about).
      const beforePromise =
        beforeIndex === null
          ? Promise.resolve(null)
          : api.loadDocument(beforeBytes).then(info => {
              beforeHandle = info.handle;
              return info;
            });
      const afterPromise = api.loadDocument(afterBytes).then(info => {
        afterHandle = info.handle;
        return info;
      });
      const [infoBefore, infoAfter] = await Promise.all([beforePromise, afterPromise]);

      const [before, after] = await Promise.all([
        infoBefore && beforeIndex !== null
          ? renderOne(infoBefore.handle, infoBefore.pageCount, beforeIndex, beforeRotationOverride)
          : Promise.resolve(null),
        renderOne(infoAfter.handle, infoAfter.pageCount, afterIndex)
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

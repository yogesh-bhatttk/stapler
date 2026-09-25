/**
 * UX-02 — renders two documents' pages as images for the pre-export review
 * step (`ExportReviewModal`). Reuses the exact render-worker call shape
 * `visual-diff-export.ts` (ANN-05) already uses, but returns image data for
 * on-screen display instead of baking a diff into a new PDF, and keeps each
 * document loaded for the length of the review (see `loaded` below).
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

/**
 * Documents the review has already handed to the render worker, keyed by the
 * byte array's identity.
 *
 * Every page view used to post *both* whole documents to the worker again — a
 * 10 × 5 MB merge meant ~50 MB structured-cloned twice per page, in one task,
 * ~46 ms of main-thread block each time (AUDIT-2026-09-25 PLT-18 perf budget).
 * Now each document is posted once per review and rendered from its handle; a
 * pinned client keeps every call on the instance that holds the handle.
 * `releasePreviewDocuments()` closes them when the review ends.
 */
interface LoadedPreview {
  client: ReturnType<typeof renderWorker.pin>;
  info: Promise<{ handle: string; pageCount: number }>;
}
const loaded = new Map<Uint8Array, LoadedPreview>();

function load(bytes: Uint8Array): LoadedPreview {
  let entry = loaded.get(bytes);
  if (!entry) {
    const client = renderWorker.pin();
    const info = client.lease(api => api.loadDocument(bytes));
    entry = { client, info };
    loaded.set(bytes, entry);
    // A failed load must not be cached: the next view retries it.
    info.catch(() => {
      if (loaded.get(bytes) === entry) {
        loaded.delete(bytes);
        client.release();
      }
    });
  }
  return entry;
}

/** Yields a macrotask, so the next large postMessage lands in its own task. */
const nextTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Closes every document the review loaded. Safe to call more than once. */
export async function releasePreviewDocuments(): Promise<void> {
  const entries = [...loaded.values()];
  loaded.clear();
  await Promise.all(
    entries.map(async ({ client, info }) => {
      try {
        const { handle } = await info;
        await client.lease(api => api.closeDocument(handle));
      } catch {
        // Already failed or the worker is gone — nothing to close.
      } finally {
        client.release();
      }
    })
  );
}

async function renderFrom(
  entry: LoadedPreview,
  index: number,
  rotationOverride?: number
): Promise<ImageData | null> {
  const { handle, pageCount } = await entry.info;
  if (index < 0 || index >= pageCount) return null;
  const bitmap = await entry.client.lease(api =>
    api.renderPage(handle, index, SCALE, rotationOverride)
  );
  return toImageData(bitmap);
}

/** The after-document's page count — used to size the review UI's page navigator. */
export async function documentPageCount(bytes: Uint8Array): Promise<number> {
  return (await load(bytes).info).pageCount;
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
 * different position on each side — so a caller with page-alignment info
 * (`page-alignment.ts`) can pass each page's true counterpart. `beforeIndex:
 * null` means this page has no baseline counterpart (new/duplicated): the
 * before side is skipped entirely.
 *
 * `beforeRotationOverride`, when given, is the rotation the *before* page is
 * rendered at instead of its own — the current page's own rotation — so a page
 * that was only rotated compares as identical rather than "changed size".
 */
export async function diffPage(
  beforeBytes: Uint8Array,
  afterBytes: Uint8Array,
  beforeIndex: number | null,
  afterIndex: number,
  beforeRotationOverride?: number
): Promise<PageDiff> {
  const afterEntry = load(afterBytes);
  let beforeEntry: LoadedPreview | null = null;
  if (beforeIndex !== null) {
    // Two large first-time posts in one task would block it for their sum.
    if (!loaded.has(beforeBytes)) await nextTask();
    beforeEntry = load(beforeBytes);
  }

  const [before, after] = await Promise.all([
    beforeEntry && beforeIndex !== null
      ? renderFrom(beforeEntry, beforeIndex, beforeRotationOverride)
      : Promise.resolve(null),
    renderFrom(afterEntry, afterIndex)
  ]);

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
  return renderFrom(load(bytes), pageIndex);
}

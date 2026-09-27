/**
 * UX-02 — renders two documents' pages as images for the pre-export review
 * step (`ExportReviewModal`). Reuses the exact render-worker call shape
 * `visual-diff-export.ts` (ANN-05) already uses, but returns image data for
 * on-screen display instead of baking a diff into a new PDF, and keeps each
 * document loaded for the length of the review (see `PreviewSession` below).
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
 * Documents one review has handed to the render worker, keyed by the byte
 * array's identity.
 *
 * Every page view used to post *both* whole documents to the worker again — a
 * 10 × 5 MB merge meant ~50 MB structured-cloned twice per page, in one task,
 * ~46 ms of main-thread block each time (AUDIT-2026-09-25 PLT-18 perf budget).
 * Now each document is posted once per review and rendered from its handle; a
 * pinned client keeps every call on the instance that holds the handle.
 *
 * The cache belongs to a {@link PreviewSession}, one per review, and only that
 * review's release closes it (regression review R-PDF-3). A module-wide cache
 * released on "review changed" also closed the documents the *next* queued
 * review had just loaded: Preact runs a child's new effects before its parent's
 * cleanup, so the replacement review's pages failed to render.
 */
interface LoadedPreview {
  client: ReturnType<typeof renderWorker.pin>;
  info: Promise<{ handle: string; pageCount: number }>;
}

/** One review's loaded documents. Opaque to callers. */
export interface PreviewSession {
  readonly released: boolean;
}

class Session implements PreviewSession {
  readonly loaded = new Map<Uint8Array, LoadedPreview>();
  released = false;
}

/** A fresh, empty cache for one review. */
export function createPreviewSession(): PreviewSession {
  return new Session();
}

function sessionOf(session: PreviewSession): Session {
  if (!(session instanceof Session)) throw new Error('Not a preview session');
  return session;
}

/** Closes one cached document and releases its pinned worker. */
async function close(entry: LoadedPreview): Promise<void> {
  try {
    const { handle } = await entry.info;
    if (!entry.client.dead) await entry.client.lease(api => api.closeDocument(handle));
  } catch {
    // Already failed or the worker is gone — nothing to close.
  } finally {
    entry.client.release();
  }
}

function load(session: Session, bytes: Uint8Array): LoadedPreview {
  if (session.released) throw new Error('This review has already been closed.');
  let entry = session.loaded.get(bytes);
  // A worker that crashed took the handle with it; every later render from this
  // entry would fail. Drop it and load the document again on a live instance.
  if (entry?.client.dead) {
    session.loaded.delete(bytes);
    entry.client.release();
    entry = undefined;
  }
  if (!entry) {
    const client = renderWorker.pin();
    const info = client.lease(api => api.loadDocument(bytes));
    const created: LoadedPreview = { client, info };
    entry = created;
    session.loaded.set(bytes, created);
    // A failed load must not be cached: the next view retries it.
    info.catch(() => {
      if (session.loaded.get(bytes) === created) {
        session.loaded.delete(bytes);
        client.release();
      }
    });
  }
  return entry;
}

/** Yields a macrotask, so the next large postMessage lands in its own task. */
const nextTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Closes every document `session` loaded. Safe to call more than once. */
export async function releasePreviewDocuments(session: PreviewSession): Promise<void> {
  const own = sessionOf(session);
  own.released = true;
  const entries = [...own.loaded.values()];
  own.loaded.clear();
  await Promise.all(entries.map(close));
}

/**
 * Closes one document of `session` — a zip review calls this when the
 * selection moves off a member, so browsing a 50-file split does not keep 50
 * documents open in the render workers.
 */
export async function releasePreviewDocument(
  session: PreviewSession,
  bytes: Uint8Array
): Promise<void> {
  const own = sessionOf(session);
  const entry = own.loaded.get(bytes);
  if (!entry) return;
  own.loaded.delete(bytes);
  await close(entry);
}

async function renderFrom(
  session: Session,
  bytes: Uint8Array,
  index: number,
  rotationOverride?: number,
  retried = false
): Promise<ImageData | null> {
  const entry = load(session, bytes);
  try {
    const { handle, pageCount } = await entry.info;
    if (index < 0 || index >= pageCount) return null;
    const bitmap = await entry.client.lease(api =>
      api.renderPage(handle, index, SCALE, rotationOverride)
    );
    return await toImageData(bitmap);
  } catch (error) {
    // The instance died under this render: reload once on a live one.
    if (!retried && entry.client.dead && !session.released) {
      return renderFrom(session, bytes, index, rotationOverride, true);
    }
    throw error;
  }
}

/** The after-document's page count — used to size the review UI's page navigator. */
export async function documentPageCount(
  session: PreviewSession,
  bytes: Uint8Array
): Promise<number> {
  return (await load(sessionOf(session), bytes).info).pageCount;
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
  session: PreviewSession,
  beforeBytes: Uint8Array,
  afterBytes: Uint8Array,
  beforeIndex: number | null,
  afterIndex: number,
  beforeRotationOverride?: number
): Promise<PageDiff> {
  const own = sessionOf(session);
  load(own, afterBytes);
  if (beforeIndex !== null) {
    // Two large first-time posts in one task would block it for their sum.
    if (!own.loaded.has(beforeBytes)) await nextTask();
    load(own, beforeBytes);
  }

  const [before, after] = await Promise.all([
    beforeIndex !== null
      ? renderFrom(own, beforeBytes, beforeIndex, beforeRotationOverride)
      : Promise.resolve(null),
    renderFrom(own, afterBytes, afterIndex)
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
export async function renderPage(
  session: PreviewSession,
  bytes: Uint8Array,
  pageIndex: number
): Promise<ImageData | null> {
  return renderFrom(sessionOf(session), bytes, pageIndex);
}

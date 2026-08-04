/**
 * DOC-03 — render handles and the thumbnail bitmap cache.
 *
 * Two problems this replaces:
 *
 *  • The Canvas component opened every document in the render worker inside an
 *    effect keyed on `documents.value`. Since every mutation produces a new array,
 *    rotating one page closed and reopened every pdf.js document and threw away
 *    every cached bitmap. Handles now live here, keyed by source id, and outlive
 *    any component.
 *  • The bitmap cache key was `${workspaceDocId}-${sourceIndex}-${scale}`, so page
 *    3 of two different merged sources collided and one showed the other's
 *    thumbnail. The key is now the *source* id.
 */
import { renderWorker } from './workers';
import { logEvent } from './errors';

/** Bitmaps are GPU-backed; the ceiling is a count because we cannot measure them. */
const MAX_BITMAPS = 120;

interface CacheEntry {
  bitmap: ImageBitmap;
  /** Number of live consumers. An entry in use is never evicted. */
  users: number;
}

export class BitmapCache {
  private entries = new Map<string, CacheEntry>();

  constructor(private readonly capacity = MAX_BITMAPS) {}

  get(key: string): ImageBitmap | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Re-insert to mark most-recently-used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.bitmap;
  }

  set(key: string, bitmap: ImageBitmap): void {
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.bitmap !== bitmap) existing.bitmap.close();
      existing.bitmap = bitmap;
      return;
    }
    this.evictIfNeeded();
    this.entries.set(key, { bitmap, users: 0 });
  }

  /** Marks an entry in use so scrolling back does not evict what is on screen. */
  retain(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.users += 1;
  }

  release(key: string): void {
    const entry = this.entries.get(key);
    if (entry && entry.users > 0) entry.users -= 1;
  }

  private evictIfNeeded(): void {
    while (this.entries.size >= this.capacity) {
      // The Map iterates in insertion order, so the first entry with no active
      // consumers is the LRU candidate. Scanning with for-of avoids spreading
      // the entire Map into a temporary array on every eviction.
      let evicted = false;
      for (const [key, entry] of this.entries) {
        if (entry.users === 0) {
          entry.bitmap.close();
          this.entries.delete(key);
          evicted = true;
          break;
        }
      }
      // Everything on screen at once: growing past the ceiling beats dropping a
      // bitmap someone is drawing.
      if (!evicted) return;
    }
  }

  /** Drops every bitmap belonging to a source, e.g. when its bytes are replaced. */
  invalidateSource(sourceId: string): void {
    for (const [key, entry] of [...this.entries]) {
      if (!key.startsWith(`${sourceId}:`)) continue;
      entry.bitmap.close();
      this.entries.delete(key);
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.bitmap.close();
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export const thumbnailCache = new BitmapCache();

export function bitmapKey(sourceId: string, pageIndex: number, scale: number): string {
  // Scale is rounded so a fractional device-pixel-ratio does not produce a new
  // cache entry on every resize.
  return `${sourceId}:${pageIndex}:${scale.toFixed(2)}`;
}

/* ------------------------------------------------------------------ *
 * Render handles
 * ------------------------------------------------------------------ */

interface HandleEntry {
  promise: Promise<string>;
  /** Kept so an invalidated source is reopened rather than served stale. */
  bytes: Uint8Array;
}

const handles = new Map<string, HandleEntry>();

/**
 * Returns the render-worker handle for a source, opening it at most once even if
 * fifty thumbnails ask simultaneously.
 */
export function renderHandleFor(sourceId: string, bytes: Uint8Array): Promise<string> {
  const existing = handles.get(sourceId);
  if (existing && existing.bytes === bytes) return existing.promise;
  if (existing) closeRenderHandle(sourceId);

  const promise = renderWorker
    .lease(api => api.loadDocument(bytes))
    .then(info => info.handle)
    .catch(err => {
      // A failed open must not be cached, or every later thumbnail reuses the
      // rejection and the page stays blank with no way to retry.
      handles.delete(sourceId);
      throw err;
    });

  handles.set(sourceId, { promise, bytes });
  return promise;
}

export function closeRenderHandle(sourceId: string): void {
  const entry = handles.get(sourceId);
  if (!entry) return;
  handles.delete(sourceId);
  thumbnailCache.invalidateSource(sourceId);
  entry.promise
    .then(handle => renderWorker.lease(api => api.closeDocument(handle)))
    .catch(err => logEvent('warn', 'render-cache', `Closing handle failed: ${String(err)}`));
}

/** Closes handles for sources that are no longer registered. */
export function pruneRenderHandles(liveSourceIds: Iterable<string>): void {
  const live = new Set(liveSourceIds);
  for (const sourceId of [...handles.keys()]) {
    if (!live.has(sourceId)) closeRenderHandle(sourceId);
  }
}

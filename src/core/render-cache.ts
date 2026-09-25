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
import type { PinnedClient } from './workers/client';
import type { RenderJob } from './workers/render.worker';
import { logEvent } from './errors';
import { readSourceBytes } from './opfs';

/**
 * RT-10 — the cache is budgeted in **bytes**, not entries. It used to hold up
 * to 120 bitmaps whatever their size, and the single-page and side-by-side
 * views put their zoomed renders in it too: an A4 page at 400 % on a 2×
 * display is ~130 MB, so 120 of them was gigabytes and the tab crashed. A
 * bitmap's footprint is exactly `width × height × 4`, so it can be measured.
 * The zoomed views no longer cache at all — they render on demand and close
 * the bitmap once drawn — so what is left here is thumbnail-sized.
 */
export const THUMBNAIL_CACHE_BYTES = 192 * 1024 * 1024;

/** Decoded RGBA footprint of a bitmap. */
export function bitmapBytes(bitmap: { width: number; height: number }): number {
  return bitmap.width * bitmap.height * 4;
}

interface CacheEntry {
  bitmap: ImageBitmap;
  bytes: number;
  /** Number of live consumers. An entry in use is never evicted or closed. */
  users: number;
  /**
   * Set by `invalidateSource` when it found this entry still in use: its
   * source is gone, but a consumer (e.g. `Thumbnail`, mid-`drawImage`) is
   * still holding the bitmap, so closing it here would throw
   * `InvalidStateError` on that consumer's next paint. Left in the cache
   * instead, and closed by `release()` once the last consumer lets go.
   */
  orphaned?: boolean;
}

export class BitmapCache {
  private entries = new Map<string, CacheEntry>();
  private totalBytes = 0;

  constructor(private readonly budgetBytes = THUMBNAIL_CACHE_BYTES) {}

  get(key: string): ImageBitmap | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.orphaned) return undefined;
    // Re-insert to mark most-recently-used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.bitmap;
  }

  /**
   * Caches `bitmap` under `key` and returns the bitmap the caller should draw.
   *
   * Two renders of the same key can race (two tiles for the same page). If
   * the entry already cached is in use, it is kept and the newcomer is closed
   * — closing the cached one instead, as this used to, broke the consumer
   * still painting it. Otherwise the newcomer replaces it. Either way, draw
   * what this returns, not what was passed in.
   */
  set(key: string, bitmap: ImageBitmap): ImageBitmap {
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.bitmap === bitmap) return bitmap;
      if (existing.users > 0 || existing.orphaned) {
        if (existing.orphaned) {
          // Its source was invalidated; it only lingers for its last user.
          // A fresh bitmap for the key cannot share its entry.
          return bitmap;
        }
        bitmap.close();
        return existing.bitmap;
      }
      existing.bitmap.close();
      this.totalBytes -= existing.bytes;
      existing.bitmap = bitmap;
      existing.bytes = bitmapBytes(bitmap);
      this.totalBytes += existing.bytes;
      this.evictIfNeeded(key);
      return bitmap;
    }
    const bytes = bitmapBytes(bitmap);
    this.entries.set(key, { bitmap, bytes, users: 0 });
    this.totalBytes += bytes;
    this.evictIfNeeded(key);
    return bitmap;
  }

  /** Marks an entry in use so scrolling back does not evict what is on screen. */
  retain(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.users += 1;
  }

  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry || entry.users === 0) return;
    entry.users -= 1;
    if (entry.users === 0 && entry.orphaned) {
      this.remove(key, entry);
      return;
    }
    // Something freed up; it may have been all that kept the cache over budget.
    if (entry.users === 0) this.evictIfNeeded();
  }

  private remove(key: string, entry: CacheEntry): void {
    entry.bitmap.close();
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
  }

  /** Evicts least-recently-used entries nobody is drawing until under budget. */
  private evictIfNeeded(keep?: string): void {
    if (this.totalBytes <= this.budgetBytes) return;
    // The Map iterates in insertion order, so the first unused entries are the
    // LRU candidates. Entries in use are skipped: growing past the budget
    // beats closing a bitmap someone is drawing.
    for (const [key, entry] of this.entries) {
      if (this.totalBytes <= this.budgetBytes) return;
      if (key === keep || entry.users > 0) continue;
      this.remove(key, entry);
    }
  }

  /** Drops every bitmap belonging to a source, e.g. when its bytes are replaced. */
  invalidateSource(sourceId: string): void {
    for (const [key, entry] of [...this.entries]) {
      if (!key.startsWith(`${sourceId}:`)) continue;
      if (entry.users > 0) {
        // A consumer is still drawing this one — closing it now would break
        // that in-progress paint. Leave it for `release()` to close once
        // free, below.
        entry.orphaned = true;
        continue;
      }
      this.remove(key, entry);
    }
  }

  /** Drops every bitmap nobody is drawing; ones in use are closed on release. */
  clear(): void {
    for (const [key, entry] of [...this.entries]) {
      if (entry.users > 0) {
        entry.orphaned = true;
        continue;
      }
      this.remove(key, entry);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** Decoded bytes currently held. */
  get bytes(): number {
    return this.totalBytes;
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
  promise: Promise<{ handle: string; client: PinnedClient<RenderJob> }>;
  client: PinnedClient<RenderJob>;
}

const handles = new Map<string, HandleEntry>();

/**
 * Returns the render-worker handle for a source, opening it at most once even if
 * fifty thumbnails ask simultaneously.
 */
export function renderHandleFor(
  sourceId: string
): Promise<{ handle: string; client: PinnedClient<RenderJob> }> {
  const existing = handles.get(sourceId);
  if (existing) {
    // RT-1: a handle pinned to an instance that has since crashed can never
    // answer again — its pdf.js document died with the worker. Handing it out
    // meant every later thumbnail for this source failed (or, before the
    // client raced calls against instance death, hung) until a reload. Drop it
    // and reopen on a fresh instance instead; the dead instance needs no close.
    if (!existing.client.dead) return existing.promise;
    handles.delete(sourceId);
    existing.client.release();
    existing.promise.catch(() => {});
  }

  const client = renderWorker.pin();
  const promise: HandleEntry['promise'] = readSourceBytes(sourceId)
    .then(bytes =>
      client.lease(api => api.loadDocument(bytes)).then(info => ({ handle: info.handle, client }))
    )
    .catch(err => {
      // A failed open must not be cached, or every later thumbnail reuses the
      // rejection and the page stays blank with no way to retry.
      client.release();
      // RT-19: by identity, not by key. If this source was closed and
      // reopened while this open was still pending, the entry under the key
      // is the *new* open — deleting it would orphan its pinned client and
      // pdf.js document where `pruneRenderHandles` can never find them.
      if (handles.get(sourceId)?.promise === promise) handles.delete(sourceId);
      throw err;
    });

  handles.set(sourceId, { promise, client });
  return promise;
}

export function closeRenderHandle(sourceId: string): void {
  const entry = handles.get(sourceId);
  if (!entry) return;
  handles.delete(sourceId);
  thumbnailCache.invalidateSource(sourceId);
  if (entry.client.dead) {
    // Nothing to close on a crashed instance; its document is already gone.
    entry.client.release();
    entry.promise.catch(() => {});
    return;
  }
  entry.promise
    .then(({ handle, client }) => {
      return client.lease(api => api.closeDocument(handle)).finally(() => client.release());
    })
    .catch(err => logEvent('warn', 'render-cache', `Closing handle failed: ${String(err)}`));
}

/** Closes handles for sources that are no longer registered. */
export function pruneRenderHandles(liveSourceIds: Iterable<string>): void {
  const live = new Set(liveSourceIds);
  for (const sourceId of [...handles.keys()]) {
    if (!live.has(sourceId)) closeRenderHandle(sourceId);
  }
}

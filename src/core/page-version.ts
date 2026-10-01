/**
 * AUDIT-2026-10-01 pattern 1 — a cache key for "this document's pages as
 * they are now".
 *
 * Read aloud (UI-1), Reflow (X-11) and Compare (X-13) cached bytes or text
 * per `doc.id` alone, so a deleted, moved or inserted page left them serving
 * the old content. A key built from the page list itself changes with every
 * such edit and with nothing else, so a cache keyed on it is never stale and
 * never needlessly thrown away (selecting a page, say, leaves it intact).
 */
import type { PageRef } from './store';

export interface PageListOptions {
  /**
   * Include each page's rotation. Text does not change when a page turns, so
   * text caches leave it out; anything rendered as pixels needs it.
   */
  rotation?: boolean;
}

/** A string that changes whenever the page list's content (or, optionally, rotation) changes. */
export function pageListKey(
  doc: { id: string; pages: readonly Pick<PageRef, 'sourceDocId' | 'sourceIndex' | 'rotation'>[] },
  options: PageListOptions = {}
): string {
  const parts = doc.pages.map(page =>
    options.rotation
      ? `${page.sourceDocId}:${page.sourceIndex}@${page.rotation}`
      : `${page.sourceDocId}:${page.sourceIndex}`
  );
  return `${doc.id}|${parts.join(',')}`;
}

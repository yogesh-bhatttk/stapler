import { signal } from '@preact/signals';
import type { PageRef } from '../../../core/store';

/**
 * Alt text, keyed by {@link altTextKey}: the page's *key* and the image's
 * XObject name.
 *
 * AUDIT-2026-10-10 UI#12 — it was keyed by page *index* and name, and image
 * names repeat from page to page (`Im0` is on nearly every page of a scan):
 * after a reorder, the description typed for page 2's picture was written onto
 * whichever image was named the same on the page that had moved into slot 2.
 * A page key follows its page.
 */
export const altTextMap = signal<Map<string, string>>(new Map());

/** UI#12 — the {@link altTextMap} key for image `name` on `page`. */
export function altTextKey(page: Pick<PageRef, 'key'>, name: string): string {
  return `${page.key}:${name}`;
}

/**
 * UI#12 — the map the worker wants (`"<pageIndex>:<name>"`, indexed into the
 * document being written, which is `pages`). Text for a page no longer in the
 * document is left out rather than attached to whatever sits at its old index.
 */
export function altTextForExport(
  map: ReadonlyMap<string, string>,
  pages: readonly PageRef[]
): Record<string, string> {
  const indexByKey = new Map(pages.map((page, index) => [page.key, index]));
  const out: Record<string, string> = {};
  for (const [key, text] of map) {
    const split = key.indexOf(':');
    if (split <= 0 || !text) continue;
    const index = indexByKey.get(key.slice(0, split));
    if (index === undefined) continue;
    out[`${index}:${key.slice(split + 1)}`] = text;
  }
  return out;
}

export function setAltText(key: string, text: string) {
  const map = new Map(altTextMap.value);
  if (!text) {
    map.delete(key);
  } else {
    map.set(key, text);
  }
  altTextMap.value = map;
}

export function clearAltText() {
  altTextMap.value = new Map();
}

/**
 * The two compare exports (visual diff, redline) each open both documents
 * once for the whole export (audit 2026-10-01 X-4). Load and close must use the
 * same pinned render-worker instance, so that pairing lives here once.
 */
import type { StaplerDoc } from './store';
import { composeDocument } from './operations';
import { renderWorker } from './workers';

export type PageSize = { width: number; height: number };

/** A composed document, loaded once into its own pinned render-worker instance. */
export interface OpenedDoc {
  client: ReturnType<typeof renderWorker.pin>;
  handle: string;
  pageSizes: PageSize[];
}

/**
 * Composes `doc` and loads it into a pinned instance; null for an empty
 * document.
 *
 * Always composes, never reads a source's raw bytes directly. A `StaplerDoc`
 * is a *view* — `pages[i].sourceIndex` is only `i` for an untouched,
 * single-source document — so a shortcut that read `pages[0]`'s source
 * directly and then rendered its own page `i` silently rendered the wrong
 * page (or threw entirely) the moment a page was deleted, reordered, or
 * pulled in from a second source, and ignored any rotation the workspace
 * had applied. `composeDocument` builds real output bytes where page `i`
 * *is* `doc.pages[i]`, rotation included, so no index translation is needed
 * anywhere below this point.
 */
export async function openComposedDocument(
  doc: StaplerDoc,
  signal?: AbortSignal
): Promise<OpenedDoc | null> {
  if (doc.pages.length === 0) return null;
  const bytes = await composeDocument(
    { pages: doc.pages, annotations: doc.annotations ?? [] },
    { signal }
  );
  const client = renderWorker.pin();
  try {
    const info = await client.lease(api => api.loadDocument(bytes));
    return { client, handle: info.handle, pageSizes: info.pageSizes };
  } catch (error) {
    client.release();
    throw error;
  }
}

/** Closes the document on the instance that opened it, then releases that instance. */
export async function closeOpenedDocument(opened: OpenedDoc | null): Promise<void> {
  if (!opened) return;
  await opened.client.lease(api => api.closeDocument(opened.handle)).catch(() => {});
  opened.client.release();
}

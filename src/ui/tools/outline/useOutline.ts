/**
 * Loads the active document's `/Outlines` into the editable tree, once per document.
 *
 * Both the bookmark editor (OPS-10) and the split-by-bookmark mode (OPS-12) need the
 * same tree, so the read lives here rather than in either panel. It reads the *source*
 * bytes of the document's first page, which is where an imported document's outline
 * lives — a merged workspace's later contributors are not walked, the same narrowness
 * OPS-01's `copyOutlines` documents.
 */
import { useEffect } from 'preact/hooks';
import { activeDoc, sources } from '../../../core/store';
import { readDocumentOutline } from '../../../core/operations';
import { readSourceBytes } from '../../../core/opfs';
import { notifyError } from '../../../core/notify';
import {
  countUnresolved,
  entriesFromNodes,
  outlineDocId,
  outlineEdited,
  outlineLoading,
  outlineLoadedSignature,
  outlineLoadingSignature,
  outlineTree,
  outlineUnresolved
} from './state';

function outlineSignature(doc: {
  pages: { sourceDocId: string; sourceIndex: number; key: string }[];
}) {
  return doc.pages
    .map(page => `${page.sourceDocId}:${page.sourceIndex}:${page.key}`)
    .join('\u0000');
}

export function useDocumentOutline(): void {
  const doc = activeDoc.value;
  const docId = doc?.id ?? null;

  useEffect(() => {
    if (!doc) return;
    const signature = `${docId}\u0000${outlineSignature(doc)}`;
    if (outlineLoadedSignature.peek() === signature) return;
    if (outlineLoading.peek() && outlineLoadingSignature.peek() === signature) return;

    // Claimed before the async read starts, so a re-render mid-read does not queue
    // a second one against the same document.
    outlineDocId.value = docId;
    outlineLoadingSignature.value = signature;
    outlineTree.value = [];
    outlineUnresolved.value = 0;
    outlineEdited.value = false;
    outlineLoading.value = true;

    const first = doc.pages[0];
    const source = first ? sources.peek()[first.sourceDocId] : undefined;

    let stale = false;
    void (async () => {
      try {
        const nodes = source ? await readDocumentOutline(await readSourceBytes(source.id)) : [];
        if (stale) return;
        // Outline destinations address the source document; the workspace addresses
        // pages by key, so map through the pages that came from that source.
        const keyBySourceIndex: (string | undefined)[] = [];
        for (const page of doc.pages) {
          if (page.sourceDocId !== source?.id) continue;
          if (keyBySourceIndex[page.sourceIndex] === undefined) {
            keyBySourceIndex[page.sourceIndex] = page.key;
          }
        }
        outlineTree.value = entriesFromNodes(nodes, keyBySourceIndex);
        outlineUnresolved.value = countUnresolved(nodes);
        outlineLoadedSignature.value = signature;
      } catch (err) {
        if (!stale) notifyError('outline.read', err);
      } finally {
        if (!stale) {
          outlineLoading.value = false;
          outlineLoadingSignature.value = null;
        }
      }
    })();

    return () => {
      stale = true;
      outlineLoading.value = false;
      outlineLoadingSignature.value = null;
    };
    // Keyed on the current page layout, not the raw object identity: a page edit
    // produces a fresh `doc`, but unrelated rerenders of the same layout do not.
  }, [docId, doc]);
}

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
import { notifyError } from '../../../core/notify';
import {
  countUnresolved,
  entriesFromNodes,
  outlineDocId,
  outlineEdited,
  outlineLoading,
  outlineTree,
  outlineUnresolved
} from './state';

export function useDocumentOutline(): void {
  const doc = activeDoc.value;
  const docId = doc?.id ?? null;

  useEffect(() => {
    if (!doc || outlineDocId.peek() === docId) return;

    // Claimed before the async read starts, so a re-render mid-read does not queue
    // a second one against the same document.
    outlineDocId.value = docId;
    outlineTree.value = [];
    outlineUnresolved.value = 0;
    outlineEdited.value = false;
    outlineLoading.value = true;

    const first = doc.pages[0];
    const source = first ? sources.peek()[first.sourceDocId] : undefined;

    let stale = false;
    void (async () => {
      try {
        const nodes = source ? await readDocumentOutline(source.bytes) : [];
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
      } catch (err) {
        if (!stale) notifyError('outline.read', err);
      } finally {
        if (!stale) outlineLoading.value = false;
      }
    })();

    return () => {
      stale = true;
    };
    // Keyed on the document id alone: `doc` is a fresh object after every page edit,
    // and re-reading the outline on each of those would discard the user's edits.
  }, [docId, doc]);
}

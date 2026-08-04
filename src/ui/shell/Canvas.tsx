/**
 * The canvas dispatcher: grid or single-page, decided by the tool's declared
 * `canvasMode` (DESIGN-ADAPTATION §4.2).
 *
 * Two things this replaces. It used four `useRoute` calls to guess what to render,
 * and it opened *every* document in the render worker inside an effect keyed on
 * `documents.value` — a new array on every mutation — so rotating one page closed
 * and reopened every pdf.js document and discarded every cached bitmap. Handles now
 * live in core/render-cache.ts, keyed by source, and outlive this component.
 */
import { useActiveTool } from '../useActiveTool';
import { useEffect, useState } from 'preact/hooks';

import { activeDoc, selectedPageKeys, sources } from '../../core/store';
import { pruneRenderHandles } from '../../core/render-cache';

import { EmptyState } from '../components/Feedback';
import { PageGrid } from './PageGrid';
import { SinglePageView } from './SinglePageView';
import { AnnotationOverlay } from '../components/AnnotationOverlay';
import { RedactOverlay } from '../tools/redact/RedactOverlay';
import { CleanupEditor } from '../tools/cleanup/CleanupEditor';
import { CompressPreview } from '../tools/compress/CompressPreview';

export function Canvas() {
  const tool = useActiveTool();
  const doc = activeDoc.value;
  const [pageIndex, setPageIndex] = useState(0);

  // Retire pdf.js documents for sources nothing references any more. Keyed on the
  // source *ids*, not the documents array, so a page reorder does not trigger it.
  const sourceIds = Object.keys(sources.value).join(',');
  useEffect(() => {
    pruneRenderHandles(sourceIds ? sourceIds.split(',') : []);
  }, [sourceIds]);

  // Keep the single-page cursor inside the document after pages are removed.
  useEffect(() => {
    if (doc && pageIndex > doc.pages.length - 1) setPageIndex(Math.max(0, doc.pages.length - 1));
  }, [doc, pageIndex]);

  if (!tool) {
    return <EmptyState title="Unknown tool" body="Pick one from the rail or press ⌘K." />;
  }

  if (!doc || doc.pages.length === 0) {
    return (
      <EmptyState
        title="No document open"
        body={
          doc
            ? 'Every page in this document has been deleted. Undo with ⌘Z, or open another file.'
            : 'Open a PDF or some images to start. Nothing is uploaded.'
        }
      />
    );
  }

  if (tool.canvasMode === 'single') {
    if (tool.id === 'cleanup') {
      return (
        <CleanupEditor
          docId={doc.id}
          pages={doc.pages}
          pageIndex={Math.min(pageIndex, doc.pages.length - 1)}
          onPageIndexChange={setPageIndex}
        />
      );
    }

    if (tool.id === 'compress') {
      return <CompressPreview pages={doc.pages} />;
    }

    return (
      <SinglePageView
        pages={doc.pages}
        pageIndex={Math.min(pageIndex, doc.pages.length - 1)}
        onPageIndexChange={setPageIndex}
        overlay={({ width, height, page }) =>
          tool.id === 'redact' ? (
            <RedactOverlay page={page} pageIndex={pageIndex} width={width} height={height} />
          ) : (
            <AnnotationOverlay docId={doc.id} pageKey={page.key} width={width} height={height} />
          )
        }
      />
    );
  }

  return <PageGrid doc={doc} selection={selectedPageKeys.value} selectable={tool.selectable} />;
}

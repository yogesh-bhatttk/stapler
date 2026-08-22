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
import { useEffect, useMemo, useState } from 'preact/hooks';

import { activeDoc, makePageRefs, selectedPageKeys, sources } from '../../core/store';
import { pruneRenderHandles } from '../../core/render-cache';

import { EmptyState } from '../components/Feedback';
import { PageGrid } from './PageGrid';
import { SinglePageView } from './SinglePageView';
import { AnnotationOverlay } from '../components/AnnotationOverlay';
import { AcroFormOverlay } from '../tools/sign/AcroFormOverlay';
import { RedactOverlay } from '../tools/redact/RedactOverlay';
import { WatermarkOverlay } from '../tools/watermark/WatermarkOverlay';
import { HeaderFooterOverlay } from '../tools/watermark/HeaderFooterOverlay';
import { CleanupEditor } from '../tools/cleanup/CleanupEditor';
import { CompressPreview } from '../tools/compress/CompressPreview';
import { CropOverlay } from '../tools/crop/CropOverlay';
import { CompareView } from '../tools/compare/CompareView';
import { AnnotateOverlay } from '../tools/annotate/AnnotateOverlay';
import { BatchView } from '../tools/batch/BatchView';
import { ReflowView } from '../tools/reflow/ReflowView';
import { SideBySideView } from '../tools/side-by-side/SideBySideView';
import { sideBySideSourceId } from '../tools/side-by-side/state';
import { useTranslation } from '../../core/i18n';

export function Canvas() {
  const t = useTranslation();
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

  // ANN-07 — `makePageRefs` mints a fresh key per page on every call, so this
  // has to be memoised on the *source id*: recomputing it on every render
  // would hand `SideBySideView`'s pane a page whose identity never survives a
  // re-render, discarding its cached bitmap and any transient state for it.
  const sideBySideSource = sideBySideSourceId.value
    ? sources.value[sideBySideSourceId.value]
    : undefined;
  const sideBySidePagesB = useMemo(
    () => (sideBySideSource ? makePageRefs(sideBySideSource.id, sideBySideSource.pageCount) : null),
    [sideBySideSource?.id, sideBySideSource?.pageCount]
  );

  if (!tool) {
    return <EmptyState title={t('Unknown tool')} body="Pick one from the rail or press ⌘K." />;
  }

  if (tool.id === 'batch') {
    return <BatchView />;
  }

  if (!doc || doc.pages.length === 0) {
    return (
      <EmptyState
        title={t('No document open')}
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

    if (tool.id === 'compare') {
      return (
        <CompareView pages={doc.pages} pageIndex={Math.min(pageIndex, doc.pages.length - 1)} />
      );
    }

    if (tool.id === 'reflow') {
      return (
        <ReflowView
          docId={doc.id}
          pages={doc.pages}
          pageIndex={Math.min(pageIndex, doc.pages.length - 1)}
          onPageIndexChange={setPageIndex}
        />
      );
    }

    if (tool.id === 'side-by-side') {
      return (
        <SideBySideView
          pagesA={doc.pages}
          nameA={doc.name}
          pagesB={sideBySidePagesB}
          nameB={sideBySideSource?.name ?? null}
        />
      );
    }

    return (
      <SinglePageView
        pages={doc.pages}
        pageIndex={Math.min(pageIndex, doc.pages.length - 1)}
        onPageIndexChange={setPageIndex}
        overlay={({ width, height, page }) =>
          tool.id === 'redact' ? (
            <RedactOverlay
              page={page}
              pageIndex={pageIndex}
              width={width}
              height={height}
              rotation={page.rotation}
            />
          ) : tool.id === 'crop' ? (
            <CropOverlay page={page} width={width} height={height} />
          ) : tool.id === 'annotate' ? (
            <AnnotateOverlay pageKey={page.key} width={width} height={height} />
          ) : tool.id === 'watermark' ? (
            <>
              <WatermarkOverlay pageIndex={pageIndex} width={width} height={height} />
              <HeaderFooterOverlay pageIndex={pageIndex} />
            </>
          ) : (
            <>
              <AcroFormOverlay pageIndex={pageIndex} width={width} height={height} />
              <AnnotationOverlay docId={doc.id} pageKey={page.key} width={width} height={height} />
            </>
          )
        }
      />
    );
  }

  return <PageGrid doc={doc} selection={selectedPageKeys.value} selectable={tool.selectable} />;
}

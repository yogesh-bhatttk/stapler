import { useEffect, useRef, useState } from 'preact/hooks';
import { type PageRef, sources } from '../../../core/store';
import { compareSettings } from './state';
import { cvWorker, renderWorker } from '../../../core/workers';
import { CompareSlider } from '../../components/CompareSlider';
import { EmptyState } from '../../components/Feedback';
import { isCancellation, logEvent, fromUnknown } from '../../../core/errors';
import { pixelDiff } from '../../../core/pixel-diff';
import type { DiffChunk } from '../../../core/diff';
import styles from './CompareView.module.css';
import { useTranslation } from '../../../core/i18n';
import { readSourceBytes } from '../../../core/opfs';

export interface CompareViewProps {
  pages: PageRef[];
  pageIndex: number;
}

export function CompareView({ pages, pageIndex }: CompareViewProps) {
  const t = useTranslation();
  const settings = compareSettings.value;
  const page = pages[pageIndex];

  const [isProcessing, setIsProcessing] = useState(false);
  const [diffChunks, setDiffChunks] = useState<DiffChunk[]>([]);

  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const compareCanvasRef = useRef<HTMLCanvasElement>(null);
  const diffCanvasRef = useRef<HTMLCanvasElement>(null);
  // X-13 — the two rendered pages, kept so the sensitivity slider only
  // recomputes the diff instead of reloading and re-rendering both documents
  // on every tick. `rendered` bumps when a new pair lands.
  const imagesRef = useRef<{ base: ImageData; compare: ImageData } | null>(null);
  const [rendered, setRendered] = useState(0);

  const source = page ? sources.value[page.sourceDocId] : undefined;
  const pageSize = source?.pageSizes[page?.sourceIndex ?? 0];

  useEffect(() => {
    if (!page || !source || !pageSize) return;
    if (!settings.compareSourceId) return;

    const compareSource = sources.value[settings.compareSourceId];
    if (!compareSource) return;

    let cancelled = false;

    // Two documents are open at once here, each needs its own pinned instance —
    // load and close must stay on the same pool instance, or the close is a
    // silent no-op on the wrong one and the pdf.js document leaks.
    const baseClient = renderWorker.pin();
    const compareClient = renderWorker.pin();

    const runDiff = async () => {
      setIsProcessing(true);
      // Another page or file: the cached pair no longer applies.
      imagesRef.current = null;

      let baseHandle: string | undefined;
      let compareHandle: string | undefined;

      try {
        const baseBytes = await readSourceBytes(source.id);
        const compareBytes = await readSourceBytes(compareSource.id);

        const baseHandleInfo = await baseClient.lease(api => api.loadDocument(baseBytes));
        baseHandle = baseHandleInfo.handle;

        const compareHandleInfo = await compareClient.lease(api => api.loadDocument(compareBytes));
        compareHandle = compareHandleInfo.handle;

        if (cancelled) return;

        if (settings.diffMode === 'text') {
          const baseText = await baseClient.lease(api =>
            api.extractText(baseHandle!, page.sourceIndex, 'text')
          );
          // try to get the same page index from compare document, otherwise empty
          const comparePageIndex = Math.min(page.sourceIndex, compareSource.pageCount - 1);
          const compareText = await compareClient.lease(api =>
            api.extractText(compareHandle!, comparePageIndex, 'text')
          );

          if (cancelled) return;
          // CONV-14: the word diff runs in the cv worker, not on the main thread.
          const chunks = await cvWorker.lease(api => api.diffText(baseText, compareText));
          if (!cancelled) setDiffChunks(chunks);
        } else {
          // Visual diff
          const scale = Number(
            Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1).toFixed(2)
          );
          const baseBitmap = await baseClient.lease(api =>
            api.renderPage(baseHandle!, page.sourceIndex, scale)
          );
          const comparePageIndex = Math.min(page.sourceIndex, compareSource.pageCount - 1);
          const compareBitmap = await compareClient.lease(api =>
            api.renderPage(compareHandle!, comparePageIndex, scale)
          );

          if (cancelled) {
            baseBitmap.close();
            compareBitmap.close();
            return;
          }

          const bCanvas = baseCanvasRef.current;
          const cCanvas = compareCanvasRef.current;
          const dCanvas = diffCanvasRef.current;

          if (bCanvas && cCanvas && dCanvas) {
            bCanvas.width = baseBitmap.width;
            bCanvas.height = baseBitmap.height;
            const bCtx = bCanvas.getContext('2d', { willReadFrequently: true });
            bCtx?.clearRect(0, 0, baseBitmap.width, baseBitmap.height);
            bCtx?.drawImage(baseBitmap, 0, 0);

            cCanvas.width = compareBitmap.width;
            cCanvas.height = compareBitmap.height;
            const cCtx = cCanvas.getContext('2d', { willReadFrequently: true });
            cCtx?.clearRect(0, 0, compareBitmap.width, compareBitmap.height);
            cCtx?.drawImage(compareBitmap, 0, 0);

            if (bCtx && cCtx) {
              const bData = bCtx.getImageData(0, 0, baseBitmap.width, baseBitmap.height);
              // Resize cData to match bData to avoid out of bounds
              let cData: ImageData;
              if (
                compareBitmap.width === baseBitmap.width &&
                compareBitmap.height === baseBitmap.height
              ) {
                cData = cCtx.getImageData(0, 0, baseBitmap.width, baseBitmap.height);
              } else {
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = baseBitmap.width;
                tempCanvas.height = baseBitmap.height;
                const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true })!;
                tempCtx.drawImage(compareBitmap, 0, 0, baseBitmap.width, baseBitmap.height);
                cData = tempCtx.getImageData(0, 0, baseBitmap.width, baseBitmap.height);
              }
              imagesRef.current = { base: bData, compare: cData };
              setRendered(n => n + 1);
            }
          }

          baseBitmap.close();
          compareBitmap.close();
        }
      } catch (err) {
        if (!isCancellation(err)) logEvent('error', 'compare.view', fromUnknown(err).message);
      } finally {
        if (baseHandle) {
          await baseClient.lease(api => api.closeDocument(baseHandle!)).catch(() => {});
        }
        if (compareHandle) {
          await compareClient.lease(api => api.closeDocument(compareHandle!)).catch(() => {});
        }
        if (!cancelled) setIsProcessing(false);
      }
    };

    // runDiff catches and logs its own failures; this only releases the pinned clients.
    void runDiff().finally(() => {
      baseClient.release();
      compareClient.release();
    });

    return () => {
      cancelled = true;
    };
  }, [page, source, pageSize, settings.compareSourceId, settings.diffMode]);

  // X-13 — the diff overlay alone, from the cached renders: all a
  // sensitivity change needs.
  useEffect(() => {
    if (settings.diffMode !== 'visual') return;
    const images = imagesRef.current;
    const dCanvas = diffCanvasRef.current;
    if (!images || !dCanvas) return;
    const frame = requestAnimationFrame(() => {
      const { base, compare } = images;
      const diffImg = pixelDiff(base, compare, settings.sensitivity);
      dCanvas.width = base.width;
      dCanvas.height = base.height;
      const dCtx = dCanvas.getContext('2d');
      // Draw the compare image as base, then draw diff on top. putImageData
      // ignores globalCompositeOperation, so the transparent diff goes
      // through a temporary canvas and drawImage.
      dCtx?.putImageData(compare, 0, 0);
      const diffTempCanvas = document.createElement('canvas');
      diffTempCanvas.width = base.width;
      diffTempCanvas.height = base.height;
      diffTempCanvas.getContext('2d')?.putImageData(diffImg, 0, 0);
      dCtx?.drawImage(diffTempCanvas, 0, 0);
      diffTempCanvas.width = 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [rendered, settings.sensitivity, settings.diffMode]);

  if (!settings.compareSourceId) {
    return (
      <EmptyState
        title={t('Compare PDFs')}
        body={t('Open a second PDF from the panel on the left to compare.')}
      />
    );
  }

  if (!page) {
    return <EmptyState title={t('No page')} body={t('There are no pages to preview.')} />;
  }

  return (
    <div className={styles.workspace}>
      <div className={styles.scrollArea}>
        <div
          className={styles.canvasContainer}
          style={
            settings.diffMode === 'visual'
              ? {
                  opacity: isProcessing ? 0.7 : 1,
                  transition: 'opacity 0.2s',
                  // Derives width from the page's own proportions, same
                  // technique as `SinglePageView`/`ExportReviewModal` — text
                  // mode below is a plain reading column, not page-shaped, so
                  // it keeps the CSS default (`width: auto`) instead.
                  aspectRatio: pageSize ? `${pageSize.width / pageSize.height}` : undefined
                }
              : { width: '100%' }
          }
        >
          {settings.diffMode === 'visual' ? (
            <CompareSlider
              before={<canvas ref={baseCanvasRef} className={styles.canvas} />}
              after={<canvas ref={diffCanvasRef} className={styles.canvas} />}
            />
          ) : (
            <div
              style={{
                padding: '2rem',
                maxWidth: '800px',
                width: '100%',
                background: 'var(--surface-1)',
                borderRadius: '8px',
                boxShadow: 'var(--shadow-2)',
                overflowY: 'auto',
                maxHeight: '100%',
                whiteSpace: 'pre-wrap',
                fontFamily: 'monospace'
              }}
            >
              {diffChunks.map((chunk, i) => (
                <span
                  key={i}
                  style={{
                    backgroundColor:
                      chunk.op === 'insert'
                        ? 'var(--success-bg)'
                        : chunk.op === 'delete'
                          ? 'var(--danger-bg)'
                          : 'transparent',
                    textDecoration: chunk.op === 'delete' ? 'line-through' : 'none',
                    color: chunk.op === 'delete' ? 'var(--ink-subtle)' : 'var(--ink)'
                  }}
                >
                  {chunk.text}{' '}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

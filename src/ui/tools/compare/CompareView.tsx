import { useEffect, useRef, useState } from 'preact/hooks';
import { type PageRef, sources } from '../../../core/store';
import { compareSettings } from './state';
import { renderWorker } from '../../../core/workers';
import { CompareSlider } from '../../components/CompareSlider';
import { EmptyState } from '../../components/Feedback';
import { isCancellation, logEvent, fromUnknown } from '../../../core/errors';
import { pixelDiff } from '../../../core/pixel-diff';
import { diffText, DiffChunk } from '../../../core/diff';
import styles from '../../shell/SinglePageView.module.css';
import { useTranslation } from '../../../core/i18n';

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

      let baseHandle: string | undefined;
      let compareHandle: string | undefined;

      try {
        const baseHandleInfo = await baseClient.lease(api => api.loadDocument(source.bytes));
        baseHandle = baseHandleInfo.handle;

        const compareHandleInfo = await compareClient.lease(api =>
          api.loadDocument(compareSource.bytes)
        );
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

          if (!cancelled) {
            setDiffChunks(diffText(baseText, compareText));
          }
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

            // Compute diff
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

              const diffImg = pixelDiff(bData, cData, settings.sensitivity);

              dCanvas.width = baseBitmap.width;
              dCanvas.height = baseBitmap.height;
              const dCtx = dCanvas.getContext('2d');
              // Draw the compare image as base, then draw diff on top
              dCtx?.putImageData(cData, 0, 0);
              // We need to draw the diffImg with transparency.
              // putImageData ignores globalCompositeOperation.
              // So we create a temporary canvas to draw the diff data, then drawImage that on top.
              const diffTempCanvas = document.createElement('canvas');
              diffTempCanvas.width = baseBitmap.width;
              diffTempCanvas.height = baseBitmap.height;
              const diffTempCtx = diffTempCanvas.getContext('2d')!;
              diffTempCtx.putImageData(diffImg, 0, 0);

              dCtx?.drawImage(diffTempCanvas, 0, 0);
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

    runDiff().finally(() => {
      baseClient.release();
      compareClient.release();
    });

    return () => {
      cancelled = true;
    };
  }, [page, source, pageSize, settings.compareSourceId, settings.diffMode, settings.sensitivity]);

  if (!settings.compareSourceId) {
    return (
      <EmptyState
        title={t('Compare PDFs')}
        body="Open a second PDF from the panel on the left to compare."
      />
    );
  }

  if (!page) {
    return <EmptyState title={t('No page')} body="There are no pages to preview." />;
  }

  return (
    <div className={styles.workspace}>
      <div className={styles.scrollArea}>
        <div
          className={styles.canvasContainer}
          style={{
            opacity: isProcessing ? 0.7 : 1,
            transition: 'opacity 0.2s',
            width: '100%',
            height: '100%',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center'
          }}
        >
          {settings.diffMode === 'visual' ? (
            <CompareSlider
              before={
                <canvas
                  ref={baseCanvasRef}
                  className={styles.canvas}
                  style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                />
              }
              after={
                <canvas
                  ref={diffCanvasRef}
                  className={styles.canvas}
                  style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                />
              }
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

import { useEffect, useRef, useState, useMemo } from 'preact/hooks';
import { ZoomIn, ZoomOut } from 'lucide-preact';
import { type PageRef } from '../../../core/store';
import { compressReport, compressSettings } from './state';
import { composeDocument, compressDocument, planCompression } from '../../../core/operations';
import { pageAnnotations } from '../annotate/state';
import { renderWorker } from '../../../core/workers';
import { CompareSlider } from '../../components/CompareSlider';
import { IconButton } from '../../components/IconButton';
import { EmptyState } from '../../components/Feedback';
import { isCancellation, logEvent, fromUnknown } from '../../../core/errors';
import styles from '../../shell/SinglePageView.module.css';
import { useTranslation } from '../../../core/i18n';

export interface CompressPreviewProps {
  pages: PageRef[];
}

const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3, 4] as const;

export function CompressPreview({ pages }: CompressPreviewProps) {
  const t = useTranslation();
  const [zoomStep, setZoomStep] = useState(2); // 100%
  const zoom = ZOOM_STEPS[zoomStep];

  const beforeCanvasRef = useRef<HTMLCanvasElement>(null);
  const afterCanvasRef = useRef<HTMLCanvasElement>(null);

  const [beforeSize, setBeforeSize] = useState({ width: 0, height: 0 });
  const [afterSize, setAfterSize] = useState({ width: 0, height: 0 });

  const [isProcessing, setIsProcessing] = useState(false);

  const report = compressReport.value;
  const settings = compressSettings.value;

  // 1. Identify representative page
  const representativeIndex = useMemo(() => {
    if (!report || report.plan.pages.length === 0) return 0;

    let best = report.plan.pages[0];
    for (const p of report.plan.pages) {
      if (p.actionableBytes > best.actionableBytes) best = p;
    }
    return best.pageIndex;
  }, [report]);

  const page = pages[representativeIndex];

  // 2. Render before
  useEffect(() => {
    if (!page) return;
    let cancelled = false;

    const renderBefore = async () => {
      try {
        const annotations = pageAnnotations.value[page.key] || [];
        const layerAnnotations = annotations.map(ann => ({ ...ann, pageKey: page.key }));
        const composedBytes = await composeDocument({
          pages: [page],
          annotations: [],
          layerAnnotations
        });
        if (cancelled) return;

        // pin() keeps load/render/close on the same pool instance — separate
        // lease() calls could land on different instances and leave the close
        // a silent no-op on the wrong one, leaking the pdf.js document.
        const client = renderWorker.pin();
        let handle: string | undefined;
        try {
          handle = await client
            .lease(api => api.loadDocument(composedBytes))
            .then(info => info.handle);
          if (cancelled) return;

          const scale = Number(
            (
              zoom * Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)
            ).toFixed(2)
          );
          const bitmap = await client.lease(api => api.renderPage(handle!, 0, scale));

          if (cancelled) {
            bitmap.close();
            return;
          }

          const canvas = beforeCanvasRef.current;
          if (canvas) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const ctx = canvas.getContext('2d');
            ctx?.clearRect(0, 0, bitmap.width, bitmap.height);
            ctx?.drawImage(bitmap, 0, 0);
            setBeforeSize({ width: bitmap.width / scale, height: bitmap.height / scale });
          }

          bitmap.close();
        } finally {
          if (handle) {
            await client.lease(api => api.closeDocument(handle!)).catch(() => {});
          }
          client.release();
        }
      } catch (err) {
        if (!isCancellation(err)) logEvent('error', 'compress.preview', fromUnknown(err).message);
      }
    };
    renderBefore();

    return () => {
      cancelled = true;
    };
  }, [page, zoom]);

  // 3. Render after (debounced on settings)
  useEffect(() => {
    if (!page) return;
    let cancelled = false;

    const renderAfter = async () => {
      setIsProcessing(true);
      try {
        const annotations = pageAnnotations.value[page.key] || [];
        const layerAnnotations = annotations.map(ann => ({ ...ann, pageKey: page.key }));
        const composedBytes = await composeDocument({
          pages: [page],
          annotations: [],
          layerAnnotations
        });
        if (cancelled) return;

        const miniReport = await planCompression(composedBytes, settings);
        if (cancelled) return;

        const compressedResult = await compressDocument(composedBytes, settings, miniReport);
        if (cancelled) return;

        // pin() keeps load/render/close on the same pool instance — see the
        // matching comment in the "before" preview effect above.
        const client = renderWorker.pin();
        let handle: string | undefined;
        try {
          handle = await client
            .lease(api => api.loadDocument(compressedResult.bytes))
            .then(info => info.handle);
          if (cancelled) return;

          const scale = Number(
            (
              zoom * Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)
            ).toFixed(2)
          );
          const bitmap = await client.lease(api => api.renderPage(handle!, 0, scale));

          if (cancelled) {
            bitmap.close();
            return;
          }

          const canvas = afterCanvasRef.current;
          if (canvas) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const ctx = canvas.getContext('2d');
            ctx?.clearRect(0, 0, bitmap.width, bitmap.height);
            ctx?.drawImage(bitmap, 0, 0);
            setAfterSize({ width: bitmap.width / scale, height: bitmap.height / scale });
          }

          bitmap.close();
        } finally {
          if (handle) {
            await client.lease(api => api.closeDocument(handle!)).catch(() => {});
          }
          client.release();
        }
      } catch (err) {
        if (!isCancellation(err)) logEvent('error', 'compress.preview', fromUnknown(err).message);
      } finally {
        if (!cancelled) setIsProcessing(false);
      }
    };

    const debounceTimer = setTimeout(renderAfter, 200);

    return () => {
      cancelled = true;
      clearTimeout(debounceTimer);
    };
  }, [page, settings, zoom]);

  if (!page) {
    return <EmptyState title={t('No page')} body="There are no pages to preview." />;
  }

  const w = Math.max(beforeSize.width, afterSize.width);
  const h = Math.max(beforeSize.height, afterSize.height);

  return (
    <div className={styles.workspace}>
      <div className={styles.scrollArea}>
        <div
          className={styles.canvasContainer}
          style={{
            width: w * zoom,
            height: h * zoom,
            opacity: isProcessing ? 0.7 : 1,
            transition: 'opacity 0.2s'
          }}
        >
          <CompareSlider
            before={
              <canvas
                ref={beforeCanvasRef}
                className={styles.canvas}
                style={{ width: '100%', height: '100%' }}
              />
            }
            after={
              <canvas
                ref={afterCanvasRef}
                className={styles.canvas}
                style={{ width: '100%', height: '100%' }}
              />
            }
          />
        </div>
      </div>

      <div className={styles.bottomBar}>
        <span className={styles.pageLabel}>
          {t('Preview: Page')}
          {page.sourceIndex + 1}
        </span>
        <div className={styles.toolbar}>
          <IconButton
            icon={ZoomOut}
            title={t('Zoom out')}
            disabled={zoomStep === 0}
            onClick={() => setZoomStep(s => Math.max(0, s - 1))}
          />
          <span className={styles.zoomLabel}>{Math.round(zoom * 100)}%</span>
          <IconButton
            icon={ZoomIn}
            title={t('Zoom in')}
            disabled={zoomStep === ZOOM_STEPS.length - 1}
            onClick={() => setZoomStep(s => Math.min(ZOOM_STEPS.length - 1, s + 1))}
          />
        </div>
      </div>
    </div>
  );
}

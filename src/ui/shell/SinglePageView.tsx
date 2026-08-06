/**
 * `SinglePageView` from DESIGN-ADAPTATION §4.2: one page at a real size with an
 * overlay layer, for sign, redact, and cleanup.
 *
 * It did not exist. Those tools instead rendered the *whole grid* at a larger scale
 * and stacked their overlay on every tile, so signature placement was relative to a
 * thumbnail — the reason SGN-02's "pixel-accurate against the exported PDF"
 * criterion could not be met.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-preact';
import { sources, type PageRef } from '../../core/store';
import { normalizeRotation } from '../../core/rotation';
import { bitmapKey, renderHandleFor, thumbnailCache } from '../../core/render-cache';
import { isCancellation, logEvent } from '../../core/errors';
import { Button } from '../components/Button';
import { IconButton } from '../components/IconButton';
import styles from './SinglePageView.module.css';
import { useTranslation } from '../../core/i18n';

export interface SinglePageViewProps {
  pages: PageRef[];
  pageIndex: number;
  onPageIndexChange: (index: number) => void;
  /**
   * Rendered inside the page box, so children can position against the page in
   * percentages and land exactly where the export puts them.
   */
  overlay?: (geometry: { width: number; height: number; page: PageRef }) => ComponentChildren;
}

const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3, 4] as const;

export function SinglePageView({
  pages,
  pageIndex,
  onPageIndexChange,
  overlay
}: SinglePageViewProps) {
  const t = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoomStep, setZoomStep] = useState(2); // 100%
  const [size, setSize] = useState({ width: 0, height: 0 });
  const zoom = ZOOM_STEPS[zoomStep];

  const page = pages[pageIndex];
  const source = page ? sources.value[page.sourceDocId] : undefined;
  const pageSize = source?.pageSizes[page?.sourceIndex ?? 0];

  useEffect(() => {
    if (!page || !source || !pageSize) return;
    let cancelled = false;
    const scale = Number(
      (zoom * Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)).toFixed(2)
    );
    const key = bitmapKey(source.id, page.sourceIndex, scale);

    const draw = (bitmap: ImageBitmap) => {
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
      // CSS size is the logical page size at this zoom; the backing store is at
      // device resolution. Keeping them separate is what makes 400% sharp.
      setSize({ width: pageSize.width * zoom, height: pageSize.height * zoom });
    };

    const cached = thumbnailCache.get(key);
    if (cached) {
      draw(cached);
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        const { handle, client } = await renderHandleFor(source.id, source.bytes);
        if (cancelled) return;
        const bitmap = await client.lease(api => api.renderPage(handle, page.sourceIndex, scale));
        if (cancelled) {
          bitmap.close();
          return;
        }
        thumbnailCache.set(key, bitmap);
        draw(bitmap);
      } catch (err) {
        if (!cancelled && !isCancellation(err)) {
          logEvent('warn', 'single-page', String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [page, source, pageSize, zoom]);

  if (!page || !pageSize) return null;

  const rotation = normalizeRotation(page.rotation);
  const swapped = rotation === 90 || rotation === 270;

  const rawWidth = size.width || pageSize.width * zoom;
  const rawHeight = size.height || pageSize.height * zoom;

  const displayWidth = swapped ? rawHeight : rawWidth;
  const displayHeight = swapped ? rawWidth : rawHeight;

  return (
    <div className={styles.wrapper}>
      <div className={styles.stage}>
        <div
          className={styles.page}
          data-index={pageIndex}
          style={{
            width: `${displayWidth}px`,
            height: `${displayHeight}px`,
            position: 'relative'
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              width: `${rawWidth}px`,
              height: `${rawHeight}px`,
              transform: `translate(-50%, -50%) rotate(${rotation}deg)`
            }}
          >
            <canvas
              ref={canvasRef}
              className={styles.canvas}
              aria-label={`Page ${pageIndex + 1}`}
            />
            {overlay?.({ width: rawWidth, height: rawHeight, page })}
          </div>
        </div>
      </div>

      <div className={styles.pager}>
        <Button
          variant="tertiary"
          size="compact"
          icon={ChevronLeft}
          disabled={pageIndex === 0}
          onClick={() => onPageIndexChange(pageIndex - 1)}
        >
          {t('Previous')}
        </Button>
        <span className={styles.pagerLabel}>
          {t('Page')} {pageIndex + 1} {t('of')} {pages.length}
        </span>
        <Button
          variant="tertiary"
          size="compact"
          icon={ChevronRight}
          iconPosition="right"
          disabled={pageIndex >= pages.length - 1}
          onClick={() => onPageIndexChange(pageIndex + 1)}
        >
          {t('Next')}
        </Button>

        <div className={styles.zoom}>
          <IconButton
            icon={ZoomOut}
            size="compact"
            aria-label="Zoom out"
            disabled={zoomStep === 0}
            onClick={() => setZoomStep(step => Math.max(0, step - 1))}
          />
          <span className={styles.zoomLabel}>{Math.round(zoom * 100)}%</span>
          <IconButton
            icon={ZoomIn}
            size="compact"
            aria-label="Zoom in"
            disabled={zoomStep === ZOOM_STEPS.length - 1}
            onClick={() => setZoomStep(step => Math.min(ZOOM_STEPS.length - 1, step + 1))}
          />
        </div>
      </div>
    </div>
  );
}

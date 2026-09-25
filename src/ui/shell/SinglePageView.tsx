import { translate } from '../../core/i18n';
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
import { useRef, useState } from 'preact/hooks';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-preact';
import { sources, type PageRef } from '../../core/store';
import { normalizeRotation } from '../../core/rotation';
import { usePageRender } from './usePageRender';
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
  const zoom = ZOOM_STEPS[zoomStep];

  const page = pages[pageIndex];
  const source = page ? sources.value[page.sourceDocId] : undefined;
  const pageSize = source?.pageSizes[page?.sourceIndex ?? 0];
  const { state, reduced, size } = usePageRender(
    canvasRef,
    page,
    source,
    pageSize,
    zoom,
    'single-page'
  );

  if (!page || !pageSize) return null;

  const rotation = normalizeRotation(page.rotation);
  const swapped = rotation === 90 || rotation === 270;

  const rawWidth = size.width || pageSize.width * zoom;
  const rawHeight = size.height || pageSize.height * zoom;

  const displayWidth = swapped ? rawHeight : rawWidth;
  const displayHeight = swapped ? rawWidth : rawHeight;

  return (
    <div className={styles.wrapper}>
      <div className={styles.stage} tabIndex={0} aria-label={translate('Page preview, scrollable')}>
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
              aria-label={t('Page {page}', { page: pageIndex + 1 })}
            />
            {overlay?.({ width: rawWidth, height: rawHeight, page })}
          </div>
          {/* UI-16 — covers the page (and blocks the overlay) until this
              page's own pixels are on screen, so nothing is marked against
              a blank or stale image. */}
          {state !== 'ready' && (
            <div
              className={`${styles.status} ${state === 'failed' ? styles.statusFailed : ''}`}
              role="status"
            >
              {state === 'failed' ? t('This page could not be displayed.') : t('Loading page…')}
            </div>
          )}
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
          {t('Page {n} of {total}', { n: pageIndex + 1, total: pages.length })}
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
            aria-label={translate('Zoom out')}
            disabled={zoomStep === 0}
            onClick={() => setZoomStep(step => Math.max(0, step - 1))}
          />
          <span className={styles.zoomLabel}>{Math.round(zoom * 100)}%</span>
          {reduced && (
            <span
              className={styles.reduced}
              title={translate(
                'This zoom needs more pixels than a preview renders, so the page is shown at lower detail. The exported file is not affected.'
              )}
            >
              {t('Reduced detail')}
            </span>
          )}
          <IconButton
            icon={ZoomIn}
            size="compact"
            aria-label={translate('Zoom in')}
            disabled={zoomStep === ZOOM_STEPS.length - 1}
            onClick={() => setZoomStep(step => Math.min(ZOOM_STEPS.length - 1, step + 1))}
          />
        </div>
      </div>
    </div>
  );
}

import { translate } from '../../core/i18n';
/**
 * `SinglePageView` from DESIGN-ADAPTATION §4.2: one page at a real size with an
 * overlay layer, for sign, redact, and cleanup.
 *
 * It did not exist. Those tools instead rendered the *whole grid* at a larger scale
 * and stacked their overlay on every tile, so signature placement was relative to a
 * thumbnail — the reason SGN-02's "pixel-accurate against the exported PDF"
 * criterion could not be met.
 *
 * The default zoom fits the whole page inside the visible stage — a page far
 * wider or taller than the stage (a screenshot placed at "Original image size",
 * a poster-sized scan) otherwise opened clipped at a fixed 100%, needing a
 * scroll the user had no reason to expect. Explicit zoom in/out still works
 * from there and is remembered while paging through the same document; a new
 * document, or a page whose own size or rotation differs, re-fits — "visible
 * in full" is the guarantee, not a one-time default.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
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
const MIN_FIT_ZOOM = 0.1;
const MAX_FIT_ZOOM = 8;

export function SinglePageView({
  pages,
  pageIndex,
  onPageIndexChange,
  overlay
}: SinglePageViewProps) {
  const t = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const page = pages[pageIndex];
  const source = page ? sources.value[page.sourceDocId] : undefined;
  const pageSize = source?.pageSizes[page?.sourceIndex ?? 0];
  const rotation = normalizeRotation(page?.rotation ?? 0);
  const swapped = rotation === 90 || rotation === 270;
  const fitWidth = pageSize ? (swapped ? pageSize.height : pageSize.width) : 0;
  const fitHeight = pageSize ? (swapped ? pageSize.width : pageSize.height) : 0;

  // The stage's own content box (its padding excluded), remeasured whenever the
  // window, the options panel, or a sheet folding away changes how much of it
  // is actually visible.
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const padX = parseFloat(cs.paddingLeft || '0') + parseFloat(cs.paddingRight || '0');
      const padY = parseFloat(cs.paddingTop || '0') + parseFloat(cs.paddingBottom || '0');
      setStageSize({
        width: Math.max(0, el.clientWidth - padX),
        height: Math.max(0, el.clientHeight - padY)
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fitZoom = useMemo(() => {
    if (!fitWidth || !fitHeight || !stageSize.width || !stageSize.height) return 1;
    const fit = Math.min(stageSize.width / fitWidth, stageSize.height / fitHeight);
    return Math.min(MAX_FIT_ZOOM, Math.max(MIN_FIT_ZOOM, fit));
  }, [fitWidth, fitHeight, stageSize.width, stageSize.height]);

  // `null` = auto-fit (recomputed live from `fitZoom`); a number pins zoom to
  // that `ZOOM_STEPS` index until the page identity changes again.
  const [manualZoomStep, setManualZoomStep] = useState<number | null>(null);
  useEffect(() => {
    setManualZoomStep(null);
  }, [page?.key]);

  const zoom = manualZoomStep === null ? fitZoom : ZOOM_STEPS[manualZoomStep];
  const nextStepUp = ZOOM_STEPS.findIndex(step => step > zoom + 0.001);
  const nextStepDown = [...ZOOM_STEPS]
    .map((step, i) => [step, i] as const)
    .findLast(([step]) => step < zoom - 0.001);

  const { state, reduced, size } = usePageRender(
    canvasRef,
    page,
    source,
    pageSize,
    zoom,
    'single-page'
  );

  if (!page || !pageSize) return null;

  const rawWidth = size.width || pageSize.width * zoom;
  const rawHeight = size.height || pageSize.height * zoom;

  const displayWidth = swapped ? rawHeight : rawWidth;
  const displayHeight = swapped ? rawWidth : rawHeight;

  return (
    <div className={styles.wrapper}>
      <div
        ref={stageRef}
        className={styles.stage}
        tabIndex={0}
        aria-label={translate('Page preview, scrollable')}
      >
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
            disabled={!nextStepDown}
            onClick={() => nextStepDown && setManualZoomStep(nextStepDown[1])}
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
            disabled={nextStepUp === -1}
            onClick={() => nextStepUp !== -1 && setManualZoomStep(nextStepUp)}
          />
        </div>
      </div>
    </div>
  );
}

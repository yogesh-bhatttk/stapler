/**
 * ANN-07 — two independent page panes kept in sync: same page, same zoom
 * (shared signals, so there is only one value for either pane to disagree
 * about), and proportional scroll position mirrored between them on every
 * `scroll` event — which fires, and is handled, well within one frame, not
 * polled or debounced.
 *
 * Deliberately not `BroadcastChannel`: both panes render in the same page in
 * the same JS context, so there is no second tab or window for a message
 * channel to bridge — a plain shared signal already is "kept in sync" here,
 * and reaching for a broadcast channel with only one listener would be
 * synchronising with nothing.
 *
 * A separate component from `SinglePageView` rather than an extension of it:
 * that component is shared by five other tools (sign, redact, crop, annotate,
 * watermark) with its own internal, uncontrolled zoom state, and threading a
 * second, externally-controlled zoom mode through it risked all five for the
 * sake of this one new consumer. This duplicates its rendering approach
 * (`renderHandleFor`/`bitmapKey`/`thumbnailCache`) rather than its code.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-preact';
import { sources, type PageRef } from '../../../core/store';
import { normalizeRotation } from '../../../core/rotation';
import { bitmapKey, renderHandleFor, thumbnailCache } from '../../../core/render-cache';
import { isCancellation, logEvent } from '../../../core/errors';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { useTranslation } from '../../../core/i18n';
import { sideBySidePageIndex, sideBySideZoomStep } from './state';
import styles from './SideBySideView.module.css';

const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3, 4] as const;

interface PaneProps {
  label: string;
  page: PageRef | undefined;
  zoom: number;
  stageRef: (el: HTMLDivElement | null) => void;
  onScroll: (el: HTMLDivElement) => void;
}

function Pane({ label, page, zoom, stageRef, onScroll }: PaneProps) {
  const t = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
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
        const { handle, client } = await renderHandleFor(source.id);
        if (cancelled) return;
        const bitmap = await client.lease(api => api.renderPage(handle, page.sourceIndex, scale));
        if (cancelled) {
          bitmap.close();
          return;
        }
        thumbnailCache.set(key, bitmap);
        draw(bitmap);
      } catch (err) {
        if (!cancelled && !isCancellation(err)) logEvent('warn', 'side-by-side', String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [page, source, pageSize, zoom]);

  if (!page || !pageSize) {
    return (
      <div className={styles.stage} aria-label={label}>
        <p className={styles.empty}>{t('No page to show.')}</p>
      </div>
    );
  }

  const rotation = normalizeRotation(page.rotation);
  const swapped = rotation === 90 || rotation === 270;
  const rawWidth = size.width || pageSize.width * zoom;
  const rawHeight = size.height || pageSize.height * zoom;
  const displayWidth = swapped ? rawHeight : rawWidth;
  const displayHeight = swapped ? rawWidth : rawHeight;

  return (
    <div
      className={styles.stage}
      ref={stageRef}
      onScroll={e => onScroll(e.currentTarget)}
      tabIndex={0}
      aria-label={label}
    >
      <div
        className={styles.page}
        style={{ width: `${displayWidth}px`, height: `${displayHeight}px`, position: 'relative' }}
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
          <canvas ref={canvasRef} className={styles.canvas} aria-label={`${label}, page`} />
        </div>
      </div>
    </div>
  );
}

export interface SideBySideViewProps {
  pagesA: PageRef[];
  nameA: string;
  pagesB: PageRef[] | null;
  nameB: string | null;
}

export function SideBySideView({ pagesA, nameA, pagesB, nameB }: SideBySideViewProps) {
  const t = useTranslation();
  const pageIndex = sideBySidePageIndex.value;
  const zoomStep = sideBySideZoomStep.value;
  const zoom = ZOOM_STEPS[zoomStep];
  const maxPages = Math.max(pagesA.length, pagesB?.length ?? 0);

  const paneARef = useRef<HTMLDivElement | null>(null);
  const paneBRef = useRef<HTMLDivElement | null>(null);
  // Re-entrancy guard: setting the other pane's scrollTop/Left from inside a
  // scroll handler fires that pane's own scroll event, which would otherwise
  // bounce back and forth. Both panes share this one flag, not one each,
  // because only one sync should ever be in flight at a time.
  const syncing = useRef(false);

  const mirror = (from: HTMLDivElement, to: HTMLDivElement | null) => {
    if (!to || syncing.current) return;
    const fx =
      from.scrollWidth > from.clientWidth
        ? from.scrollLeft / (from.scrollWidth - from.clientWidth)
        : 0;
    const fy =
      from.scrollHeight > from.clientHeight
        ? from.scrollTop / (from.scrollHeight - from.clientHeight)
        : 0;
    syncing.current = true;
    try {
      to.scrollLeft = fx * (to.scrollWidth - to.clientWidth);
      to.scrollTop = fy * (to.scrollHeight - to.clientHeight);
    } finally {
      syncing.current = false;
    }
  };

  return (
    <div className={styles.wrapper}>
      <div className={styles.panes}>
        <Pane
          label={nameA}
          page={pagesA[pageIndex]}
          zoom={zoom}
          stageRef={el => (paneARef.current = el)}
          onScroll={el => mirror(el, paneBRef.current)}
        />
        <Pane
          label={nameB ?? t('No second document')}
          page={pagesB?.[pageIndex]}
          zoom={zoom}
          stageRef={el => (paneBRef.current = el)}
          onScroll={el => mirror(el, paneARef.current)}
        />
      </div>

      <div className={styles.pager}>
        <Button
          variant="tertiary"
          size="compact"
          icon={ChevronLeft}
          disabled={pageIndex === 0}
          onClick={() => (sideBySidePageIndex.value = pageIndex - 1)}
        >
          {t('Previous')}
        </Button>
        <span className={styles.pagerLabel}>
          {t('Page')} {pageIndex + 1} {t('of')} {maxPages}
        </span>
        <Button
          variant="tertiary"
          size="compact"
          icon={ChevronRight}
          iconPosition="right"
          disabled={pageIndex >= maxPages - 1}
          onClick={() => (sideBySidePageIndex.value = pageIndex + 1)}
        >
          {t('Next')}
        </Button>

        <div className={styles.zoom}>
          <IconButton
            icon={ZoomOut}
            size="compact"
            aria-label={t('Zoom out')}
            disabled={zoomStep === 0}
            onClick={() => (sideBySideZoomStep.value = Math.max(0, zoomStep - 1))}
          />
          <span className={styles.zoomLabel}>{Math.round(zoom * 100)}%</span>
          <IconButton
            icon={ZoomIn}
            size="compact"
            aria-label={t('Zoom in')}
            disabled={zoomStep === ZOOM_STEPS.length - 1}
            onClick={() =>
              (sideBySideZoomStep.value = Math.min(ZOOM_STEPS.length - 1, zoomStep + 1))
            }
          />
        </div>
      </div>
    </div>
  );
}

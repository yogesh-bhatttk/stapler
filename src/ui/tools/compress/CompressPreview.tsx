/**
 * CMP-05 — the before/after quality preview.
 *
 * This is not a simulation of compression: the "after" half is the real
 * pipeline. The representative page is composed into a one-page PDF
 * (`composeDocument`), classified by the real planner (`planCompression`) and
 * run through the real re-encoder (`compressDocument`) at the current DPI and
 * quality; the bytes that come back are loaded into pdf.js and rendered. What
 * the user judges is therefore the same encoder output the export will contain,
 * and the "this page" figure next to it is a *measured* byte count, not a model.
 *
 * Three caches keep a slider tick inside CMP-05's 400ms budget by only redoing
 * the part of that pipeline the changed input actually invalidates:
 *   - the composed one-page bytes depend on the page alone;
 *   - the plan depends on the page and DPI (quality only moves the estimate,
 *     never the routing, so it is not a key);
 *   - the compressed bytes depend on the page, DPI and quality — a zoom change
 *     re-renders from the bytes already in hand and re-encodes nothing.
 *
 * All of the work is in the render and process workers; the main thread only
 * draws the returned bitmaps. Every stage is cancellable, and an effect that is
 * torn down (page change, another slider tick, leaving the tool) aborts the job
 * it started rather than letting it run to completion unwatched.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ZoomIn, ZoomOut } from 'lucide-preact';
import { type PageRef } from '../../../core/store';
import { compressMeasurement, compressReport, compressSettings, projectedOutput } from './state';
import {
  composeDocument,
  compressDocument,
  planCompression,
  currentDocumentBytes,
  type CompressionReport
} from '../../../core/operations';
import { representativePageIndex } from '../../../core/compress-plan';
import { pageAnnotations } from '../annotate/state';
import { renderWorker } from '../../../core/workers';
import { CompareSlider } from '../../components/CompareSlider';
import { IconButton } from '../../components/IconButton';
import { EmptyState, SizeDelta } from '../../components/Feedback';
import { isCancellation, logEvent, fromUnknown } from '../../../core/errors';
import styles from './CompressPreview.module.css';
import { useTranslation } from '../../../core/i18n';

export interface CompressPreviewProps {
  pages: PageRef[];
}

const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3, 4] as const;
const INITIAL_ZOOM_STEP = 2; // 100%

/**
 * Short enough that a slider drag still lands inside the 400ms budget, long
 * enough that the intermediate steps of one drag do not each start a re-encode.
 */
const SETTLE_MS = 50;

interface Rendered {
  width: number;
  height: number;
}

/** Draws a bitmap into a canvas and returns its size in CSS pixels. */
function paint(canvas: HTMLCanvasElement | null, bitmap: ImageBitmap, scale: number): Rendered {
  const size = { width: bitmap.width / scale, height: bitmap.height / scale };
  if (!canvas) return size;
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx?.clearRect(0, 0, bitmap.width, bitmap.height);
  ctx?.drawImage(bitmap, 0, 0);
  return size;
}

/**
 * Renders page 0 of `bytes` at `scale`.
 *
 * `pin()` keeps load/render/close on the same pool instance — separate `lease()`
 * calls could land on different instances, leaving the close a silent no-op on
 * the wrong one and leaking the pdf.js document.
 */
async function renderFirstPage(bytes: Uint8Array, scale: number): Promise<ImageBitmap> {
  const client = renderWorker.pin();
  let handle: string | undefined;
  try {
    handle = await client.lease(api => api.loadDocument(bytes)).then(info => info.handle);
    return await client.lease(api => api.renderPage(handle!, 0, scale));
  } finally {
    if (handle) await client.lease(api => api.closeDocument(handle!)).catch(() => {});
    client.release();
  }
}

export function CompressPreview({ pages }: CompressPreviewProps) {
  const t = useTranslation();
  const [zoomStep, setZoomStep] = useState(INITIAL_ZOOM_STEP);
  const zoom = ZOOM_STEPS[zoomStep];

  const beforeCanvasRef = useRef<HTMLCanvasElement>(null);
  const afterCanvasRef = useRef<HTMLCanvasElement>(null);

  const [beforeSize, setBeforeSize] = useState<Rendered>({ width: 0, height: 0 });
  const [afterSize, setAfterSize] = useState<Rendered>({ width: 0, height: 0 });
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  /** Measured bytes of the previewed page, before and after the real re-encode. */
  const [measured, setMeasured] = useState<{ before: number; after: number } | null>(null);
  /**
   * What the currently *displayed* halves were produced with — settings for the
   * "after" canvas, render scale for both. The scale belongs here because a zoom
   * change re-renders without re-encoding, and a preview that reported "ready"
   * while still showing the previous zoom's bitmap is exactly the kind of stale
   * frame a quality judgement must not be made on.
   */
  const [shown, setShown] = useState<{ dpi: number; quality: number; scale: number } | null>(null);
  const [shownBeforeScale, setShownBeforeScale] = useState(0);

  const report = compressReport.value;
  const settings = compressSettings.value;

  const index = Math.min(
    useMemo(() => representativePageIndex(report?.plan), [report]),
    Math.max(0, pages.length - 1)
  );
  const page = pages[index];
  const pageKey = page?.key;

  const composedCache = useRef(new Map<string, Uint8Array>());
  const planCache = useRef(new Map<string, CompressionReport>());
  const compressedCache = useRef(
    new Map<string, { bytes: Uint8Array; actionableBytes: number; targetPixels: number }>()
  );

  // The caches are keyed by page/DPI/quality, but they are only ever useful for
  // the document currently open. Clearing on a page change keeps a long session
  // from holding on to every page of every document it has previewed.
  useEffect(() => {
    composedCache.current.clear();
    planCache.current.clear();
    compressedCache.current.clear();
    // A measurement describes one page of one document. Dropping it with the
    // caches stops the panel projecting the previous document's measured ratio
    // onto this one until the first re-encode lands.
    compressMeasurement.value = null;
  }, [pageKey]);

  /** The one-page PDF for the representative page, composed at most once. */
  const composeOnce = useCallback(
    async (target: PageRef, signal: AbortSignal): Promise<Uint8Array> => {
      const cached = composedCache.current.get(target.key);
      if (cached) return cached;
      const annotations = pageAnnotations.value[target.key] || [];
      const bytes = await composeDocument(
        {
          pages: [target],
          annotations: [],
          layerAnnotations: annotations.map(ann => ({ ...ann, pageKey: target.key }))
        },
        { signal }
      );
      composedCache.current.set(target.key, bytes);
      return bytes;
    },
    []
  );

  const scale = useMemo(
    () =>
      Number(
        (zoom * Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)).toFixed(2)
      ),
    [zoom]
  );

  /*
   * The preview needs a document-wide plan to know which page is representative,
   * and the panel's projection needs the same report. Running it here means
   * opening the tool shows a real preview of the right page without the user
   * having to press "Analyse" first; if a report already exists (the panel ran
   * one, or the settings changed), this does nothing.
   */
  useEffect(() => {
    if (compressReport.value) return;
    const controller = new AbortController();
    (async () => {
      try {
        const bytes = await currentDocumentBytes({ signal: controller.signal });
        const analysed = await planCompression(bytes, compressSettings.value, {
          signal: controller.signal
        });
        if (!controller.signal.aborted) compressReport.value = analysed;
      } catch (err) {
        if (!isCancellation(err)) logEvent('error', 'compress.preview', fromUnknown(err).message);
      }
    })();
    return () => controller.abort();
    // Deliberately mount-only: re-running on every settings change would
    // duplicate the panel's own debounced re-projection.
  }, []);

  // "Before" — the page exactly as it is today.
  useEffect(() => {
    if (!page) return;
    const controller = new AbortController();
    (async () => {
      try {
        const composed = await composeOnce(page, controller.signal);
        if (controller.signal.aborted) return;
        const bitmap = await renderFirstPage(composed, scale);
        if (controller.signal.aborted) {
          bitmap.close();
          return;
        }
        setBeforeSize(paint(beforeCanvasRef.current, bitmap, scale));
        bitmap.close();
        setShownBeforeScale(scale);
      } catch (err) {
        if (!isCancellation(err)) logEvent('error', 'compress.preview', fromUnknown(err).message);
      }
    })();
    return () => controller.abort();
  }, [page, scale, composeOnce]);

  // "After" — the real compression pipeline at the current settings.
  useEffect(() => {
    if (!page) return;
    const controller = new AbortController();
    const { dpi, quality } = settings;
    const compressedKey = `${page.key}|${dpi}|${quality}`;

    const run = async () => {
      // Only announce work when there is work: a cached encode (a zoom change, or
      // a slider returned to a value already seen) should not flash the overlay.
      const cached = compressedCache.current.get(compressedKey);
      if (!cached) setPending(true);
      try {
        const composed = await composeOnce(page, controller.signal);
        if (controller.signal.aborted) return;

        let encoded = compressedCache.current.get(compressedKey);
        if (!encoded) {
          const planKey = `${page.key}|${dpi}`;
          let plan = planCache.current.get(planKey);
          if (!plan) {
            plan = await planCompression(composed, settings, { signal: controller.signal });
            if (controller.signal.aborted) return;
            planCache.current.set(planKey, plan);
          }
          const result = await compressDocument(composed, settings, plan, {
            signal: controller.signal
          });
          if (controller.signal.aborted) return;
          // The plan of the *composed* page, not of the page inside the original
          // file: `composeDocument` re-embeds streams, so the one-page PDF's own
          // byte counts are the only ones the measured output can be compared
          // against. Its pixel targets are the same either way (same geometry,
          // same DPI), which is what makes the ratio transferable.
          const planned = plan.plan.pages[0];
          encoded = {
            bytes: result.bytes,
            actionableBytes: planned?.actionableBytes ?? 0,
            targetPixels: planned?.targetPixels ?? 0
          };
          compressedCache.current.set(compressedKey, encoded);
        }
        const compressed = encoded.bytes;

        const bitmap = await renderFirstPage(compressed, scale);
        if (controller.signal.aborted) {
          bitmap.close();
          return;
        }
        setAfterSize(paint(afterCanvasRef.current, bitmap, scale));
        bitmap.close();
        setMeasured({ before: composed.byteLength, after: compressed.byteLength });
        // Re-anchors the projection on bytes this document's own content really
        // produced (CMP-05), for this panel and the options panel alike.
        compressMeasurement.value = {
          // The plan indexes pages by their position in the *document*, which is
          // what `index` is; `sourceIndex` is where the page came from and can
          // differ once pages have been reordered or merged in.
          pageIndex: index,
          beforeBytes: composed.byteLength,
          afterBytes: compressed.byteLength,
          pageActionableBytes: encoded.actionableBytes,
          pageTargetPixels: encoded.targetPixels,
          dpi,
          quality
        };
        setShown({ dpi, quality, scale });
        setFailed(false);
      } catch (err) {
        if (isCancellation(err)) return;
        // Never leave a stale "after" passing for the current settings: the
        // preview says so instead of quietly showing the previous encode.
        logEvent('error', 'compress.preview', fromUnknown(err).message);
        setFailed(true);
      } finally {
        if (!controller.signal.aborted) setPending(false);
      }
    };

    const timer = setTimeout(run, SETTLE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [page, index, settings, scale, composeOnce]);

  if (!page) {
    return <EmptyState title={t('No page')} body="There are no pages to preview." />;
  }

  const projection = projectedOutput(report, compressMeasurement.value, settings);
  const width = Math.max(beforeSize.width, afterSize.width) * zoom;
  const height = Math.max(beforeSize.height, afterSize.height) * zoom;
  const upToDate =
    shown?.dpi === settings.dpi &&
    shown?.quality === settings.quality &&
    shown?.scale === scale &&
    shownBeforeScale === scale;

  return (
    <div
      className={styles.wrapper}
      data-preview-status={failed ? 'error' : pending || !upToDate ? 'working' : 'ready'}
      data-preview-page={index + 1}
      data-preview-quality={shown ? Math.round(shown.quality * 100) : ''}
      data-preview-dpi={shown ? shown.dpi : ''}
      data-preview-page-before={measured ? measured.before : ''}
      data-preview-page-after={measured ? measured.after : ''}
      data-projected-bytes={projection ? projection.bytes : ''}
      data-projected-measured={projection ? String(projection.measured) : ''}
    >
      <div className={styles.stage}>
        <div
          className={`${styles.page} ${pending ? styles.pending : ''}`}
          style={{ width: width || undefined, height: height || undefined }}
        >
          <CompareSlider
            label={t('Compare original and compressed quality')}
            before={
              <canvas
                ref={beforeCanvasRef}
                className={styles.canvas}
                data-preview-canvas="before"
              />
            }
            after={
              <canvas ref={afterCanvasRef} className={styles.canvas} data-preview-canvas="after" />
            }
          />
        </div>
      </div>

      <div className={styles.bar}>
        <span className={styles.label}>
          {t('Page')} {index + 1} — {t('most image area')}
        </span>

        {measured && (
          <span className={styles.projection}>
            {t('This page')} <SizeDelta before={measured.before} after={measured.after} />
          </span>
        )}

        {report && projection && (
          <span className={styles.projection}>
            {projection.measured ? t('Projected output (measured)') : t('Projected output')}{' '}
            <SizeDelta before={report.originalBytes} after={projection.bytes} />
          </span>
        )}

        <span className={styles.status} role="status" aria-live="polite">
          {failed
            ? t('Preview unavailable')
            : pending || !upToDate
              ? t('Updating…')
              : shown
                ? `${Math.round(shown.quality * 100)}% · ${shown.dpi} DPI`
                : ''}
        </span>

        <div className={styles.zoom}>
          <IconButton
            icon={ZoomOut}
            title={t('Zoom out')}
            disabled={zoomStep === 0}
            onClick={() => setZoomStep(step => Math.max(0, step - 1))}
          />
          <span className={styles.zoomLabel} data-preview-zoom={Math.round(zoom * 100)}>
            {Math.round(zoom * 100)}%
          </span>
          <IconButton
            icon={ZoomIn}
            title={t('Zoom in')}
            disabled={zoomStep === ZOOM_STEPS.length - 1}
            onClick={() => setZoomStep(step => Math.min(ZOOM_STEPS.length - 1, step + 1))}
          />
        </div>
      </div>
    </div>
  );
}

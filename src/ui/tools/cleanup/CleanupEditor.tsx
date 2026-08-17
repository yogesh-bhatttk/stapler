/**
 * Scan cleanup: before/after compare, draggable corners, and apply (SCN-01..03).
 *
 * The biggest gap this closes is that the previous editor was a *preview only* — it
 * rendered a comparison and then threw the result away. There was no Apply anywhere
 * in the app, so the hero feature could not produce a file. It also had no corner
 * handles despite SCN-01 requiring them as the always-available fallback, and set
 * `ctx.fillStyle = 'var(--primary)'`, which canvas does not understand, so the
 * compare divider drew in whatever colour happened to be current.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Check, ScanSearch } from 'lucide-preact';
import {
  registerSource,
  repointPage,
  replaceWithSource,
  sources,
  type PageRef,
  type SourceDocument
} from '../../../core/store';
import { renderHandleFor } from '../../../core/render-cache';
import { cvWorker, processWorker, renderWorker } from '../../../core/workers';
import { createJobHandle } from '../../../core/workers/protocol';
import { frameQuad, isFrameQuad, type Quad } from '../../../core/cv/imageUtils';
import { normalizeRotation } from '../../../core/rotation';
import { notify } from '../../../core/notify';
import { cancelled, logEvent } from '../../../core/errors';
import { Button } from '../../components/Button';
import { cleanupSettings, cornerOverrides, isDetectingCorners } from './state';
import { useJob } from '../../useJob';
import styles from './CleanupEditor.module.css';

export interface CleanupEditorProps {
  docId: string;
  pages: PageRef[];
  pageIndex: number;
  onPageIndexChange: (index: number) => void;
}

/** Working resolution. High enough to read 8pt text, low enough to stay interactive. */
const WORK_DPI = 150;

const CORNERS: (keyof Quad)[] = ['tl', 'tr', 'br', 'bl'];

/**
 * The corners to hand `processScan`, or `null` to skip de-warping entirely.
 *
 * A quad covering the whole frame is what "detection was not confident" and the
 * "Use the whole page" button both produce. Warping through it is an identity
 * homography that still resamples every pixel, so it is skipped: a page we could
 * not read the edges of is left exactly as it came in.
 */
function cornersFor(quad: Quad, image: ImageData): Quad | null {
  return isFrameQuad(quad, image.width, image.height) ? null : quad;
}

/** One page's cleaned pixels, encoded as JPEG for `imagesToPdf`. */
async function encodeJpeg(image: ImageData): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(image.width, image.height);
  canvas.getContext('2d')?.putImageData(image, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return new Uint8Array(await blob.arrayBuffer());
}

export function CleanupEditor({ docId, pages, pageIndex, onPageIndexChange }: CleanupEditorProps) {
  const beforeRef = useRef<ImageData | null>(null);
  const afterRef = useRef<ImageData | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(0.5);
  const [ready, setReady] = useState(false);
  // Tracks whether afterRef.current reflects the *current* settings/quad rather
  // than a stale or nonexistent preview — apply() must never ship what this page
  // hasn't actually rendered yet (SCN-03 regression: Apply was gated on `ready`
  // alone, so clicking right after a preset change, or before the first preview
  // round trip lands, silently applied nothing).
  const [previewReady, setPreviewReady] = useState(false);
  const { run } = useJob();

  const page = pages[pageIndex];
  const source = page ? sources.value[page.sourceDocId] : undefined;
  const settings = cleanupSettings.value;
  const quad = page ? cornerOverrides.value[page.key] : undefined;

  /** Loads the page at working resolution and detects its corners. */
  useEffect(() => {
    if (!page || !source) return;
    let cancelled = false;
    setReady(false);

    void (async () => {
      try {
        const { handle, client } = await renderHandleFor(source.id, source.bytes);
        const bitmap = await client.lease(api =>
          api.renderPage(handle, page.sourceIndex, WORK_DPI / 72)
        );
        if (cancelled) {
          bitmap.close();
          return;
        }

        const rotation = normalizeRotation(page.rotation);
        const swapped = rotation === 90 || rotation === 270;

        const canvas = new OffscreenCanvas(
          swapped ? bitmap.height : bitmap.width,
          swapped ? bitmap.width : bitmap.height
        );
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;

        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);

        bitmap.close();
        beforeRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);

        if (!cornerOverrides.value[page.key]) {
          isDetectingCorners.value = true;
          const detection = await cvWorker.lease(api => api.detectCorners(beforeRef.current!));
          isDetectingCorners.value = false;
          if (cancelled) return;
          cornerOverrides.value = { ...cornerOverrides.value, [page.key]: detection.quad };
          if (!detection.confident) {
            // SCN-01: when detection is not trustworthy, say so and hand over the
            // handles rather than silently cropping to a guess.
            notify('info', 'Could not find the page edges confidently.', {
              detail: 'Drag the four corner handles to mark the page yourself.'
            });
          }
        }
        setReady(true);
      } catch (err) {
        isDetectingCorners.value = false;
        logEvent('warn', 'cleanup', String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [page, source]);

  /**
   * Re-processes whenever the settings or the corners change.
   *
   * Every setting `processScan` reads is listed in the dependency array. `despeckle`
   * was missing, so toggling it changed the signal, changed nothing on screen, and
   * the user concluded (correctly, as far as they could see) that despeckle did
   * nothing. If you add a field to `ScanSettings`, add it here.
   */
  useEffect(() => {
    if (!ready || !beforeRef.current || !quad) return;
    let cancelled = false;
    setPreviewReady(false);

    void (async () => {
      const processed = await cvWorker.lease(api =>
        api.processScan(
          beforeRef.current!,
          { ...settings, corners: cornersFor(quad, beforeRef.current!) },
          createJobHandle()
        )
      );
      if (cancelled) return;
      afterRef.current = processed;
      paint();
      setPreviewReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [
    ready,
    quad,
    settings.preset,
    settings.contrast,
    settings.brightness,
    settings.deskew,
    settings.despeckle
  ]);

  const paint = () => {
    const canvas = canvasRef.current;
    const before = beforeRef.current;
    if (!canvas || !before) return;
    canvas.width = before.width;
    canvas.height = before.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.putImageData(before, 0, 0);

    const after = afterRef.current;
    if (after) {
      const cut = Math.round(before.width * split);
      // The processed image can be a different size (de-warping changes the box), so
      // it is drawn scaled into the original's frame for a fair comparison.
      const temp = new OffscreenCanvas(after.width, after.height);
      temp.getContext('2d')?.putImageData(after, 0, 0);
      ctx.save();
      ctx.beginPath();
      ctx.rect(cut, 0, before.width - cut, before.height);
      ctx.clip();
      ctx.drawImage(temp, 0, 0, before.width, before.height);
      ctx.restore();
    }
  };

  useEffect(paint, [split]);

  const apply = () =>
    run({ label: 'Applying cleanup to the page', scope: 'cleanup.apply' }, async job => {
      const after = afterRef.current;
      if (!after || !page || !source) return;

      // OPS-13 requires flatten to touch only the background layer and leave
      // foreground text/vector content untouched — which only exists on the
      // *original* page. Routing flatten through the rasterized cleanup preview
      // (a single all-image page) would give it nothing but background to find,
      // so it would erase everything, cleaned pixels included. The two exports
      // are therefore built from different sources, and repointed at different
      // page indices in the result they each produce.
      let bytes: Uint8Array;
      let resultPageIndex: number;
      if (settings.flattenBackground) {
        bytes = await processWorker.lease(api =>
          api.flattenBackground(
            source.bytes,
            page.sourceIndex,
            settings.flattenTint,
            createJobHandle(job)
          )
        );
        resultPageIndex = page.sourceIndex;
      } else {
        const jpeg = await encodeJpeg(after);
        const originalSize = source.pageSizes[page.sourceIndex];
        bytes = await processWorker.lease(api =>
          api.imagesToPdf(
            [jpeg],
            originalSize
              ? {
                  pageSize: { width: originalSize.width, height: originalSize.height },
                  orientation: 'portrait',
                  margin: 0,
                  quality: 0.85
                }
              : undefined,
            createJobHandle(job)
          )
        );
        resultPageIndex = 0;
      }
      // pin() keeps load and close on the same pool instance — two independent
      // lease() calls could land on different instances and leave the close a
      // silent no-op on the wrong one.
      const client = renderWorker.pin();
      let newSource: SourceDocument;
      try {
        const info = await client.lease(api => api.loadDocument(bytes));
        newSource = {
          id: crypto.randomUUID(),
          name: `${source?.name ?? 'page'} (cleaned)`,
          bytes,
          pageCount: info.pageCount,
          pageSizes: info.pageSizes
        };
        await client.lease(api => api.closeDocument(info.handle));
      } finally {
        client.release();
      }

      registerSource(newSource);
      // A single-page result (the non-flatten path) is replaced outright; flatten's
      // whole-document result repoints just this page, leaving its siblings alone.
      if (pages.length === 1 && resultPageIndex === 0) {
        replaceWithSource(docId, newSource);
      } else {
        notify('info', 'Applied to this page.', {
          detail: 'Move to the next page to clean it, then export when you are done.'
        });
        repointPage(docId, page.key, newSource.id, resultPageIndex);
      }
      notify('success', 'Page cleaned.');
    });

  const applyToAll = () =>
    run({ label: 'Cleaning all pages', scope: 'cleanup.applyToAll' }, async job => {
      // Flatten (OPS-13) has to run against the original vector pages — it keeps
      // foreground text/vector content and only replaces the background layer,
      // which does not exist any more once a page has been rasterized to a single
      // cleaned JPEG. So the two modes stay on separate paths: flatten touches
      // every page of the *source* document directly and never rasterizes anything;
      // everything else runs the de-warp/despeckle/contrast pipeline per page (this
      // used to silently stop after page 1) and rebuilds the pages as images.
      let bytes: Uint8Array;
      if (settings.flattenBackground) {
        const firstSourceId = pages[0].sourceDocId;
        if (pages.some(p => p.sourceDocId !== firstSourceId)) {
          throw new Error(
            'Flatten background does not yet support a selection spanning more than one source document.'
          );
        }
        const firstSource = sources.value[firstSourceId];
        if (!firstSource) throw new Error('Source not found');
        job.onProgress?.(0.05, 'Flattening the background');
        bytes = await processWorker.lease(api =>
          api.flattenBackground(
            firstSource.bytes,
            'all',
            settings.flattenTint,
            createJobHandle(job)
          )
        );
      } else {
        const jpegs: Uint8Array[] = [];
        const originalSizes: { width: number; height: number }[] = [];

        for (let i = 0; i < pages.length; i++) {
          if (job.signal?.aborted) throw cancelled();
          job.onProgress?.(i / pages.length, `Cleaning page ${i + 1} of ${pages.length}`);

          const p = pages[i];
          const s = sources.value[p.sourceDocId];
          if (!s) throw new Error(`Source not found for page ${i + 1}`);

          const { handle, client } = await renderHandleFor(s.id, s.bytes);
          const bitmap = await client.lease(api =>
            api.renderPage(handle, p.sourceIndex, WORK_DPI / 72)
          );

          const rotation = normalizeRotation(p.rotation);
          const swapped = rotation === 90 || rotation === 270;

          const canvas = new OffscreenCanvas(
            swapped ? bitmap.height : bitmap.width,
            swapped ? bitmap.width : bitmap.height
          );
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) throw new Error(`Failed to create 2d context for page ${i + 1}`);

          ctx.translate(canvas.width / 2, canvas.height / 2);
          ctx.rotate((rotation * Math.PI) / 180);
          ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);

          bitmap.close();

          const before = ctx.getImageData(0, 0, canvas.width, canvas.height);

          let pageQuad = cornerOverrides.value[p.key];
          if (!pageQuad) {
            const detection = await cvWorker.lease(api => api.detectCorners(before));
            // A detection we do not believe means "leave this page's geometry
            // alone" — not "crop 2% off it and hope". `detectCorners` already
            // returns the whole frame in that case; `cornersFor` turns that into
            // "skip the warp".
            pageQuad = detection.quad;
          }

          const after = await cvWorker.lease(api =>
            api.processScan(before, { ...settings, corners: cornersFor(pageQuad, before) })
          );

          const afterCanvas = new OffscreenCanvas(after.width, after.height);
          afterCanvas.getContext('2d')?.putImageData(after, 0, 0);
          const blob = await afterCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
          jpegs.push(new Uint8Array(await blob.arrayBuffer()));

          const origSize = s.pageSizes[p.sourceIndex];
          originalSizes.push({
            width: swapped ? origSize.height : origSize.width,
            height: swapped ? origSize.width : origSize.height
          });
        }

        if (jpegs.length === 0) return;

        bytes = await processWorker.lease(api =>
          api.imagesToPdf(
            jpegs,
            {
              pageSize: originalSizes,
              orientation: 'portrait',
              margin: 0,
              quality: 0.85
            },
            createJobHandle(job)
          )
        );
      }

      const firstSource = sources.value[pages[0].sourceDocId];

      // pin() keeps load and close on the same pool instance — two independent
      // lease() calls could land on different instances and leave the close a
      // silent no-op on the wrong one.
      const client = renderWorker.pin();
      let newSource: SourceDocument;
      try {
        const info = await client.lease(api => api.loadDocument(bytes));
        newSource = {
          id: crypto.randomUUID(),
          name: `${firstSource?.name ?? 'document'} (cleaned)`,
          bytes,
          pageCount: info.pageCount,
          pageSizes: info.pageSizes
        };
        await client.lease(api => api.closeDocument(info.handle));
      } finally {
        client.release();
      }

      registerSource(newSource);
      replaceWithSource(docId, newSource);
      notify('success', 'All pages cleaned.');
    });

  if (!page || !source) return null;

  return (
    <div className={styles.wrapper}>
      <div className={styles.stage}>
        <div
          className={styles.compare}
          ref={boxRef}
          onPointerDown={event => {
            if ((event.target as HTMLElement).dataset.corner) return;
            const rect = boxRef.current?.getBoundingClientRect();
            if (!rect) return;
            boxRef.current?.setPointerCapture(event.pointerId);
            setSplit(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)));
          }}
          onPointerMove={event => {
            if (event.buttons !== 1) return;
            if ((event.target as HTMLElement).dataset.corner) return;
            const rect = boxRef.current?.getBoundingClientRect();
            if (!rect) return;
            setSplit(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)));
          }}
        >
          <canvas ref={canvasRef} className={styles.canvas} aria-label="Before and after" />

          <span className={styles.label + ' ' + styles.labelBefore}>Original</span>
          <span className={styles.label + ' ' + styles.labelAfter}>Cleaned</span>
          <span className={styles.divider} style={{ left: `${split * 100}%` }}>
            <span className={styles.grip} />
          </span>

          {quad && beforeRef.current && (
            <CornerHandles
              quad={quad}
              imageWidth={beforeRef.current.width}
              imageHeight={beforeRef.current.height}
              onChange={next =>
                (cornerOverrides.value = { ...cornerOverrides.value, [page.key]: next })
              }
            />
          )}
        </div>
      </div>

      <div className={styles.bar}>
        <span className={styles.status}>
          Page {pageIndex + 1} of {pages.length}
          {isDetectingCorners.value ? ' · finding edges…' : ''}
        </span>
        <Button
          variant="tertiary"
          size="compact"
          icon={ScanSearch}
          onClick={() => {
            const next = { ...cornerOverrides.value };
            delete next[page.key];
            cornerOverrides.value = next;
            if (beforeRef.current) {
              // Re-detect from scratch rather than nudging the existing quad.
              void cvWorker
                .lease(api => api.detectCorners(beforeRef.current!))
                .then(detection => {
                  cornerOverrides.value = { ...cornerOverrides.value, [page.key]: detection.quad };
                });
            }
          }}
        >
          Detect edges again
        </Button>
        <Button
          variant="tertiary"
          size="compact"
          onClick={() => {
            if (!beforeRef.current) return;
            cornerOverrides.value = {
              ...cornerOverrides.value,
              [page.key]: frameQuad(beforeRef.current.width, beforeRef.current.height, 0)
            };
          }}
        >
          Use the whole page
        </Button>
        <Button
          variant="tertiary"
          size="compact"
          disabled={pageIndex === 0}
          onClick={() => onPageIndexChange(pageIndex - 1)}
        >
          Previous
        </Button>
        <Button
          variant="tertiary"
          size="compact"
          disabled={pageIndex >= pages.length - 1}
          onClick={() => onPageIndexChange(pageIndex + 1)}
        >
          Next
        </Button>
        <Button variant="secondary" icon={Check} onClick={apply} disabled={!ready || !previewReady}>
          Apply to this page
        </Button>
        <Button
          variant="secondary"
          icon={Check}
          onClick={applyToAll}
          disabled={!ready || !previewReady}
        >
          Apply to all pages
        </Button>
      </div>
    </div>
  );
}

/** Four draggable corners, each also nudgeable by keyboard. */
function CornerHandles({
  quad,
  imageWidth,
  imageHeight,
  onChange
}: {
  quad: Quad;
  imageWidth: number;
  imageHeight: number;
  onChange: (quad: Quad) => void;
}) {
  const drag = (corner: keyof Quad) => (event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const parent = (event.currentTarget as HTMLElement).parentElement;
    const rect = parent?.getBoundingClientRect();
    if (!rect) return;

    const move = (moveEvent: PointerEvent) => {
      onChange({
        ...quad,
        [corner]: {
          x: Math.max(
            0,
            Math.min(imageWidth, ((moveEvent.clientX - rect.left) / rect.width) * imageWidth)
          ),
          y: Math.max(
            0,
            Math.min(imageHeight, ((moveEvent.clientY - rect.top) / rect.height) * imageHeight)
          )
        }
      });
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  };

  return (
    <div className={styles.handles}>
      <svg className={styles.quad} viewBox={`0 0 ${imageWidth} ${imageHeight}`} aria-hidden="true">
        <polygon
          points={CORNERS.map(c => `${quad[c].x},${quad[c].y}`).join(' ')}
          fill="none"
          stroke="currentColor"
          stroke-width={Math.max(1, imageWidth / 400)}
          stroke-dasharray={`${imageWidth / 80} ${imageWidth / 80}`}
        />
      </svg>
      {CORNERS.map(corner => (
        <span
          key={corner}
          data-corner={corner}
          className={styles.handle}
          style={{
            left: `${(quad[corner].x / imageWidth) * 100}%`,
            top: `${(quad[corner].y / imageHeight) * 100}%`
          }}
          role="slider"
          tabIndex={0}
          aria-label={`${corner.toUpperCase()} page corner`}
          aria-valuetext={`${Math.round(quad[corner].x)}, ${Math.round(quad[corner].y)}`}
          onPointerDown={drag(corner)}
          onKeyDown={event => {
            const step = event.shiftKey ? 10 : 2;
            const deltas: Record<string, [number, number]> = {
              ArrowLeft: [-step, 0],
              ArrowRight: [step, 0],
              ArrowUp: [0, -step],
              ArrowDown: [0, step]
            };
            const delta = deltas[event.key];
            if (!delta) return;
            event.preventDefault();
            onChange({
              ...quad,
              [corner]: {
                x: Math.max(0, Math.min(imageWidth, quad[corner].x + delta[0])),
                y: Math.max(0, Math.min(imageHeight, quad[corner].y + delta[1]))
              }
            });
          }}
        />
      ))}
    </div>
  );
}

/**
 * RT-10 / UI-16 — renders one page at a zoom into a canvas, for the
 * single-page and side-by-side views.
 *
 * What this replaced, in both views:
 *
 *  • Zoomed renders went into the shared thumbnail cache. An A4 page at 400 %
 *    on a 2× display is ~130 MB, and the cache held 120 entries. They are now
 *    rendered on demand, drawn, and closed at once — never cached.
 *  • The render scale was unbounded; past what a canvas can hold, the page
 *    came back blank with no message. It is now clamped to
 *    `MAX_VIEW_PIXELS`, and `reduced` says so for the view to show.
 *  • Turning the page left the previous page's pixels on screen until the new
 *    render landed — or for good, if it failed — under the new page's Redact
 *    and Crop overlays, so a region could be marked against the wrong image.
 *    A different page now clears the canvas first, and `state` reports
 *    loading / failed so the view can cover the page until it is ready.
 */
import { useEffect, useRef, useState, type MutableRef } from 'preact/hooks';
import type { PageRef, SourceDocument } from '../../core/store';
import { renderHandleFor } from '../../core/render-cache';
import { clampRenderScale, MAX_VIEW_PIXELS } from '../../core/render-limits';
import { isCancellation, logEvent } from '../../core/errors';

export type PageRenderState = 'loading' | 'ready' | 'failed';

export interface PageRender {
  state: PageRenderState;
  /** True when the zoom asked for more pixels than a view renders; shown at less. */
  reduced: boolean;
  /** CSS size of the page at this zoom, once rendered; zero before. */
  size: { width: number; height: number };
}

/** Empties a canvas so nothing of a previous page stays visible. */
function clearCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

/** The render scale for a zoom: device pixels, at most 2× the CSS size, then clamped. */
export function viewRenderScale(
  pageSize: { width: number; height: number },
  zoom: number,
  devicePixelRatio: number
): { scale: number; clamped: boolean } {
  const requested = Number((zoom * Math.min(2, devicePixelRatio)).toFixed(2));
  return clampRenderScale(pageSize.width, pageSize.height, requested, MAX_VIEW_PIXELS);
}

export function usePageRender(
  canvasRef: MutableRef<HTMLCanvasElement | null>,
  page: PageRef | undefined,
  source: SourceDocument | undefined,
  pageSize: { width: number; height: number } | undefined,
  zoom: number,
  scope: string
): PageRender {
  const [state, setState] = useState<PageRenderState>('loading');
  const [reduced, setReduced] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  /** Which page's pixels the canvas holds right now, or null when blank. */
  const shown = useRef<string | null>(null);

  useEffect(() => {
    if (!page || !source || !pageSize) return;
    let cancelled = false;
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    const { scale, clamped } = viewRenderScale(pageSize, zoom, dpr);
    const pageId = `${source.id}:${page.sourceIndex}`;

    // A zoom change on the same page may keep its (rescaled) pixels while the
    // sharper render arrives; a different page never shows the old one's.
    // Only a different page shows the loading cover: covering the page (and
    // blocking the Redact/Crop overlays) on every zoom step made each zoom
    // flash an opaque panel for pixels the user was already looking at
    // (regression review R-RT-8).
    if (shown.current !== pageId) {
      clearCanvas(canvasRef.current);
      shown.current = null;
      setState('loading');
    }
    setReduced(clamped);

    void (async () => {
      try {
        const { handle, client } = await renderHandleFor(source.id);
        if (cancelled) return;
        const bitmap = await client.lease(api => api.renderPage(handle, page.sourceIndex, scale));
        try {
          const canvas = canvasRef.current;
          if (cancelled || !canvas) return;
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
          shown.current = pageId;
          // CSS size is the logical page size at this zoom; the backing store is
          // at device resolution. Keeping them separate is what makes 400% sharp.
          setSize({ width: pageSize.width * zoom, height: pageSize.height * zoom });
          setState('ready');
        } finally {
          // Drawn (or unwanted); nothing else holds it, and it is not cached.
          bitmap.close();
        }
      } catch (err) {
        if (cancelled || isCancellation(err)) return;
        logEvent('warn', scope, String(err));
        clearCanvas(canvasRef.current);
        shown.current = null;
        setState('failed');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [page, source, pageSize, zoom]);

  return { state, reduced, size };
}

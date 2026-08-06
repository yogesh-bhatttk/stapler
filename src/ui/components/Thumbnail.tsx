/**
 * One page thumbnail.
 *
 * Three bugs this replaces:
 *
 *  • The bitmap cache key was `${workspaceDocId}-${sourceIndex}-${scale}`. Merge two
 *    PDFs and page 3 of each collided, so one document showed the other's page. The
 *    key is now the *source* id (core/render-cache.ts).
 *  • Rotation was a CSS `transform` on the canvas inside a fixed portrait frame, so a
 *    rotated page rendered squashed and clipped. pdf.js applies /Rotate itself, so the
 *    canvas is simply rendered at the rotated size.
 *  • A render failure logged to the console and left the tile saying "Loading"
 *    forever, with nothing to tell the user something had gone wrong.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Check, RotateCw, Trash2 } from 'lucide-preact';
import { deletePage, rotatePage, sources, type PageRef } from '../../core/store';
import { bitmapKey, renderHandleFor, thumbnailCache } from '../../core/render-cache';
import { isCancellation, logEvent } from '../../core/errors';
import { normalizeRotation } from '../../core/rotation';
import { IconButton } from './IconButton';
import styles from './Thumbnail.module.css';

export interface ThumbnailProps {
  page: PageRef;
  docId: string;
  /** CSS pixel width of the tile, used to pick a render scale. */
  width: number;
  aspect: number;
  isSelected?: boolean;
  selectable?: boolean;
}

type State = 'loading' | 'ready' | 'failed';

/** Renders at device resolution, capped so a retina 300-page grid stays affordable. */
function renderScale(cssWidth: number, pageWidthPt: number): number {
  const dpr = Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
  if (pageWidthPt <= 0) return 1;
  return Math.min(2, Math.max(0.2, (cssWidth * dpr) / pageWidthPt));
}

export function Thumbnail({ page, docId, width, aspect, isSelected, selectable }: ThumbnailProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<State>('loading');

  const source = sources.value[page.sourceDocId];
  const pageSize = source?.pageSizes[page.sourceIndex];
  const scale = Number(renderScale(width, pageSize?.width ?? 595).toFixed(2));

  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      // Start a little before the tile scrolls in, so the render lands as it becomes
      // visible rather than after.
      rootMargin: '320px 0px'
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !source) return;
    let cancelled = false;
    const key = bitmapKey(source.id, page.sourceIndex, scale);

    const draw = (bitmap: ImageBitmap) => {
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;

      const rotation = normalizeRotation(page.rotation);
      const swapped = rotation === 90 || rotation === 270;

      canvas.width = swapped ? bitmap.height : bitmap.width;
      canvas.height = swapped ? bitmap.width : bitmap.height;

      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
      }
      setState('ready');
    };

    const cached = thumbnailCache.get(key);
    if (cached) {
      thumbnailCache.retain(key);
      draw(cached);
      return () => {
        cancelled = true;
        thumbnailCache.release(key);
      };
    }

    setState('loading');
    void (async () => {
      try {
        const { handle, client } = await renderHandleFor(source.id, source.bytes);
        if (cancelled) return;
        const bitmap = await client.lease(api => api.renderPage(handle, page.sourceIndex, scale));
        if (cancelled) {
          // Scrolled away mid-render: release the bitmap rather than caching a
          // thumbnail nobody is looking at.
          bitmap.close();
          return;
        }
        thumbnailCache.set(key, bitmap);
        thumbnailCache.retain(key);
        draw(bitmap);
      } catch (err) {
        if (cancelled || isCancellation(err)) return;
        logEvent('warn', 'thumbnail', `Page ${page.sourceIndex + 1}: ${String(err)}`);
        setState('failed');
      }
    })();

    return () => {
      cancelled = true;
      thumbnailCache.release(key);
    };
  }, [visible, source, page.sourceIndex, scale]);

  const rotation = normalizeRotation(page.rotation);
  const actualAspect = pageSize
    ? rotation === 90 || rotation === 270
      ? pageSize.height / pageSize.width
      : pageSize.width / pageSize.height
    : aspect;

  return (
    <div
      ref={frameRef}
      className={`${styles.frame} ${isSelected ? styles.selected : ''}`}
      style={{ aspectRatio: `${actualAspect}` }}
    >
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />

      {state !== 'ready' && (
        <div className={`${styles.placeholder} ${state === 'failed' ? styles.failed : ''}`}>
          {state === 'failed' ? 'Cannot render' : ''}
        </div>
      )}

      {rotation !== 0 && <span className={styles.rotationBadge}>{rotation}°</span>}

      {selectable && (
        <span className={`${styles.checkbox} ${isSelected ? styles.checkboxOn : ''}`}>
          {isSelected && <Check size={14} aria-hidden="true" />}
        </span>
      )}

      <div className={styles.tools}>
        <IconButton
          icon={RotateCw}
          size="compact"
          aria-label={`Rotate page ${page.sourceIndex + 1} clockwise`}
          onClick={event => {
            event.stopPropagation();
            rotatePage(docId, page.key, 90);
          }}
        />
        <IconButton
          icon={Trash2}
          size="compact"
          aria-label={`Delete page ${page.sourceIndex + 1}`}
          onClick={event => {
            event.stopPropagation();
            deletePage(docId, page.key);
          }}
        />
      </div>
    </div>
  );
}

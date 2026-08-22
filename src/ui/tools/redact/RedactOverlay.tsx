import { translate } from '../../../core/i18n';
/**
 * Drawing redaction marks on a page — rectangles (RED-01) and freehand shapes
 * (RED-07).
 *
 * Marks are keyed by the page's index in the *workspace*, not by `sourceIndex` as
 * before: after a reorder or a merge those differ, so marks landed on the wrong pages.
 *
 * A freehand mark is stored as its traced outline *plus* the bounding box every
 * rectangle mark already carries, so the commit path, the verifier, and the list
 * in the panel treat it as one more mark rather than a second feature.
 */
import { useRef, useState } from 'preact/hooks';
import { X } from 'lucide-preact';
import type { PageRef } from '../../../core/store';
import { pendingRedactions, redactShapeMode } from './state';
import styles from './RedactOverlay.module.css';
import { displayFrame, displayPointToNormalizedPage } from '../../../core/rotation';
import { polygonBounds, type Point } from '../../../core/geometry';

export interface RedactOverlayProps {
  page: PageRef;
  pageIndex: number;
  width: number;
  height: number;
  rotation: number;
}

interface Draft {
  x: number;
  y: number;
  toX: number;
  toY: number;
}

/** Below this a drag is a mis-click, not a region. */
const MIN_SIZE = 0.008;

/**
 * Minimum distance between two sampled points of a freehand trace, as a fraction
 * of the page. A pointer emits move events far faster than a shape needs vertices,
 * and every vertex is one more edge in the point-in-polygon tests the operator
 * filter, the verifier, and the image blackout each run — so the trace is thinned
 * as it is drawn rather than afterwards.
 */
const TRACE_STEP = 0.006;

/** Hard cap on a shape's vertices, in case of a very long slow drag. */
const MAX_TRACE_POINTS = 160;

/** Default size for a mark created with the keyboard, centred on the page. */
const DEFAULT_MARK = { width: 0.3, height: 0.08 };
const NUDGE = 0.005;
const NUDGE_COARSE = 0.03;
const clamp = (min: number, max: number, value: number) => Math.max(min, Math.min(max, value));

/** Keeps at most `MAX_TRACE_POINTS` vertices, evenly spaced, plus the last one. */
function thinTrace(points: Point[]): Point[] {
  if (points.length <= MAX_TRACE_POINTS) return points;
  const step = Math.ceil(points.length / MAX_TRACE_POINTS);
  const kept = points.filter((_, i) => i % step === 0);
  const last = points[points.length - 1];
  if (kept[kept.length - 1] !== last) kept.push(last);
  return kept;
}

export function RedactOverlay({ pageIndex, width, height, rotation }: RedactOverlayProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const pendingFocusIndex = useRef<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [trace, setTrace] = useState<Point[] | null>(null);
  const marks = pendingRedactions.value;
  const frame = displayFrame(width, height, rotation);
  const freehand = redactShapeMode.value === 'polygon';

  const updateMark = (
    index: number,
    next: { x: number; y: number; width: number; height: number }
  ) => {
    pendingRedactions.value = marks.map((m, i) => {
      if (i !== index) return m;
      // A shape's outline has to be carried by the same transform as its box.
      // Moving the box alone would leave the outline — which is what actually
      // decides the removal and what the verifier grades — behind the mark the
      // user can see, on the very first arrow-key nudge.
      const points =
        m.points && m.width > 0 && m.height > 0
          ? m.points.map(p => ({
              x: next.x + ((p.x - m.x) / m.width) * next.width,
              y: next.y + ((p.y - m.y) / m.height) * next.height
            }))
          : m.points;
      return { ...m, ...next, points };
    });
  };

  /**
   * Creating a region by drag is inherently pointer-only. `Enter`/`Space` on the
   * (otherwise empty) layer adds one at a default size and position instead —
   * the same "keyboard equivalent of a drag" convention `SignPanel`'s stamp
   * placement uses — so a keyboard-only user can redact something that isn't
   * findable by the text search (a photo, a signature, a hand-drawn mark).
   *
   * It adds a **rectangle even in freehand mode**, deliberately. There is no
   * keyboard equivalent of tracing a shape — and inventing one (a default
   * hexagon, say) would hand a keyboard user a mark they cannot reshape, since
   * per-vertex editing is out of scope, in place of one they can move and resize
   * with the arrow keys. The point of this fallback is that a keyboard user is
   * never left without a way to redact something a text search cannot find; a
   * rectangle does that, and a decorative polygon would not do it better.
   */
  const addMarkViaKeyboard = () => {
    const region = {
      pageIndex,
      x: (1 - DEFAULT_MARK.width) / 2,
      y: (1 - DEFAULT_MARK.height) / 2,
      width: DEFAULT_MARK.width,
      height: DEFAULT_MARK.height
    };
    pendingRedactions.value = [...marks, region];
    // Focus lands on the new mark once it renders — see the ref callback below.
    pendingFocusIndex.current = marks.length;
  };

  const onMarkKeyDown = (event: KeyboardEvent, index: number, mark: (typeof marks)[number]) => {
    event.stopPropagation();
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      pendingRedactions.value = marks.filter((_, i) => i !== index);
      return;
    }
    if (!/^Arrow/.test(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? NUDGE_COARSE : NUDGE;
    if (event.ctrlKey || event.metaKey) {
      let w = mark.width;
      let h = mark.height;
      if (event.key === 'ArrowLeft') w -= step;
      if (event.key === 'ArrowRight') w += step;
      if (event.key === 'ArrowUp') h -= step;
      if (event.key === 'ArrowDown') h += step;
      updateMark(index, {
        x: mark.x,
        y: mark.y,
        width: clamp(MIN_SIZE, 1 - mark.x, w),
        height: clamp(MIN_SIZE, 1 - mark.y, h)
      });
      return;
    }
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step]
    };
    const [dx, dy] = deltas[event.key];
    updateMark(index, {
      x: clamp(0, 1 - mark.width, mark.x + dx),
      y: clamp(0, 1 - mark.height, mark.y + dy),
      width: mark.width,
      height: mark.height
    });
  };

  const pointFrom = (event: PointerEvent) => {
    const rect = layerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const displayX = ((event.clientX - rect.left) / rect.width) * frame.displayWidth;
    const displayY = ((event.clientY - rect.top) / rect.height) * frame.displayHeight;
    const point = displayPointToNormalizedPage(frame, displayX, displayY);
    return {
      x: Math.max(0, Math.min(1, point.x)),
      y: Math.max(0, Math.min(1, point.y))
    };
  };

  const box = (d: Draft) => ({
    left: Math.min(d.x, d.toX),
    top: Math.min(d.y, d.toY),
    width: Math.abs(d.toX - d.x),
    height: Math.abs(d.toY - d.y)
  });

  /**
   * Turns a finished trace into a mark, or discards it.
   *
   * The size floor differs from the rectangle's on purpose: a scribble along one
   * line of text is only a few thousandths of the page tall, and requiring
   * `MIN_SIZE` in *both* directions — as a rectangle drag does — would silently
   * throw that away. A trace tiny in both directions is a mis-click, and that is
   * what is rejected.
   */
  const finishTrace = (points: Point[]) => {
    const thinned = thinTrace(points);
    if (thinned.length < 3) return;
    const bounds = polygonBounds(thinned);
    if (Math.max(bounds.width, bounds.height) < MIN_SIZE) return;
    pendingRedactions.value = [
      ...marks,
      {
        pageIndex,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        points: thinned
      }
    ];
  };

  /** The in-progress trace as an SVG `points` list in page percentages. */
  const tracePoints = (points: Point[]) => points.map(p => `${p.x * 100},${p.y * 100}`).join(' ');

  return (
    <div
      ref={layerRef}
      className={styles.layer}
      style={{ width: `${width}px`, height: `${height}px` }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement).closest('button')) return;
        const point = pointFrom(event);
        if (freehand) setTrace([point]);
        else setDraft({ x: point.x, y: point.y, toX: point.x, toY: point.y });
        // Capture on the layer, not the event target, so dragging past the page edge
        // keeps reporting instead of stranding a half-drawn rectangle.
        layerRef.current?.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        if (trace) {
          const point = pointFrom(event);
          const last = trace[trace.length - 1];
          // One vertex per pointer event is far more than a shape needs; sample
          // by distance so a slow drag does not produce hundreds of them.
          if (Math.hypot(point.x - last.x, point.y - last.y) < TRACE_STEP) return;
          setTrace([...trace, point]);
          return;
        }
        if (!draft) return;
        const point = pointFrom(event);
        setDraft({ ...draft, toX: point.x, toY: point.y });
      }}
      onPointerUp={() => {
        if (trace) {
          // Lifting the pointer closes the shape — the outline is treated as a
          // closed polygon from the last point back to the first.
          setTrace(null);
          finishTrace(trace);
          return;
        }
        if (!draft) return;
        const rect = box(draft);
        setDraft(null);
        if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) return;
        pendingRedactions.value = [
          ...marks,
          { pageIndex, x: rect.left, y: rect.top, width: rect.width, height: rect.height }
        ];
      }}
      onPointerCancel={() => {
        setDraft(null);
        setTrace(null);
      }}
      tabIndex={0}
      role="group"
      aria-label={translate(
        freehand
          ? 'Redaction drawing area, freehand mode. Drag to trace a shape around the content to remove, or press Enter to add a rectangular mark at a default size and position, then use arrow keys to move it and Control plus arrows to resize it.'
          : 'Redaction drawing area. Drag to mark a region, or press Enter to add one at a default size and position, then use arrow keys to move it and Control plus arrows to resize it.'
      )}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        addMarkViaKeyboard();
      }}
    >
      {marks.map((mark, index) => {
        if (mark.pageIndex !== pageIndex) return null;
        return (
          <div
            // Stable across a move: keying on position (as before) remounted
            // the element on every arrow-key nudge, which drops DOM focus —
            // fatal for a control that only exists to be operated by keyboard.
            key={index}
            // A shape draws its own outline inside the box, so the box itself
            // must not also be filled — that filled rectangle is exactly the
            // "bounding box instead of the shape" the export path avoids.
            className={mark.points ? styles.shapeMark : styles.mark}
            style={{
              left: `${mark.x * 100}%`,
              top: `${mark.y * 100}%`,
              width: `${mark.width * 100}%`,
              height: `${mark.height * 100}%`
            }}
            tabIndex={0}
            role="group"
            aria-label={
              mark.points
                ? `Redaction shape ${index + 1} on page ${pageIndex + 1}. Arrow keys move it, Control plus arrows resize it, Delete removes it.`
                : `Redaction region ${index + 1} on page ${pageIndex + 1}. Arrow keys move it, Control plus arrows resize it, Delete removes it.`
            }
            onKeyDown={event => onMarkKeyDown(event, index, mark)}
            ref={el => {
              if (pendingFocusIndex.current === index) {
                el?.focus();
                pendingFocusIndex.current = null;
              }
            }}
          >
            {mark.points && (
              <svg
                className={styles.shape}
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <polygon
                  points={mark.points
                    .map(
                      p =>
                        `${((p.x - mark.x) / (mark.width || 1)) * 100},${
                          ((p.y - mark.y) / (mark.height || 1)) * 100
                        }`
                    )
                    .join(' ')}
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            )}
            <button
              type="button"
              className={styles.remove}
              aria-label={`Remove redaction ${index + 1} on page ${pageIndex + 1}`}
              onClick={event => {
                event.stopPropagation();
                pendingRedactions.value = marks.filter((_, i) => i !== index);
              }}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        );
      })}

      {draft && (
        <div
          className={styles.drawing}
          style={{
            left: `${box(draft).left * 100}%`,
            top: `${box(draft).top * 100}%`,
            width: `${box(draft).width * 100}%`,
            height: `${box(draft).height * 100}%`
          }}
        />
      )}

      {trace && trace.length > 1 && (
        <svg
          className={styles.tracing}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {/* Drawn as a polygon rather than a polyline: the shape closes on
              pointer-up, so showing it closed while drawing is what the mark
              will actually be. */}
          <polygon points={tracePoints(trace)} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
    </div>
  );
}

/**
 * Drawing redaction rectangles on a page (RED-01).
 *
 * Marks are keyed by the page's index in the *workspace*, not by `sourceIndex` as
 * before: after a reorder or a merge those differ, so marks landed on the wrong pages.
 */
import { useRef, useState } from 'preact/hooks';
import { X } from 'lucide-preact';
import type { PageRef } from '../../../core/store';
import { pendingRedactions } from './state';
import styles from './RedactOverlay.module.css';

export interface RedactOverlayProps {
  page: PageRef;
  pageIndex: number;
  width: number;
  height: number;
}

interface Draft {
  x: number;
  y: number;
  toX: number;
  toY: number;
}

/** Below this a drag is a mis-click, not a region. */
const MIN_SIZE = 0.008;

export function RedactOverlay({ pageIndex, width, height }: RedactOverlayProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const marks = pendingRedactions.value;

  const pointFrom = (event: PointerEvent) => {
    const rect = layerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
    };
  };

  const box = (d: Draft) => ({
    left: Math.min(d.x, d.toX),
    top: Math.min(d.y, d.toY),
    width: Math.abs(d.toX - d.x),
    height: Math.abs(d.toY - d.y)
  });

  return (
    <div
      ref={layerRef}
      className={styles.layer}
      style={{ width: `${width}px`, height: `${height}px` }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement).closest('button')) return;
        const point = pointFrom(event);
        setDraft({ x: point.x, y: point.y, toX: point.x, toY: point.y });
        // Capture on the layer, not the event target, so dragging past the page edge
        // keeps reporting instead of stranding a half-drawn rectangle.
        layerRef.current?.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        if (!draft) return;
        const point = pointFrom(event);
        setDraft({ ...draft, toX: point.x, toY: point.y });
      }}
      onPointerUp={() => {
        if (!draft) return;
        const rect = box(draft);
        setDraft(null);
        if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) return;
        pendingRedactions.value = [
          ...marks,
          { pageIndex, x: rect.left, y: rect.top, width: rect.width, height: rect.height }
        ];
      }}
      onPointerCancel={() => setDraft(null)}
    >
      {marks.map((mark, index) => {
        if (mark.pageIndex !== pageIndex) return null;
        return (
          <div
            key={`${index}-${mark.x}-${mark.y}`}
            className={styles.mark}
            style={{
              left: `${mark.x * 100}%`,
              top: `${mark.y * 100}%`,
              width: `${mark.width * 100}%`,
              height: `${mark.height * 100}%`
            }}
          >
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
    </div>
  );
}

import { translate } from '../../../core/i18n';
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
import { displayFrame, displayPointToNormalizedPage } from '../../../core/rotation';

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

/** Default size for a mark created with the keyboard, centred on the page. */
const DEFAULT_MARK = { width: 0.3, height: 0.08 };
const NUDGE = 0.005;
const NUDGE_COARSE = 0.03;
const clamp = (min: number, max: number, value: number) => Math.max(min, Math.min(max, value));

export function RedactOverlay({ pageIndex, width, height, rotation }: RedactOverlayProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const pendingFocusIndex = useRef<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const marks = pendingRedactions.value;
  const frame = displayFrame(width, height, rotation);

  const updateMark = (
    index: number,
    next: { x: number; y: number; width: number; height: number }
  ) => {
    pendingRedactions.value = marks.map((m, i) => (i === index ? { ...m, ...next } : m));
  };

  /**
   * Creating a region by drag is inherently pointer-only. `Enter`/`Space` on the
   * (otherwise empty) layer adds one at a default size and position instead —
   * the same "keyboard equivalent of a drag" convention `SignPanel`'s stamp
   * placement uses — so a keyboard-only user can redact something that isn't
   * findable by the text search (a photo, a signature, a hand-drawn mark).
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
      tabIndex={0}
      role="group"
      aria-label={translate(
        'Redaction drawing area. Drag to mark a region, or press Enter to add one at a default size and position, then use arrow keys to move it and Control plus arrows to resize it.'
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
            className={styles.mark}
            style={{
              left: `${mark.x * 100}%`,
              top: `${mark.y * 100}%`,
              width: `${mark.width * 100}%`,
              height: `${mark.height * 100}%`
            }}
            tabIndex={0}
            role="group"
            aria-label={`Redaction region ${index + 1} on page ${pageIndex + 1}. Arrow keys move it, Control plus arrows resize it, Delete removes it.`}
            onKeyDown={event => onMarkKeyDown(event, index, mark)}
            ref={el => {
              if (pendingFocusIndex.current === index) {
                el?.focus();
                pendingFocusIndex.current = null;
              }
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

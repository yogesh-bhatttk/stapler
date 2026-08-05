import { useRef, useState } from 'preact/hooks';
import type { PageRef } from '../../../core/store';
import { activeDoc, activePageIndex } from '../../../core/store';
import { commit, beginTransaction } from '../../../core/history';
import { cropBoxes, cropSettings, pagesForScope, type CropBox } from './state';
import styles from './CropOverlay.module.css';

export interface CropOverlayProps {
  page: PageRef;
  width: number;
  height: number;
}

interface Draft {
  x: number;
  y: number;
  toX: number;
  toY: number;
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const MIN_SIZE = 0.05;
const NUDGE = 0.005;
const NUDGE_COARSE = 0.03;

const clamp = (min: number, max: number, value: number) => Math.max(min, Math.min(max, value));

export function resizeBox(box: CropBox, handle: Handle, dx: number, dy: number): CropBox {
  let { x, y, width, height } = box;
  if (handle.includes('w')) {
    const newX = clamp(0, x + width - MIN_SIZE, x + dx);
    width += x - newX;
    x = newX;
  }
  if (handle.includes('e')) {
    width = clamp(MIN_SIZE, 1 - x, width + dx);
  }
  if (handle.includes('n')) {
    const newY = clamp(0, y + height - MIN_SIZE, y + dy);
    height += y - newY;
    y = newY;
  }
  if (handle.includes('s')) {
    height = clamp(MIN_SIZE, 1 - y, height + dy);
  }
  return { x, y, width, height };
}

const HANDLE_CURSOR: Record<Handle, string> = {
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  e: 'ew-resize',
  se: 'nwse-resize',
  s: 'ns-resize',
  sw: 'nesw-resize',
  w: 'ew-resize'
};

/** Resolves the page keys a crop-box edit should land on, given the current scope. */
function scopeTargets(pageKey: string): string[] {
  const doc = activeDoc.value;
  const scope = cropSettings.value.scope;
  if (!doc || scope === 'current') return [pageKey];
  const keys = new Set(pagesForScope(doc.pages, scope, activePageIndex.value).map(p => p.key));
  keys.add(pageKey);
  return [...keys];
}

/** Applies (or clears) a box across every page the current scope targets. */
function applyBox(pageKey: string, box: CropBox | null) {
  commit();
  const next = { ...cropBoxes.value };
  for (const key of scopeTargets(pageKey)) {
    if (box) next[key] = box;
    else delete next[key];
  }
  cropBoxes.value = next;
}

export function CropOverlay({ page, width, height }: CropOverlayProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dragging, setDragging] = useState(false);

  const box = cropBoxes.value[page.key];

  const pointFrom = (event: PointerEvent) => {
    const rect = layerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
    };
  };

  const getRect = (d: Draft) => ({
    x: Math.min(d.x, d.toX),
    y: Math.min(d.y, d.toY),
    width: Math.abs(d.toX - d.x),
    height: Math.abs(d.toY - d.y)
  });

  const activeBox = draft ? getRect(draft) : box;

  /** Shared pointer-drag helper for both moving and resizing an existing box. */
  const startBoxDrag = (
    event: PointerEvent,
    apply: (base: CropBox, dx: number, dy: number) => CropBox
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = layerRef.current?.getBoundingClientRect();
    if (!rect || !box) return;
    const base = box;
    const startX = event.clientX;
    const startY = event.clientY;
    setDragging(true);
    const tx = beginTransaction(`crop-${page.key}`);

    const move = (moveEvent: PointerEvent) => {
      const dx = (moveEvent.clientX - startX) / rect.width;
      const dy = (moveEvent.clientY - startY) / rect.height;
      applyBox(page.key, apply(base, dx, dy));
    };
    const end = () => {
      setDragging(false);
      tx.end();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!box) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      applyBox(page.key, null);
      return;
    }
    if (!/^Arrow/.test(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? NUDGE_COARSE : NUDGE;
    if (event.ctrlKey || event.metaKey) {
      let { width: w, height: h } = box;
      if (event.key === 'ArrowLeft') w -= step;
      if (event.key === 'ArrowRight') w += step;
      if (event.key === 'ArrowUp') h -= step;
      if (event.key === 'ArrowDown') h += step;
      applyBox(page.key, {
        ...box,
        width: clamp(MIN_SIZE, 1 - box.x, w),
        height: clamp(MIN_SIZE, 1 - box.y, h)
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
    applyBox(page.key, {
      ...box,
      x: clamp(0, 1 - box.width, box.x + dx),
      y: clamp(0, 1 - box.height, box.y + dy)
    });
  };

  return (
    <div
      ref={layerRef}
      className={styles.layer}
      style={{ width: `${width}px`, height: `${height}px` }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        if (event.target !== layerRef.current) return;
        const point = pointFrom(event);
        setDraft({ x: point.x, y: point.y, toX: point.x, toY: point.y });
        layerRef.current?.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        if (!draft) return;
        const point = pointFrom(event);
        setDraft({ ...draft, toX: point.x, toY: point.y });
      }}
      onPointerUp={() => {
        if (!draft) return;
        const rect = getRect(draft);
        setDraft(null);
        if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) {
          applyBox(page.key, null);
          return;
        }
        applyBox(page.key, rect);
      }}
      onPointerCancel={() => setDraft(null)}
    >
      {activeBox && (
        <>
          <div
            className={styles.dim}
            style={{ left: 0, top: 0, width: '100%', height: `${activeBox.y * 100}%` }}
          />
          <div
            className={styles.dim}
            style={{
              left: 0,
              top: `${(activeBox.y + activeBox.height) * 100}%`,
              width: '100%',
              bottom: 0
            }}
          />
          <div
            className={styles.dim}
            style={{
              left: 0,
              top: `${activeBox.y * 100}%`,
              width: `${activeBox.x * 100}%`,
              height: `${activeBox.height * 100}%`
            }}
          />
          <div
            className={styles.dim}
            style={{
              left: `${(activeBox.x + activeBox.width) * 100}%`,
              top: `${activeBox.y * 100}%`,
              right: 0,
              height: `${activeBox.height * 100}%`
            }}
          />
          <div
            className={`${styles.box} ${dragging ? styles.dragging : ''}`}
            style={{
              left: `${activeBox.x * 100}%`,
              top: `${activeBox.y * 100}%`,
              width: `${activeBox.width * 100}%`,
              height: `${activeBox.height * 100}%`
            }}
            tabIndex={box && !draft ? 0 : -1}
            role={box ? 'group' : undefined}
            aria-label={
              box
                ? 'Crop box. Arrow keys move it; Control plus arrows resizes; Delete resets it.'
                : undefined
            }
            onKeyDown={onKeyDown}
            onPointerDown={event => {
              if (!box || draft) return;
              startBoxDrag(event, (base, dx, dy) => ({
                ...base,
                x: clamp(0, 1 - base.width, base.x + dx),
                y: clamp(0, 1 - base.height, base.y + dy)
              }));
            }}
          >
            {box &&
              !draft &&
              HANDLES.map(handle => (
                <span
                  key={handle}
                  className={`${styles.handle} ${styles[`handle-${handle}`]}`}
                  role="presentation"
                  style={{ cursor: HANDLE_CURSOR[handle] }}
                  onPointerDown={event =>
                    startBoxDrag(event, (base, dx, dy) => resizeBox(base, handle, dx, dy))
                  }
                />
              ))}
          </div>
        </>
      )}
    </div>
  );
}

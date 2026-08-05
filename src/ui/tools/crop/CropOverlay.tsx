import { useRef, useState } from 'preact/hooks';
import type { PageRef } from '../../../core/store';
import { cropBoxes } from './state';
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

const MIN_SIZE = 0.05;

export function CropOverlay({ page, width, height }: CropOverlayProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

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

  return (
    <div
      ref={layerRef}
      className={styles.layer}
      style={{ width: `${width}px`, height: `${height}px` }}
      onPointerDown={event => {
        if (event.button !== 0) return;
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
          // If they just clicked, clear the crop box
          const next = { ...cropBoxes.value };
          delete next[page.key];
          cropBoxes.value = next;
          return;
        }
        cropBoxes.value = { ...cropBoxes.value, [page.key]: rect };
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
            className={styles.box}
            style={{
              left: `${activeBox.x * 100}%`,
              top: `${activeBox.y * 100}%`,
              width: `${activeBox.width * 100}%`,
              height: `${activeBox.height * 100}%`
            }}
          />
        </>
      )}
    </div>
  );
}

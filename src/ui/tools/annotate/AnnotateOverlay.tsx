import { translate } from '../../../core/i18n';
import { useEffect, useRef, useState } from 'preact/hooks';
import { commit } from '../../../core/history';
import { ANNOTATION_COLORS, DOC_SIGNATURE_STROKE } from '../../../core/doc-colors';
import {
  Annotation,
  activeAnnotationTool,
  annotationColor,
  annotationStrokeWidth,
  pageAnnotations,
  addAnnotation,
  updateAnnotation,
  removeAnnotation
} from './state';

// A whiteout always covers with white — that is what the tool name promises —
// regardless of whatever ink colour is currently selected for the drawing tools.
const WHITEOUT_COLOR = ANNOTATION_COLORS[5];

export interface AnnotateOverlayProps {
  pageKey: string;
  width: number;
  height: number;
}

/** Default size for a shape created with the keyboard, centred on the page. */
const DEFAULT_RECT = { width: 0.3, height: 0.08 };
/** Default straight segment for freehand/highlight created with the keyboard. */
const DEFAULT_LINE_LENGTH = 0.3;
const NUDGE = 0.01;
const NUDGE_COARSE = 0.05;
const clamp = (min: number, max: number, value: number) => Math.max(min, Math.min(max, value));
/** Default size for a sticky note created with pointer or keyboard. */
const DEFAULT_STICKY = { width: 0.16, height: 0.12 };

/** Wraps `text` at `maxWidth`, drawing each line `lineHeight` apart. */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number
) {
  const words = text.split(/\s+/);
  let line = '';
  let cursorY = y;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, cursorY);
      line = word;
      cursorY += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, cursorY);
}

export function AnnotateOverlay({ pageKey, width, height }: AnnotateOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [isDrawing, setIsDrawing] = useState(false);
  const [currentAnnotation, setCurrentAnnotation] = useState<Partial<Annotation> | null>(null);
  // The annotation most recently created or touched by the keyboard path —
  // arrow keys move it and Delete removes it, mirroring RedactOverlay's
  // "Enter adds, arrows move, Delete removes" convention for the one thing a
  // canvas-based tool cannot offer a pointer alternative for: keyboard-only
  // creation and editing of a mark a mouse would otherwise drag.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const annotations = pageAnnotations.value[pageKey] || [];
  const selected = annotations.find(a => a.id === selectedId) ?? null;

  const redraw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw committed annotations
    const drawList = [...annotations];
    if (currentAnnotation) drawList.push(currentAnnotation as Annotation);

    drawList.forEach(ann => {
      ctx.beginPath();
      ctx.strokeStyle = ann.color;
      ctx.fillStyle = ann.color;
      // `strokeWidth` is stored as a fraction of page width (like x/y), not a
      // pixel count, so a stroke drawn at one zoom level reproduces at the
      // same *relative* thickness at any other — and matches the PDF export,
      // which scales it by the real page width in `drawAnnotations`.
      ctx.lineWidth = ann.strokeWidth * width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (ann.type === 'highlight') {
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = 0.5;
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1.0;
      }

      if (
        (ann.type === 'freehand' || ann.type === 'highlight') &&
        ann.points &&
        ann.points.length > 0
      ) {
        ctx.moveTo(ann.points[0].x * width, ann.points[0].y * height);
        for (let i = 1; i < ann.points.length; i++) {
          ctx.lineTo(ann.points[i].x * width, ann.points[i].y * height);
        }
        ctx.stroke();
      } else if (ann.type === 'rectangle' && ann.rect) {
        ctx.strokeRect(
          ann.rect.x * width,
          ann.rect.y * height,
          ann.rect.width * width,
          ann.rect.height * height
        );
      } else if (ann.type === 'ellipse' && ann.rect) {
        ctx.beginPath();
        ctx.ellipse(
          ann.rect.x * width + (ann.rect.width * width) / 2,
          ann.rect.y * height + (ann.rect.height * height) / 2,
          Math.abs(ann.rect.width * width) / 2,
          Math.abs(ann.rect.height * height) / 2,
          0,
          0,
          2 * Math.PI
        );
        ctx.stroke();
      } else if (ann.type === 'arrow' && ann.points && ann.points.length >= 2) {
        const start = ann.points[0];
        const end = ann.points[ann.points.length - 1];
        const x1 = start.x * width;
        const y1 = start.y * height;
        const x2 = end.x * width;
        const y2 = end.y * height;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        const angle = Math.atan2(y2 - y1, x2 - x1);
        const headlen = 10 + ctx.lineWidth;
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(
          x2 - headlen * Math.cos(angle - Math.PI / 6),
          y2 - headlen * Math.sin(angle - Math.PI / 6)
        );
        ctx.moveTo(x2, y2);
        ctx.lineTo(
          x2 - headlen * Math.cos(angle + Math.PI / 6),
          y2 - headlen * Math.sin(angle + Math.PI / 6)
        );
        ctx.stroke();
      } else if (ann.type === 'text' && ann.text && ann.rect) {
        ctx.font = `${ann.fontSize || 16}px sans-serif`;
        ctx.fillText(ann.text, ann.rect.x * width, ann.rect.y * height + (ann.fontSize || 16));
      } else if (ann.type === 'whiteout' && ann.rect) {
        // A solid cover, not a redaction: this hides content visually on the
        // page without touching the underlying document structure. RED-02 is
        // the tool for actual content removal.
        ctx.globalAlpha = 1.0;
        ctx.fillRect(
          ann.rect.x * width,
          ann.rect.y * height,
          ann.rect.width * width,
          ann.rect.height * height
        );
      } else if (ann.type === 'sticky' && ann.rect) {
        ctx.globalAlpha = 1.0;
        ctx.fillRect(
          ann.rect.x * width,
          ann.rect.y * height,
          ann.rect.width * width,
          ann.rect.height * height
        );
        ctx.globalAlpha = 0.3;
        ctx.strokeStyle = DOC_SIGNATURE_STROKE;
        ctx.lineWidth = 1;
        ctx.strokeRect(
          ann.rect.x * width,
          ann.rect.y * height,
          ann.rect.width * width,
          ann.rect.height * height
        );
        ctx.globalAlpha = 1.0;
        if (ann.text) {
          ctx.fillStyle = DOC_SIGNATURE_STROKE;
          ctx.font = `${ann.fontSize || 12}px sans-serif`;
          wrapText(
            ctx,
            ann.text,
            ann.rect.x * width + 6,
            ann.rect.y * height + (ann.fontSize || 12) + 4,
            ann.rect.width * width - 12,
            (ann.fontSize || 12) * 1.2
          );
        }
      }
    });
  };

  useEffect(() => {
    redraw();
  }, [annotations, currentAnnotation, width, height]);

  const handlePointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Normalise to unscaled coordinates (0..1 across the canvas)
    // We can just use the provided width/height to get relative coordinates, or store absolute scaled coordinates
    // Let's store absolute coordinates relative to the unscaled page size.
    // However, if we don't have the original page size handy, we can store normalized coordinates (0..1)
    // and scale them up on render.

    // Instead of querying `sources` which is complex, we will just use `width` as the current scale,
    // meaning the points will be in logical CSS pixels at the current zoom level.
    // Wait, if zoom changes, the points won't scale.
    // Let's use normalized coordinates (0 to 1).
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / width;
    const y = (e.clientY - rect.top) / height;

    // Check if clicked on an existing annotation (reverse order for z-index)
    // A click on an existing annotation selects it instead of drawing a new one.
    for (let i = annotations.length - 1; i >= 0; i--) {
      const ann = annotations[i];
      let hit = false;
      const pad = 0.02; // generous hit area
      if (ann.rect) {
        const rx = Math.min(ann.rect.x, ann.rect.x + ann.rect.width);
        const ry = Math.min(ann.rect.y, ann.rect.y + ann.rect.height);
        const rw = Math.abs(ann.rect.width);
        const rh = Math.abs(ann.rect.height);
        if (x >= rx - pad && x <= rx + rw + pad && y >= ry - pad && y <= ry + rh + pad) {
          hit = true;
        }
      } else if (ann.points && ann.points.length > 0) {
        let minX = 1,
          minY = 1,
          maxX = 0,
          maxY = 0;
        for (const p of ann.points) {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
        if (x >= minX - pad && x <= maxX + pad && y >= minY - pad && y <= maxY + pad) {
          hit = true;
        }
      }
      if (hit) {
        setSelectedId(ann.id);
        return; // Stop here, do not start drawing
      }
    }

    // Clicked empty space: deselect any existing, and start drawing
    setSelectedId(null);
    setIsDrawing(true);
    const type = activeAnnotationTool.value;
    // Normalised to a fraction of page width, exactly like x/y above, so the
    // stroke keeps the same relative thickness regardless of zoom and matches
    // what `drawAnnotations` (process.worker.ts) draws into the exported PDF.
    const strokeWidth = annotationStrokeWidth.value / width;

    if (type === 'text') {
      const text = window.prompt('Enter note text:');
      if (text) {
        commit();
        addAnnotation(pageKey, {
          id: crypto.randomUUID(),
          type: 'text',
          color: annotationColor.value,
          strokeWidth,
          rect: { x, y, width: 100, height: 20 },
          text,
          fontSize: 16
        });
      }
      setIsDrawing(false);
      return;
    }

    if (type === 'sticky') {
      const text = window.prompt('Enter note text:');
      if (text) {
        commit();
        addAnnotation(pageKey, {
          id: crypto.randomUUID(),
          type: 'sticky',
          color: annotationColor.value,
          strokeWidth,
          rect: { x, y, width: DEFAULT_STICKY.width, height: DEFAULT_STICKY.height },
          text,
          fontSize: 12
        });
      }
      setIsDrawing(false);
      return;
    }

    setCurrentAnnotation({
      id: crypto.randomUUID(),
      type,
      color: type === 'whiteout' ? WHITEOUT_COLOR : annotationColor.value,
      strokeWidth,
      points:
        type === 'freehand' || type === 'highlight' || type === 'arrow' ? [{ x, y }] : undefined,
      rect:
        type === 'rectangle' || type === 'whiteout' || type === 'ellipse'
          ? { x, y, width: 0, height: 0 }
          : undefined
    });

    // e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: PointerEvent) => {
    if (!isDrawing || !currentAnnotation) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / width;
    const y = (e.clientY - rect.top) / height;

    setCurrentAnnotation(prev => {
      if (!prev) return prev;
      if ((prev.type === 'freehand' || prev.type === 'highlight') && prev.points) {
        return { ...prev, points: [...prev.points, { x, y }] };
      } else if (prev.type === 'arrow' && prev.points) {
        return { ...prev, points: [prev.points[0], { x, y }] };
      } else if (
        (prev.type === 'rectangle' || prev.type === 'whiteout' || prev.type === 'ellipse') &&
        prev.rect
      ) {
        return {
          ...prev,
          rect: {
            x: prev.rect.x,
            y: prev.rect.y,
            width: x - prev.rect.x,
            height: y - prev.rect.y
          }
        };
      }
      return prev;
    });
  };

  const handlePointerUp = () => {
    if (isDrawing && currentAnnotation) {
      commit();
      addAnnotation(pageKey, currentAnnotation as Annotation);
      setSelectedId(currentAnnotation.id ?? null);
    }
    setIsDrawing(false);
    setCurrentAnnotation(null);
  };

  /**
   * Drawing by drag (freehand strokes especially) is inherently pointer-only.
   * Enter/Space adds one annotation of the active tool at a default size and
   * position instead, selected for the arrow-key/Delete handling below — the
   * same "keyboard equivalent of a drag" convention RedactOverlay uses.
   */
  const addAnnotationViaKeyboard = () => {
    const type = activeAnnotationTool.value;
    const strokeWidth = annotationStrokeWidth.value / width;
    const color = annotationColor.value;

    if (type === 'text') {
      const text = window.prompt('Enter note text:');
      if (!text) return;
      const ann: Annotation = {
        id: crypto.randomUUID(),
        type: 'text',
        color,
        strokeWidth,
        rect: {
          x: (1 - DEFAULT_RECT.width) / 2,
          y: (1 - DEFAULT_RECT.height) / 2,
          width: 100,
          height: 20
        },
        text,
        fontSize: 16
      };
      commit();
      addAnnotation(pageKey, ann);
      setSelectedId(ann.id);
      return;
    }

    if (type === 'sticky') {
      const text = window.prompt('Enter note text:');
      if (!text) return;
      const ann: Annotation = {
        id: crypto.randomUUID(),
        type: 'sticky',
        color,
        strokeWidth,
        rect: {
          x: (1 - DEFAULT_STICKY.width) / 2,
          y: (1 - DEFAULT_STICKY.height) / 2,
          width: DEFAULT_STICKY.width,
          height: DEFAULT_STICKY.height
        },
        text,
        fontSize: 12
      };
      commit();
      addAnnotation(pageKey, ann);
      setSelectedId(ann.id);
      return;
    }

    const cx = 0.5;
    const cy = 0.5;
    const ann: Annotation =
      type === 'rectangle' || type === 'whiteout' || type === 'ellipse'
        ? {
            id: crypto.randomUUID(),
            type,
            color: type === 'whiteout' ? WHITEOUT_COLOR : color,
            strokeWidth,
            rect: {
              x: (1 - DEFAULT_RECT.width) / 2,
              y: (1 - DEFAULT_RECT.height) / 2,
              width: DEFAULT_RECT.width,
              height: DEFAULT_RECT.height
            }
          }
        : {
            id: crypto.randomUUID(),
            type,
            color,
            strokeWidth,
            points: [
              { x: cx - DEFAULT_LINE_LENGTH / 2, y: cy },
              { x: cx + DEFAULT_LINE_LENGTH / 2, y: cy }
            ]
          };
    commit();
    addAnnotation(pageKey, ann);
    setSelectedId(ann.id);
  };

  const handleOverlayKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      addAnnotationViaKeyboard();
      return;
    }
    if (!selected) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      commit();
      removeAnnotation(pageKey, selected.id);
      setSelectedId(null);
      return;
    }
    if (!/^Arrow/.test(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? NUDGE_COARSE : NUDGE;
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step]
    };
    const [dx, dy] = deltas[event.key];
    const resizable =
      selected.type === 'rectangle' || selected.type === 'whiteout' || selected.type === 'ellipse';

    if ((event.ctrlKey || event.metaKey) && resizable && selected.rect) {
      commit();
      updateAnnotation(pageKey, selected.id, {
        rect: {
          x: selected.rect.x,
          y: selected.rect.y,
          width: clamp(0.01, 1 - selected.rect.x, selected.rect.width + dx),
          height: clamp(0.01, 1 - selected.rect.y, selected.rect.height + dy)
        }
      });
      return;
    }

    if (selected.rect) {
      commit();
      updateAnnotation(pageKey, selected.id, {
        rect: {
          ...selected.rect,
          x: clamp(0, 1 - selected.rect.width, selected.rect.x + dx),
          y: clamp(0, 1 - selected.rect.height, selected.rect.y + dy)
        }
      });
    } else if (selected.points) {
      commit();
      updateAnnotation(pageKey, selected.id, {
        points: selected.points.map(p => ({
          x: clamp(0, 1, p.x + dx),
          y: clamp(0, 1, p.y + dy)
        }))
      });
    }
  };

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      tabIndex={0}
      role="group"
      aria-label={translate(
        'Annotation drawing area. Draw with the pointer, or press Enter to add a shape at a default size and position, then use arrow keys to move it, Control plus arrows to resize a rectangle, and Delete to remove it.'
      )}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        touchAction: 'none',
        cursor: 'crosshair'
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onKeyDown={handleOverlayKeyDown}
    />
  );
}

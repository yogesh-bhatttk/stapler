import { useEffect, useRef, useState } from 'preact/hooks';
import {
  Annotation,
  activeAnnotationTool,
  annotationColor,
  annotationStrokeWidth,
  pageAnnotations,
  addAnnotation
} from './state';

export interface AnnotateOverlayProps {
  pageKey: string;
  width: number;
  height: number;
}

export function AnnotateOverlay({ pageKey, width, height }: AnnotateOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [isDrawing, setIsDrawing] = useState(false);
  const [currentAnnotation, setCurrentAnnotation] = useState<Partial<Annotation> | null>(null);

  const annotations = pageAnnotations.value[pageKey] || [];

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
      ctx.lineWidth = ann.strokeWidth;
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
      } else if (ann.type === 'text' && ann.text && ann.rect) {
        ctx.font = `${ann.fontSize || 16}px sans-serif`;
        ctx.fillText(ann.text, ann.rect.x * width, ann.rect.y * height + (ann.fontSize || 16));
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

    setIsDrawing(true);
    const type = activeAnnotationTool.value;

    if (type === 'text') {
      const text = window.prompt('Enter note text:');
      if (text) {
        addAnnotation(pageKey, {
          id: crypto.randomUUID(),
          type: 'text',
          color: annotationColor.value,
          strokeWidth: annotationStrokeWidth.value,
          rect: { x, y, width: 100, height: 20 },
          text,
          fontSize: 16
        });
      }
      setIsDrawing(false);
      return;
    }

    setCurrentAnnotation({
      id: crypto.randomUUID(),
      type,
      color: annotationColor.value,
      strokeWidth: annotationStrokeWidth.value,
      points: type === 'freehand' || type === 'highlight' ? [{ x, y }] : undefined,
      rect: type === 'rectangle' ? { x, y, width: 0, height: 0 } : undefined
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
      } else if (prev.type === 'rectangle' && prev.rect) {
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
      addAnnotation(pageKey, currentAnnotation as Annotation);
    }
    setIsDrawing(false);
    setCurrentAnnotation(null);
  };

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
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
    />
  );
}

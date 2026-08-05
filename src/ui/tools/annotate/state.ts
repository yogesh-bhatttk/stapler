import { signal } from '@preact/signals';

export type AnnotationType = 'freehand' | 'highlight' | 'rectangle' | 'text';

export interface Point {
  x: number;
  y: number;
}

export interface Annotation {
  id: string;
  type: AnnotationType;
  color: string;
  strokeWidth: number;
  // For freehand & highlight:
  points?: Point[];
  // For rectangle & text:
  rect?: { x: number; y: number; width: number; height: number };
  // For text:
  text?: string;
  fontSize?: number;
}

export const activeAnnotationTool = signal<AnnotationType>('freehand');
export const annotationColor = signal<string>('#' + 'FFEB3B'); // Default yellow for highlight
export const annotationStrokeWidth = signal<number>(4);

// Map of pageKey (e.g. "docId-pageIndex") to array of Annotations
export const pageAnnotations = signal<Record<string, Annotation[]>>({});

export function addAnnotation(pageKey: string, annotation: Annotation) {
  const current = pageAnnotations.value[pageKey] || [];
  pageAnnotations.value = {
    ...pageAnnotations.value,
    [pageKey]: [...current, annotation]
  };
}

export function clearAnnotations(pageKey: string) {
  const updated = { ...pageAnnotations.value };
  delete updated[pageKey];
  pageAnnotations.value = updated;
}

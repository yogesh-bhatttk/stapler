import { signal } from '@preact/signals';
import { ANNOTATION_COLORS } from '../../../core/doc-colors';

export type AnnotationType =
  'freehand' | 'highlight' | 'rectangle' | 'text' | 'sticky' | 'whiteout';

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
  // For rectangle, text, sticky & whiteout:
  rect?: { x: number; y: number; width: number; height: number };
  // For text & sticky:
  text?: string;
  fontSize?: number;
  author?: string;
  date?: string;
  pageKey?: string;
}

export const activeAnnotationTool = signal<AnnotationType>('freehand');
export const annotationColor = signal<string>(ANNOTATION_COLORS[0]); // Default yellow for highlight
export const annotationStrokeWidth = signal<number>(4);

// Map of pageKey (e.g. "docId-pageIndex") to array of Annotations. Included in
// `core/history.ts`'s undo snapshot, exactly like `cropBoxes`. `core/history.ts`
// imports this module for that snapshot, so these mutators cannot import
// `commit` back from there without a cycle — callers (`AnnotateOverlay.tsx`)
// call `commit()`/`beginTransaction()` themselves, exactly as `CropOverlay.tsx`
// does around `cropBoxes` mutations.
export const pageAnnotations = signal<Record<string, Annotation[]>>({});

export function addAnnotation(pageKey: string, annotation: Annotation) {
  const current = pageAnnotations.value[pageKey] || [];
  pageAnnotations.value = {
    ...pageAnnotations.value,
    [pageKey]: [...current, annotation]
  };
}

/**
 * ANN-03 — adds many annotations across many pages as one change.
 *
 * One signal write, so a search that highlights 40 matches is a single undo entry
 * (the caller calls `commit()` once before it, exactly as the single-annotation
 * path does) rather than 40 the user has to press ⌘Z through.
 */
export function addAnnotations(entries: readonly { pageKey: string; annotation: Annotation }[]) {
  if (entries.length === 0) return;
  const next = { ...pageAnnotations.value };
  for (const { pageKey, annotation } of entries) {
    next[pageKey] = [...(next[pageKey] ?? []), annotation];
  }
  pageAnnotations.value = next;
}

export function clearAnnotations(pageKey: string) {
  const updated = { ...pageAnnotations.value };
  delete updated[pageKey];
  pageAnnotations.value = updated;
}

export function updateAnnotation(pageKey: string, id: string, patch: Partial<Annotation>) {
  const current = pageAnnotations.value[pageKey] || [];
  pageAnnotations.value = {
    ...pageAnnotations.value,
    [pageKey]: current.map(a => (a.id === id ? { ...a, ...patch } : a))
  };
}

export function removeAnnotation(pageKey: string, id: string) {
  const current = pageAnnotations.value[pageKey] || [];
  pageAnnotations.value = {
    ...pageAnnotations.value,
    [pageKey]: current.filter(a => a.id !== id)
  };
}

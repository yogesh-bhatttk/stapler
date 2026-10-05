/**
 * ANN-04 — what the annotation summary says about each note, shared by the
 * plain-text export (main thread, `annotation-summary.ts`) and the PDF build
 * (process worker, `workers/annotation-summary-pdf.ts`). Pure: no pdf-lib, no
 * worker pool, so both sides can import it without pulling in the other.
 */
export interface SummaryAnnotation {
  id?: string;
  type?: string;
  color?: string;
  strokeWidth?: number;
  points?: { x: number; y: number }[];
  rect?: { x: number; y: number; width: number; height: number };
  x?: number;
  y?: number;
  text?: string;
  data?: string;
  author?: string;
  date?: string;
  pageKey?: string;
  pageIndex?: number;
}

export function getTypeLabel(type?: string): string {
  switch (type) {
    case 'sticky':
      return 'Sticky Note';
    case 'text':
      return 'Text Comment';
    case 'highlight':
      return 'Highlight';
    case 'rectangle':
      return 'Rectangle';
    case 'freehand':
      return 'Freehand Ink';
    case 'whiteout':
      return 'Whiteout';
    case 'signature':
      return 'Signature Stamp';
    case 'date':
      return 'Date Stamp';
    case 'check':
      return 'Checkmark';
    default:
      return type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Note';
  }
}

export function getPageNumber(ann: SummaryAnnotation, docPages?: { key: string }[]): number | null {
  if (ann.pageIndex !== undefined) {
    return ann.pageIndex + 1;
  }
  if (ann.pageKey && docPages) {
    const idx = docPages.findIndex(p => p.key === ann.pageKey);
    if (idx >= 0) return idx + 1;
  }
  return null;
}

export function sortPageNumber(ann: SummaryAnnotation, docPages?: { key: string }[]): number {
  return getPageNumber(ann, docPages) ?? Number.POSITIVE_INFINITY;
}

export function formatPageNumber(ann: SummaryAnnotation, docPages?: { key: string }[]): string {
  const pageNum = getPageNumber(ann, docPages);
  return pageNum === null ? 'Detached' : String(pageNum);
}

export function getPositionString(ann: SummaryAnnotation): string {
  if (ann.rect) {
    const xPct = Math.round(ann.rect.x * 100);
    const yPct = Math.round(ann.rect.y * 100);
    return `X: ${xPct}%, Y: ${yPct}%`;
  }
  if (ann.x !== undefined && ann.y !== undefined) {
    const xPct = Math.round(ann.x * 100);
    const yPct = Math.round(ann.y * 100);
    return `X: ${xPct}%, Y: ${yPct}%`;
  }
  if (ann.points && ann.points.length > 0) {
    const xPct = Math.round(ann.points[0].x * 100);
    const yPct = Math.round(ann.points[0].y * 100);
    return `X: ${xPct}%, Y: ${yPct}%`;
  }
  return 'N/A';
}

/** Page order, then top-to-bottom within a page; detached notes last. */
export function sortAnnotations(
  annotations: SummaryAnnotation[],
  pages: { key: string }[]
): SummaryAnnotation[] {
  return [...annotations].sort((a, b) => {
    const pA = sortPageNumber(a, pages);
    const pB = sortPageNumber(b, pages);
    if (pA !== pB) return pA - pB;
    const yA = a.rect?.y ?? a.y ?? a.points?.[0]?.y ?? 0;
    const yB = b.rect?.y ?? b.y ?? b.points?.[0]?.y ?? 0;
    return yA - yB;
  });
}

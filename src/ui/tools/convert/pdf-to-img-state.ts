/**
 * GAP-5 — what the last sized PDF → images export actually produced, per page.
 *
 * Set by the commit path, measured on the bytes that went into the ZIP, and
 * shown by the panel so a page that missed its target is named rather than
 * hidden inside an archive. Describes one revision of one document, so it is
 * cleared when either changes.
 */
import { signal } from '@preact/signals';
import type { SizedPageImage } from '../../../core/operations';
import { resetOnDocumentChange } from '../docScoped';
import type { SourceDocument, StaplerDoc } from '../../../core/store';
import {
  exactOutputSize,
  isExactSide,
  type ExactDimensions,
  type ImageSize
} from '../../../core/image-target';
import { exactSizeOverLimit } from '../../../core/render-limits';
import type { PdfToImageSettings } from '../state';
import { exactRequest } from '../image-size/state';

export interface PdfToImageReport {
  docId: string;
  targetBytes: number | null;
  pages: SizedPageImage[];
}

export const pdfToImageReport = signal<PdfToImageReport | null>(null);

resetOnDocumentChange(
  () => {
    pdfToImageReport.value = null;
  },
  { onPageEdits: true }
);

/** Longest-side presets offered in the panels, in pixels. */
export const MAX_DIMENSION_PRESETS = [4000, 3000, 2000, 1600, 1200, 1024, 800, 600, 400] as const;

/** `0` stands for "no limit" in the select; the setting stores null. */
export function maxDimensionOptions(
  current: number | null,
  t: (key: string, params?: Record<string, string | number>) => string
): { value: number; label: string }[] {
  const values: number[] = [...MAX_DIMENSION_PRESETS];
  if (current !== null && !values.includes(current)) values.push(current);
  values.sort((a, b) => b - a);
  return [
    { value: 0, label: t('No limit') },
    ...values.map(value => ({ value, label: t('{size} px', { size: value }) }))
  ];
}

/* ------------------------------------------------------------------ *
 * CNV-14 — an exact width × height for PDF → images.
 *
 * Pages can differ in size, so with the aspect locked the side that follows is
 * worked out per page, from that page's own size as it will be exported:
 * `pageSizes` is the `/Rotate`d viewport at scale 1, and a quarter turn made in
 * Stapler swaps the sides — the same viewport the render worker sizes from.
 * ------------------------------------------------------------------ */

/** One exported page: its index in the document and its rotated size in points. */
export interface ExportedPageSize extends ImageSize {
  pageIndex: number;
}

/**
 * The pages a PDF → images export writes (the selection, or every page), each
 * with its size in points as rendered. A page whose source size is not known
 * yet falls back to A4, as the panel's estimate always has.
 */
export function exportedPageSizes(
  doc: StaplerDoc,
  sourceDocs: Record<string, SourceDocument | undefined>,
  selected: ReadonlySet<string>
): ExportedPageSize[] {
  return doc.pages.flatMap((page, pageIndex) => {
    if (selected.size > 0 && !selected.has(page.key)) return [];
    const size = sourceDocs[page.sourceDocId]?.pageSizes[page.sourceIndex] ?? {
      width: 595,
      height: 842
    };
    const quarterTurn = page.rotation % 180 !== 0;
    return [
      {
        pageIndex,
        width: quarterTurn ? size.height : size.width,
        height: quarterTurn ? size.width : size.height
      }
    ];
  });
}

/**
 * The exact sides a PDF → images setting sends, or null when exact size is
 * off. Only valid sides are sent; `exactSizeProblem` is what refuses a run
 * with an invalid one, so this never quietly drops a side that is on screen.
 */
export function pdfExactRequest(settings: PdfToImageSettings): ExactDimensions | null {
  if (!settings.exact?.on) return null;
  const sent = exactRequest(settings.exact);
  const width = isExactSide(sent.width) ? sent.width : null;
  const height = isExactSide(sent.height) ? sent.height : null;
  return width === null && height === null ? null : { width, height };
}

/** Each exported page's output size for `dims`, in pixels. */
export function exactPageOutputs(
  pages: ExportedPageSize[],
  dims: ExactDimensions
): (ImageSize & { pageIndex: number })[] {
  return pages.flatMap(page => {
    const size = exactOutputSize(page, dims);
    return size ? [{ pageIndex: page.pageIndex, ...size }] : [];
  });
}

/** Whether `sizes` are not all the same pixel size. */
export function exactSizesVary(sizes: ImageSize[]): boolean {
  return sizes.some(size => size.width !== sizes[0].width || size.height !== sizes[0].height);
}

/** The first page whose exact output is past what a render may allocate ({@link exactSizeOverLimit}). */
export function exactSizeOverCap(
  sizes: (ImageSize & { pageIndex: number })[]
): (ImageSize & { pageIndex: number }) | null {
  return sizes.find(exactSizeOverLimit) ?? null;
}

/**
 * The size part of a sized export's ZIP name: `1200x800` unlocked,
 * `1200px-wide` / `800px-high` locked (the other side is each page's own),
 * otherwise `max1600px`; a size target adds `-200kb`.
 */
export function sizedArchiveSuffix(settings: PdfToImageSettings): string {
  const exact = pdfExactRequest(settings);
  const parts: string[] = [];
  if (exact) {
    if (exact.width != null && exact.height != null) parts.push(`${exact.width}x${exact.height}`);
    else if (exact.width != null) parts.push(`${exact.width}px-wide`);
    else parts.push(`${exact.height}px-high`);
  } else if (settings.maxDimension !== null) {
    parts.push(`max${settings.maxDimension}px`);
  }
  if (settings.sizeMode === 'target') parts.push(`${settings.targetKb}kb`);
  return parts.join('-');
}

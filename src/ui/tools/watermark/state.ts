import { signal } from '@preact/signals';
import { DOC_SIGNATURE_STROKE } from '../../../core/doc-colors';

export type WatermarkPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export type WatermarkKind = 'text' | 'image';

/** A user-picked raster, read once into memory. Never persisted. */
export interface WatermarkImage {
  bytes: Uint8Array;
  format: 'png' | 'jpeg';
  /** Natural pixel dimensions, so the placed box keeps the image's aspect ratio. */
  width: number;
  height: number;
  /** Original filename, shown in the panel so the user knows what is loaded. */
  name: string;
}

export interface WatermarkSettings {
  /** `image` draws `image` instead of `text` — the two are mutually exclusive. */
  kind: WatermarkKind;
  text: string;
  image: WatermarkImage | null;
  /** Fraction of the page width the image should occupy (kind: 'image' only). */
  imageScale: number;
  position: WatermarkPosition;
  opacity: number;
  rotation: number;
  fontSize: number;
  color: string;
  /** Number substituted for `{n}` on the first document page. */
  startAt: number;
  /** `all` or a comma-separated list such as `1-3, 6`. */
  pageRange: string;
}

export const watermarkSettings = signal<WatermarkSettings>({
  kind: 'text',
  text: '',
  image: null,
  imageScale: 0.35,
  position: 'center',
  opacity: 0.5,
  rotation: 45,
  fontSize: 72,
  color: DOC_SIGNATURE_STROKE,
  startAt: 1,
  pageRange: 'all'
});

/** True when a watermark is actually configured, not merely "the panel exists". */
export function hasWatermarkContent(settings: WatermarkSettings): boolean {
  return settings.kind === 'image' ? !!settings.image : !!settings.text.trim();
}

/**
 * OPS-11 — Bates numbering, configured alongside the other stamps because it is
 * drawn by the same engine, but kept as its own settings object: a Bates number is
 * not a page number and a document can carry both.
 */
export interface BatesSettings {
  enabled: boolean;
  prefix: string;
  digits: number;
  start: number;
  position: WatermarkPosition;
  fontSize: number;
}

export const batesSettings = signal<BatesSettings>({
  enabled: false,
  prefix: '',
  digits: 6,
  start: 1,
  // Bottom-right is where a production stamp goes, out of the way of body text.
  position: 'bottom-right',
  fontSize: 10
});

export type HeaderFooterAlign = 'left' | 'center' | 'right';

export interface HeaderFooterSettings {
  headerText: string;
  headerAlign: HeaderFooterAlign;
  footerText: string;
  footerAlign: HeaderFooterAlign;
  fontSize: number;
  /** `all` or a comma-separated list such as `1-3, 6` — independent of the watermark's. */
  pageRange: string;
}

export const headerFooterSettings = signal<HeaderFooterSettings>({
  headerText: '',
  headerAlign: 'center',
  footerText: '',
  footerAlign: 'center',
  fontSize: 10,
  pageRange: 'all'
});

/** True when a header or footer is actually configured. */
export function hasHeaderFooterContent(settings: HeaderFooterSettings): boolean {
  return !!settings.headerText.trim() || !!settings.footerText.trim();
}

/** Whether a 1-based `pageRange` string ("all" or "1-3, 6") covers `pageIndex` (0-based). */
export function pageInRange(pageRange: string, pageIndex: number): boolean {
  const value = pageRange.trim().toLowerCase();
  if (!value || value === 'all') return true;
  return value.split(',').some(part => {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) return false;
    const from = Number(match[1]);
    const to = Number(match[2] ?? match[1]);
    const current = pageIndex + 1;
    return current >= Math.min(from, to) && current <= Math.max(from, to);
  });
}

/**
 * Reads a user-picked file into a `WatermarkImage`. PNG and JPEG are embedded
 * directly by pdf-lib, so the bytes are kept as-is — no canvas round-trip, which
 * would recompress a JPEG and silently change its quality.
 *
 * Format is sniffed from the file's magic bytes rather than trusted from
 * `file.type`, which browsers can get wrong or omit for a file picked via a
 * bare `<input type=file>`.
 */
export async function readWatermarkImage(file: File): Promise<WatermarkImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = sniffImageFormat(bytes);
  if (!format) {
    throw new Error('Choose a PNG or JPEG image.');
  }

  const bitmap = await createImageBitmap(new Blob([bytes]));
  try {
    return { bytes, format, width: bitmap.width, height: bitmap.height, name: file.name };
  } finally {
    bitmap.close();
  }
}

function sniffImageFormat(bytes: Uint8Array): 'png' | 'jpeg' | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  return null;
}

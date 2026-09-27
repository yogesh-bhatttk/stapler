/**
 * GAP-5 — "Image to size": one image in, one JPEG out.
 *
 * The panel configures, the action bar commits (siblings, so signals), and the
 * canvas shows the last result. Nothing here belongs to an open document —
 * the tool reads its image from disk — so none of it resets on document change.
 */
import { signal } from '@preact/signals';
import type { SizeParam } from '../../../core/deep-link';
import { sizeParamBytes } from '../../../core/deep-link';

export interface ImageSizeSettings {
  /** The image chosen from disk, or null before one is picked. */
  file: File | null;
  /** Whether to aim for `target`. Off means "only fit the pixel box". */
  useTarget: boolean;
  target: SizeParam;
  /** Longest side limit in pixels, or null for none. */
  maxDimension: number | null;
}

export const imageSizeSettings = signal<ImageSizeSettings>({
  file: null,
  useTarget: true,
  target: { amount: 50, unit: 'KB' },
  maxDimension: null
});

/** What the last run produced; every number is measured on `bytes`. */
export interface ImageSizeResult {
  /** The file it was made from, so a later pick of another file hides it. */
  source: File;
  bytes: Uint8Array;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  /** JPEG quality used, 0..1 — or null when the original was kept as-is. */
  quality: number | null;
  targetBytes: number | null;
  reached: boolean;
  attempts: number;
  sourcePages: number;
  /** True when the original JPEG already met every limit and was kept byte for byte. */
  keptOriginal: boolean;
}

export const imageSizeResult = signal<ImageSizeResult | null>(null);

export function imageSizeRequest(settings: ImageSizeSettings): {
  targetBytes: number | null;
  maxDimension: number | null;
} {
  return {
    targetBytes: settings.useTarget ? sizeParamBytes(settings.target) : null,
    maxDimension: settings.maxDimension
  };
}

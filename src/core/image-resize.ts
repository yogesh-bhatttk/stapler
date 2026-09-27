/**
 * GAP-5 — the encoder behind `image-target.ts`, shared by the image worker
 * (a single photo) and the render worker (PDF pages as images).
 *
 * Runs wherever `OffscreenCanvas` exists: both workers, and Node tests that
 * install a canvas shim. Every output is a JPEG composited on white — the
 * formats portals accept are JPEG first, and a transparent pixel encoded as
 * JPEG would otherwise come out black.
 */
import { DOC_PAGE_WHITE } from './doc-colors';
import { corrupt } from './errors';
import { translate } from './i18n';
import {
  searchImageTargetSize,
  type ImageSize,
  type ImageTargetOutcome,
  type ImageTrial
} from './image-target';

/** Anything `drawImage` accepts from a worker: an ImageBitmap or a canvas. */
export type DrawableSource = ImageBitmap | OffscreenCanvas;

export async function encodeScaledJpeg(
  source: DrawableSource,
  size: ImageSize,
  quality: number
): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw corrupt(translate('A 2D canvas context was unavailable for image conversion.'));
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = DOC_PAGE_WHITE;
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.drawImage(source, 0, 0, size.width, size.height);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Release the backing store now: a search runs up to fourteen of these.
  canvas.width = 0;
  canvas.height = 0;
  return bytes;
}

export interface SizedImageRequest {
  targetBytes: number | null;
  maxDimension: number | null;
}

/** What one sized image came out as — all of it measured on the returned bytes. */
export interface SizedImageResult {
  bytes: Uint8Array;
  width: number;
  height: number;
  quality: number;
  /** Source size before any resizing. */
  sourceWidth: number;
  sourceHeight: number;
  targetBytes: number | null;
  /** True when `bytes.byteLength <= targetBytes`, or when there was no target. */
  reached: boolean;
  attempts: number;
}

export function toSizedResult(
  outcome: ImageTargetOutcome<Uint8Array>,
  source: ImageSize,
  request: SizedImageRequest
): SizedImageResult {
  const { chosen } = outcome;
  return {
    bytes: chosen.output,
    width: chosen.width,
    height: chosen.height,
    quality: chosen.quality,
    sourceWidth: source.width,
    sourceHeight: source.height,
    targetBytes: request.targetBytes,
    // Re-derived from the bytes being returned, not trusted from the search.
    reached: request.targetBytes === null || chosen.output.byteLength <= request.targetBytes,
    attempts: outcome.trials.length
  };
}

/**
 * Runs the measured search over `source` and returns the chosen encode.
 * `onTrial` reports progress (`trial / max`) and is where the caller checks
 * for cancellation between encodes.
 */
export async function resizeToTarget(
  source: DrawableSource,
  request: SizedImageRequest,
  hooks: {
    signal?: AbortSignal;
    onTrial?: (trialIndex: number, maxTrials: number) => Promise<void> | void;
  } = {}
): Promise<SizedImageResult> {
  const size = { width: source.width, height: source.height };
  let pending: Promise<void> | void = undefined;
  const outcome = await searchImageTargetSize<Uint8Array>({
    width: size.width,
    height: size.height,
    targetBytes: request.targetBytes,
    maxDimension: request.maxDimension,
    signal: hooks.signal,
    onTrial: (index, max) => {
      pending = hooks.onTrial?.(index, max);
    },
    encode: async (scaledSize: ImageSize, quality: number) => {
      // The progress/cancel hook is async (a Comlink round trip); awaiting it
      // here makes a cancel land before the next encode rather than after.
      await pending;
      const bytes = await encodeScaledJpeg(source, scaledSize, quality);
      return { output: bytes, byteLength: bytes.byteLength };
    }
  });
  return toSizedResult(outcome, size, request);
}

export type { ImageTrial };

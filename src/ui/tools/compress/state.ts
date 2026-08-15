import { signal } from '@preact/signals';
import type { CompressionReport } from '../../../core/operations';
import type { CompressionPlan } from '../../../core/compress-plan';
import { refineEstimate, type PreviewMeasurement } from '../../../core/compress-plan';

export interface CompressSettings {
  /** Render resolution for the raster path. 150 is the CMP-02 default. */
  dpi: number;
  quality: number;
}

export const compressSettings = signal<CompressSettings>({ dpi: 150, quality: 0.75 });

/**
 * DOC-07 — which preset the compress tool is committing.
 *
 * `quality` is CMP-02's manual DPI/quality pair. `target` hands those two knobs
 * to the search in `compress-target.ts` instead, which measures real output at
 * each rung it tries. Kept as separate signals rather than as fields on
 * `CompressSettings` because that type is also the cache key for CMP-05's
 * measured preview: a target size does not change what one page encodes to, and
 * adding it to the key would throw away a valid measurement on every keystroke.
 */
export type CompressMode = 'quality' | 'target';

export const compressMode = signal<CompressMode>('quality');

export type TargetUnit = 'KB' | 'MB';

export interface TargetSize {
  amount: number;
  unit: TargetUnit;
}

export const compressTarget = signal<TargetSize>({ amount: 2, unit: 'MB' });

/** Decimal MB/KB, matching `formatBytes` so the UI never contradicts itself. */
export function targetSizeBytes(target: TargetSize): number {
  const scale = target.unit === 'MB' ? 1_000_000 : 1_000;
  return Math.max(0, Math.round(target.amount * scale));
}

/**
 * DOC-07 — what the last target-size run actually produced, in measured bytes.
 *
 * Set by the commit path whether or not the target was met, because "could not
 * reach it, here is the smallest available" is the outcome the panel most needs
 * to show honestly.
 */
export interface TargetOutcome {
  targetBytes: number;
  achievedBytes: number;
  originalBytes: number;
  reached: boolean;
  settings: { dpi: number; quality: number } | null;
  attempts: number;
  /** Constructs CMP-01/03 deliberately refused to re-encode, for the report. */
  skipped: string[];
}

export const compressTargetOutcome = signal<TargetOutcome | null>(null);

/** Last pre-flight analysis, so the panel can show the projection (CMP-04/05). */
export const compressReport = signal<CompressionReport | null>(null);

/**
 * CMP-05 — the preview's real re-encode of the representative page, tagged with
 * the settings it was produced at so a stale measurement is never applied to a
 * projection for different settings.
 */
export interface CompressMeasurement extends PreviewMeasurement, CompressSettings {}

export const compressMeasurement = signal<CompressMeasurement | null>(null);

export interface Projection {
  bytes: number;
  fraction: number;
  /**
   * True when the number came from bytes this document's own content actually
   * produced, rather than from the pre-flight model. The UI says which, because
   * "estimated" and "measured" deserve different levels of trust.
   */
  measured: boolean;
}

/**
 * The projected output size to show, preferring the measured re-anchor.
 *
 * Only the *displayed* projection is refined. The export path (`commit.ts`) runs
 * its own pre-flight `planCompression` and keeps gating on that, so a preview
 * that has not run — or has run at other settings — cannot change what the
 * safety net decides.
 */
export function projectedOutput(
  report: CompressionReport | null,
  measurement: CompressMeasurement | null,
  settings: CompressSettings
): Projection | null {
  if (!report) return null;
  const usable =
    measurement && measurement.dpi === settings.dpi && measurement.quality === settings.quality
      ? refineEstimate(report.plan, report.originalBytes, settings.quality, measurement)
      : null;
  return usable
    ? { bytes: usable.estimatedBytes, fraction: usable.estimatedFraction, measured: true }
    : { bytes: report.estimatedBytes, fraction: report.estimatedFraction, measured: false };
}

export interface LastCompressionResult {
  plan: CompressionPlan;
  originalBytes: number;
  compressedBytes: number;
  keptOriginal?: boolean;
}

export const lastCompressionResult = signal<LastCompressionResult | null>(null);

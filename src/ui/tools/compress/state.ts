import { signal } from '@preact/signals';
import type { CompressionReport } from '../../../core/operations';
import { refineEstimate, type PreviewMeasurement } from '../../../core/compress-plan';

export interface CompressSettings {
  /** Render resolution for the raster path. 150 is the CMP-02 default. */
  dpi: number;
  quality: number;
}

export const compressSettings = signal<CompressSettings>({ dpi: 150, quality: 0.75 });

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

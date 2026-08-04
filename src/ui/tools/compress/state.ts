import { signal } from '@preact/signals';
import type { CompressionReport } from '../../../core/operations';

export interface CompressSettings {
  /** Render resolution for the raster path. 150 is the CMP-02 default. */
  dpi: number;
  quality: number;
}

export const compressSettings = signal<CompressSettings>({ dpi: 150, quality: 0.75 });

/** Last pre-flight analysis, so the panel can show the projection (CMP-04/05). */
export const compressReport = signal<CompressionReport | null>(null);

import { signal } from '@preact/signals';

export type PaperSize = 'A4' | 'Letter' | 'Legal';
export type ScaleMode = 'fit' | 'fill' | 'center';

export interface NormalizeSettings {
  targetSize: PaperSize;
  scaleMode: ScaleMode;
}

export const normalizeSettings = signal<NormalizeSettings | null>(null);

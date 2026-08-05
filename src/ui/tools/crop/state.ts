import { signal } from '@preact/signals';

export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CropSettings {
  applyToAll: boolean;
}

export const cropSettings = signal<CropSettings>({
  applyToAll: false
});

/** Maps page keys to their manual crop box in normalized [0, 1] coordinates. */
export const cropBoxes = signal<Record<string, CropBox>>({});

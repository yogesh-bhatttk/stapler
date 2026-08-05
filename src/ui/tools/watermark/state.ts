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

export interface WatermarkSettings {
  text: string;
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
  text: '',
  position: 'center',
  opacity: 0.5,
  rotation: 45,
  fontSize: 72,
  color: DOC_SIGNATURE_STROKE,
  startAt: 1,
  pageRange: 'all'
});

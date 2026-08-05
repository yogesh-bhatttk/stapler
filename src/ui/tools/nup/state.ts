import { signal } from '@preact/signals';

export type NUpLayout = '2-up' | '4-up' | 'booklet';

export interface NUpSettings {
  layout: NUpLayout;
  margin: number;
  gutter: number;
  drawBorders: boolean;
}

export const nupSettings = signal<NUpSettings | null>(null);

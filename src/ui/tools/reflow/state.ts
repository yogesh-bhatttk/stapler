import { signal } from '@preact/signals';

/** Reading font size in px — deliberately large by default; this is a low-vision aid. */
export const reflowFontSize = signal<number>(22);

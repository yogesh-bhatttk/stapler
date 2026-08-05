import { signal } from '@preact/signals';
import type { PageRef } from '../../../core/store';

export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CropScope = 'current' | 'all' | 'odd' | 'even';

export interface CropSettings {
  scope: CropScope;
}

export const cropSettings = signal<CropSettings>({
  scope: 'current'
});

/** Maps page keys to their manual crop box in normalized [0, 1] coordinates. */
export const cropBoxes = signal<Record<string, CropBox>>({});

/**
 * Resolves a scope to the pages it targets. `current` is resolved against
 * `activeIndex`, not against selection state — the crop tool always operates on
 * whichever page is on screen. Page numbers are 1-indexed for odd/even, so index 0
 * (page 1) is odd.
 */
export function pagesForScope(pages: PageRef[], scope: CropScope, activeIndex: number): PageRef[] {
  switch (scope) {
    case 'all':
      return pages;
    case 'odd':
      return pages.filter((_, i) => i % 2 === 0);
    case 'even':
      return pages.filter((_, i) => i % 2 === 1);
    case 'current':
    default:
      return pages[activeIndex] ? [pages[activeIndex]] : [];
  }
}

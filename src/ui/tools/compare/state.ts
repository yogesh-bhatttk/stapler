import { signal } from '@preact/signals';

export type DiffMode = 'visual' | 'text' | 'redline';
export type UnchangedPagesMode = 'skip' | 'mark';

export const compareSettings = signal({
  compareSourceId: null as string | null,
  diffMode: 'visual' as DiffMode,
  sensitivity: 10, // 0 to 100
  /** ANN-06 — only meaningful when diffMode is 'redline'. */
  unchangedPages: 'mark' as UnchangedPagesMode
});

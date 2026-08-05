import { signal } from '@preact/signals';

export type DiffMode = 'visual' | 'text';

export const compareSettings = signal({
  compareSourceId: null as string | null,
  diffMode: 'visual' as DiffMode,
  sensitivity: 10 // 0 to 100
});

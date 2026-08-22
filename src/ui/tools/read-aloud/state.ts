import { signal } from '@preact/signals';

export type ReadAloudStatus = 'idle' | 'playing' | 'paused';

export interface ReadAloudProgress {
  status: ReadAloudStatus;
  pageIndex: number;
  /** Set when the current page had no extractable text and was skipped. */
  note: string | null;
}

export const readAloudProgress = signal<ReadAloudProgress>({
  status: 'idle',
  pageIndex: 0,
  note: null
});

/** Speech rate, the same 0.5-2x range every OS speech UI offers. */
export const readAloudRate = signal<number>(1);

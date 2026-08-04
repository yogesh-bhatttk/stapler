/**
 * The three workers PLAN §2.1 specifies, and nothing else.
 *
 * There were five, because redaction and verification each spawned their own
 * pdf.js and pdf-lib. Splitting by *library* rather than by feature keeps one copy
 * of each in the bundle: `render` reads, `process` writes, `cv` does pure image
 * maths for scan cleanup.
 */
import { createWorkerClient } from './client';
import type { RenderJob } from './render.worker';
import type { ProcessJob } from './process.worker';
import type { CVJob } from './cv.worker';

/** pdf.js — reading, rasterising, text extraction, search, verification. */
export const renderWorker = createWorkerClient<RenderJob>(
  () => new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' }),
  // pdf.js keeps parsed documents behind handles, so retiring this worker throws
  // them away. Hold it longer than the others.
  { idleMs: 120_000, name: 'render' }
);

/** pdf-lib — composition, compression, redaction, metadata. */
export const processWorker = createWorkerClient<ProcessJob>(
  () => new Worker(new URL('./process.worker.ts', import.meta.url), { type: 'module' }),
  { idleMs: 30_000, name: 'process' }
);

/** Pure pixel maths for scan cleanup. Stateless, so it can go away quickly. */
export const cvWorker = createWorkerClient<CVJob>(
  () => new Worker(new URL('./cv.worker.ts', import.meta.url), { type: 'module' }),
  { idleMs: 10_000, name: 'cv' }
);

export type { RenderJob, ProcessJob, CVJob };

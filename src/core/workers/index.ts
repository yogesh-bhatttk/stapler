/**
 * The workers PLAN §2.1 specifies, and nothing else.
 *
 * There were five, because redaction and verification each spawned their own
 * pdf.js and pdf-lib. Splitting by *library* rather than by feature keeps one copy
 * of each in the bundle: `render` reads, `process` writes, `cv` does pure image
 * maths for scan cleanup, `ocr` owns tesseract.js.
 */
import { createWorkerClient } from './client';
import type { RenderJob } from './render.worker';
import type { ProcessJob } from './process.worker';
import type { CVJob } from './cv.worker';
import type { OCRJob } from './ocr.worker';
import type { ConvertJob } from './convert.worker';

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

/**
 * tesseract.js (OCR-01). Lazily spawned like the rest, but capped at a single
 * instance: each one loads its own WASM engine plus a language model, tens of
 * megabytes, so letting the default pool size (`min(4, cores - 1)`) apply would
 * quadruple that for no throughput gain on a job that is already CPU-bound.
 */
export const ocrWorker = createWorkerClient<OCRJob>(
  () => new Worker(new URL('./ocr.worker.ts', import.meta.url), { type: 'module' }),
  { idleMs: 30_000, name: 'ocr', maxSize: 1 }
);

/**
 * `docx` (CNV-08). Capped at a single instance for the same reason `ocr` is,
 * scaled to this library's cost: writing a DOCX holds the whole OOXML tree plus
 * every embedded image in memory while jszip deflates it, so a pool of four would
 * multiply the peak footprint of a job that is one document at a time anyway.
 */
export const convertWorker = createWorkerClient<ConvertJob>(
  () => new Worker(new URL('./convert.worker.ts', import.meta.url), { type: 'module' }),
  { idleMs: 30_000, name: 'convert', maxSize: 1 }
);

export type { RenderJob, ProcessJob, CVJob, OCRJob, ConvertJob };

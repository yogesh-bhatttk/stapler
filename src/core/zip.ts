/**
 * AUDIT-2026-10-10 M5/M6 — the main thread's way to build or open a ZIP:
 * always in `zip.worker.ts`, never with `zipSync`/`unzipSync` here.
 *
 * Both calls are cancellable. An abort throws `UserCancelled` — the caller
 * must write nothing — rather than resolving with a partial archive.
 */
import { cancelled } from './errors';
import { createJobHandle, type JobOptions } from './workers/protocol';

export interface ZipCallOptions extends JobOptions {
  /**
   * Hand the input buffers to the worker instead of copying them. They are
   * detached on this side afterwards — only for bytes the caller is done with.
   */
  transfer?: boolean;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelled();
}

/** Builds a ZIP in the worker. PDFs and images are stored, everything else deflated. */
export async function zipInWorker(
  entries: Record<string, Uint8Array>,
  options: ZipCallOptions = {}
): Promise<Uint8Array> {
  throwIfAborted(options.signal);
  const [{ zipWorker }, Comlink] = await Promise.all([import('./workers'), import('comlink')]);
  const job = createJobHandle(options);
  const buffers = new Set<ArrayBuffer>();
  if (options.transfer) {
    for (const bytes of Object.values(entries)) buffers.add(bytes.buffer as ArrayBuffer);
  }
  const payload = options.transfer ? Comlink.transfer(entries, [...buffers]) : entries;
  const out = await zipWorker.lease(api => api.zip(payload, job));
  throwIfAborted(options.signal);
  return out;
}

/** Inflates every member of `bytes` in the worker. */
export async function unzipInWorker(
  bytes: Uint8Array,
  options: ZipCallOptions = {}
): Promise<Record<string, Uint8Array>> {
  throwIfAborted(options.signal);
  const [{ zipWorker }, Comlink] = await Promise.all([import('./workers'), import('comlink')]);
  const job = createJobHandle(options);
  const payload = options.transfer ? Comlink.transfer(bytes, [bytes.buffer as ArrayBuffer]) : bytes;
  const files = await zipWorker.lease(api => api.unzip(payload, job));
  throwIfAborted(options.signal);
  return files;
}

/** Inflates the one member `name` of `bytes` in the worker (a review preview). */
export async function unzipMemberInWorker(
  bytes: Uint8Array,
  name: string
): Promise<Uint8Array | null> {
  const { zipWorker } = await import('./workers');
  return zipWorker.lease(api => api.member(bytes, name));
}

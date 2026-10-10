/**
 * AUDIT-2026-10-10 M5/M6 — ZIP building and opening, off the main thread.
 *
 * A worker of its own rather than another method on `process.worker.ts`: it
 * needs only fflate (a few kB), so it boots instantly, and a ZIP of a batch
 * folder never queues behind a pdf-lib job holding a process instance. A
 * bundled module like every other worker — fflate's own async API spawns
 * `blob:` workers, which `worker-src 'self'` refuses.
 */
import './network-guard'; // PLT-2: first, so it wraps the network APIs before any library runs
import * as Comlink from 'comlink';
import { loadLocale } from '../i18n';
import type { LocaleAware } from './client';
import { releaseJobHandlesAfterCall, type JobHandle } from './protocol';
import { buildZip, openZip, readZipMember } from '../zip-archive';

export interface ZipJob extends LocaleAware {
  /** Builds an archive; already-compressed members are stored, the rest deflated. */
  zip(entries: Record<string, Uint8Array>, job?: JobHandle): Promise<Uint8Array>;
  /** Inflates every member. */
  unzip(bytes: Uint8Array, job?: JobHandle): Promise<Record<string, Uint8Array>>;
  /** Inflates one member by name; null when the archive has no such member. */
  member(bytes: Uint8Array, name: string): Promise<Uint8Array | null>;
}

export const zipWorkerImpl: ZipJob = {
  setLocale: loadLocale,
  async zip(entries, job) {
    const out = await buildZip(entries, job);
    return Comlink.transfer(out, [out.buffer as ArrayBuffer]);
  },
  async unzip(bytes, job) {
    const files = await openZip(bytes, job);
    // A stored member is a subarray of the archive, so several can share one
    // buffer; `postMessage` throws on a repeated transferable.
    const buffers = new Set<ArrayBuffer>();
    for (const member of Object.values(files)) buffers.add(member.buffer as ArrayBuffer);
    return Comlink.transfer(files, [...buffers]);
  },
  async member(bytes, name) {
    const out = readZipMember(bytes, name);
    return out ? Comlink.transfer(out, [out.buffer as ArrayBuffer]) : null;
  }
};

// Guarded like `process.worker.ts`, so a unit test can import the API in-process.
if (
  typeof self !== 'undefined' &&
  typeof (self as unknown as { addEventListener?: unknown }).addEventListener === 'function'
) {
  Comlink.expose(releaseJobHandlesAfterCall(zipWorkerImpl));
}

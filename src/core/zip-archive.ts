/**
 * AUDIT-2026-10-10 M5/M6 — building and opening ZIP archives without blocking
 * the page.
 *
 * `zipSync`/`unzipSync` on the main thread froze the editor for as long as an
 * archive took to deflate or inflate (a batch folder of scans: seconds). The
 * work now runs in `zip.worker.ts`; this module is the part both sides share,
 * kept free of worker globals so it is unit-testable in Node:
 *
 *  • {@link buildZip} — one entry at a time, with a cancellation checkpoint
 *    and progress between entries. Formats that are already compressed (PDF,
 *    JPEG, PNG, WebP, …) are *stored* (level 0): deflating them again costs
 *    real time for a few bytes at best.
 *  • {@link openZip} — inflates every member (the directory-output branches
 *    write each one out).
 *  • {@link listZip} — names and sizes from the central directory only,
 *    inflating nothing. Cheap enough for the main thread (the export review
 *    lists an archive's members and only previews one on demand).
 *
 * fflate's own async APIs (`zip`, `unzip`, `AsyncZipDeflate`) are not used:
 * they spawn workers from inline `blob:` URLs, which the CSP's
 * `worker-src 'self'` refuses (see `scripts/csp.mjs`).
 */
import { Zip, ZipDeflate, ZipPassThrough, unzipSync } from 'fflate';
import { checkpoint, type JobHandle } from './workers/protocol';
import { corrupt } from './errors';
import { translate } from './i18n';

/** Extensions whose bytes are already compressed: stored, not deflated again. */
const STORED_EXTENSIONS = new Set([
  'pdf',
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'avif',
  'heic',
  'heif',
  'jp2',
  'j2k',
  'jpx',
  'zip',
  'docx',
  'xlsx',
  'pptx',
  'gz'
]);

/** The deflate level an archive member gets: 0 (stored) for compressed formats, else 6. */
export function zipLevelFor(name: string): 0 | 6 {
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
  return STORED_EXTENSIONS.has(ext) ? 0 : 6;
}

export interface ZipMemberInfo {
  name: string;
  /** Uncompressed size in bytes, as the central directory records it. */
  size: number;
}

/**
 * Builds a ZIP from `entries` (in insertion order). Checks for cancellation
 * before each member, so an aborted run throws `UserCancelled` instead of
 * returning a partial archive.
 */
export async function buildZip(
  entries: Record<string, Uint8Array>,
  job?: JobHandle
): Promise<Uint8Array> {
  const names = Object.keys(entries);
  const chunks: Uint8Array[] = [];
  let failure: Error | null = null;
  const zip = new Zip((err, chunk) => {
    if (err) failure = err;
    else chunks.push(chunk);
  });
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    await checkpoint(
      job,
      i / Math.max(1, names.length),
      translate('Adding {name} to the archive', { name })
    );
    const file =
      zipLevelFor(name) === 0 ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 6 });
    zip.add(file);
    file.push(entries[name], true);
    if (failure) throw failure;
  }
  await checkpoint(job, 1, translate('Saving ZIP archive...'));
  zip.end();
  if (failure) throw failure;
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** Inflates every member. Throws a `CorruptDocument` error on an unreadable archive. */
export async function openZip(
  bytes: Uint8Array,
  job?: JobHandle
): Promise<Record<string, Uint8Array>> {
  await checkpoint(job, 0, translate('Opening the archive'));
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (err) {
    throw corrupt(
      translate('The archive could not be read ({message}).', {
        message: err instanceof Error ? err.message : String(err)
      })
    );
  }
  await checkpoint(job, 1, translate('Opening the archive'));
  return files;
}

/** Member names and sizes from the central directory; nothing is inflated. */
export function listZip(bytes: Uint8Array): ZipMemberInfo[] {
  const members: ZipMemberInfo[] = [];
  unzipSync(bytes, {
    filter: file => {
      members.push({ name: file.name, size: file.originalSize });
      return false;
    }
  });
  return members;
}

/** Inflates one member by name, or returns null when the archive has none. */
export function readZipMember(bytes: Uint8Array, name: string): Uint8Array | null {
  return unzipSync(bytes, { filter: file => file.name === name })[name] ?? null;
}

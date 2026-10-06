/**
 * GAP-2 — hand-off of files shared to the installed web app (manifest
 * `share_target`, e.g. the Android share sheet).
 *
 * The OS delivers them as a multipart POST, which only the service worker can
 * receive; the page that then opens cannot read that request body. So the
 * worker stores each file in a same-origin Cache Storage bucket and redirects
 * to the app, which takes them out (and deletes the bucket) on load. Nothing
 * leaves the device: the cache keys are synthetic URLs under the app's own
 * scope that are never requested from any server.
 *
 * Audit 2026-10-01 PLT-5 — if the redirected page never loads, or loads
 * without the share param, nothing takes the files out. Each entry therefore
 * records when it was stored, and `sweepStaleSharedFiles` (run by the app on
 * every start that is not a share-target launch, and by the worker before it
 * stores a new share) deletes batches older than `SHARE_INBOX_MAX_AGE_MS`,
 * plus anything in the bucket that is not a well-formed inbox entry.
 */

export const SHARE_INBOX_CACHE = 'stapler-share-inbox';

const NAME_HEADER = 'x-stapler-name';
const MODIFIED_HEADER = 'x-stapler-modified';
const STORED_HEADER = 'x-stapler-stored';
const VERIFIED_HEADER = 'x-stapler-verified';

/**
 * How long a shared batch may wait to be picked up: 10 minutes. The hand-off
 * it covers — worker stores, 303 redirect, page loads and calls
 * `takeSharedFiles` — takes seconds; 10 minutes is two orders of magnitude of
 * headroom for a cold start on a slow phone writing large files, so a share
 * still in flight (in this tab or another) is never swept. Past that the
 * hand-off has failed, and the user's files should not sit on disk unasked
 * for any longer than that.
 */
export const SHARE_INBOX_MAX_AGE_MS = 10 * 60 * 1000;

/** `__share-inbox/<batch>-<index>` — see `inboxKey`. */
const KEY_PATTERN = /\/__share-inbox\/(\d+)-(\d{4})$/;

/** The minimal Cache Storage surface used here, so tests can pass a fake. */
export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
  has(name: string): Promise<boolean>;
  delete(name: string): Promise<boolean>;
}

export interface CacheLike {
  put(request: Request, response: Response): Promise<void>;
  match(request: Request): Promise<Response | undefined>;
  keys(): Promise<readonly Request[]>;
  delete(request: Request): Promise<boolean>;
}

function inboxKey(scope: string, batch: number, index: number): Request {
  // Zero-padded so `keys()` order and name order agree.
  return new Request(
    new URL(`__share-inbox/${batch}-${String(index).padStart(4, '0')}`, scope).href
  );
}

/**
 * Service-worker side: store `files` for the page to pick up. Stale batches
 * left by an earlier, failed hand-off are swept first, so they are not opened
 * along with this one.
 *
 * Audit 2026-10-01 PLT-3 — `verified` records whether the worker positively
 * traced the share to this app's own origin (`classifyShareRequest`). It is
 * stored with each file, never passed in the redirect URL, which any website
 * can link to: the app opens an unverified batch only after asking. It
 * defaults to unverified.
 */
export async function storeSharedFiles(
  storage: CacheStorageLike,
  scope: string,
  files: readonly File[],
  batch = Date.now(),
  now = Date.now(),
  verified = false
): Promise<number> {
  try {
    await sweepStaleSharedFiles(storage, now);
  } catch {
    // A failed sweep must not lose this share; the app sweeps again on start.
  }
  const cache = await storage.open(SHARE_INBOX_CACHE);
  await Promise.all(
    files.map((file, index) =>
      cache.put(
        inboxKey(scope, batch, index),
        new Response(file, {
          headers: {
            'content-type': file.type || 'application/octet-stream',
            [NAME_HEADER]: encodeURIComponent(file.name),
            [MODIFIED_HEADER]: String(file.lastModified),
            [STORED_HEADER]: String(now),
            [VERIFIED_HEADER]: verified ? '1' : '0'
          }
        })
      )
    )
  );
  return files.length;
}

/** What the page takes out of the inbox. */
export interface SharedBatch {
  /** Every stored file, in the order it was shared. */
  files: File[];
  /**
   * PLT-3 — true only when every file was stored by a share the worker
   * positively traced to this origin. A file without the flag (stored by an
   * older worker) counts as unverified.
   */
  verified: boolean;
}

/** Page side: every stored file, in the order it was shared; empties the inbox. */
export async function takeSharedFiles(storage: CacheStorageLike): Promise<File[]> {
  return (await takeSharedBatch(storage)).files;
}

/**
 * Page side: every stored file and whether all of them were verified; empties
 * the inbox either way, so a batch the user then discards is already gone.
 */
export async function takeSharedBatch(storage: CacheStorageLike): Promise<SharedBatch> {
  if (!(await storage.has(SHARE_INBOX_CACHE))) return { files: [], verified: true };
  const cache = await storage.open(SHARE_INBOX_CACHE);
  const keys = [...(await cache.keys())].sort((a, b) => a.url.localeCompare(b.url));
  const files: File[] = [];
  let verified = true;
  for (const key of keys) {
    const response = await cache.match(key);
    if (!response) continue;
    if (response.headers.get(VERIFIED_HEADER) !== '1') verified = false;
    const blob = await response.blob();
    let name = 'shared-file';
    try {
      name = decodeURIComponent(response.headers.get(NAME_HEADER) ?? name) || name;
    } catch {
      // A malformed name is not a reason to drop the file.
    }
    const modified = Number(response.headers.get(MODIFIED_HEADER));
    const type = response.headers.get('content-type') ?? '';
    files.push(
      new File([blob], name, {
        // Stored as octet-stream only because the file had no type at all.
        type: type === 'application/octet-stream' ? '' : type,
        lastModified: Number.isFinite(modified) && modified > 0 ? modified : Date.now()
      })
    );
  }
  await storage.delete(SHARE_INBOX_CACHE);
  return { files, verified };
}

/**
 * When an entry was stored: its `x-stapler-stored` header, or — for an entry
 * written before that header existed — the batch number in its key, which the
 * worker has always set to `Date.now()`. `null` when neither is usable.
 */
function storedAt(key: Request, response: Response): number | null {
  const header = response.headers.get(STORED_HEADER);
  if (header !== null) {
    const value = Number(header);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const batch = Number(KEY_PATTERN.exec(key.url)?.[1]);
  return Number.isFinite(batch) && batch > 0 ? batch : null;
}

/**
 * Audit 2026-10-01 PLT-5 — deletes every inbox entry stored more than
 * `maxAgeMs` ago, or that far in the future (a clock moved back), plus any
 * entry that is not a well-formed inbox entry (unknown key, no stored time).
 * Deletes the whole bucket once it is empty. Returns how many entries went.
 *
 * Callers must not run it while a share-target launch is about to take the
 * inbox — `src/ui/pwa.ts` takes instead of sweeping on such a launch — and
 * the age limit keeps a hand-off in flight in another tab out of reach.
 */
export async function sweepStaleSharedFiles(
  storage: CacheStorageLike,
  now = Date.now(),
  maxAgeMs = SHARE_INBOX_MAX_AGE_MS
): Promise<number> {
  if (!(await storage.has(SHARE_INBOX_CACHE))) return 0;
  const cache = await storage.open(SHARE_INBOX_CACHE);
  const keys = await cache.keys();
  let removed = 0;
  let kept = 0;
  for (const key of keys) {
    let stale = true;
    if (KEY_PATTERN.test(key.url)) {
      const response = await cache.match(key);
      const at = response ? storedAt(key, response) : null;
      stale = at === null || Math.abs(now - at) > maxAgeMs;
    }
    if (stale && (await cache.delete(key))) removed++;
    else if (!stale) kept++;
  }
  if (kept === 0 && (await cache.keys()).length === 0) await storage.delete(SHARE_INBOX_CACHE);
  return removed;
}

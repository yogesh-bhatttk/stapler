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
 */

export const SHARE_INBOX_CACHE = 'stapler-share-inbox';

const NAME_HEADER = 'x-stapler-name';
const MODIFIED_HEADER = 'x-stapler-modified';

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
}

function inboxKey(scope: string, batch: number, index: number): Request {
  // Zero-padded so `keys()` order and name order agree.
  return new Request(
    new URL(`__share-inbox/${batch}-${String(index).padStart(4, '0')}`, scope).href
  );
}

/** Service-worker side: store `files` for the page to pick up. */
export async function storeSharedFiles(
  storage: CacheStorageLike,
  scope: string,
  files: readonly File[],
  batch = Date.now()
): Promise<number> {
  const cache = await storage.open(SHARE_INBOX_CACHE);
  await Promise.all(
    files.map((file, index) =>
      cache.put(
        inboxKey(scope, batch, index),
        new Response(file, {
          headers: {
            'content-type': file.type || 'application/octet-stream',
            [NAME_HEADER]: encodeURIComponent(file.name),
            [MODIFIED_HEADER]: String(file.lastModified)
          }
        })
      )
    )
  );
  return files.length;
}

/** Page side: every stored file, in the order it was shared; empties the inbox. */
export async function takeSharedFiles(storage: CacheStorageLike): Promise<File[]> {
  if (!(await storage.has(SHARE_INBOX_CACHE))) return [];
  const cache = await storage.open(SHARE_INBOX_CACHE);
  const keys = [...(await cache.keys())].sort((a, b) => a.url.localeCompare(b.url));
  const files: File[] = [];
  for (const key of keys) {
    const response = await cache.match(key);
    if (!response) continue;
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
  return files;
}

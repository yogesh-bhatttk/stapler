/**
 * The File System Access implementation of the platform adapter, shared by both
 * targets.
 *
 * There is no meaningful difference between the extension and a modern browser tab
 * here — the API is the same and needs no permission either way, which is exactly
 * why PLAN §2.5 chose it over the `downloads` permission. `extension.ts` and
 * `web.ts` differ only in their fallbacks.
 */
import {
  ensureReadPermission,
  hasDirectoryPicker,
  hasFileSystemAccess,
  isAbort,
  pickerTypes,
  showDirectoryPicker,
  showOpenFilePicker,
  showSaveFilePicker,
  type FsaDirectoryHandle,
  type FsaFileHandle
} from './fsa';
import type { OpenOptions, OpenedFile, OutputDirectory, RecentEntry } from './index';
import { deleteHandle, listHandles, readHandle, writeHandle } from '../core/db';
import { withUserActivation } from './user-activation';

/**
 * Reads an image off the OS clipboard through the async Clipboard API.
 *
 * The paste handler prefers `ClipboardEvent.clipboardData`; this is its
 * fallback. There is deliberately no test hook here (AUDIT-FINDINGS §11.10):
 * the e2e writes a real `ClipboardItem` and pastes with the real shortcut.
 */
export async function readClipboardImage(): Promise<File | null> {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const type of item.types) {
        if (type.startsWith('image/')) {
          const blob = await item.getType(type);
          const extension = type.split('/')[1] || 'png';
          return new File([blob], `Pasted Image.${extension}`, { type });
        }
      }
    }
  } catch {
    // Permission denied or clipboard empty
  }
  return null;
}

/** Handles from this session, so `saveOver` can find the one a file came from. */
const session = new Map<string, FsaFileHandle>();

/** A picker's (or a PWA launch's, GAP-2) file handle as an `OpenedFile`. */
export function wrapFileHandle(handle: FsaFileHandle): OpenedFile {
  const id = crypto.randomUUID();
  session.set(id, handle);
  return {
    id,
    name: handle.name,
    getFile: () => handle.getFile(),
    persistable: true,
    writable: true
  };
}

export async function openFilesViaPicker(options?: OpenOptions): Promise<OpenedFile[]> {
  try {
    const handles = await showOpenFilePicker({
      multiple: options?.multiple,
      types: pickerTypes(options?.accept, 'PDFs and images')
    });
    return handles.map(wrapFileHandle);
  } catch (err) {
    if (isAbort(err)) return [];
    throw err;
  }
}

/** L4 — `name` with ` (n)` before its extension: `Report.pdf` → `Report (2).pdf`. */
export function numberedName(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/** The most suffixes tried before giving up on a free name. */
const MAX_NAME_ATTEMPTS = 1000;

/**
 * AUDIT-2026-10-10 L4 — the first of `name`, `name (1)`, `name (2)`, … that
 * neither exists in `directory` nor is in `claimed` (lower-cased names this
 * export already wrote). `getFileHandle(create:true)` silently replaced an
 * existing file of the same name — someone's earlier export, or an unrelated
 * file. The probe asks the directory itself, so it follows the filesystem's
 * own case rule (`summary.pdf` is found for `Summary.pdf` on Windows/macOS);
 * `claimed` is compared case-insensitively whatever the filesystem.
 */
export async function freeNameIn(
  directory: Pick<FsaDirectoryHandle, 'getFileHandle'>,
  name: string,
  claimed: ReadonlySet<string>
): Promise<string> {
  for (let n = 0; n < MAX_NAME_ATTEMPTS; n++) {
    const candidate = n === 0 ? name : numberedName(name, n);
    if (claimed.has(candidate.toLowerCase())) continue;
    try {
      await directory.getFileHandle(candidate);
    } catch (err) {
      const errName = (err as { name?: unknown } | null)?.name;
      if (errName === 'NotFoundError') return candidate;
      // A folder of that name: taken, try the next one.
      if (errName === 'TypeMismatchError') continue;
      throw err;
    }
  }
  throw new Error(`No free file name for "${name}" in this folder`);
}

export async function openDirectoryViaPicker(): Promise<OutputDirectory | null> {
  if (!hasDirectoryPicker()) return null;
  try {
    // AUDIT-2026-10-10 H3 — reached after the export review and the work
    // before it, so the click may have expired: asked for, as for a save.
    const directory = await withUserActivation(null, () =>
      showDirectoryPicker({ mode: 'readwrite' })
    );
    if (directory === null) return null;
    if (!(await ensureWritePermissionWithActivation(directory, null))) return null;
    return directoryOutput(directory);
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
}

/**
 * The writer over a picked folder. Never overwrites (L4): a name that is
 * taken gets ` (n)`, and `write` resolves with the name actually used.
 */
export function directoryOutput(
  directory: Pick<FsaDirectoryHandle, 'name' | 'getFileHandle'>
): OutputDirectory {
  const claimed = new Set<string>();
  return {
    name: directory.name,
    write: async (fileName, bytes) => {
      const name = await freeNameIn(directory, fileName, claimed);
      claimed.add(name.toLowerCase());
      const file = await directory.getFileHandle(name, { create: true });
      const writable = await file.createWritable();
      try {
        await writable.write(bytes);
        await writable.close();
      } catch (err) {
        // abort() discards the partial write atomically; ignore its own error.
        await (writable as unknown as { abort(): Promise<void> }).abort().catch(() => {});
        throw err;
      }
      return name;
    }
  };
}

/**
 * Every extension Stapler actually writes, mapped to its real MIME type.
 * Everything else previously fell back to `text/plain` — a mismatch the File
 * System Access API doesn't validate (`writable.write` isn't affected either
 * way), but an OS/desktop file picker that *does* use the declared type to
 * decide what extension belongs on the saved file has no reason to trust
 * ".docx is a text/plain file" and is exactly the kind of malformed input
 * that invites it to fall back to its own default naming instead.
 */
const EXTENSION_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  // CV15: what image extraction writes for JPEG 2000 (a JP2 file, or a bare codestream).
  '.jp2': 'image/jp2',
  '.j2k': 'image/j2c',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.md': 'text/markdown',
  '.txt': 'text/plain'
};

/** `EXTENSION_MIME[ext]`, or the generic fallback for anything not in that table. */
function mimeForName(name: string): string {
  const extension = name.match(/\.[^.]+$/)?.[0] ?? '';
  return EXTENSION_MIME[extension.toLowerCase()] ?? 'application/octet-stream';
}

export async function saveViaPicker(bytes: Uint8Array, suggestedName: string): Promise<boolean> {
  const extension = suggestedName.match(/\.[^.]+$/)?.[0] ?? '.pdf';
  const mime = mimeForName(suggestedName);
  try {
    // AUDIT-2026-10-10 H3 — an export that worked for a while reaches this
    // long after the click that started it, and the picker needs a recent
    // one. Asked for, rather than refused and swallowed as a "cancel".
    const handle = await withUserActivation(suggestedName, () =>
      showSaveFilePicker({
        suggestedName,
        types: pickerTypes({ [mime]: [extension] }, 'Saved file')
      })
    );
    if (handle === null) return false;
    const writable = await handle.createWritable();
    try {
      await writable.write(bytes);
      await writable.close();
    } catch (err) {
      await (writable as unknown as { abort(): Promise<void> }).abort().catch(() => {});
      throw err;
    }
    return true;
  } catch (err) {
    if (isAbort(err)) return false;
    throw err;
  }
}

/**
 * H3 — `ensureWritePermission`, with the prompt (`requestPermission`, which
 * needs a fresh gesture exactly as a picker does) run through
 * `withUserActivation`. Save over original reaches it after the export's own
 * work and a confirm dialog; a permission prompt refused for want of a click
 * used to read as "Could not save over the original file".
 */
export async function ensureWritePermissionWithActivation(
  handle: Pick<FsaFileHandle, 'queryPermission' | 'requestPermission'>,
  name: string | null,
  activate: typeof withUserActivation = withUserActivation
): Promise<boolean> {
  if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  const state = await activate(name, () => handle.requestPermission({ mode: 'readwrite' }));
  return state === 'granted';
}

export async function saveOverHandle(fileId: string, bytes: Uint8Array): Promise<boolean> {
  const handle = session.get(fileId) ?? (await readHandle(fileId));
  if (!handle) return false;
  if (!(await ensureWritePermissionWithActivation(handle, handle.name))) return false;
  let writable: Awaited<ReturnType<typeof handle.createWritable>>;
  try {
    // Unlike the missing-handle and permission-refused cases above,
    // `createWritable()` can still throw here: FSA permission state does not
    // verify the file still exists, so a file moved or deleted since it was
    // opened passes both checks above and only fails here, with a raw
    // `NotFoundError`/`NoModificationAllowedError`. Every other failure in
    // this function is reported the same way — `return false` — so the
    // caller's existing "Could not save over the original file… try again to
    // save a new file instead" message covers this too, instead of an
    // uncaught exception surfacing a generic internal error.
    writable = await handle.createWritable();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      // FS-02: Handle went stale (e.g. after sleep), but queryPermission still
      // claimed 'granted'. Re-requesting refreshes the internal OS handle.
      if (
        (await withUserActivation(handle.name, () =>
          handle.requestPermission({ mode: 'readwrite' })
        )) === 'granted'
      ) {
        try {
          writable = await handle.createWritable();
        } catch {
          return false;
        }
      } else {
        return false;
      }
    } else {
      return false;
    }
  }
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (err) {
    await (writable as unknown as { abort(): Promise<void> }).abort().catch(() => {});
    throw err;
  }
  return true;
}

/** L5 — the most Recents entries kept; the oldest go first. */
export const MAX_RECENT_HANDLES = 50;

/**
 * DS-05 Recents: handles survive a reload; permission is re-requested on reopen.
 *
 * AUDIT-2026-10-10 L5 — every picker open mints a fresh id, so opening the same
 * file ten times used to leave ten Recents rows, without limit. An existing
 * entry for the same file (`isSameEntry`) is replaced, so the file appears once
 * with its latest open time, and the list is capped at
 * {@link MAX_RECENT_HANDLES}.
 */
export async function persistFileHandle(file: OpenedFile): Promise<void> {
  const handle = session.get(file.id);
  if (!handle) return;
  const existing = await listHandles();
  for (const entry of existing) {
    if (entry.id === file.id) continue;
    const stored = await readHandle(entry.id);
    if (!stored) continue;
    let same = false;
    try {
      same = await handle.isSameEntry(stored);
    } catch {
      // A handle whose file is gone cannot be compared; it is not this one.
    }
    if (same) await deleteHandle(entry.id);
  }
  await writeHandle(file.id, file.name, handle);
  // Newest first; everything past the cap is the oldest.
  const kept = await listHandles();
  for (const stale of kept.slice(MAX_RECENT_HANDLES)) await deleteHandle(stale.id);
}

export async function listRecent(): Promise<RecentEntry[]> {
  return listHandles();
}

export async function reopenPersisted(id: string): Promise<OpenedFile | null> {
  const handle = await readHandle(id);
  if (!handle) return null;
  // Chrome drops permission between sessions, so a Recents click has to be allowed
  // to re-prompt rather than failing silently.
  if (!(await ensureReadPermission(handle))) return null;
  session.set(id, handle);

  let writable = false;
  if (hasFileSystemAccess()) {
    try {
      writable = (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
    } catch {
      // Ignore if queryPermission fails
    }
  }

  return {
    id,
    name: handle.name,
    getFile: () => handle.getFile(),
    persistable: true,
    writable
  };
}

export async function revokePersisted(id: string): Promise<void> {
  session.delete(id);
  await deleteHandle(id);
}

/**
 * How long the focus heuristic waits after the window regains focus before it
 * gives up on a `change` event. Only used where the `cancel` event does not
 * exist. Audit 2026-09-25 PLT-19: this was 300 ms and applied everywhere, so a
 * slow selection (a cloud-backed file, a network share) whose `change` event
 * arrived later was reported as a cancel and silently dropped.
 */
export const FOCUS_CANCEL_FALLBACK_MS = 3_000;

/** Whether this browser fires `cancel` on a dismissed `<input type=file>`. */
function supportsInputCancelEvent(): boolean {
  return typeof HTMLInputElement !== 'undefined' && 'oncancel' in HTMLInputElement.prototype;
}

/** Fallback: `<input type=file>`, for browsers without the picker (Firefox). */
export function openFilesViaInput(options?: OpenOptions): Promise<OpenedFile[]> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    if (options?.multiple) input.multiple = true;
    if (options?.accept) {
      input.accept = Object.entries(options.accept)
        .flatMap(([mime, extensions]) => [mime, ...extensions])
        .join(',');
    }

    const pickedFiles = (): FileList | null =>
      input.files && input.files.length > 0 ? input.files : null;

    let settled = false;
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (files: FileList | null) => {
      if (settled) return;
      settled = true;
      if (focusTimer !== undefined) clearTimeout(focusTimer);
      window.removeEventListener('focus', onWindowFocus);
      resolve(
        Array.from(files ?? []).map(file => ({
          id: crypto.randomUUID(),
          name: file.name,
          getFile: async () => file,
          persistable: false,
          writable: false
        }))
      );
      input.remove();
    };

    // A dismissed picker fires `cancel` (Chrome 113+, Firefox 91+, Safari 16.4+
    // — every browser at or above the manifest floors). It is the only reliable
    // "closed without a choice" signal, so it is authoritative wherever it
    // exists. Even then, re-check `input.files`: a selection that has landed is
    // never thrown away because of event ordering.
    //
    // Only where `cancel` does not exist (some Android WebViews) is window focus
    // used instead, since without *some* signal the Promise — and the job
    // awaiting it — would hang forever. It waits several seconds, re-checks the
    // input, and any `change` that fires first still wins.
    const onWindowFocus = () => {
      if (focusTimer !== undefined) clearTimeout(focusTimer);
      focusTimer = setTimeout(() => settle(pickedFiles()), FOCUS_CANCEL_FALLBACK_MS);
    };

    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.top = '0';
    input.style.width = '1px';
    input.style.height = '1px';
    input.style.opacity = '0';
    input.style.pointerEvents = 'none';
    document.body.append(input);
    input.addEventListener('change', () => settle(pickedFiles()), { once: true });
    input.addEventListener('cancel', () => settle(pickedFiles()), { once: true });
    if (!supportsInputCancelEvent()) window.addEventListener('focus', onWindowFocus);
    input.click();
  });
}

/** Bytes a single `Blob` part copies in one task (NFR-02, 50 ms main-thread budget). */
const BLOB_SLICE = 4 * 1024 * 1024;

/**
 * `bytes` as a Blob, without one long main-thread copy.
 *
 * `new Blob([bytes])` copies synchronously; a 50 MB merge output took ~40 ms in
 * one task, and the old `bytes.slice()` in front of it (to drop the rest of a
 * shared buffer — unnecessary, since a view part contributes only the bytes it
 * covers) another ~50 ms. Large outputs are now copied a few megabytes per task
 * and stitched together by reference.
 */
async function blobInSlices(bytes: Uint8Array, type: string): Promise<Blob> {
  // Blob takes no SharedArrayBuffer-backed view; copy in that (never expected) case.
  const own = bytes.buffer instanceof ArrayBuffer ? bytes : bytes.slice();
  if (own.byteLength <= BLOB_SLICE) return new Blob([own], { type });
  const parts: Blob[] = [];
  for (let at = 0; at < own.byteLength; at += BLOB_SLICE) {
    parts.push(new Blob([own.subarray(at, at + BLOB_SLICE)]));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return new Blob(parts, { type });
}

/**
 * Fallback: anchor download, for saving without the picker.
 *
 * The `<a download>` technique has no completion event and no error channel —
 * once `anchor.click()` returns, the actual save is entirely up to the browser
 * and OS, invisible to this page. There is no browser API that reports back
 * whether it succeeded, so the boolean this returns can only ever mean
 * "the download was *started* without an immediate synchronous failure," not
 * "the file was saved" — callers should not treat `true` as a completion
 * guarantee the way `saveViaPicker`'s real success/failure result is.
 */
export async function saveViaDownload(bytes: Uint8Array, suggestedName: string): Promise<boolean> {
  try {
    const blob = await blobInSlices(bytes, mimeForName(suggestedName));
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = suggestedName;
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    let revoked = false;
    const cleanup = () => {
      if (revoked) return;
      revoked = true;
      URL.revokeObjectURL(url);
      window.removeEventListener('focus', cleanup);
    };
    window.addEventListener('focus', cleanup);
    setTimeout(cleanup, 60_000);
    return true;
  } catch {
    return false;
  }
}

export { hasFileSystemAccess };

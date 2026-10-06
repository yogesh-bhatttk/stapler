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
  ensureWritePermission,
  hasDirectoryPicker,
  hasFileSystemAccess,
  isAbort,
  pickerTypes,
  showDirectoryPicker,
  showOpenFilePicker,
  showSaveFilePicker,
  type FsaFileHandle
} from './fsa';
import type { OpenOptions, OpenedFile, OutputDirectory, RecentEntry } from './index';
import { deleteHandle, listHandles, readHandle, writeHandle } from '../core/db';

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

export async function openDirectoryViaPicker(): Promise<OutputDirectory | null> {
  if (!hasDirectoryPicker()) return null;
  try {
    const directory = await showDirectoryPicker({ mode: 'readwrite' });
    if (!(await ensureWritePermission(directory))) return null;
    return {
      name: directory.name,
      write: async (fileName, bytes) => {
        const file = await directory.getFileHandle(fileName, { create: true });
        const writable = await file.createWritable();
        try {
          await writable.write(bytes);
          await writable.close();
        } catch (err) {
          // abort() discards the partial write atomically; ignore its own error.
          await (writable as unknown as { abort(): Promise<void> }).abort().catch(() => {});
          throw err;
        }
      }
    };
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
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
    const handle = await showSaveFilePicker({
      suggestedName,
      types: pickerTypes({ [mime]: [extension] }, 'Saved file')
    });
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

export async function saveOverHandle(fileId: string, bytes: Uint8Array): Promise<boolean> {
  const handle = session.get(fileId) ?? (await readHandle(fileId));
  if (!handle) return false;
  if (!(await ensureWritePermission(handle))) return false;
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
      if ((await handle.requestPermission({ mode: 'readwrite' })) === 'granted') {
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

/** DS-05 Recents: handles survive a reload; permission is re-requested on reopen. */
export async function persistFileHandle(file: OpenedFile): Promise<void> {
  const handle = session.get(file.id);
  if (!handle) return;
  await writeHandle(file.id, file.name, handle);
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

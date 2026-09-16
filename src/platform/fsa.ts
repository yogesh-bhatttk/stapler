/**
 * File System Access API, typed.
 *
 * The DOM lib does not yet declare these, and the previous code reached for them
 * through `(window as any)` at nine call sites with an eslint-disable on each. One
 * narrow declaration is both safer and shorter, and it keeps the `any` count at
 * zero (TICKETS definition of done).
 *
 * Using this API rather than the `downloads` permission is what keeps the install
 * dialog free of warnings (PLAN §2.5).
 */

export interface FsaWritable {
  write(data: Uint8Array | Blob): Promise<void>;
  close(): Promise<void>;
}

export interface FsaFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<FsaWritable>;
  queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  isSameEntry(other: FsaFileHandle): Promise<boolean>;
}

export interface FsaDirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsaFileHandle>;
  queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  isSameEntry?(other: unknown): Promise<boolean>;
}

interface FsaPickerTypes {
  description?: string;
  accept: Record<string, string[]>;
}

interface FsaWindow {
  showOpenFilePicker?(options?: {
    multiple?: boolean;
    excludeAcceptAllOption?: boolean;
    types?: FsaPickerTypes[];
  }): Promise<FsaFileHandle[]>;
  showSaveFilePicker?(options?: {
    suggestedName?: string;
    types?: FsaPickerTypes[];
  }): Promise<FsaFileHandle>;
  showDirectoryPicker?(options?: { mode?: 'read' | 'readwrite' }): Promise<FsaDirectoryHandle>;
}

const fsa = globalThis as unknown as FsaWindow;

export const hasFileSystemAccess = (): boolean =>
  typeof fsa.showOpenFilePicker === 'function' && typeof fsa.showSaveFilePicker === 'function';

export const hasDirectoryPicker = (): boolean => typeof fsa.showDirectoryPicker === 'function';

export function showOpenFilePicker(options?: {
  multiple?: boolean;
  types?: FsaPickerTypes[];
}): Promise<FsaFileHandle[]> {
  if (!fsa.showOpenFilePicker) throw new Error('showOpenFilePicker is unavailable');
  return fsa.showOpenFilePicker(options);
}

export function showSaveFilePicker(options?: {
  suggestedName?: string;
  types?: FsaPickerTypes[];
}): Promise<FsaFileHandle> {
  if (!fsa.showSaveFilePicker) throw new Error('showSaveFilePicker is unavailable');
  return fsa.showSaveFilePicker(options);
}

export function showDirectoryPicker(options?: {
  mode?: 'read' | 'readwrite';
}): Promise<FsaDirectoryHandle> {
  if (!fsa.showDirectoryPicker) throw new Error('showDirectoryPicker is unavailable');
  return fsa.showDirectoryPicker(options);
}

/** Turns an accept map into picker `types`. */
export function pickerTypes(
  accept: Record<string, string[]> | undefined,
  description = 'Documents'
): FsaPickerTypes[] | undefined {
  return accept ? [{ description, accept }] : undefined;
}

/**
 * True when the user dismissed a picker, or the browser refused to even show
 * one — not an error worth reporting. Chromium throws `NotAllowedError`
 * (not `AbortError`) when a file-picker call isn't the direct result of a
 * user gesture, e.g. the page lost focus between the click and the picker
 * call; treated the same as a dismissed picker (silently return to the
 * caller's "nothing happened" path) rather than falling through to a
 * generic `InternalError` that reads as "Stapler crashed" for what is really
 * "just click the button again."
 */
export function isAbort(err: unknown): boolean {
  return (
    err instanceof DOMException && (err.name === 'AbortError' || err.name === 'NotAllowedError')
  );
}

/**
 * Ensures write permission, re-prompting if a persisted handle has gone stale.
 * Chrome drops permission between sessions, which is what makes Recents need this.
 */
export async function ensureWritePermission(
  handle: FsaFileHandle | FsaDirectoryHandle
): Promise<boolean> {
  if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

export async function ensureReadPermission(handle: FsaFileHandle): Promise<boolean> {
  if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return true;
  return (await handle.requestPermission({ mode: 'read' })) === 'granted';
}

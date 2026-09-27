/**
 * GAP-2 — "Open with Stapler" for the installed web app.
 *
 * `manifest.webmanifest` declares `file_handlers` for PDFs and the supported
 * image types; when the OS opens files with the app, Chromium hands their
 * handles to the page through `window.launchQueue`. They are real File System
 * Access handles, so they are wrapped exactly like a picker's
 * (`wrapFileHandle`): "Save" can then write back to the file that was opened.
 */
import type { OpenedFile } from '../index';
import type { FsaFileHandle } from '../fsa';
import { wrapFileHandle } from '../file-system';

/** The Launch Handler API surface used here (not yet in the DOM lib). */
export interface LaunchParamsLike {
  readonly files?: readonly { readonly kind: string }[];
}

export interface LaunchQueueLike {
  setConsumer(consumer: (params: LaunchParamsLike) => void): void;
}

export interface LaunchedFiles {
  files: File[];
  handles: OpenedFile[];
}

const isFileHandle = (value: { readonly kind: string }): value is FsaFileHandle =>
  value.kind === 'file' && typeof (value as Partial<FsaFileHandle>).getFile === 'function';

/**
 * Registers `onLaunch` for files the OS launches the app with. Returns false
 * when the browser has no `launchQueue` (not installed, or not Chromium).
 * Directories and handles that can no longer be read are skipped.
 */
export function consumeLaunchQueue(
  target: { launchQueue?: LaunchQueueLike },
  onLaunch: (launched: LaunchedFiles) => void
): boolean {
  const queue = target.launchQueue;
  if (!queue || typeof queue.setConsumer !== 'function') return false;
  queue.setConsumer(params => {
    void (async () => {
      const handles = (params.files ?? []).filter(isFileHandle);
      const results = await Promise.allSettled(handles.map(handle => handle.getFile()));
      const launched: LaunchedFiles = { files: [], handles: [] };
      results.forEach((result, index) => {
        if (result.status !== 'fulfilled') return;
        launched.files.push(result.value);
        launched.handles.push(wrapFileHandle(handles[index]));
      });
      if (launched.files.length > 0) onLaunch(launched);
    })();
  });
  return true;
}

/**
 * GAP-2 — files handed to the app from outside the page: the installed web
 * app's "Open with" (`launchQueue`) and the OS share sheet (`share_target`).
 *
 * Both arrive before or independently of the app tree, and opening them needs
 * the app shell's image-options dialog, so they are queued here and drained by
 * `useExternalOpen` (mounted once, in `AppShell`), which runs them through the
 * same `importFilesAsDocuments` path as a drop or the file picker.
 */
import { signal } from '@preact/signals';
import type { OpenedFile } from '../platform/index';

export interface ExternalOpenRequest {
  files: File[];
  /** File System Access handles, when the files came with them (launchQueue). */
  handles?: OpenedFile[];
}

export const pendingExternalOpens = signal<readonly ExternalOpenRequest[]>([]);

export function queueExternalOpen(request: ExternalOpenRequest): void {
  if (request.files.length === 0) return;
  pendingExternalOpens.value = [...pendingExternalOpens.value, request];
}

/** Removes and returns every queued request, oldest first. */
export function takeExternalOpens(): ExternalOpenRequest[] {
  const queued = [...pendingExternalOpens.value];
  if (queued.length > 0) pendingExternalOpens.value = [];
  return queued;
}

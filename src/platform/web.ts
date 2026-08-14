/**
 * Website-twin target (DIST-03).
 *
 * Chrome and Edge give the same File System Access API here, so the web build is
 * not a degraded experience — it only falls back on Firefox and Safari, where
 * `<input type=file>` plus a download is the best available (PLAN §2.5).
 */
import type { PlatformAdapter } from './index';
import {
  hasFileSystemAccess,
  listRecent,
  openDirectoryViaPicker,
  openFilesViaInput,
  openFilesViaPicker,
  persistFileHandle,
  reopenPersisted,
  revokePersisted,
  saveOverHandle,
  saveViaDownload,
  saveViaPicker,
  readClipboardImage
} from './file-system';

export const webPlatform: PlatformAdapter = {
  kind: 'web',
  supportsFileSystemAccess: hasFileSystemAccess(),

  openFiles: options =>
    hasFileSystemAccess() ? openFilesViaPicker(options) : openFilesViaInput(options),
  openDirectory: openDirectoryViaPicker,
  saveFileAs: async (bytes, name) =>
    hasFileSystemAccess() ? saveViaPicker(bytes, name) : saveViaDownload(bytes, name),
  saveOver: async (fileId, bytes) =>
    hasFileSystemAccess() ? saveOverHandle(fileId, bytes) : false,
  persistHandle: async file => {
    // Without the picker there is no handle to persist, so Recents is simply
    // absent rather than showing entries that cannot be reopened.
    if (hasFileSystemAccess()) await persistFileHandle(file);
  },
  restoreHandles: async () => (hasFileSystemAccess() ? listRecent() : []),
  reopenHandle: async id => (hasFileSystemAccess() ? reopenPersisted(id) : null),
  revokeHandle: revokePersisted,
  readClipboardImage
};

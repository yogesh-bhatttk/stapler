/**
 * Extension target. Everything runs in an extension page, where the File System
 * Access API is available and needs no manifest permission — which is what keeps
 * the install dialog free of warnings (F-02).
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
  saveViaPicker
} from './file-system';

export const extensionPlatform: PlatformAdapter = {
  kind: 'extension',
  supportsFileSystemAccess: hasFileSystemAccess(),

  openFiles: options =>
    hasFileSystemAccess() ? openFilesViaPicker(options) : openFilesViaInput(options),
  openDirectory: openDirectoryViaPicker,
  saveFileAs: async (bytes, name) =>
    hasFileSystemAccess() ? saveViaPicker(bytes, name) : saveViaDownload(bytes, name),
  saveOver: saveOverHandle,
  persistHandle: persistFileHandle,
  restoreHandles: listRecent,
  reopenHandle: reopenPersisted,
  revokeHandle: revokePersisted
};

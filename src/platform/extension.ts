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
  saveViaPicker,
  readClipboardImage
} from './file-system';
import { isNavigateMessage } from '../core/navigate-message';

/**
 * GAP-7 — the service worker's "open this tool" message reaches every open
 * extension page, so each editor tab answers only for its own tab id, looked
 * up once (`tabs.getCurrent` needs no permission). A tab that is not the
 * target returns nothing synchronously, which lets the sender's promise settle
 * on the target's answer instead of waiting on every page.
 */
function onExternalNavigate(handler: (route: string) => void): () => void {
  let ownTabId: number | undefined;
  void chrome.tabs
    .getCurrent()
    .then(tab => {
      ownTabId = tab?.id;
    })
    .catch(() => {});

  const listener = (message: unknown, _sender: unknown, sendResponse: (reply: boolean) => void) => {
    if (!isNavigateMessage(message) || ownTabId === undefined) return;
    if (message.tabId !== ownTabId) return;
    handler(message.route);
    sendResponse(true);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

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
  revokeHandle: revokePersisted,
  readClipboardImage,
  onExternalNavigate
};

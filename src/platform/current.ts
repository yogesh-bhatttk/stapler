/**
 * Picks the adapter for the running target.
 *
 * Split out of `index.ts` so that importing the *interface* does not pull both
 * implementations — and with them `chrome.*` — into the website bundle.
 */
import { extensionPlatform } from './extension';
import { webPlatform } from './web';
import type { PlatformAdapter } from './index';

const isExtension =
  typeof chrome !== 'undefined' && Boolean(chrome.runtime) && Boolean(chrome.runtime?.id);

export const platform: PlatformAdapter = isExtension ? extensionPlatform : webPlatform;

/**
 * GAP-2 — the website twin as an installable, offline-capable app. Called from
 * every web entry page (`app.tsx`, `mountLanding.tsx`); a no-op in the
 * extension, which is offline by construction and ships no service worker.
 *
 *  - registers `sw.js` (built by `scripts/pwa.mjs` for the web target only)
 *    and offers a reload, as a toast, when a new version has installed;
 *  - queues files the OS opens with the installed app (`launchQueue`) and
 *    files shared to it (`share_target`, stored by the worker) for
 *    `useExternalOpen` to import.
 */
import { platform } from '../platform/current';
import { consumeLaunchQueue, type LaunchQueueLike } from '../platform/pwa/launch-queue';
import { registerServiceWorker } from '../platform/pwa/register';
import { takeSharedFiles } from '../platform/pwa/share-inbox';
import { SHARE_TARGET_PARAM } from '../platform/pwa/sw-routing';
import { queueExternalOpen } from '../core/external-open';
import { notify } from '../core/notify';
import { translate } from '../core/i18n';

/**
 * The e2e build (`VITE_E2E_TEST_HOOKS`) registers the worker only when a test
 * opts in, so the other suites — the perf budgets above all — are not timed
 * while ~20 MB precaches in the background.
 */
export const E2E_SW_OPT_IN_KEY = 'stapler:e2e-service-worker';

function shouldRegister(): boolean {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return false;
  if (import.meta.env.VITE_E2E_TEST_HOOKS !== 'true') return true;
  try {
    return localStorage.getItem(E2E_SW_OPT_IN_KEY) === '1';
  } catch {
    return false;
  }
}

async function receiveSharedFiles(): Promise<void> {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(SHARE_TARGET_PARAM)) return;
  url.searchParams.delete(SHARE_TARGET_PARAM);
  // A reload must not look for the same files again.
  history.replaceState(history.state, '', url.href);
  let files: File[];
  try {
    files = typeof caches === 'undefined' ? [] : await takeSharedFiles(caches);
  } catch {
    files = [];
  }
  if (files.length > 0) {
    queueExternalOpen({ files });
    return;
  }
  notify('warning', translate('The shared files could not be received.'), {
    detail: translate('Share them again, or open them with the file picker.')
  });
}

/**
 * `true` in the web build, `false` in the extension builds (`define` in
 * vite.config.ts), so an extension bundle carries none of this code. Absent
 * under vitest.
 */
declare const __STAPLER_WEB_BUILD__: boolean | undefined;
const WEB_BUILD = typeof __STAPLER_WEB_BUILD__ !== 'undefined' && __STAPLER_WEB_BUILD__;

export function startWebApp(): void {
  if (!WEB_BUILD || platform.kind !== 'web') return;

  consumeLaunchQueue(window as { launchQueue?: LaunchQueueLike }, launched =>
    queueExternalOpen(launched)
  );
  void receiveSharedFiles();

  if (!shouldRegister()) return;
  const base = import.meta.env.BASE_URL;
  void registerServiceWorker({
    container: navigator.serviceWorker,
    url: `${base}sw.js`,
    scope: base,
    reload: () => window.location.reload(),
    onUpdateReady: apply =>
      notify('info', translate('A new version of Stapler is ready.'), {
        detail: translate('Reload to start using it.'),
        timeout: 0,
        action: { label: translate('Reload'), run: apply }
      })
  }).catch(() => {
    // No worker (private mode, a blocked registration): the site still works
    // online, it just is not available offline. Nothing to tell the user.
  });
}

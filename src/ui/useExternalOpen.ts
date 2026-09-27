/**
 * GAP-2 — drains `core/external-open.ts`: files the OS opened with, or shared
 * to, the installed web app become documents through the same
 * `importFilesAsDocuments` path as a drop or the file picker (so the restore
 * prompt, the job lock and the image-options dialog all apply). Launched
 * files' handles are remembered in Recents like a picker's.
 */
import { useEffect, useRef } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { importFilesAsDocuments, type ImportFilesDeps } from '../core/open-document';
import { pendingExternalOpens, takeExternalOpens } from '../core/external-open';
import { platform } from '../platform/current';
import { toolRoute } from '../core/tools';

export function useExternalOpen(requestImageOptions: ImportFilesDeps['requestImageOptions']) {
  const [location, setLocation] = useLocation();
  // Read when an import finishes, not when the subscription was made.
  const where = useRef({ location, setLocation });
  where.current = { location, setLocation };

  useEffect(() => {
    let running = false;
    const drain = async () => {
      if (running) return;
      running = true;
      try {
        for (let batch = takeExternalOpens(); batch.length > 0; batch = takeExternalOpens()) {
          for (const request of batch) {
            for (const handle of request.handles ?? []) {
              if (handle.persistable) await platform.persistHandle(handle).catch(() => undefined);
            }
            const result = await importFilesAsDocuments(request.files, {
              handles: request.handles,
              requestImageOptions
            });
            // Same as a drop on Home: show what was opened. From inside a
            // tool the new document just becomes the active tab.
            if (result.imported > 0 && where.current.location === '/') {
              where.current.setLocation(toolRoute('organize'));
            }
          }
        }
      } finally {
        running = false;
      }
    };
    // `subscribe` fires immediately with the current value, which also covers
    // files queued before the shell mounted.
    return pendingExternalOpens.subscribe(queued => {
      if (queued.length > 0) void drain();
    });
    // `requestImageOptions` is recreated each render but always opens the same
    // shell dialog (its state lives in refs/setters); subscribing once is intended.
  }, []);
}

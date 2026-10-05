/**
 * Export-wide settings: choices that apply to every single-PDF export, whichever
 * tool produced it, rather than to one tool's panel.
 *
 * HRD-23 / DOC-08 — `fastWebViewExport`. Off by default, because DOC-05's
 * object-stream save is smaller. On, every single-PDF export is rewritten so page
 * 1's objects come first with a plain xref (`core/pdf/fast-web-view.ts`), which
 * lets a viewer that streams the file show page 1 before the rest arrives.
 *
 * Persisted in the app's own IndexedDB settings store (`core/db.ts`), like the
 * theme and shortcuts. It is switched in the export review dialog, the one step
 * every reviewed export passes through; exports that skip the review still read
 * the persisted value in `commit.ts`.
 */
import { signal } from '@preact/signals';
import { readSetting, writeSetting } from '../../core/db';

const FAST_WEB_VIEW_KEY = 'export.fastWebView';

export const fastWebViewExport = signal<boolean>(false);

let loaded: Promise<void> | null = null;
// Set once the user changes the option this session, so a slow settings read
// landing afterwards does not overwrite the fresher choice.
let touched = false;

/** Loads the remembered export settings once per session; later calls reuse it. */
export function loadExportSettings(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      try {
        const value = await readSetting<unknown>(FAST_WEB_VIEW_KEY);
        if (typeof value === 'boolean' && !touched) fastWebViewExport.value = value;
      } catch {
        // Unreadable storage: keep the default; nothing to recover.
      }
    })();
  }
  return loaded;
}

export function setFastWebViewExport(on: boolean): void {
  touched = true;
  fastWebViewExport.value = on;
  void writeSetting(FAST_WEB_VIEW_KEY, on).catch(() => {});
}

export function __resetExportSettingsForTests(): void {
  loaded = null;
  touched = false;
  fastWebViewExport.value = false;
}

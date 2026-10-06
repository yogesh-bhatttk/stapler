/**
 * GAP-7 — the release notes behind the "What's new" page, and the rule for
 * when the service worker opens it.
 *
 * Deliberately import-free apart from `tKey` (itself import-free): the
 * extension's service worker imports this module, and anything heavier here
 * would be bundled into `background.js`.
 *
 * Each item is a translation key, translated where it is rendered. Newest
 * release first. A version with no entry here never opens the page on
 * update — a patch release with nothing user-visible should not interrupt
 * anyone — so adding the entry is part of cutting a release that has news.
 */
import { tKey } from '../../core/i18n/key';

export interface ReleaseNotes {
  /** Exactly the manifest's `version`. */
  version: string;
  /** Translation keys, one sentence each. */
  items: readonly string[];
}

export const RELEASES: readonly ReleaseNotes[] = [
  {
    version: '0.3.0',
    items: [
      tKey(
        'New: Fast web view saves PDFs with page 1 first, so a browser can show it before the rest has loaded.'
      ),
      tKey(
        'New: Compress can turn scans grey or black and white, and never saves a file larger than the original.'
      ),
      tKey('New: Image to size and PDF to images can produce an exact width and height.'),
      tKey(
        'New: Folder search can read scanned pages with OCR, after you approve the one-time model download.'
      ),
      tKey(
        'Redaction now also removes content hidden in repeating patterns and thick strokes, and checks the result.'
      )
    ]
  },
  {
    version: '0.2.1',
    items: [
      tKey(
        'Switching tools or documents while a job runs no longer interrupts it or drops the unsaved-changes warning.'
      ),
      tKey(
        'Compress, Redact, Scan cleanup, OCR and Batch handle damaged and unusual files more safely.'
      ),
      tKey('Every screen is now translated into all 11 supported languages.')
    ]
  },
  {
    version: '0.2.0',
    items: [
      tKey('New, in beta: PDF to Word and Word to PDF.'),
      tKey('New, in beta: PDF to Excel and Excel to PDF.'),
      tKey('New, in beta: PDF to PowerPoint and PowerPoint to PDF.')
    ]
  }
];

export function releaseNotesFor(version: string): ReleaseNotes | undefined {
  return RELEASES.find(release => release.version === version);
}

export interface WhatsNewInput {
  /** The `reason` of the extension's install/update event. */
  reason: string;
  previousVersion?: string;
  currentVersion: string;
  /** The version the page was last opened for, if it ever was. */
  lastShownVersion?: string;
}

/**
 * Open "What's new" only for a real update to a version that has notes, and
 * never twice for the same version.
 *
 * - `install` is excluded: the welcome dialog already covers a first run.
 * - Chrome also fires `update` when an unpacked extension is reloaded without
 *   a version change (`previousVersion === currentVersion`); that is not news.
 * - `lastShownVersion` covers the rest — a reinstall-free downgrade and
 *   re-upgrade, or the event firing twice.
 */
export function shouldShowWhatsNew(input: WhatsNewInput): boolean {
  if (input.reason !== 'update') return false;
  if (input.previousVersion === input.currentVersion) return false;
  if (input.lastShownVersion === input.currentVersion) return false;
  return releaseNotesFor(input.currentVersion) !== undefined;
}

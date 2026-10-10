/**
 * What the drop zone accepts, split out so it is testable without a DOM.
 *
 * During a drag the browser exposes each item's MIME type but not its name, and
 * some files have no MIME type at all — macOS reports HEIC as '' (AUDIT-2026-10-10
 * UI7). Such an item may well be one Stapler opens, so it is accepted while
 * dragging, and the real check happens on drop, where the file name is known
 * (`isPdfFile` / `isSupportedImage`, both of which fall back to the extension).
 */
import { isPdfFile } from '../../core/import';
import { isSupportedImage } from '../../core/image';

/** The parts of a `DataTransferItem` the decision reads. */
export interface DragItemLike {
  kind: string;
  type: string;
}

/**
 * 'accept' when some item is a PDF or an image by MIME type, 'maybe' when none
 * is but some file item has no MIME type, 'reject' otherwise.
 */
export function classifyDragItems(items: Iterable<DragItemLike>): 'accept' | 'maybe' | 'reject' {
  let maybe = false;
  for (const item of items) {
    if (item.kind !== 'file') continue;
    if (item.type === 'application/pdf' || item.type.startsWith('image/')) return 'accept';
    if (item.type === '') maybe = true;
  }
  return maybe ? 'maybe' : 'reject';
}

/** Whether a dropped file is one the import pipeline can open, by type or extension. */
export function isOpenableFile(file: File): boolean {
  return isPdfFile(file) || isSupportedImage(file);
}

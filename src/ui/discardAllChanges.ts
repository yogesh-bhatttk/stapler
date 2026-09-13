/**
 * "Discard all changes" — reverts a document's page structure to its
 * baseline (the last import/save) and clears every other pending edit
 * alongside it: crop, watermark/header-footer/Bates/barcode, N-up, this
 * document's loaded outline, redaction marks, and page annotations.
 *
 * Lives here rather than inside one tool's panel because it isn't specific
 * to any one tool — a rotation done in Organize, a crop box, and a
 * watermark are all "changes to this document" regardless of which panel
 * happens to be open when the user wants out of all of them at once. The
 * action bar renders it on every tool screen for exactly that reason.
 */
import { confirmAction } from '../core/notify';
import { translate } from '../core/i18n';
import { clearPageSelection, discardPageChanges, type StaplerDoc } from '../core/store';
import { cropBoxes } from './tools/crop/state';
import { pageAnnotations } from './tools/annotate/state';
import { resetStampSettings } from './tools/watermark/state';
import { nupSettings } from './tools/nup/state';
import { resetOutlineIfLoaded } from './tools/outline/state';
import { resetRedactionState } from './tools/redact/state';

/**
 * Prompts for confirmation, then applies the reset if the user agrees.
 * Returns whether it actually happened, in case a caller wants to react.
 */
export async function confirmAndDiscardAllChanges(doc: StaplerDoc): Promise<boolean> {
  const confirmed = await confirmAction({
    title: translate('Discard all changes to this document?'),
    body: translate(
      'Rotation, reordering, deletions, and duplicates revert to how this document looked when it was last opened or saved. Crop, watermark, header/footer, Bates, barcode, N-up, bookmarks, redaction marks, and annotations are cleared too — those apply to every open document, not just this one, and clearing them here is not undoable with ⌘Z the way the page list is.'
    ),
    confirmLabel: translate('Discard everything'),
    cancelLabel: translate('Keep my changes'),
    tone: 'danger'
  });
  if (!confirmed) return false;

  // Collected before `discardPageChanges` replaces `doc.pages`, so a crop box
  // or annotation set on a page since removed is cleared too, not just ones
  // on pages that survive the revert.
  const keys = new Set([...doc.pages.map(p => p.key), ...doc.baseline.map(p => p.key)]);
  discardPageChanges(doc.id);

  const nextCropBoxes = { ...cropBoxes.value };
  for (const key of keys) delete nextCropBoxes[key];
  cropBoxes.value = nextCropBoxes;

  const nextAnnotations = { ...pageAnnotations.value };
  for (const key of keys) delete nextAnnotations[key];
  pageAnnotations.value = nextAnnotations;

  resetStampSettings();
  nupSettings.value = null;
  resetOutlineIfLoaded(doc.id);
  resetRedactionState();
  clearPageSelection();
  return true;
}

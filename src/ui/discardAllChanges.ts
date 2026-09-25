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
import {
  batesSettings,
  barcodeStampSettings,
  hasHeaderFooterContent,
  hasWatermarkContent,
  headerFooterSettings,
  resetStampSettings,
  watermarkSettings
} from './tools/watermark/state';
import { nupSettings } from './tools/nup/state';
import { outlineDocId, outlineEdited, resetOutlineIfLoaded } from './tools/outline/state';
import { pendingRedactions, resetRedactionState } from './tools/redact/state';

/**
 * Whether there is actually anything `confirmAndDiscardAllChanges` would
 * revert or clear — every source it touches, checked read-only. The action
 * bar uses this to decide whether to offer the action at all: without it, the
 * button sat there fully enabled on a document nobody had touched yet,
 * popping a "danger" confirmation for a click that would have discarded
 * nothing.
 */
export function hasAnythingToDiscard(doc: StaplerDoc): boolean {
  // Mirrors `refreshBaseline`/`addDocument`: baseline is only ever a *new*
  // array once a mutation (rotate/reorder/delete/duplicate) has actually
  // happened, so reference inequality is exactly "the page list changed",
  // not merely "an array was recreated".
  if (doc.pages !== doc.baseline) return true;
  // Stamps and form fields placed with Sign — with nothing else changed, the
  // action used not to be offered at all (UI-14).
  if (doc.annotations.length > 0) return true;

  const keys = [...doc.pages, ...doc.baseline].map(p => p.key);
  if (keys.some(key => cropBoxes.value[key])) return true;
  if (keys.some(key => pageAnnotations.value[key]?.length)) return true;

  if (hasWatermarkContent(watermarkSettings.value)) return true;
  if (hasHeaderFooterContent(headerFooterSettings.value)) return true;
  if (batesSettings.value.enabled) return true;
  if (barcodeStampSettings.value.enabled) return true;
  if (nupSettings.value !== null) return true;
  if (outlineDocId.value === doc.id && outlineEdited.value) return true;
  if (pendingRedactions.value.length > 0) return true;

  return false;
}

/**
 * Prompts for confirmation, then applies the reset if the user agrees.
 * Returns whether it actually happened, in case a caller wants to react.
 */
// `confirmAction`'s `confirmRequest` is a single global signal (`core/notify.ts`)
// — a second call before the first resolves replaces it outright, silently
// orphaning the first `await` forever (nothing ever calls its `resolve`,
// since the dialog now shows the *second* request). A fast double-click,
// before the modal has actually mounted to swallow the second click, is
// exactly that: two overlapping calls into the same confirm. Guarded at
// module scope, not component state, so it holds regardless of which button
// (Organize's, or another tool's — this is rendered on every tool's action
// bar) fired it.
let discardInFlight = false;

export async function confirmAndDiscardAllChanges(doc: StaplerDoc): Promise<boolean> {
  if (discardInFlight) return false;
  discardInFlight = true;
  try {
    return await discardAllChangesFlow(doc);
  } finally {
    discardInFlight = false;
  }
}

async function discardAllChangesFlow(doc: StaplerDoc): Promise<boolean> {
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

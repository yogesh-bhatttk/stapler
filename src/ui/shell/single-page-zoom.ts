/**
 * Pure zoom rules for `SinglePageView`, kept apart so they can be unit-tested
 * without a DOM.
 */

export const MIN_FIT_ZOOM = 0.1;
export const MAX_FIT_ZOOM = 8;

/**
 * UI-7 — the zoom that fits a `fitWidth`×`fitHeight` page inside the stage,
 * floored to a whole percent. Unrounded, every pixel of a window drag gave a
 * new zoom, and every new zoom a full worker render; floored, a drag changes
 * it a few times at most, and the page still fits.
 */
export function fitZoomFor(
  stage: { width: number; height: number },
  fitWidth: number,
  fitHeight: number
): number {
  if (!fitWidth || !fitHeight || !stage.width || !stage.height) return 1;
  const fit = Math.min(stage.width / fitWidth, stage.height / fitHeight);
  const floored = Math.floor(fit * 100 + 1e-9) / 100;
  return Math.min(MAX_FIT_ZOOM, Math.max(MIN_FIT_ZOOM, floored));
}

/**
 * UI-6 — whether `next` is a different document from `previous`: the view
 * gets no document id, but page keys are unique per page, so a page list
 * sharing no key with the last one is another document. An edit to the same
 * document (a rotate, a delete, an insert) always keeps some keys.
 */
export function isDifferentDocument(
  previous: readonly { key: string }[],
  next: readonly { key: string }[]
): boolean {
  if (previous === next) return false;
  if (previous.length === 0 || next.length === 0) return previous.length !== next.length;
  const keys = new Set(previous.map(page => page.key));
  return !next.some(page => keys.has(page.key));
}

/**
 * UI-6 — what a manual zoom is remembered against. The same document and the
 * same displayed page size and rotation keep it while paging; anything else
 * re-fits, so the new page is visible in full.
 */
export function zoomContextKey(
  documentGeneration: number,
  fitWidth: number,
  fitHeight: number,
  rotation: number
): string {
  return `${documentGeneration}|${fitWidth}x${fitHeight}|${rotation}`;
}

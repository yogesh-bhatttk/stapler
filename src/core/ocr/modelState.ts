/**
 * OCR-01 — "has this language's model already been downloaded, with consent?"
 *
 * tesseract.js keeps its own IndexedDB cache of the traineddata and checks it
 * before fetching, so a second run would not hit the network even if nothing here
 * existed. That is not enough on its own for two reasons:
 *
 *  • The confirmation dialog has to be shown *before* the worker starts, which is
 *    before anything can consult tesseract's cache. Without a flag of our own we
 *    would either re-ask forever or ask nothing and let the library decide.
 *  • "The extension performs no fetch unless the user opts in" has to be provable
 *    without trusting a third-party library's cache semantics.
 *
 * The flag is written only after a run has actually succeeded, so a failed or
 * cancelled download leaves the user opted *out* and the dialog comes back.
 *
 * Uses the generic `settings` store from F-06; no schema change.
 */
import { readSetting, writeSetting } from '../db';

const KEY_PREFIX = 'ocr.modelDownloaded.';

function key(lang: string): string {
  return `${KEY_PREFIX}${lang}`;
}

/** True once this language's model has been downloaded after an explicit opt-in. */
export async function isModelDownloaded(lang: string): Promise<boolean> {
  return (await readSetting<boolean>(key(lang))) === true;
}

export async function markModelDownloaded(lang: string): Promise<void> {
  await writeSetting(key(lang), true);
}

/** Test and "reset my data" seam. */
export async function forgetModel(lang: string): Promise<void> {
  await writeSetting(key(lang), false);
}

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
import { deleteModelBytes, hasModelBytes } from '../opfs';
import { deleteCachedModel, hasCachedModel } from './tesseractCache';
import { OCR_LANGUAGES, splitLangCodes } from './model';

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

/** Every individual language code the catalogue can ever store a model for. */
function componentCodes(): string[] {
  return [...new Set(OCR_LANGUAGES.flatMap(lang => splitLangCodes(lang.code)))];
}

/**
 * Removes every trace of `lang`'s model — tesseract's cached copy, an uploaded
 * copy in OPFS, and the "downloaded with consent" flag — so the next OCR run
 * in that language asks again (audit 2026-09-25 CNV-8).
 */
export async function removeOcrModel(lang: string): Promise<void> {
  await deleteCachedModel(lang).catch(() => {});
  await deleteModelBytes(lang);
  await forgetModel(lang);
}

/** The component language codes that currently have model bytes stored locally. */
export async function listStoredOcrModels(): Promise<string[]> {
  const stored: string[] = [];
  for (const code of componentCodes()) {
    if ((await hasCachedModel(code)) || (await hasModelBytes(code))) stored.push(code);
  }
  return stored;
}

/** "Remove downloaded models" — every stored OCR model, downloaded or uploaded. */
export async function removeAllOcrModels(): Promise<void> {
  for (const code of componentCodes()) await removeOcrModel(code);
}

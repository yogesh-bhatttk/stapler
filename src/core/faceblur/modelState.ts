/**
 * RED-08 — "have the face-detector weights already been downloaded, with consent?"
 *
 * Same shape and same reasoning as `ocr/modelState.ts`: the OPFS cache in
 * `core/opfs.ts` would already stop a second download, but a flag of our own is
 * still needed, for two reasons.
 *
 *  • The confirmation has to be shown *before* anything is fetched or spawned,
 *    which is before the cache can be usefully consulted for the answer the
 *    dialog needs ("has this user ever agreed to this?").
 *  • "The extension performs no fetch unless the user opts in" has to be
 *    provable from our own state, not inferred from a cache a library owns.
 *
 * The flag is written only after a run has actually succeeded, so a failed
 * download or a cancelled run leaves the user opted *out* and the dialog comes
 * back.
 *
 * Uses the generic `settings` store from F-06; no schema change.
 */
import { readSetting, writeSetting } from '../db';

const KEY_PREFIX = 'faceblur.modelDownloaded.';

function key(modelId: string): string {
  return `${KEY_PREFIX}${modelId}`;
}

/** True once these weights have been downloaded after an explicit opt-in. */
export async function isFaceModelDownloaded(modelId: string): Promise<boolean> {
  return (await readSetting<boolean>(key(modelId))) === true;
}

export async function markFaceModelDownloaded(modelId: string): Promise<void> {
  await writeSetting(key(modelId), true);
}

/** Test and "reset my data" seam. */
export async function forgetFaceModel(modelId: string): Promise<void> {
  await writeSetting(key(modelId), false);
}

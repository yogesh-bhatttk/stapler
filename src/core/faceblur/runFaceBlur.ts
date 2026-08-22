/**
 * RED-08 — the orchestration a panel handler calls.
 *
 * Order matters here, and the order is the same one OCR-01 established: **ask
 * first, then do anything at all**. The confirmation resolves before the
 * weights are requested and before the detector is loaded into a worker, so a
 * declined dialog leaves no download, no model in memory, and no request.
 * `runFaceBlur` returning `null` is the "user said no" signal; it is not an
 * error and raises no toast of its own — the caller turns it into the visible,
 * persistent "this tool is off until you allow the download" state that RED-08
 * requires instead of a silent no-op.
 *
 * Two other properties this file is responsible for:
 *
 *  • **Logo-only mode needs no model at all.** Template matching is arithmetic.
 *    If the user only wants a marked logo blurred, nothing is downloaded and
 *    nothing is asked — checking for consent we do not need would train people
 *    to click through the dialog that does matter.
 *  • **One encode per image, not one per page.** A letterhead logo on 300 pages
 *    is one image XObject; it is decoded, detected, mosaicked and re-encoded
 *    once, then substituted into all 300 resource dictionaries.
 */
import { renderWorker, processWorker } from '../workers';
import { createJobHandle, type JobOptions } from '../workers/protocol';
import { confirmAction } from '../notify';
import { cancelled, internal } from '../errors';
import type { BlurImageRequest, BlurredImageResult } from '../workers/render.worker';
import type {
  PageImageRef,
  RedactedImageReplacements,
  RedactionRegion
} from '../workers/process.worker';
import type { UnitRect } from '../pdf/image-redaction';
import type { BlurStrength } from './blur';
import type { DetectedRegion } from './detect';
import { DEFAULT_MIN_SCORE } from './detect';
import { ensureFaceModelWeights } from './download';
import { isFaceModelDownloaded, markFaceModelDownloaded } from './modelState';
import { APPROX_SIZE_MB, FACE_MODEL_ID, FACE_MODEL_LABEL, MODEL_HOST } from './model';

export interface RunFaceBlurOptions extends JobOptions {
  /** Defaults to every page. */
  pageIndices?: number[];
  /** Off only when the user wants logo-only blurring. */
  detectFaces?: boolean;
  minScore?: number;
  strength?: BlurStrength;
  /**
   * A rectangle the user drew around a logo, in page space. Its pixels become
   * the template correlated against every image in scope.
   */
  logoRegion?: RedactionRegion;
  logoMinScore?: number;
}

export interface FaceBlurSkip {
  pageIndex: number;
  reason: string;
}

export interface FaceBlurReport {
  facesBlurred: number;
  logosBlurred: number;
  /** Distinct image XObjects rewritten — not pages, and not placements. */
  imagesChanged: number;
  imagesInspected: number;
  pagesTouched: number;
  skipped: FaceBlurSkip[];
  /** True when the weights were fetched during this run rather than read from cache. */
  downloadedModel: boolean;
}

export interface FaceBlurResult extends FaceBlurReport {
  bytes: Uint8Array;
}

/**
 * Disclosure copy for the one download this feature can make.
 *
 * Says what is downloaded, how big it is, from which host, that it happens
 * once, that the picture never goes anywhere, and — the part specific to this
 * feature, because people reasonably assume face detection means a server —
 * that detection itself runs on the device either way.
 */
export function faceModelConsentCopy(): { title: string; body: string } {
  return {
    title: `Download the ${FACE_MODEL_LABEL}?`,
    body:
      `Stapler works entirely offline except for this one file. To find faces in a picture it ` +
      `needs a detection model — about ${APPROX_SIZE_MB} MB — downloaded from ${MODEL_HOST}, ` +
      `the public npm mirror the detector is published on.\n\n` +
      `This happens once. The model then stays in this browser, and every later run works ` +
      `with no network at all. Your images are never uploaded: only the model comes down, ` +
      `nothing goes up, and the detection itself runs here on your device.`
    // Tone stays 'default': a disclosed, reversible download is not a
    // destructive action, and dressing it in danger styling would train users
    // to ignore the styling that does mean danger.
  };
}

/**
 * Blurs faces (and/or a marked logo) in the embedded images of `bytes`.
 *
 * Returns `null` if the user declined the model download. Throws
 * `UserCancelled` if they aborted a run that had already started — the two are
 * different events and the caller reports them differently.
 */
export async function runFaceBlur(
  bytes: Uint8Array,
  pageCount: number,
  options: RunFaceBlurOptions = {}
): Promise<FaceBlurResult | null> {
  const wantsFaces = options.detectFaces ?? true;
  const wantsLogo = options.logoRegion !== undefined;
  if (!wantsFaces && !wantsLogo) {
    throw internal('Face blur was asked to look for neither faces nor a logo.');
  }

  const pages = (options.pageIndices ?? Array.from({ length: pageCount }, (_, i) => i))
    .filter(index => index >= 0 && index < pageCount)
    .sort((a, b) => a - b);
  if (pages.length === 0) throw internal('No pages were selected for face blur.');

  // ---- 1. Consent, before anything at all happens. -------------------------
  let downloadedModel = false;
  let weights = null as Awaited<ReturnType<typeof ensureFaceModelWeights>> | null;
  if (wantsFaces) {
    const already = await isFaceModelDownloaded(FACE_MODEL_ID);
    if (!already) {
      const { title, body } = faceModelConsentCopy();
      const agreed = await confirmAction({
        title,
        body,
        confirmLabel: 'Download once',
        cancelLabel: 'Not now'
      });
      // Nothing has been spawned, opened, or requested at this point. Declining
      // is a clean no-op by construction, not by cleanup.
      if (!agreed) return null;
      downloadedModel = true;
    }
    weights = await ensureFaceModelWeights({
      signal: options.signal,
      onProgress: (fraction, label) => options.onProgress?.(fraction * 0.15, label)
    });
  }

  if (options.signal?.aborted) throw cancelled();

  // ---- 2. Which images are on which pages. ---------------------------------
  options.onProgress?.(0.18, 'Finding images');
  const plan = await processWorker.lease(api => api.planPageImages(bytes, pages));
  const skipped: FaceBlurSkip[] = plan.unaddressablePages.map(pageIndex => ({
    pageIndex,
    reason:
      'An image on this page is stored in a form Stapler cannot address for pixel-level ' +
      'editing, so it was left untouched.'
  }));

  if (plan.images.length === 0) {
    // The model was already downloaded and consented to above (if this run
    // needed faces at all) — recording that now, same as the other early
    // return below, is what stops the consent dialog from reappearing on the
    // next run just because this particular document had no images to check.
    if (downloadedModel) await markFaceModelDownloaded(FACE_MODEL_ID);
    return {
      bytes,
      facesBlurred: 0,
      logosBlurred: 0,
      imagesChanged: 0,
      imagesInspected: 0,
      pagesTouched: 0,
      skipped,
      downloadedModel
    };
  }

  // First placement wins: an image drawn on pages 3, 7 and 40 is decoded on
  // page 3 and never again. `placements` still remembers every slot it has to
  // be substituted into.
  const firstPlacement = new Map<number, PageImageRef>();
  const placements: PageImageRef[] = plan.images;
  for (const image of plan.images) {
    if (!firstPlacement.has(image.objectNumber)) firstPlacement.set(image.objectNumber, image);
  }

  const client = renderWorker.pin();
  const results = new Map<number, BlurredImageResult>();
  try {
    const info = await client.lease(api => api.loadDocument(bytes));
    try {
      // ---- 3. The logo template, if there is one. --------------------------
      let logoTemplate: { rgba: Uint8ClampedArray; width: number; height: number } | undefined;
      const forced = new Map<number, UnitRect[]>();
      if (options.logoRegion) {
        const marked = await processWorker.lease(api =>
          api.planImageRedactions(bytes, [options.logoRegion as RedactionRegion])
        );
        if (marked.length === 0) {
          throw internal(
            'The marked logo does not sit on top of an embedded image, so there are no pixels ' +
              'to match. Mark the logo where it is drawn as a picture, or use a redaction mark ' +
              'to remove it outright.'
          );
        }
        const source = marked[0];
        forced.set(source.objectNumber, source.rects);
        const crop = await client.lease(api =>
          api.extractImageRegion(
            info.handle,
            source.pageIndex,
            source.objectNumber,
            source.rects[0]
          )
        );
        if (!crop) {
          throw internal('The marked logo could not be read out of the image it sits on.');
        }
        logoTemplate = crop;
      }

      // ---- 4. Detect and mosaic, one decode per distinct image. ------------
      if (weights) await client.lease(api => api.loadFaceDetector(weights));

      const byPage = new Map<number, BlurImageRequest[]>();
      for (const [objectNumber, image] of firstPlacement) {
        const list = byPage.get(image.pageIndex) ?? [];
        list.push({ objectNumber, forcedRects: forced.get(objectNumber) });
        byPage.set(image.pageIndex, list);
      }

      let done = 0;
      for (const [pageIndex, requests] of byPage) {
        if (options.signal?.aborted) throw cancelled();
        const base = 0.2 + (done / byPage.size) * 0.6;
        options.onProgress?.(base, `Checking page ${pageIndex + 1} of ${pageCount}`);
        done += 1;

        const pageResults = await client.lease(api =>
          api.blurPageImages(
            info.handle,
            pageIndex,
            requests,
            {
              detectFaces: wantsFaces,
              minScore: options.minScore ?? DEFAULT_MIN_SCORE,
              strength: options.strength,
              logoTemplate,
              logoMinScore: options.logoMinScore
            },
            createJobHandle({ signal: options.signal })
          )
        );
        for (const result of pageResults) {
          results.set(result.objectNumber, result);
          if (result.reason) skipped.push({ pageIndex, reason: result.reason });
        }
      }
    } finally {
      await client.lease(api => api.closeDocument(info.handle)).catch(() => {});
    }
  } finally {
    client.release();
  }

  if (options.signal?.aborted) throw cancelled();

  // ---- 5. Substitute, or leave the document completely alone. --------------
  const replacements: RedactedImageReplacements = {};
  const changedObjects = new Set<number>();
  const touchedPages = new Set<number>();
  const found: DetectedRegion[] = [];

  for (const placement of placements) {
    const result = results.get(placement.objectNumber);
    if (!result?.image) continue;
    if (!changedObjects.has(placement.objectNumber)) {
      changedObjects.add(placement.objectNumber);
      found.push(...result.regions);
    }
    const page = (replacements[placement.pageIndex] ??= {});
    page[placement.name] = result.image;
    touchedPages.add(placement.pageIndex);
  }

  const report: FaceBlurReport = {
    facesBlurred: found.filter(region => region.kind === 'face').length,
    logosBlurred: found.filter(region => region.kind === 'logo').length,
    imagesChanged: changedObjects.size,
    imagesInspected: firstPlacement.size,
    pagesTouched: touchedPages.size,
    skipped,
    downloadedModel
  };

  if (changedObjects.size === 0) {
    // Nothing was found, so nothing is rewritten. Returning the *input bytes*
    // rather than a re-saved copy is the point: a save that changes nothing
    // still changes the file, and "we found no faces" must not silently mean
    // "we rewrote your document anyway".
    if (downloadedModel) await markFaceModelDownloaded(FACE_MODEL_ID);
    options.onProgress?.(1, 'Done');
    return { ...report, bytes };
  }

  options.onProgress?.(0.85, 'Rebuilding document');
  const written = await processWorker.lease(api =>
    api.replacePageImages(bytes, replacements, createJobHandle(options))
  );

  // ---- 6. Prove the output is a document before handing it back. -----------
  await assertStillReadable(written, pageCount);

  // Only now, with a run that actually completed and produced a re-readable
  // document, is the download recorded. A failed fetch or a cancelled run
  // leaves the user opted *out* and the dialog comes back next time — the flag
  // records consent *and* success, never intent.
  if (downloadedModel) await markFaceModelDownloaded(FACE_MODEL_ID);

  options.onProgress?.(1, 'Done');
  return { ...report, bytes: written };
}

/**
 * Re-parses the bytes that are about to be handed back and checks the page
 * count survived.
 *
 * Image substitution touches the one part of a PDF that pdf-lib is most likely
 * to get subtly wrong — a resource dictionary shared between pages — and a
 * document that has lost a page is exactly the silent corruption PLAN §5.2
 * forbids. A failure here throws, so the caller keeps the original bytes.
 */
async function assertStillReadable(bytes: Uint8Array, expectedPages: number): Promise<void> {
  const client = renderWorker.pin();
  try {
    const info = await client.lease(api => api.loadDocument(bytes));
    try {
      if (info.pageCount !== expectedPages) {
        throw internal(
          `Blurring produced a document with ${info.pageCount} pages instead of ${expectedPages}. ` +
            'Nothing was saved — your original document is untouched.'
        );
      }
    } finally {
      await client.lease(api => api.closeDocument(info.handle)).catch(() => {});
    }
  } finally {
    client.release();
  }
}

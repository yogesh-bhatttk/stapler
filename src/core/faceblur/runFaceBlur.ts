/**
 * RED-08 — the orchestration a panel handler calls.
 *
 * The detector weights are bundled (`model.ts`), so there is nothing to
 * download and nothing to ask: a face-blur run touches no network at all,
 * exactly like every other tool. Two other properties this file is
 * responsible for:
 *
 *  • **Logo-only mode loads no model at all.** Template matching is
 *    arithmetic; decoding the detector weights for a run that never uses them
 *    would be wasted work.
 *  • **One encode per image, not one per page.** A letterhead logo on 300 pages
 *    is one image XObject; it is decoded, detected, mosaicked and re-encoded
 *    once, then substituted into all 300 resource dictionaries.
 */
import { renderWorker, processWorker } from '../workers';
import { createJobHandle, type JobOptions } from '../workers/protocol';
import { cancelled, internal } from '../errors';
import { translate } from '../i18n';
import type { BlurImageRequest, BlurredImageResult } from '../workers/render.worker';
import type {
  FormImageReplacements,
  PageImageRef,
  RedactedImageReplacements,
  RedactionRegion
} from '../workers/process.worker';
import type { UnitRect } from '../pdf/image-redaction';
import type { BlurStrength } from './blur';
import type { DetectedRegion } from './detect';
import { DEFAULT_MIN_SCORE } from './detect';

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
}

export interface FaceBlurResult extends FaceBlurReport {
  bytes: Uint8Array;
}

/**
 * Blurs faces (and/or a marked logo) in the embedded images of `bytes`.
 *
 * Throws `UserCancelled` if the user aborted the run.
 */
export async function runFaceBlur(
  bytes: Uint8Array,
  pageCount: number,
  options: RunFaceBlurOptions = {}
): Promise<FaceBlurResult> {
  const wantsFaces = options.detectFaces ?? true;
  const wantsLogo = options.logoRegion !== undefined;
  if (!wantsFaces && !wantsLogo) {
    throw internal(translate('Face blur was asked to look for neither faces nor a logo.'));
  }

  const pages = (options.pageIndices ?? Array.from({ length: pageCount }, (_, i) => i))
    .filter(index => index >= 0 && index < pageCount)
    .sort((a, b) => a - b);
  if (pages.length === 0) throw internal(translate('No pages were selected for face blur.'));

  if (options.signal?.aborted) throw cancelled();

  // ---- 1. Which images are on which pages. ---------------------------------
  options.onProgress?.(0.18, translate('Finding images'));
  const plan = await processWorker.lease(api => api.planPageImages(bytes, pages));
  const skipped: FaceBlurSkip[] = plan.unaddressablePages.map(pageIndex => ({
    pageIndex,
    reason: translate(
      'An image on this page is stored in a form Stapler cannot address for pixel-level ' +
        'editing, so it was left untouched.'
    )
  }));
  // Images inside Form XObjects are inspected and blurred (PDF-14) — except
  // below `MAX_FORM_DEPTH`, which is reported so "no faces found" is never
  // said about pictures nobody looked at.
  for (const pageIndex of plan.formImagePages) {
    skipped.push({
      pageIndex,
      reason: translate(
        'Some images on this page sit inside a form nested too deeply to reach, so they were ' +
          'not checked for faces or logos, and were left untouched.'
      )
    });
  }

  // HRD-41 (PDF-14): images in annotation appearances are blurred when the
  // appearance is the one a viewer shows, and images in tiling pattern cells
  // like any form's. Those only a hidden annotation or an alternate look draws
  // cannot be decoded here — said per page, so "no faces found" never covers
  // them.
  for (const pageIndex of plan.hiddenAppearancePages ?? []) {
    skipped.push({
      pageIndex,
      reason: translate(
        'An image on this page is drawn only by a hidden comment or field, or by its ' +
          'pressed or hover look, so it was not checked for faces or logos, and was left ' +
          'untouched.'
      )
    });
  }

  if (plan.images.length === 0) {
    return {
      bytes,
      facesBlurred: 0,
      logosBlurred: 0,
      imagesChanged: 0,
      imagesInspected: 0,
      pagesTouched: 0,
      skipped
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
      // ---- 2. The logo template, if there is one. --------------------------
      let logoTemplate: { rgba: Uint8ClampedArray; width: number; height: number } | undefined;
      const forced = new Map<number, UnitRect[]>();
      if (options.logoRegion) {
        // Blur's own planner, not redaction's: a pattern fill the redaction
        // planner would refuse to vouch for is no reason to refuse a blur. It
        // is skipped instead, and the skip is reported like any other.
        const plan = await processWorker.lease(api =>
          api.planLogoMark(bytes, options.logoRegion as RedactionRegion)
        );
        skipped.push(...plan.skipped);
        const marked = plan.requests;
        if (marked.length === 0) {
          throw internal(
            plan.skipped.length > 0
              ? translate(
                  'The marked logo sits on a pattern fill Stapler could not look inside, so there ' +
                    'are no pixels to match. Mark a copy of the logo that is drawn as a picture.'
                )
              : translate(
                  'The marked logo does not sit on top of an embedded image, so there are no pixels ' +
                    'to match. Mark the logo where it is drawn as a picture, or use a redaction mark ' +
                    'to remove it outright.'
                )
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
          throw internal(
            translate('The marked logo could not be read out of the image it sits on.')
          );
        }
        logoTemplate = crop;
      }

      // ---- 3. Detect and mosaic, one decode per distinct image. ------------
      if (wantsFaces) await client.lease(api => api.loadFaceDetector());

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
        options.onProgress?.(
          base,
          translate('Checking page {page} of {total}', { page: pageIndex + 1, total: pageCount })
        );
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

  // ---- 4. Substitute, or leave the document completely alone. --------------
  const replacements: RedactedImageReplacements = {};
  const formReplacements: FormImageReplacements = {};
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
    if (placement.inForm) {
      // Drawn through a form: no page-level name, so addressed by object number.
      (formReplacements[placement.pageIndex] ??= {})[placement.objectNumber] = result.image;
    } else {
      (replacements[placement.pageIndex] ??= {})[placement.name] = result.image;
    }
    touchedPages.add(placement.pageIndex);
  }

  const report: FaceBlurReport = {
    facesBlurred: found.filter(region => region.kind === 'face').length,
    logosBlurred: found.filter(region => region.kind === 'logo').length,
    imagesChanged: changedObjects.size,
    imagesInspected: firstPlacement.size,
    pagesTouched: touchedPages.size,
    skipped
  };

  if (changedObjects.size === 0) {
    // Nothing was found, so nothing is rewritten. Returning the *input bytes*
    // rather than a re-saved copy is the point: a save that changes nothing
    // still changes the file, and "we found no faces" must not silently mean
    // "we rewrote your document anyway".
    options.onProgress?.(1, translate('Done'));
    return { ...report, bytes };
  }

  options.onProgress?.(0.85, translate('Rebuilding document'));
  const written = await processWorker.lease(api =>
    api.replacePageImages(bytes, replacements, createJobHandle(options), formReplacements)
  );

  // ---- 5. Prove the output is a document before handing it back. -----------
  await assertStillReadable(written, pageCount);

  options.onProgress?.(1, translate('Done'));
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
          translate(
            'Blurring produced a document with {actual} pages instead of {expected}. ' +
              'Nothing was saved — your original document is untouched.',
            { actual: info.pageCount, expected: expectedPages }
          )
        );
      }
    } finally {
      await client.lease(api => api.closeDocument(info.handle)).catch(() => {});
    }
  } finally {
    client.release();
  }
}

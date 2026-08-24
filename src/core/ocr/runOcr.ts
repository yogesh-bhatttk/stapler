/**
 * OCR-01 — the orchestration a commit handler calls.
 *
 * Order matters here, and the order is: **ask first, then do anything at all**.
 * The confirmation is resolved before the OCR worker is even spawned, so a
 * declined dialog leaves no worker, no WASM load, and — the point of the
 * exercise — no request. `runOcr` returning `null` is the "user said no" signal;
 * it is not an error and raises no toast.
 *
 * Everything heavy happens in a worker: pdf.js rasterises in `render`, tesseract
 * recognises in `ocr`, pdf-lib writes the text layer in `process`. This module is
 * only the sequencing, and it yields to the event loop between pages.
 */
import * as Comlink from 'comlink';
import { renderWorker, cvWorker, ocrWorker, processWorker } from '../workers';
import { createJobHandle, type JobOptions } from '../workers/protocol';
import { requestOcrConsent } from '../notify';
import { cancelled, internal } from '../errors';
import { markModelDownloaded } from './modelState';
import { readModelBytes } from '../opfs';
import { fetchVerifiedModel } from './download';
import { hasCachedModel, writeCachedModel } from './tesseractCache';
import { DEFAULT_OCR_LANGUAGE, MODEL_HOST, findLanguage, splitLangCodes } from './model';
import type { OcrLayerReport, OcrPageLayer } from './types';

/**
 * Rasterisation resolution for recognition.
 *
 * 300 DPI is the resolution tesseract's LSTM models were trained around; 150 DPI
 * (what scan cleanup previews at) measurably loses small type, and 400+ costs
 * memory and time without improving accuracy on scanned documents.
 */
export const OCR_DPI = 300;

export interface RunOcrOptions extends JobOptions {
  /** Defaults to every page. */
  pageIndices?: number[];
  lang?: string;
}

export interface OcrRunResult extends OcrLayerReport {
  bytes: Uint8Array;
  /** True when the model was fetched during this run rather than read from cache. */
  downloadedModel: boolean;
}

/**
 * Disclosure copy for the languages named in `missingCodes` — never the whole
 * requested run, so a combined `eng+hin` request where `eng` is already cached
 * discloses only the `hin` download still needed. Says what is downloaded, how
 * big it is, from which host, that it happens once, and that everything
 * afterwards is local — the four things OCR-01 requires the dialog to state, in
 * the user's terms rather than the library's.
 */
export function modelConsentCopy(missingCodes: string[]): { title: string; body: string } {
  const languages = missingCodes.map(code => {
    const language = findLanguage(code);
    return { label: language?.label ?? code, size: language?.approxSizeMb ?? 12 };
  });
  const label = languages.map(l => l.label).join(' + ');
  const size = languages.reduce((total, l) => total + l.size, 0);
  const plural = languages.length > 1 ? 's' : '';
  return {
    title: `Download the ${label} OCR language model${plural}?`,
    body:
      `Stapler works entirely offline except for this one file. To read text in a scan it ` +
      `needs the ${label} recognition model${plural} — about ${size} MB — which ${
        plural ? 'are' : 'is'
      } downloaded from ${MODEL_HOST}, the public npm mirror the OCR engine publishes it on.\n\n` +
      `This happens once. The model${plural} then stay${
        plural ? '' : 's'
      } in this browser, and every later OCR run works with no network at all. Your document ` +
      `is never uploaded: only the model comes down, and nothing goes up.`
    // Tone stays 'default': this is a disclosed, reversible download, not a
    // destructive action, and dressing it in danger styling would train users to
    // ignore the styling that does mean danger.
  };
}

/**
 * Asks for consent to fetch every language in `missingCodes`. Returns `null`
 * when the user declined, otherwise the choice they made — the caller needs to
 * know 'download' from 'upload' to decide how it gets the bytes into
 * tesseract's cache (see `runOcr`).
 */
async function ensureConsent(missingCodes: string[]): Promise<'download' | 'upload' | null> {
  const { title, body } = modelConsentCopy(missingCodes);
  const result = await requestOcrConsent(missingCodes, title, body);
  return result === 'cancel' ? null : result;
}

/**
 * OCR-01 Defect 2 fix: whether `code` can be recognised right now with no
 * further download — checked against where the bytes actually live, never
 * against a boolean "the user said yes once" flag alone. A flag like that can
 * go stale: the browser can evict IndexedDB under storage pressure without
 * telling Stapler, and a run that trusted the flag anyway would let tesseract's
 * own loader silently re-fetch the model with no consent dialog shown — which
 * is exactly what the zero-network invariant forbids.
 *
 * Two real sources of truth are checked instead, and both double as the seed
 * for the cache the OCR worker actually reads from:
 *
 *  - tesseract's own cache (`hasCachedModel`) — a genuine byte-presence probe.
 *  - a manually uploaded copy in OPFS (`readModelBytes`), which never touched
 *    the network in the first place, so finding one here re-seeds tesseract's
 *    cache silently: there is nothing for a fresh consent dialog to disclose.
 */
async function isModelReady(code: string): Promise<boolean> {
  if (await hasCachedModel(code)) return true;
  const uploaded = await readModelBytes(code);
  if (uploaded) {
    await writeCachedModel(code, uploaded);
    return true;
  }
  return false;
}

/**
 * Recognises `pageIndices` of `bytes` and returns the same document with an
 * invisible text layer added.
 *
 * Returns `null` if the user declined the model download. Throws `UserCancelled`
 * if they aborted a run that had already started — the two are different events
 * and the caller reports them differently.
 */
export async function runOcr(
  bytes: Uint8Array,
  pageCount: number,
  options: RunOcrOptions = {}
): Promise<OcrRunResult | null> {
  const lang = options.lang ?? DEFAULT_OCR_LANGUAGE;
  if (!findLanguage(lang)) throw internal(`Unknown OCR language: ${lang}`);

  const pages = (options.pageIndices ?? Array.from({ length: pageCount }, (_, i) => i))
    .filter(index => index >= 0 && index < pageCount)
    .sort((a, b) => a - b);
  if (pages.length === 0) throw internal('No pages were selected for OCR.');

  const components = splitLangCodes(lang);
  const availability = await Promise.all(
    components.map(async code => ({ code, already: await isModelReady(code) }))
  );
  const missing = availability.filter(a => !a.already).map(a => a.code);

  if (missing.length > 0) {
    const choice = await ensureConsent(missing);
    // Nothing has been spawned, opened, or requested at this point. Declining is
    // a clean no-op by construction, not by cleanup.
    if (!choice) return null;

    if (choice === 'download') {
      // OCR-01 Defects 1 & 3: Stapler fetches and integrity-verifies every
      // missing language itself (`download.ts`), then seeds tesseract's own
      // cache directly (`writeCachedModel`) — tesseract's internal loader is
      // never given the chance to fetch on its own. That matters for a
      // combined run especially: each component lives at a different base
      // URL, and tesseract's own hardcoded default has no version pin at all
      // (see `model.ts`), so leaving it to fetch a language itself would
      // silently reintroduce the unpinned-URL problem this fix closes.
      await Promise.all(
        missing.map(async code => {
          const verified = await fetchVerifiedModel(code, options.signal);
          await writeCachedModel(code, verified);
        })
      );
    } else {
      // 'upload' is only offered when `missing.length === 1` — one file
      // cannot cover two languages — and the consent dialog's handler has
      // already written the bytes to OPFS before resolving with this choice.
      const code = missing[0];
      const uploaded = await readModelBytes(code);
      if (!uploaded) {
        throw internal(
          `The uploaded ${code} OCR language model could not be read back after upload.`
        );
      }
      await writeCachedModel(code, uploaded);
    }
  }

  const layers: OcrPageLayer[] = [];

  // `pin()` rather than the shared render cache: these bytes are the *export* of
  // the current workspace, not one of the registered sources, so a cached handle
  // keyed on a synthetic id would be closed out from under this loop the next
  // time the canvas prunes. Load, use, close, on one instance.
  const client = renderWorker.pin();
  try {
    const info = await client.lease(api => api.loadDocument(bytes));
    try {
      for (let i = 0; i < pages.length; i++) {
        if (options.signal?.aborted) throw cancelled();

        const pageIndex = pages[i];
        // Progress is reported across the page set, with the worker's own
        // per-page fraction folded in, so the bar moves during a single long page
        // instead of sitting still for thirty seconds.
        const base = i / pages.length;
        const span = 1 / pages.length;
        options.onProgress?.(base, `Reading page ${pageIndex + 1} of ${pageCount}`);

        const rawBitmap = await client.lease(api =>
          api.renderPage(info.handle, pageIndex, OCR_DPI / 72)
        );
        const { width, height } = rawBitmap;

        // Cleaned up before recognition — cancels the lighting/shadow gradient
        // and JPEG speckle a phone-camera photo carries, which is most of what
        // makes such a scan hard to recognise. Only recolours pixels in place
        // (see `cv.worker.ts`'s `cleanupForOcr`), so the bitmap's dimensions —
        // and therefore the `bitmapToUserSpace` mapping `textLayer.ts` uses to
        // place each word back on the page — are unaffected.
        const cleanupSpan = span * 0.15;
        const bitmap = await cvWorker.lease(api =>
          api.cleanupForOcr(
            Comlink.transfer(rawBitmap, [rawBitmap]),
            createJobHandle({
              signal: options.signal,
              onProgress: (fraction, label) =>
                options.onProgress?.(
                  fraction === null ? base : base + fraction * cleanupSpan,
                  `${label} — page ${pageIndex + 1} of ${pageCount}`
                )
            })
          )
        );

        const recognizeBase = base + cleanupSpan;
        const recognizeSpan = span - cleanupSpan;
        const result = await ocrWorker.lease(api =>
          api.recognizePage(
            // Transferred, not copied — a 300 DPI A4 raster is ~35 MB of RGBA.
            // The OCR worker takes ownership and closes it.
            Comlink.transfer(bitmap, [bitmap]),
            // No model bytes or path travel with this call: every language in
            // `lang` is already sitting in tesseract's own cache by this point
            // (seeded above, or on an earlier run), so the worker only ever
            // needs the plain language string (see `ocr.worker.ts`).
            { lang },
            createJobHandle({
              signal: options.signal,
              onProgress: (fraction, label) =>
                options.onProgress?.(
                  // `fraction` is per-phase, so it is scaled into this page's
                  // slice rather than replacing the document-wide number.
                  fraction === null ? recognizeBase : recognizeBase + fraction * recognizeSpan,
                  `${label} — page ${pageIndex + 1} of ${pageCount}`
                )
            })
          )
        );

        layers.push({
          pageIndex,
          bitmapWidth: width,
          bitmapHeight: height,
          dpi: OCR_DPI,
          words: result.words
        });
      }
    } finally {
      await client.lease(api => api.closeDocument(info.handle)).catch(() => {});
    }
  } finally {
    client.release();
  }

  if (options.signal?.aborted) throw cancelled();

  const written = await processWorker.lease(api =>
    api.addOcrTextLayer(bytes, layers, createJobHandle(options))
  );

  // Only now, with a run that actually completed, are the newly-fetched
  // languages recorded as downloaded. A failed fetch or a cancelled run leaves
  // the user opted out and the dialog comes back next time — the flag records
  // consent *and* success, never intent.
  await Promise.all(missing.map(code => markModelDownloaded(code)));

  options.onProgress?.(1, 'Done');
  return { ...written, downloadedModel: missing.length > 0 };
}

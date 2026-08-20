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
import { isModelDownloaded, markModelDownloaded } from './modelState';
import { hasModelBytes } from '../opfs';
import {
  DEFAULT_OCR_LANGUAGE,
  MODEL_HOST,
  findLanguage,
  resolveModelBase,
  splitLangCodes
} from './model';
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
 * know 'download' from 'upload' to decide whether it still has to fetch the
 * bytes itself (see `runOcr`'s combined-language branch).
 */
async function ensureConsent(missingCodes: string[]): Promise<'download' | 'upload' | null> {
  const { title, body } = modelConsentCopy(missingCodes);
  const result = await requestOcrConsent(missingCodes, title, body);
  return result === 'cancel' ? null : result;
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
    components.map(async code => ({
      code,
      already: (await hasModelBytes(code)) || (await isModelDownloaded(code))
    }))
  );
  const missing = availability.filter(a => !a.already).map(a => a.code);

  if (missing.length > 0) {
    const choice = await ensureConsent(missing);
    // Nothing has been spawned, opened, or requested at this point. Declining is
    // a clean no-op by construction, not by cleanup.
    if (!choice) return null;
    // Nothing further to do here: a solo language's 'download' is fetched by
    // tesseract itself inside the worker (as OCR-01 shipped it), and a
    // combined run is *also* left to tesseract — leaving `langPath` unset
    // there makes it compute each language's own default URL (the exact
    // package/version `resolveModelBase` pins) and cache each independently,
    // so it never re-fetches a language a prior solo run already has. Fetching
    // here too, into OPFS, would just be a second, unused download — the OCR
    // worker only ever reads OPFS bytes back for a single-language run (see
    // `ocr.worker.ts`). 'upload' has already written its one OPFS file via the
    // consent dialog — the dialog only offers that choice when
    // `missing.length === 1`.
  }

  const modelBase = resolveModelBase(components[0]);
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
            { lang, modelBase },
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

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
import { wholeKilobytes } from '../bytes';
import * as Comlink from 'comlink';
import { renderWorker, cvWorker, ocrWorker, processWorker } from '../workers';
import { createJobHandle, type JobOptions } from '../workers/protocol';
import { requestOcrConsent } from '../notify';
import { tPlural, translate } from '../i18n';
import { cancelled, internal, isCancellation, fromUnknown } from '../errors';
import { markModelDownloaded, removeOcrModel } from './modelState';
import { noteModelStored } from '../storage-persistence';
import { hasModelBytes, readModelBytes } from '../opfs';
import { fetchVerifiedModel } from './download';
import { hasCachedModel, writeCachedModel } from './tesseractCache';
import { DEFAULT_OCR_LANGUAGE, MODEL_HOST, findLanguage, splitLangCodes } from './model';
import {
  OCR_ENGINE_INIT_FAILED,
  isEngineInitFailure,
  type OcrLayerReport,
  type OcrPageLayer
} from './types';

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
  /**
   * Pages recognition could not run on, with why — most likely a page whose box
   * is legal PDF (the spec allows up to 14,400×14,400pt) but produces a canvas
   * past the browser's own pixel-area limit at `OCR_DPI`. Recognition already
   * completed for every other page in the run is kept rather than discarded;
   * see `runOcr`'s per-page try/catch.
   */
  skippedPages: { pageIndex: number; reason: string }[];
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
    return {
      label: language ? translate(language.label) : code,
      size: language?.approxSizeMb ?? 12
    };
  });
  const label = languages.map(l => l.label).join(' + ');
  const size = languages.reduce((total, l) => total + l.size, 0);
  const count = languages.length;
  return {
    title: tPlural('Download the {label} OCR language models?', count, { label }),
    body:
      tPlural(
        'Stapler works entirely offline except for this one file. To read text in a scan it needs the {label} recognition models — about {size} MB — which are downloaded from {host}, the public npm mirror the OCR engine publishes it on.',
        count,
        { label, size, host: MODEL_HOST }
      ) +
      '\n\n' +
      tPlural(
        'This happens once. The models then stay in this browser, and every later OCR run works with no network at all. Your document is never uploaded: only the model comes down, and nothing goes up.',
        count
      )
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
async function ensureConsent(
  missingCodes: string[],
  notice?: string
): Promise<'download' | 'upload' | null> {
  const { title, body } = modelConsentCopy(missingCodes);
  const result = await requestOcrConsent(
    missingCodes,
    title,
    notice ? `${notice}\n\n${body}` : body
  );
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
 * Fetches, verifies and caches every language in `missing`, reporting the
 * streamed byte progress (CNV-16) as the run's first slice of the bar.
 */
async function downloadMissing(missing: string[], options: RunOcrOptions): Promise<void> {
  // OCR-01 Defects 1 & 3: Stapler fetches and integrity-verifies every
  // missing language itself (`download.ts`), then seeds tesseract's own
  // cache directly (`writeCachedModel`) — tesseract's internal loader is
  // never given the chance to fetch on its own (and, since CNV-2, cannot).
  // `allSettled` rather than `all`, so every failure is reported together and
  // no download keeps running unobserved after the first one rejects.
  const progress = new Map<string, { received: number; total: number }>();
  const report = () => {
    let received = 0;
    let total = 0;
    for (const entry of progress.values()) {
      received += entry.received;
      total += entry.total;
    }
    if (total > 0) {
      options.onProgress?.(
        Math.min(1, received / total) * 0.1,
        translate('Downloading the language model ({received} of {total} KB)', {
          received: wholeKilobytes(received),
          total: wholeKilobytes(total)
        })
      );
    }
  };
  const results = await Promise.allSettled(
    missing.map(async code => {
      const verified = await fetchVerifiedModel(code, {
        signal: options.signal,
        onProgress: (received, total) => {
          progress.set(code, { received, total });
          report();
        }
      });
      await writeCachedModel(code, verified);
      return code;
    })
  );
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failures.length > 0) {
    if (failures.some(f => isCancellation(f.reason))) throw cancelled();
    throw internal(
      failures
        .map(f => (f.reason instanceof Error ? f.reason.message : String(f.reason)))
        .join('; ')
    );
  }
}

/**
 * Trial-loads `code` in the OCR worker. Returns `null` when the engine started,
 * otherwise why it could not.
 */
async function validateModel(code: string): Promise<string | null> {
  try {
    await ocrWorker.lease(api => api.validateModel(code));
    return null;
  } catch (err) {
    const reason = fromUnknown(err).message;
    if (!isEngineInitFailure(reason)) throw err;
    return reason.slice(OCR_ENGINE_INIT_FAILED.length).replace(/^:\s*/, '') || reason;
  }
}

/** Removes `code`'s model only if it came from an upload (an OPFS copy exists). */
async function forgetUploadedModel(code: string): Promise<void> {
  if (await hasModelBytes(code)) await removeOcrModel(code);
}

/**
 * Recognises `pageIndices` of `bytes` and returns the same document with an
 * invisible text layer added.
 *
 * Returns `null` if the user declined the model download. Throws `UserCancelled`
 * if they aborted a run that had already started — the two are different events
 * and the caller reports them differently.
 */
/** The DPI a bitmap of `bitmapWidth` px represents for a page `pageWidth` pt wide. */
export function effectiveDpi(bitmapWidth: number, pageWidth: number | undefined): number {
  if (!pageWidth || pageWidth <= 0 || !bitmapWidth) return OCR_DPI;
  return (72 * bitmapWidth) / pageWidth;
}

/** The component languages of `lang` that are not yet usable offline. */
async function missingModels(lang: string): Promise<string[]> {
  const availability = await Promise.all(
    splitLangCodes(lang).map(async code => ({ code, already: await isModelReady(code) }))
  );
  return availability.filter(a => !a.already).map(a => a.code);
}

/**
 * True when every component of `lang` can be recognised right now with no
 * download. Never fetches and never prompts — the probe folder search uses to
 * decide whether OCR is available for a run (OCR-02).
 */
export async function isOcrModelReady(lang: string = DEFAULT_OCR_LANGUAGE): Promise<boolean> {
  return (await missingModels(lang)).length === 0;
}

/**
 * The consent loop: shows OCR-01's dialog for `missing`, then downloads or
 * accepts an upload. Returns `null` when the user declined, and nothing at all
 * has been requested in that case.
 */
async function acquireModels(
  missing: string[],
  options: JobOptions
): Promise<'download' | 'upload' | null> {
  // A loop only because a rejected upload (CNV-8) puts the same dialog back
  // in front of the user — every other path leaves it on the first pass.
  let rejectedUpload: string | undefined;
  for (;;) {
    const choice = await ensureConsent(missing, rejectedUpload);
    // Nothing has been spawned, opened, or requested at this point. Declining
    // is a clean no-op by construction, not by cleanup.
    if (!choice) return null;

    if (choice === 'download') {
      await downloadMissing(missing, options);
      return choice;
    }

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

    // Audit 2026-09-25 CNV-8 — trial-load it before keeping it. A wrong
    // file (legacy/non-LSTM data, or something that is not a model at all)
    // used to be kept in OPFS and re-seeded before every run, with the
    // dialog never shown again to replace it.
    options.onProgress?.(0, translate('Checking the uploaded language model'));
    const problem = await validateModel(code);
    if (!problem) return choice;
    await removeOcrModel(code);
    // Said inside the re-shown dialog itself rather than in a toast, which
    // would sit on top of the dialog's own buttons.
    rejectedUpload = translate(
      'That file is not a usable OCR language model — the OCR engine could not load it ({problem}), so it was not kept. Choose the {label} "best_int" LSTM .traineddata file, or download the model instead.',
      { problem, label: translate(findLanguage(code)?.label ?? code) }
    );
  }
}

/** Records `missing` as downloaded with consent, once a model is known to work. */
async function recordAcquired(missing: string[]): Promise<void> {
  // The flag records consent *and* success, never intent.
  await Promise.all(missing.map(code => markModelDownloaded(code)));
  // GAP-9 — a model is now stored locally; ask (once) that it not be evicted.
  if (missing.length > 0) noteModelStored();
}

export type OcrModelPreparation = 'ready' | 'acquired' | 'declined';

/**
 * OCR-02 — makes `lang`'s model available ahead of a run that will need it
 * (folder search's "Also OCR scanned pages"), through exactly the consent and
 * download flow `runOcr` uses. Returns:
 *
 *  - `'ready'` — already stored; no dialog was shown and nothing was fetched.
 *  - `'acquired'` — the user agreed and the model was downloaded (or uploaded)
 *    and trial-loaded in the OCR engine.
 *  - `'declined'` — the user said no; nothing was requested.
 */
export async function prepareOcrModel(
  lang: string = DEFAULT_OCR_LANGUAGE,
  options: JobOptions = {}
): Promise<OcrModelPreparation> {
  if (!findLanguage(lang)) throw internal(`Unknown OCR language: ${lang}`);
  const missing = await missingModels(lang);
  if (missing.length === 0) return 'ready';

  const choice = await acquireModels(missing, options);
  if (!choice) return 'declined';
  if (options.signal?.aborted) throw cancelled();

  if (choice === 'download') {
    // An upload was trial-loaded inside `acquireModels`; a download is checked
    // here, because there is no page run after this to prove it loads.
    for (const code of missing) {
      const problem = await validateModel(code);
      if (problem) {
        await removeOcrModel(code);
        throw internal(
          translate(
            'OCR stopped: {reason}. Nothing was changed. If you uploaded this model, it has been removed — run OCR again to download it or upload a different file.',
            { reason: problem }
          ),
          { lang: code }
        );
      }
    }
  }
  await recordAcquired(missing);
  return 'acquired';
}

/** One recognised page: the text-layer geometry plus tesseract's whole-page text. */
interface RecognizedLayer extends OcrPageLayer {
  text: string;
}

/**
 * Rasterises, cleans up and recognises `pages` of `bytes`, all in workers
 * (`render`, `cv`, `ocr`). The model for every component of `lang` must already
 * be in tesseract's cache — this never prompts and never fetches.
 */
async function recognizePages(
  bytes: Uint8Array,
  pages: number[],
  pageCount: number,
  lang: string,
  options: JobOptions
): Promise<{ layers: RecognizedLayer[]; skippedPages: { pageIndex: number; reason: string }[] }> {
  const layers: RecognizedLayer[] = [];
  // §2.3 — a page whose box is legal PDF but produces a canvas past the
  // browser's pixel-area limit at OCR_DPI throws when rendered. That used to
  // propagate straight out of the loop, discarding recognition already
  // completed for every earlier page in the run. `scanDocumentBarcodes`
  // (`core/operations.ts`) already solves the identical problem for the same
  // reason: the other pages are still worth the user's time.
  const skippedPages: { pageIndex: number; reason: string }[] = [];

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
        options.onProgress?.(
          base,
          translate('Reading page {page} of {total}', { page: pageIndex + 1, total: pageCount })
        );

        try {
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
                    translate('{label} — page {page} of {total}', {
                      label,
                      page: pageIndex + 1,
                      total: pageCount
                    })
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
                    translate('{label} — page {page} of {total}', {
                      label,
                      page: pageIndex + 1,
                      total: pageCount
                    })
                  )
              })
            )
          );

          layers.push({
            pageIndex,
            bitmapWidth: width,
            bitmapHeight: height,
            // The DPI the page was *actually* rendered at. The render worker
            // clamps very large pages (A1, A0) to its pixel ceiling, so the
            // bitmap can be smaller than OCR_DPI asked for; placing words with
            // the requested DPI put every word on an A0 page at ~69% of its
            // position (regression review R-RT-3). `pageSizes` is the viewport
            // at scale 1 — the same box and rotation the bitmap was rendered in.
            dpi: effectiveDpi(width, info.pageSizes?.[pageIndex]?.width),
            words: result.words,
            text: result.text
          });
        } catch (err) {
          if (isCancellation(err)) throw err;
          const reason = fromUnknown(err).message;
          // Audit 2026-09-25 CNV-2 — an engine that cannot load the model
          // cannot read *any* page, so this is fatal for the run, not a
          // per-page skip. (Skipping used to lead straight into tesseract's
          // silent CDN fallback on the next page.) An uploaded copy is
          // removed so the next run asks again instead of re-seeding it.
          if (isEngineInitFailure(reason)) {
            await Promise.all(splitLangCodes(lang).map(forgetUploadedModel));
            throw internal(
              translate(
                'OCR stopped: {reason}. Nothing was changed. If you uploaded this model, it has been removed — run OCR again to download it or upload a different file.',
                { reason }
              ),
              { lang }
            );
          }
          skippedPages.push({ pageIndex, reason });
        }
      }
    } finally {
      await client.lease(api => api.closeDocument(info.handle)).catch(() => {});
    }
  } finally {
    client.release();
  }
  return { layers, skippedPages };
}

/** Sorted, in-range, de-duplicated page indices; every page when none are given. */
function normalisePages(pageIndices: number[] | undefined, pageCount: number): number[] {
  const pages = pageIndices ?? Array.from({ length: pageCount }, (_, i) => i);
  return [...new Set(pages.filter(index => index >= 0 && index < pageCount))].sort((a, b) => a - b);
}

export async function runOcr(
  bytes: Uint8Array,
  pageCount: number,
  options: RunOcrOptions = {}
): Promise<OcrRunResult | null> {
  const lang = options.lang ?? DEFAULT_OCR_LANGUAGE;
  if (!findLanguage(lang)) throw internal(`Unknown OCR language: ${lang}`);

  const pages = normalisePages(options.pageIndices, pageCount);
  if (pages.length === 0) throw internal(translate('No pages were selected for OCR.'));

  const missing = await missingModels(lang);
  if (missing.length > 0 && !(await acquireModels(missing, options))) return null;

  const { layers, skippedPages } = await recognizePages(bytes, pages, pageCount, lang, options);

  if (options.signal?.aborted) throw cancelled();

  const written = await processWorker.lease(api =>
    api.addOcrTextLayer(
      bytes,
      // The whole-page text is only for callers that index it; the text layer
      // is written from the positioned words alone.
      layers.map(({ pageIndex, bitmapWidth, bitmapHeight, dpi, words }) => ({
        pageIndex,
        bitmapWidth,
        bitmapHeight,
        dpi,
        words
      })),
      createJobHandle(options)
    )
  );

  // Only now, with a run that actually completed, are the newly-fetched
  // languages recorded as downloaded. A failed fetch or a cancelled run leaves
  // the user opted out and the dialog comes back next time.
  await recordAcquired(missing);

  options.onProgress?.(1, translate('Done'));
  return { ...written, downloadedModel: missing.length > 0, skippedPages };
}

export interface RecognizedPageText {
  pageIndex: number;
  /** tesseract's whole-page text, in its reading order. */
  text: string;
}

export interface OcrTextResult {
  pages: RecognizedPageText[];
  skippedPages: { pageIndex: number; reason: string }[];
}

/**
 * OCR-02 — recognises `pageIndices` of `bytes` and returns their text, without
 * writing anything back into the document (folder search indexes the text; the
 * file on disk is never touched).
 *
 * Uses the stored model only. When any component of `lang` is not stored it
 * throws rather than asking or fetching: folder search obtains consent when the
 * user turns the option on (`prepareOcrModel`), never in the middle of a run.
 */
export async function recognizeText(
  bytes: Uint8Array,
  pageCount: number,
  options: RunOcrOptions = {}
): Promise<OcrTextResult> {
  const lang = options.lang ?? DEFAULT_OCR_LANGUAGE;
  if (!findLanguage(lang)) throw internal(`Unknown OCR language: ${lang}`);
  const pages = normalisePages(options.pageIndices, pageCount);
  if (pages.length === 0) return { pages: [], skippedPages: [] };

  if ((await missingModels(lang)).length > 0) {
    throw internal(translate('The OCR language model is not stored in this browser.'), { lang });
  }

  const { layers, skippedPages } = await recognizePages(bytes, pages, pageCount, lang, options);
  if (options.signal?.aborted) throw cancelled();
  options.onProgress?.(1, translate('Done'));
  return {
    pages: layers.map(layer => ({ pageIndex: layer.pageIndex, text: layer.text })),
    skippedPages
  };
}

/**
 * OCR-01 — the tesseract.js worker.
 *
 * Four things here are load-bearing rather than tuning:
 *
 *  • `workerPath` and `corePath` point at **bundled** copies (the
 *    `stapler:tesseract-assets` Vite plugin). tesseract.js's browser defaults are
 *    jsdelivr URLs for both — its own nested worker script and the WASM engine.
 *    Those are *code*, and PLAN §5.4 item 2 forbids remote code regardless of
 *    consent; only the language model (item 5) may ever be fetched. Leaving the
 *    defaults would mean an OCR run silently pulls three megabytes of executable
 *    JavaScript off a CDN, and would 404 inside the extension besides.
 *  • `corePath` names the `.js` file directly, not a directory. `getCore.js`
 *    takes the `corePathImport.slice(-2) === 'js'` branch for a file and skips its
 *    SIMD/relaxed-SIMD feature detection entirely — which matters because that
 *    detection would ask for whichever of the six engine variants the browser
 *    prefers, and only one is vendored. Evergreen Chrome is the target, so the
 *    SIMD + LSTM-only variant is the right single choice.
 *  • tesseract.js is loaded with a dynamic `import()`. Nothing in this module —
 *    and so nothing in the tesseract dependency tree — is evaluated until an OCR
 *    run actually starts.
 *  • `createWorker` is always called with `options.lang` as a **plain string**,
 *    never an array of `{ code, data }` objects. tesseract.js 7.0.0 has a real
 *    bug in its own `initialize()`: given such an array it builds the language
 *    string for `TessBaseAPI.Init` via `langs.map(l => l.data).join('+')` — the
 *    *bytes*, not any code field — so `Init` is called with a stringified byte
 *    array instead of e.g. `"eng"`, and recognition fails outright ("Tesseract
 *    couldn't load any languages!"), whatever the array's field names are. This
 *    used to be worked around for a single-language "uploaded a custom model"
 *    path by building exactly that broken shape (OCR-01 Defect 3) — the actual
 *    fix is upstream, in `runOcr.ts`: every language `lang` names is guaranteed
 *    to already be sitting in tesseract's own cache (`tesseractCache.ts`) by the
 *    time this worker is ever spawned, whether it got there by a verified CDN
 *    download or a manual upload, so a plain string is all this worker ever
 *    needs — tesseract's normal cache-hit path does the rest.
 *
 * `recognize()` is not preemptible: once the engine is inside a page there is no
 * supported way to interrupt it. Cancellation therefore races the recognition
 * against a poll of the job handle and, if the caller aborted, terminates the
 * tesseract worker outright. That reclaims the thread immediately but throws away
 * a warm engine, which is why it is a last resort rather than the normal path.
 */
import * as Comlink from 'comlink';
import { loadLocale, translate } from '../i18n';
import type { LocaleAware } from './client';
import { checkpoint, releaseJobHandlesAfterCall, type JobHandle } from './protocol';
import { cancelled as cancelledError, internal } from '../errors';
import { OCR_ENGINE_INIT_FAILED, type OcrPageResult, type OcrWord } from '../ocr/types';
// Type-only, so it is erased: the runtime import stays dynamic (see the header).
import type * as Tesseract from 'tesseract.js';

/**
 * Base URL of the bundled tesseract assets, resolved from this worker's own
 * location with the hashed `assets/` segment stripped — the same trick
 * `pdfjs-setup.ts` uses, so it is correct under `chrome-extension://` and on the
 * website twin without either build knowing the other's base path.
 */
const ASSETS = new URL('ocr/', self.location.href.replace(/\/assets\/[^/]*$/, '/')).href;

const WORKER_PATH = `${ASSETS}worker.min.js`;
const CORE_PATH = `${ASSETS}tesseract-core-simd-lstm.wasm.js`;

export interface RecognizeOptions {
  /**
   * tesseract language code, e.g. `eng`, or several joined with `+` (e.g.
   * `eng+hin`) for a single mixed-script recognition pass.
   */
  lang: string;
}

export interface OCRJob extends LocaleAware {
  /**
   * Audit 2026-09-25 CNV-8 — a trial engine init against whatever is in
   * tesseract's cache for `lang`, then an immediate terminate. Used to reject
   * an uploaded model that is not a usable LSTM `.traineddata` *before* it is
   * kept. Rejects with an {@link OCR_ENGINE_INIT_FAILED}-prefixed error.
   */
  validateModel(lang: string): Promise<void>;
  recognizePage(
    bitmap: ImageBitmap,
    options: RecognizeOptions,
    job?: JobHandle
  ): Promise<OcrPageResult>;
}

/** tesseract's `logger` statuses, mapped onto labels a user can read. */
function progressLabel(status: string): string {
  if (status.includes('traineddata')) return translate('Downloading the language model');
  if (status.includes('core')) return translate('Starting the OCR engine');
  if (status.includes('initializ')) return translate('Preparing the OCR engine');
  if (status.includes('recognizing')) return translate('Reading the page');
  return translate('Running OCR');
}

/**
 * Flattens tesseract's block → paragraph → line → word tree into words, carrying
 * the line's baseline down to each of its words.
 *
 * `blocks` is `null` when the engine found no layout at all (a blank page), which
 * is a valid result and not an error.
 */
function collectWords(page: Tesseract.Page): OcrWord[] {
  const words: OcrWord[] = [];
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        // The baseline is given as a segment in page coordinates; its y at the
        // word's left edge is close enough at word scale to take y0 directly.
        const baselineY = line.baseline ? Math.max(line.baseline.y0, line.baseline.y1) : undefined;
        for (const word of line.words ?? []) {
          if (!word.text) continue;
          words.push({
            text: word.text,
            bbox: {
              x0: word.bbox.x0,
              y0: word.bbox.y0,
              x1: word.bbox.x1,
              y1: word.bbox.y1
            },
            confidence: word.confidence,
            baselineY
          });
        }
      }
    }
  }
  return words;
}

/**
 * Resolves when the caller has aborted. Polls rather than listening because
 * `AbortSignal` cannot cross a Comlink boundary — the protocol exposes
 * `cancelled()` instead (see `protocol.ts`).
 */
function cancellationWatch(job: JobHandle | undefined, intervalMs = 150) {
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  const promise = new Promise<never>((_resolve, reject) => {
    if (!job) return;
    const tick = async () => {
      if (stopped) return;
      let aborted: boolean;
      try {
        aborted = await job.cancelled();
      } catch {
        // The port is gone — the caller went away, which is a cancellation too.
        aborted = true;
      }
      if (stopped) return;
      if (aborted) {
        reject(cancelledError());
        return;
      }
      setTimeout(() => void tick(), intervalMs);
    };
    setTimeout(() => void tick(), intervalMs);
  });
  return { promise, stop };
}

/**
 * Audit 2026-09-25 CNV-2 — a `langPath` that cannot reach the network.
 *
 * With no `langPath`, a cache miss inside tesseract.js falls back to its own
 * hard-coded jsDelivr URL — unpinned, unverified, and never disclosed. An
 * unknown URL scheme makes `fetch()` reject immediately with no request at
 * all, so a cache miss fails closed instead. Combined with
 * `cacheMethod: 'readOnly'` (tesseract never writes to, and never *deletes
 * from*, its cache — the default deletes the model when init fails, which was
 * what turned one bad upload into a silent download on the next page), the
 * only bytes this engine can ever load are ones `runOcr.ts` put in the cache
 * itself after a verified download or a validated upload.
 */
export const NO_NETWORK_LANG_PATH = 'stapler-offline-cache-only:';

type Tess = typeof import('tesseract.js');

async function startEngine(
  tess: Tess,
  lang: string,
  logger?: (message: Tesseract.LoggerMessage) => void
): Promise<Tesseract.Worker> {
  // tesseract.js 7.0.0's `createWorker` only rejects its promise when the
  // *script load* fails. When loading the language or `TessBaseAPI.Init`
  // fails, it swallows the rejection, leaves the promise pending forever, and
  // — with no `errorHandler` — rethrows inside its `onmessage`, an uncaught
  // error that surfaces on this worker as an `error` event (the pool then
  // drops the whole OCR worker: "A background worker stopped unexpectedly").
  // So an `errorHandler` turns that into a real rejection raced against the
  // creation, and the nested engine worker — which the stuck promise would
  // otherwise leak, WASM heap and all — is captured as it is spawned (the
  // spawn happens synchronously inside the `createWorker` call) so it can be
  // terminated on that path.
  let failInit: (reason: unknown) => void = () => {};
  const initFailed = new Promise<never>((_resolve, reject) => {
    failInit = reject;
  });
  const spawned: Worker[] = [];
  const NativeWorker = self.Worker;
  self.Worker = class CapturedWorker extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      spawned.push(this);
    }
  };
  let creating: Promise<Tesseract.Worker>;
  try {
    creating = tess.createWorker(lang, tess.OEM.LSTM_ONLY, {
      workerPath: WORKER_PATH,
      corePath: CORE_PATH,
      langPath: NO_NETWORK_LANG_PATH,
      cacheMethod: 'readOnly',
      // tesseract.js defaults to spawning its worker from a `blob:` URL that
      // does nothing but `importScripts(workerPath)` — a level of
      // indirection meant to dodge CORS on a cross-origin `workerPath` in a
      // plain website. Inside a Chrome extension, a `blob:`-sourced worker
      // is refused permission to `importScripts` an extension-hosted file
      // at all ("Failed to execute 'importScripts' ... failed to load"),
      // even though `WORKER_PATH` is same-origin and `script-src 'self'`
      // already allows it directly. Disabling the wrapper makes tesseract
      // spawn `new Worker(WORKER_PATH)` itself, with no blob in between.
      workerBlobURL: false,
      errorHandler: (data: unknown) => failInit(data),
      ...(logger ? { logger } : {})
    });
  } finally {
    self.Worker = NativeWorker;
  }
  try {
    return await Promise.race([creating, initFailed]);
  } catch (err) {
    for (const worker of spawned) worker.terminate();
    // tesseract rejects with a bare string or an Error depending on where
    // init failed; either way the message is carried, prefixed, so the caller
    // can tell "the engine could not load this model" (fatal for the whole
    // run) from "this one page could not be read" (skip it).
    const detail = err instanceof Error ? err.message : String(err);
    throw internal(`${OCR_ENGINE_INIT_FAILED}: ${detail}`, { lang });
  }
}

const api: OCRJob = {
  setLocale: loadLocale,
  async validateModel(lang) {
    const tess = await import('tesseract.js');
    const engine = await startEngine(tess, lang);
    await engine.terminate().catch(() => {});
  },

  async recognizePage(bitmap, options, job) {
    await checkpoint(job, 0, translate('Starting the OCR engine'));

    // tesseract's browser `loadImage` accepts an OffscreenCanvas natively; an
    // ImageBitmap is what the render worker hands us, so it is drawn into one
    // here rather than round-tripped through a blob on the main thread.
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw internal(translate('Could not create a canvas for OCR.'));
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const tess = await import('tesseract.js');

    const watch = cancellationWatch(job);
    let engine: Tesseract.Worker | null = null;

    try {
      // Always a plain string — see the header comment for why an array of
      // `{ code, data }` objects must never be built here. Every component of
      // `options.lang` is guaranteed to already be in tesseract's own cache by
      // the time this worker is spawned (`runOcr.ts` seeds it, from a verified
      // download or a validated upload, before ever leasing this worker); a
      // miss fails closed (`NO_NETWORK_LANG_PATH`), it never fetches.
      engine = await startEngine(tess, options.lang, message => {
        // `progress` is 0..1 per phase, not across the whole run; the caller
        // scales it into the document-wide fraction it is reporting.
        void job?.progress(
          typeof message.progress === 'number' ? message.progress : null,
          progressLabel(message.status ?? '')
        );
      });

      const recognition = engine.recognize(canvas, {}, { blocks: true, text: true });
      const result = await Promise.race([recognition, watch.promise]);

      return { words: collectWords(result.data), text: result.data.text ?? '' };
    } finally {
      watch.stop();
      // Always terminated: each engine holds the WASM heap plus the loaded model,
      // tens of megabytes, and the pool is capped at one instance precisely
      // because keeping several alive is not affordable. On the cancellation path
      // this is also what actually stops the in-flight recognition.
      await engine?.terminate().catch(() => {});
    }
  }
};

Comlink.expose(releaseJobHandlesAfterCall(api));

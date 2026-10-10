import { expect, type BrowserContext, type Page, type Request } from '@playwright/test';
import {
  PDFDict,
  PDFDocument,
  PDFName,
  StandardFonts,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState
} from 'pdf-lib';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { FIXTURES_DIR, ensureFixture } from './fixtures';
import { OCR_MODEL_CONNECT_SOURCES } from '../../scripts/csp.mjs';
import { MODEL_SHA256, resolveModelUrl } from '../../src/core/ocr/model';

/**
 * Shared helpers for the 2026-10-10 test-audit specs. Test-side only: nothing
 * here needs, or adds, a hook in `src/`.
 */

/* ------------------------------------------------------------------ *
 * Positive "the app has settled" signals (audit T10)
 * ------------------------------------------------------------------ */

/**
 * Resolves once no app job is running, and has stayed that way for `frames`
 * consecutive animation frames.
 *
 * The signal is the app's own: while `activeJob` is set — any import, export
 * or tool run — the active tab's close control carries `aria-disabled="true"`
 * (`FileTabs.tsx`), the action bar shows a progress bar instead of its
 * button, and a drop zone mid-import is `aria-busy`. Holding for a run of
 * frames, not a single sample, is what makes "nothing started" observable: a
 * job that was about to start would have to stay invisible across all of
 * them, and every import or export sets `activeJob` within a task or two of
 * its trigger.
 */
export async function waitForJobsIdle(page: Page, frames = 12): Promise<void> {
  await page.waitForFunction(
    async needed => {
      const idle = () =>
        document.querySelector('[role="group"] [role="button"][aria-disabled="true"]') === null &&
        document.querySelector('[role="progressbar"]') === null &&
        document.querySelector('[aria-busy="true"]') === null;
      for (let i = 0; i < needed; i++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (!idle()) return false;
      }
      return true;
    },
    frames,
    { timeout: 60_000, polling: 100 }
  );
}

/**
 * Counts IndexedDB reads in flight, from before any app script runs.
 *
 * The folder-search race (`recents-folder-search.spec.ts`) is decided by
 * which of two lookups' IndexedDB reads lands last. Wrapping the read methods
 * of the browser's own IndexedDB API (not anything in `src/`) gives a positive
 * "every lookup has finished reading" signal, instead of a sleep that guesses.
 */
export async function trackIndexedDbReads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __idbReads: { pending: number; done: number } };
    w.__idbReads = { pending: 0, done: 0 };
    const wrap = (proto: object, method: string) => {
      const target = proto as Record<string, (...args: unknown[]) => IDBRequest>;
      const original = target[method];
      if (typeof original !== 'function') return;
      target[method] = function (this: unknown, ...args: unknown[]) {
        const request = original.apply(this, args);
        w.__idbReads.pending++;
        const settle = () => {
          w.__idbReads.pending--;
          w.__idbReads.done++;
        };
        request.addEventListener('success', settle, { once: true });
        request.addEventListener('error', settle, { once: true });
        return request;
      };
    };
    for (const method of ['get', 'getAll', 'getKey', 'getAllKeys', 'count']) {
      wrap(IDBObjectStore.prototype, method);
      wrap(IDBIndex.prototype, method);
    }
  });
}

/** Resolves once no IndexedDB read is in flight for `frames` consecutive frames. */
export async function waitForIndexedDbIdle(page: Page, frames = 6): Promise<void> {
  await page.waitForFunction(
    async needed => {
      const reads = (window as unknown as { __idbReads?: { pending: number } }).__idbReads;
      if (!reads) throw new Error('trackIndexedDbReads was not installed before the app loaded');
      for (let i = 0; i < needed; i++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (reads.pending !== 0) return false;
      }
      return true;
    },
    frames,
    { timeout: 30_000, polling: 50 }
  );
}

/* ------------------------------------------------------------------ *
 * Network and CSP watching (audit T7, T8, T9)
 * ------------------------------------------------------------------ */

/** Same-origin, `blob:`, `data:` and extension URLs are local. Everything else is a request out. */
export function isLocalUrl(url: string, origin: string): boolean {
  if (/^(blob:|data:|chrome-extension:)/.test(url)) return true;
  return url.startsWith(origin);
}

/** True for exactly the pinned OCR model directories the CSP's `connect-src` allows. */
export function isPinnedOcrModelUrl(url: string): boolean {
  return OCR_MODEL_CONNECT_SOURCES.some(prefix => url.startsWith(prefix));
}

/** Runs before any app script, in every frame: records `securitypolicyviolation` events. */
export function recordCspViolations() {
  const w = window as unknown as { __cspViolations: string[] };
  w.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', event => {
    w.__cspViolations.push(`${event.violatedDirective} blocked ${event.blockedURI}`);
  });
}

export interface Watch {
  /** Every non-local request, as `METHOD url`. */
  external: string[];
  /** Every request URL, local or not — to prove the watched code really ran. */
  seen: string[];
  /** `Refused to …` / CSP console errors. */
  cspConsole: string[];
}

/**
 * Attaches a request and CSP-console watcher to `page`. Pair with
 * `page.addInitScript(recordCspViolations)` *before* navigation to also catch
 * `securitypolicyviolation` events, then call {@link expectNoNetworkOrCsp}.
 */
export function watchPage(page: Page, origin: string): Watch {
  const watch: Watch = { external: [], seen: [], cspConsole: [] };
  page.on('request', (request: Request) => {
    const url = request.url();
    watch.seen.push(url);
    if (!isLocalUrl(url, origin)) watch.external.push(`${request.method()} ${url}`);
  });
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/Content Security Policy|Refused to/i.test(text)) watch.cspConsole.push(text);
  });
  return watch;
}

/** Fails on any external request (beyond `allow`) and on any recorded CSP violation. */
export async function expectNoNetworkOrCsp(
  page: Page,
  watch: Watch,
  allow: (url: string) => boolean = () => false
): Promise<void> {
  const events = await page
    .evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [])
    .catch(() => [] as string[]);
  const external = watch.external.filter(entry => !allow(entry.replace(/^\S+ /, '')));
  expect(
    external,
    `Stapler must make no external request. Observed:\n${external.join('\n')}`
  ).toEqual([]);
  expect([...watch.cspConsole, ...events], 'CSP violations').toEqual([]);
}

/* ------------------------------------------------------------------ *
 * OCR model, served locally (audit T7, T8)
 * ------------------------------------------------------------------ */

/**
 * Where a real, pin-verified copy of the English model is kept for offline
 * runs. Not committed (`tests/fixtures/*` is gitignored): it is written by the
 * opt-in live test (`STAPLER_LIVE_OCR=1`, `tool-flows.spec.ts`), or placed by
 * hand from the pinned URL. `STAPLER_OCR_MODEL_FILE` overrides the location.
 */
export const OCR_MODEL_FILE = path.resolve(
  process.env.STAPLER_OCR_MODEL_FILE ?? path.join(FIXTURES_DIR, '.ocr-model', 'eng.traineddata.gz')
);

/** The pinned URL the app will request for English. */
export const ENG_MODEL_URL = resolveModelUrl('eng');

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * The cached English model, or why it cannot be used.
 *
 * The app verifies every downloaded byte against `MODEL_SHA256` (and the web
 * and extension builds have no test seam to change that), so a stand-in file
 * would be refused — only the real file can be served. A cached file that does
 * not match the pin is reported, not used.
 */
export function cachedOcrModel(): { bytes: Uint8Array } | { missing: string } {
  if (!existsSync(OCR_MODEL_FILE)) {
    return {
      missing:
        `No local OCR model at ${OCR_MODEL_FILE}. Run once with STAPLER_LIVE_OCR=1 to record ` +
        `it from ${ENG_MODEL_URL}, or download that URL to this path by hand.`
    };
  }
  const bytes = new Uint8Array(readFileSync(OCR_MODEL_FILE));
  if (sha256(bytes) !== MODEL_SHA256.eng) {
    return {
      missing: `${OCR_MODEL_FILE} does not match the pinned SHA-256 (${MODEL_SHA256.eng}).`
    };
  }
  return { bytes };
}

/** Saves `bytes` as the offline model cache, only if they match the pin. */
export function recordOcrModel(bytes: Uint8Array): boolean {
  if (sha256(bytes) !== MODEL_SHA256.eng) return false;
  mkdirSync(path.dirname(OCR_MODEL_FILE), { recursive: true });
  writeFileSync(OCR_MODEL_FILE, bytes);
  return true;
}

/**
 * Serves the pinned model URL from `bytes`, and nothing else on that host.
 * Returns the list of model requests seen, so a test can assert the download
 * path really ran (exactly once).
 */
export async function serveOcrModelLocally(
  target: Page | BrowserContext,
  bytes: Uint8Array
): Promise<string[]> {
  const requested: string[] = [];
  await target.route(
    url => isPinnedOcrModelUrl(url.href),
    async route => {
      const url = route.request().url();
      requested.push(url);
      if (url !== ENG_MODEL_URL) return route.abort('blockedbyclient');
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.byteLength),
          'access-control-allow-origin': '*'
        },
        body: Buffer.from(bytes)
      });
    }
  );
  return requested;
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** The value the QR fixture encodes. */
export const QR_TEXT = 'STAPLER-AUDIT-QR-20261010';

/** One A4 page carrying a QR code for {@link QR_TEXT}, and a line of text. */
export async function qrPdf(): Promise<Uint8Array> {
  const png = await QRCode.toBuffer(QR_TEXT, { type: 'png', scale: 10, margin: 4 });
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText('Scan me', { x: 56, y: 780, size: 18, font });
  const image = await doc.embedPng(png);
  page.drawImage(image, { x: 150, y: 350, width: 300, height: 300 });
  return doc.save();
}

/** Every page's text through pdf.js, in page order — real extraction, not a byte grep. */
export async function pdfPageTexts(bytes: Uint8Array): Promise<string[]> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
  const texts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    texts.push(
      content.items
        .map(item => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    );
  }
  return texts;
}

/** True when page `index` of `bytes` draws at least one image XObject. */
export async function pageHasImage(bytes: Uint8Array, index: number): Promise<boolean> {
  const doc = await PDFDocument.load(bytes);
  const xobjects = doc.getPage(index).node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xobjects) return false;
  return xobjects.keys().some(key => {
    const stream = doc.context.lookup(xobjects.get(key));
    const dict = (stream as { dict?: { get: (n: PDFName) => unknown } } | undefined)?.dict;
    return String(dict?.get(PDFName.of('Subtype'))) === '/Image';
  });
}

/** A 2-page US Letter document whose text cannot be mistaken for `textPdf`'s. */
export async function insertSourcePdf(): Promise<string> {
  return ensureFixture('audit-insert-source-2.pdf', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 2; i++) {
      doc.addPage([612, 792]).drawText(`Inserted page ${i + 1}`, { x: 72, y: 700, size: 18, font });
    }
    return doc.save();
  });
}

/**
 * NFR-03 — a ~100 MB document, generated on demand into
 * `tests/fixtures/.generated/` (gitignored with the rest of `tests/fixtures/*`,
 * never committed).
 *
 * Twenty A4 pages, each drawing its *own* uncompressed 1300×1300 RGB noise
 * image (~5.07 MB of samples, no `/Filter`, so the size on disk is the pixel
 * data, deterministically — the same reasoning as `heavyPdf`), plus a line of
 * text naming the page so split/delete outputs can be checked by page. Twenty
 * distinct images rather than one shared one: a P0 operation on this file has
 * to carry 100 MB of distinct objects, not one object referenced twenty times.
 */
export const LARGE_PDF_PAGES = 20;

export async function ensureLargePdf(): Promise<string> {
  const dir = path.join(FIXTURES_DIR, '.generated');
  const file = path.join(dir, 'large-100mb.pdf');
  if (existsSync(file) && statSync(file).size > 95 * 1024 * 1024) return file;
  mkdirSync(dir, { recursive: true });

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const side = 1300;
  let seed = 20261010;
  for (let p = 0; p < LARGE_PDF_PAGES; p++) {
    const px = new Uint8Array(side * side * 3);
    for (let i = 0; i < px.length; i++) {
      // Math.imul: a plain multiply passes 2^53 and loses the low bits, so the
      // "noise" came out partly compressible.
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      px[i] = (seed >> 16) & 0xff;
    }
    const image = doc.context.register(
      doc.context.stream(px, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: side,
        Height: side,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8
      })
    );
    const page = doc.addPage([595.28, 841.89]);
    page.node.setXObject(PDFName.of('Im0'), image);
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(480, 0, 0, 480, 56, 200),
      drawObject('Im0'),
      popGraphicsState()
    );
    page.drawText(`Large fixture page ${p + 1}`, { x: 56, y: 780, size: 18, font });
  }
  writeFileSync(file, await doc.save({ useObjectStreams: false }));
  return file;
}

/**
 * OPS-18 — QR and 1D barcode encoding. SCN-04 — decoding (see
 * `decodeBarcodesFromImage` at the bottom of this file).
 *
 * Both `qrcode` and `jsbarcode` are bundled, vendored dependencies (no runtime
 * fetch of any kind — the zero-network invariant is about network calls, not
 * about which libraries ship in the bundle; `pdf-lib`/`pdf.js`/`tesseract.js`
 * are already bundled the same way). Neither library's *encoder* needs a DOM:
 * `qrcode`'s `create()` returns a pure module matrix with no canvas involved,
 * and `jsbarcode`'s "object" render target (an empty plain object, matched by
 * its `getRenderProperties` on having no `nodeName`/`getContext`) populates
 * `.encodings` with the encoded bar pattern instead of drawing anywhere — so
 * this runs identically on the main thread or inside a worker.
 *
 * QR is rasterised here by hand into a flat RGB buffer, then handed to the
 * existing `encodePng` writer — the same "no canvas round trip" approach
 * `png.ts` already uses for extraction. QR tolerates that raster round-trip
 * (through `PDFDocument.embedPng`, then whatever DPI a viewer/printer/scanner
 * renders it at) because its Reed-Solomon error correction absorbs the
 * antialiasing a raster resample introduces.
 *
 * CODE128 does not get the same treatment: `process.worker.ts` draws its bars
 * as vector rectangles instead of a raster this module produces, because a 1D
 * barcode has no error correction and decodes by comparing *relative bar
 * widths* — antialiasing from rasterising here and then rendering the PDF at
 * whatever DPI a viewer chooses was enough width distortion, in testing, to
 * make a real decoder fail on an otherwise correctly-encoded barcode. This
 * module exposes the bar pattern (`encodeCode128Bars`) rather than a raster,
 * so the caller can draw it as PDF vector content, which stays geometrically
 * exact at any render resolution.
 *
 * Both paths are round-tripped against an independent decoder (`zxing-wasm`,
 * ZXing-C++ compiled to WASM — not derived from either encoder here) in
 * `tests/unit/barcode.test.ts`.
 */
import QRCode from 'qrcode';
import JsBarcode from 'jsbarcode';
import { encodePng } from './png';
import { internal } from './errors';

export type BarcodeKind = 'qr' | 'code128';

export interface BarcodeRaster {
  width: number;
  height: number;
  pngBytes: Uint8Array;
}

/** Modules are drawn this many pixels wide — legible to a scanner without an oversized file. */
const QR_MODULE_PX = 6;
const QR_QUIET_MODULES = 4;

function fillRect(
  samples: Uint8Array,
  width: number,
  x0: number,
  y0: number,
  w: number,
  h: number
): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const idx = (y * width + x) * 3;
      samples[idx] = 0;
      samples[idx + 1] = 0;
      samples[idx + 2] = 0;
    }
  }
}

/** OPS-18 — encodes `text` as a QR raster, ready to embed and stamp onto a page. */
export function generateQrRaster(text: string): BarcodeRaster {
  if (!text.trim()) throw internal('There is no text to encode.');
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const dim = size * QR_MODULE_PX + QR_QUIET_MODULES * 2 * QR_MODULE_PX;
  const samples = new Uint8Array(dim * dim * 3).fill(255);

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!qr.modules.get(row, col)) continue;
      fillRect(
        samples,
        dim,
        (QR_QUIET_MODULES + col) * QR_MODULE_PX,
        (QR_QUIET_MODULES + row) * QR_MODULE_PX,
        QR_MODULE_PX,
        QR_MODULE_PX
      );
    }
  }

  return {
    width: dim,
    height: dim,
    pngBytes: encodePng({ width: dim, height: dim, bitDepth: 8, colorType: 2, samples })
  };
}

/**
 * `jsbarcode`'s shipped `.d.ts` only covers the string-selector/canvas/image/
 * SVG-element call shapes it renders directly to. Passing a plain object is
 * real, supported behaviour it does not advertise in its types:
 * `getRenderProperties` explicitly matches "an object with no `nodeName`" to
 * its `ObjectRenderer`, which does nothing but assign the encoded bar pattern
 * onto that object instead of drawing anywhere — exactly the DOM-free encode
 * this module needs. One local, well-isolated cast bridges the gap between
 * that real behaviour and the narrower published signature.
 */
type JsBarcodeObjectTarget = (
  target: { encodings?: { data: string }[] },
  text: string,
  options: { format: string }
) => void;

/**
 * OPS-18 — the bar/space pattern for `text` as CODE128, one character per
 * module ('1' = bar, '0' = space), start/checksum/stop characters included,
 * quiet zone excluded (the caller decides how much to add, in whatever unit
 * it is drawing in). Meant to be drawn as vector rectangles — see the module
 * doc comment above for why this is not rasterised the way QR is.
 */
export function encodeCode128Bars(text: string): string {
  if (!text.trim()) throw internal('There is no text to encode.');
  const target: { encodings?: { data: string }[] } = {};
  (JsBarcode as unknown as JsBarcodeObjectTarget)(target, text, { format: 'CODE128' });
  const encoding = target.encodings?.[0];
  if (!encoding) throw internal('Could not encode this text as a CODE128 barcode.');
  return encoding.data;
}

export interface DecodedBarcode {
  text: string;
  /** Canonical ZXing format name, e.g. `'QRCode'`, `'Code128'`. */
  format: string;
}

/**
 * `zxing-wasm` defaults `locateFile` to the jsDelivr CDN — real behaviour
 * documented on `PrepareZXingModuleOptions.overrides`, not an oversight, but
 * exactly the remote-code-execution risk PLAN §5.4 item 2 rules out (unlike
 * OCR's language *model*, this is the decoding *engine* itself). It went
 * unnoticed against the dev server, where the request happens to succeed
 * against the real internet and nothing looks wrong; loading the actual
 * packaged extension and watching the network panel is what caught it — the
 * exact way OCR-04's `workerBlobURL` bug was found, and the reason this is
 * verified there rather than trusted from the dev server.
 *
 * Overridden here the same way `ocr.worker.ts`'s `WORKER_PATH`/`CORE_PATH`
 * are: resolved from this worker's own `self.location`, so the same code
 * finds the right file under `chrome-extension://` and on the website twin
 * without either build knowing the other's base path. `self.location` is
 * meaningless outside a worker/window (the Node test environment, notably),
 * so the override is skipped there and the library's own resolution — which
 * behaves correctly under plain Node — is left alone.
 */
let zxingPrepared: Promise<void> | undefined;

function ensureZxingLocalWasm(): Promise<void> {
  if (!zxingPrepared) {
    // Not cached on failure: a transient error here (a dropped fetch, a
    // worker torn down mid-instantiation) would otherwise wedge every later
    // `decodeBarcodesFromImage` call for the rest of the page's lifetime,
    // re-throwing the same stale error with no way to recover short of a
    // reload. Clearing the memo lets the next call retry from scratch.
    zxingPrepared = (async () => {
      if (typeof self === 'undefined' || typeof self.location?.href !== 'string') return;
      const assetsBase = self.location.href.replace(/[^/]*$/, '');
      const { prepareZXingModule } = await import('zxing-wasm/reader');
      // Must resolve before the first `readBarcodes` call below, or that call
      // instantiates the module lazily with the library's own CDN default
      // `locateFile` first, which is the exact bug this exists to prevent.
      await prepareZXingModule({
        overrides: { locateFile: (path: string) => `${assetsBase}${path}` },
        fireImmediately: true
      });
    })().catch(err => {
      zxingPrepared = undefined;
      throw err;
    });
  }
  return zxingPrepared;
}

/**
 * SCN-04 — scans one rendered page bitmap for any barcode/QR code ZXing knows
 * how to read. `zxing-wasm` is a real bundled dependency (a WASM binary
 * fetched from the extension's own bundle, same-origin — not a runtime
 * network call; see the module doc comment above on why bundled engines are
 * distinct from the zero-network invariant). Its reader build is
 * single-threaded — no worker of its own to spawn, so none of OCR-04's
 * blob-URL-under-MV3-CSP problem applies here.
 *
 * Library defaults (`tryHarder`, `tryRotate`, `tryInvert` all on) are used
 * as-is: they are tuned for exactly this "find whatever is on a real,
 * possibly imperfectly-scanned page" case, not the synthetic, perfectly
 * upright images the encoders in this module produce.
 */
export async function decodeBarcodesFromImage(image: {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}): Promise<DecodedBarcode[]> {
  await ensureZxingLocalWasm();
  const { readBarcodes } = await import('zxing-wasm/reader');
  const results = await readBarcodes({
    data: image.data instanceof Uint8ClampedArray ? image.data : new Uint8ClampedArray(image.data),
    width: image.width,
    height: image.height,
    colorSpace: 'srgb'
  });
  return results.filter(r => r.isValid).map(r => ({ text: r.text, format: r.format }));
}

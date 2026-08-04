/**
 * The one place pdf.js is configured. Imported by the render worker only.
 *
 * Four things here are load-bearing rather than tuning:
 *
 *  • `CanvasFactory` / `FilterFactory` — pdf.js defaults to DOM implementations that
 *    reach for `document`, which does not exist in a worker, so `getDocument()` threw
 *    `ReferenceError: document is not defined` before it read a single byte. All the
 *    heavy work is supposed to happen in a worker (PLAN §5.1), so worker-safe factories
 *    are what make that possible at all.
 *  • `cMapUrl` / `standardFontDataUrl` / `wasmUrl` / `iccUrl` point at copies of the
 *    pdf.js data files bundled by the `stapler:pdfjs-assets` Vite plugin. Left unset,
 *    pdf.js fetches them from a remote-relative default — a network request the
 *    zero-network invariant forbids (PLAN §5.4), and a 404 inside the extension, which
 *    is how CJK text and JBIG2 images silently fail to render.
 *  • No `isEvalSupported` flag: pdf.js v6 dropped it, having stopped compiling glyph
 *    programs with `new Function`, which MV3's `script-src 'self'` would block. If a
 *    future version reintroduces eval, this is where to disable it.
 *  • Nothing enables scripting. pdf.js only runs JavaScript embedded in a document when
 *    the viewer asks it to, and the build deliberately ships no quickjs interpreter for
 *    it. RED-04 exists to strip embedded script, not to run it.
 */
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorkerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url';

/*
 * pdf.js resolves its data-file URLs through an internal `fetchData` helper that reads
 * `document.baseURI`, with no option to override it. In a worker there is no `document`,
 * so merely *evaluating* that expression throws `ReferenceError` before a single byte of
 * the PDF is read — which is why loading a document in a worker failed outright.
 *
 * This supplies the one property that helper needs and nothing else. It is deliberately
 * not a DOM stand-in: every pdf.js path that genuinely wants a DOM (the XFA layer, the
 * annotation editor) is one we never call, and if that ever changed we would rather see a
 * blunt `createElement is not a function` than have a fake DOM quietly return nothing.
 *
 * `fetchData` is called lazily, on the first document load, so assigning here — after the
 * hoisted imports have already been evaluated — is early enough.
 */
const workerGlobal = globalThis as { document?: { baseURI: string } };
if (typeof workerGlobal.document === 'undefined') {
  workerGlobal.document = { baseURI: self.location.href };
}

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerSrc;

/**
 * Base URL of the bundled pdf.js data files.
 *
 * Resolved from this worker's own location, with the hashed `assets/` segment stripped,
 * so it is correct under `chrome-extension://` and on the website twin without either
 * knowing the other's base path.
 */
const ASSETS = new URL('pdfjs/', self.location.href.replace(/\/assets\/[^/]*$/, '/')).href;

/**
 * OffscreenCanvas stand-in for pdf.js's `DOMCanvasFactory`.
 *
 * Same shape pdf.js expects — `create`, `reset`, `destroy` — with no `document`.
 */
class OffscreenCanvasFactory {
  #enableHWA: boolean;

  constructor({ enableHWA = false }: { enableHWA?: boolean } = {}) {
    this.#enableHWA = enableHWA;
  }

  create(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: !this.#enableHWA });
    return { canvas, context };
  }

  reset(canvasAndContext: { canvas: OffscreenCanvas | null }, width: number, height: number) {
    if (!canvasAndContext.canvas) throw new Error('Canvas is not specified');
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext: {
    canvas: OffscreenCanvas | null;
    context: OffscreenCanvasRenderingContext2D | null;
  }) {
    if (!canvasAndContext.canvas) return;
    // Releasing the backing store early keeps peak memory down on long documents.
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

/**
 * pdf.js uses SVG filters to apply transfer maps and soft masks *without* touching
 * pixels, which needs a DOM. In a worker there is nothing to attach a filter to, so
 * every hook returns `'none'`.
 *
 * The visible consequence is narrow: images carrying a /Decode transfer function or a
 * high-contrast override render without it. Since Stapler never asks pdf.js for
 * high-contrast rendering, and a missing transfer map is a subtle tone shift rather than
 * corruption, this is the right trade for keeping rendering off the main thread. The
 * compression classifier separately refuses to *re-encode* masked images at all
 * (CMP-01), so nothing here can be written back into a document.
 */
class NoopFilterFactory {
  addFilter() {
    return 'none';
  }
  addHCMFilter() {
    return 'none';
  }
  addAlphaFilter() {
    return 'none';
  }
  addLuminosityFilter() {
    return 'none';
  }
  addKnockoutFilter() {
    return 'none';
  }
  addHighlightHCMFilter() {
    return 'none';
  }
  addSelectionHCMFilter() {
    return 'none';
  }
  addSelectionFilter() {
    return 'none';
  }
  createSelectionStyle() {
    return null;
  }
  destroy() {}
}

export interface OpenOptions {
  /** pdf.js takes ownership of the buffer it is given, so pass a copy if reused. */
  data: Uint8Array;
  password?: string;
}

export function openDocument({ data, password }: OpenOptions) {
  return pdfjsLib.getDocument({
    data,
    password,
    cMapUrl: `${ASSETS}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${ASSETS}standard_fonts/`,
    wasmUrl: `${ASSETS}wasm/`,
    iccUrl: `${ASSETS}iccs/`,
    CanvasFactory: OffscreenCanvasFactory,
    FilterFactory: NoopFilterFactory,
    // Rendering happens on an OffscreenCanvas; there is no document to install
    // @font-face rules into, so glyphs are drawn as paths.
    disableFontFace: true
  });
}

export { pdfjsLib };

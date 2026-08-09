/**
 * The pdf.js worker: everything that *reads* a PDF.
 *
 * Consolidated from three workers (`render`, `redact`, `verify`) that each bundled
 * their own copy of pdf.js — 1.7MB of duplicated code and three independent
 * document caches. PLAN §2.1 specifies one reader and one writer.
 *
 * Documents live behind an opaque handle so callers never re-parse bytes they have
 * already loaded, and every multi-page loop is a cancellation point.
 */
import * as Comlink from 'comlink';
import { openDocument, pdfjsLib } from './pdfjs-setup';
import { checkpoint, type JobHandle } from './protocol';
import { corrupt, encrypted, internal } from '../errors';
import { DOC_PAGE_WHITE } from '../doc-colors';
import { blankCoverageLimit, inkCoverage, layoutText, toRgba, type TextRun } from '../text-layout';
import type { RedactionRegion } from './process.worker';

export interface DocumentInfo {
  handle: string;
  pageCount: number;
  isXfa: boolean;
  /** Two documents with the same fingerprint are the same file to pdf.js. */
  fingerprint: string;
  /** Page sizes in CSS pixels at scale 1, i.e. points with /Rotate applied. */
  pageSizes: { width: number; height: number }[];
}

export interface TextRegion {
  pageIndex: number;
  /** Normalised to the page box, origin top-left, ready for the DOM. */
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
}

export interface PageTextPresence {
  pageIndex: number;
  /** Non-whitespace characters pdf.js can extract. */
  charCount: number;
  /** Glyph-drawing runs — distinguishes "no text" from "one stray label". */
  runCount: number;
}

export interface ExtractedImage {
  /**
   * PDF object number of the image XObject this JPEG replaces.
   *
   * Deliberately *not* the resource name: pdf.js identifies images in an operator
   * list by its own generated id (`img_p0_1`), which has no relationship to the
   * `/XObject` key in the page's resources, and the same image reached from two
   * pages gets two different ids. The object number is the one identifier both
   * halves of the pipeline agree on.
   */
  objectNumber: number;
  jpeg: Uint8Array;
  /** Pixel size of the JPEG, which is the downscaled size, not the source size. */
  width: number;
  height: number;
  /** Source pixel size, so the caller can report what was actually resampled. */
  sourceWidth: number;
  sourceHeight: number;
  /**
   * True when pdf.js applied an /SMask or stencil /Mask to this image. The JPEG
   * carries the *base colour* only; the mask has to be re-attached to the
   * replacement stream or the image renders opaque.
   */
  hadTransparency: boolean;
  /** Downscaled grayscale mask (SMask) pixels, uncompressed. */
  maskBytes?: Uint8Array;
}

export interface RegionRaster {
  png: Uint8Array;
  width: number;
  height: number;
}

export interface RenderJob {
  loadDocument(bytes: Uint8Array, password?: string): Promise<DocumentInfo>;
  closeDocument(handle: string): Promise<void>;
  renderPage(handle: string, pageIndex: number, scale: number): Promise<ImageBitmap>;
  pageToImageBytes(
    handle: string,
    pageIndex: number,
    format: 'png' | 'jpeg',
    dpi: number,
    quality?: number
  ): Promise<Uint8Array>;
  renderRegionPng(
    handle: string,
    pageIndex: number,
    region: { x: number; y: number; width: number; height: number },
    dpi: number
  ): Promise<RegionRaster>;
  extractText(handle: string, pageIndex: number, mode: 'text' | 'markdown'): Promise<string>;
  textPresence(handle: string, job?: JobHandle): Promise<PageTextPresence[]>;
  findText(
    handle: string,
    query: string,
    matchCase: boolean,
    job?: JobHandle
  ): Promise<TextRegion[]>;
  /** Per-page text — the input to the redaction verifier. */
  documentText(handle: string, job?: JobHandle): Promise<string[]>;
  detectBlankPages(handle: string, threshold: number, job?: JobHandle): Promise<number[]>;
  detectSignatureLines(handle: string, job?: JobHandle): Promise<TextRegion[]>;
  /**
   * Re-encodes the page's image XObjects to JPEG (CMP-03). `wanted` names the
   * object numbers worth touching; anything else on the page is left alone.
   */
  extractPageImages(
    handle: string,
    pageIndex: number,
    quality: number,
    targetDpi: number,
    wanted?: number[]
  ): Promise<ExtractedImage[]>;
  checkRegionText(
    handle: string,
    regions: RedactionRegion[]
  ): Promise<{ region: RedactionRegion; foundText: string }[]>;
}

interface DocEntry {
  doc: pdfjsLib.PDFDocumentProxy;
  task: pdfjsLib.PDFDocumentLoadingTask;
}

/**
 * The subset of pdf.js's annotation shape this module reads. `getAnnotations()`
 * returns a loosely-typed grab-bag whose exact fields vary by annotation type
 * (`contents` for markup annotations, `fieldValue`/`buttonValue` for form
 * widgets) — pdf.js does not export a discriminated union for it.
 */
interface PdfJsAnnotation {
  contents?: string;
  fieldValue?: string;
  buttonValue?: string;
  rect?: [number, number, number, number];
}

const docs = new Map<string, DocEntry>();

function entry(handle: string): DocEntry {
  const found = docs.get(handle);
  if (!found) throw internal(`Render handle is not open`, { handle });
  return found;
}

function isTextRun(item: unknown): item is TextRun {
  return typeof item === 'object' && item !== null && 'str' in item && 'transform' in item;
}

async function textRuns(page: pdfjsLib.PDFPageProxy): Promise<TextRun[]> {
  const content = await page.getTextContent();
  // getTextContent returns marked-content markers interleaved with glyph runs.
  return (content.items as unknown[]).filter(isTextRun);
}

function offscreen(width: number, height: number) {
  const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw internal('OffscreenCanvas 2D context unavailable');
  return { canvas, ctx };
}

/**
 * pdf.js v6 wants an explicit `canvas` property; passing `null` alongside
 * `canvasContext` is the documented way to render into an OffscreenCanvas.
 */
function renderParams(ctx: OffscreenCanvasRenderingContext2D, viewport: pdfjsLib.PageViewport) {
  return {
    canvas: null,
    canvasContext: ctx as unknown as CanvasRenderingContext2D,
    viewport,
    background: DOC_PAGE_WHITE,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE
  };
}

const api: RenderJob = {
  async loadDocument(bytes, password) {
    // pdf.js takes ownership of the buffer it is given, so hand it a copy — the
    // caller's Uint8Array has to stay usable for the pdf-lib half of the pipeline.
    const task = openDocument({ data: new Uint8Array(bytes), password });
    let doc: pdfjsLib.PDFDocumentProxy;
    try {
      doc = await task.promise;
    } catch (err) {
      // Detect-and-explain, never half-process (PLAN §5.2).
      if (err instanceof pdfjsLib.PasswordException) {
        throw encrypted('The document requires a password to open.');
      }
      if (err instanceof pdfjsLib.InvalidPDFException) {
        throw corrupt('The file is not a readable PDF — its structure is invalid or truncated.');
      }
      throw err;
    }

    const handle = crypto.randomUUID();
    docs.set(handle, { doc, task });

    try {
      const pageSizes: DocumentInfo['pageSizes'] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const { width, height } = page.getViewport({ scale: 1 });
        pageSizes.push({ width, height });
        page.cleanup();
      }

      return {
        handle,
        pageCount: doc.numPages,
        isXfa: Boolean(doc.isPureXfa),
        fingerprint: doc.fingerprints[0] ?? handle,
        pageSizes
      };
    } catch (err) {
      docs.delete(handle);
      await doc.cleanup().catch(() => {});
      await task.destroy().catch(() => {});
      throw err;
    }
  },

  async closeDocument(handle) {
    const found = docs.get(handle);
    if (!found) return;
    docs.delete(handle);
    await found.doc.cleanup();
    await found.task.destroy();
  },

  async renderPage(handle, pageIndex, scale) {
    const page = await entry(handle).doc.getPage(pageIndex + 1);
    try {
      const viewport = page.getViewport({ scale });
      const { canvas, ctx } = offscreen(viewport.width, viewport.height);
      await page.render(renderParams(ctx, viewport)).promise;
      const bitmap = canvas.transferToImageBitmap();
      return Comlink.transfer(bitmap, [bitmap]);
    } finally {
      page.cleanup();
    }
  },

  async pageToImageBytes(handle, pageIndex, format, dpi, quality) {
    const page = await entry(handle).doc.getPage(pageIndex + 1);
    try {
      const viewport = page.getViewport({ scale: dpi / 72 });
      const { canvas, ctx } = offscreen(viewport.width, viewport.height);
      await page.render(renderParams(ctx, viewport)).promise;
      const blob = await canvas.convertToBlob({
        type: `image/${format}`,
        quality: format === 'jpeg' ? (quality ?? 0.92) : undefined
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return Comlink.transfer(bytes, [bytes.buffer]);
    } finally {
      page.cleanup();
    }
  },

  async renderRegionPng(handle, pageIndex, region, dpi) {
    const page = await entry(handle).doc.getPage(pageIndex + 1);
    try {
      const full = page.getViewport({ scale: dpi / 72 });
      const px = {
        x: region.x * full.width,
        y: region.y * full.height,
        width: Math.max(1, region.width * full.width),
        height: Math.max(1, region.height * full.height)
      };
      const { canvas, ctx } = offscreen(px.width, px.height);
      // Shift the page so the requested region lands on the canvas origin.
      await page.render({
        ...renderParams(ctx, full),
        transform: [1, 0, 0, 1, -px.x, -px.y]
      }).promise;
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const png = new Uint8Array(await blob.arrayBuffer());
      return Comlink.transfer({ png, width: canvas.width, height: canvas.height }, [png.buffer]);
    } finally {
      page.cleanup();
    }
  },

  async extractText(handle, pageIndex, mode) {
    const page = await entry(handle).doc.getPage(pageIndex + 1);
    try {
      return layoutText(await textRuns(page), mode);
    } finally {
      page.cleanup();
    }
  },

  async textPresence(handle, job) {
    const { doc } = entry(handle);
    const out: PageTextPresence[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      await checkpoint(job, (i - 1) / doc.numPages, `Analysing page ${i} of ${doc.numPages}`);
      const page = await doc.getPage(i);
      try {
        const runs = await textRuns(page);
        out.push({
          pageIndex: i - 1,
          charCount: runs.reduce((n, run) => n + run.str.trim().length, 0),
          runCount: runs.length
        });
      } catch {
        // An unparseable text layer counts as no text; the classifier decides
        // what that means rather than this loop failing the whole analysis.
        out.push({ pageIndex: i - 1, charCount: 0, runCount: 0 });
      } finally {
        page.cleanup();
      }
    }
    return out;
  },

  async documentText(handle, job) {
    const { doc } = entry(handle);
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      await checkpoint(job, (i - 1) / doc.numPages, `Reading page ${i} of ${doc.numPages}`);
      const page = await doc.getPage(i);
      try {
        const textFromRuns = (await textRuns(page)).map(run => run.str).join('');
        const annots = (await page.getAnnotations()) as PdfJsAnnotation[];
        const textFromAnnots = annots
          .flatMap(a => [a.contents, a.fieldValue, a.buttonValue])
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .join('\n');
        pages.push(textFromRuns + '\n' + textFromAnnots);
      } finally {
        page.cleanup();
      }
    }
    return pages;
  },

  async findText(handle, query, matchCase, job) {
    const needle = matchCase ? query : query.toLowerCase();
    if (!needle) return [];
    const { doc } = entry(handle);
    const regions: TextRegion[] = [];

    for (let i = 1; i <= doc.numPages; i++) {
      await checkpoint(job, (i - 1) / doc.numPages, `Searching page ${i} of ${doc.numPages}`);
      const page = await doc.getPage(i);
      try {
        const viewport = page.getViewport({ scale: 1 });
        for (const run of await textRuns(page)) {
          if (!run.str.trim()) continue;
          const haystack = matchCase ? run.str : run.str.toLowerCase();

          // pdf.js does not expose per-glyph advance widths, so we divide the
          // total run width evenly across characters (monospace approximation).
          // For search this is intentionally over-inclusive — a slightly wider
          // hit box is safe. For verification at the exact redaction boundary a
          // character on the edge may be mis-classified, but the geometric check
          // in checkRegionText uses the same approximation so both sides are
          // consistently conservative.
          let from = 0;
          for (;;) {
            const at = haystack.indexOf(needle, from);
            if (at === -1) break;
            from = at + needle.length;

            const perChar = run.width / Math.max(1, run.str.length);
            const height = run.height || run.transform[3] || 12;
            regions.push({
              pageIndex: i - 1,
              x: (run.transform[4] + at * perChar) / viewport.width,
              y: 1 - (run.transform[5] + height) / viewport.height,
              width: (needle.length * perChar) / viewport.width,
              height: height / viewport.height,
              text: run.str.slice(at, at + needle.length)
            });
          }
        }

        const annots = (await page.getAnnotations()) as PdfJsAnnotation[];
        for (const annot of annots) {
          const contents = [annot.contents, annot.fieldValue, annot.buttonValue]
            .filter((s): s is string => typeof s === 'string')
            .join(' ');
          if (!contents.trim()) continue;

          const haystack = matchCase ? contents : contents.toLowerCase();
          let from = 0;
          for (;;) {
            const at = haystack.indexOf(needle, from);
            if (at === -1) break;
            from = at + needle.length;

            if (annot.rect) {
              const [llx, lly, urx, ury] = annot.rect;
              const [x1, y1] = viewport.convertToViewportPoint(llx, lly);
              const [x2, y2] = viewport.convertToViewportPoint(urx, ury);
              const x = Math.min(x1, x2) / viewport.width;
              const y = Math.min(y1, y2) / viewport.height;
              const width = Math.abs(x2 - x1) / viewport.width;
              const height = Math.abs(y2 - y1) / viewport.height;
              regions.push({
                pageIndex: i - 1,
                x,
                y,
                width,
                height,
                text: contents.slice(at, at + needle.length)
              });
            }
          }
        }
      } finally {
        page.cleanup();
      }
    }
    return regions;
  },

  async detectSignatureLines(handle, job) {
    const { doc } = entry(handle);
    const found: TextRegion[] = [];
    const LABEL = /signature|sign here|signed by|_{5,}/i;

    for (let i = 1; i <= doc.numPages; i++) {
      await checkpoint(job, (i - 1) / doc.numPages, `Scanning page ${i} of ${doc.numPages}`);
      const page = await doc.getPage(i);
      try {
        const viewport = page.getViewport({ scale: 1 });
        for (const run of await textRuns(page)) {
          if (!run.str.trim() || !LABEL.test(run.str)) continue;
          const height = run.height || run.transform[3] || 12;
          // Suggest a box sitting just above the label's baseline.
          const boxHeight = height * 2.5;
          found.push({
            pageIndex: i - 1,
            x: run.transform[4] / viewport.width,
            y: Math.max(0, 1 - (run.transform[5] + height + boxHeight) / viewport.height),
            width: Math.min(1, Math.max(run.width, height * 8) / viewport.width),
            height: boxHeight / viewport.height,
            text: run.str.trim()
          });
        }
      } finally {
        page.cleanup();
      }
    }
    return found;
  },

  async detectBlankPages(handle, threshold, job) {
    const { doc } = entry(handle);
    const blank: number[] = [];
    // A tenth-scale render is enough to measure ink coverage and keeps a
    // 300-page scan inside the memory budget.
    const scale = 0.1;
    const limit = blankCoverageLimit(threshold);

    for (let i = 1; i <= doc.numPages; i++) {
      await checkpoint(job, (i - 1) / doc.numPages, `Checking page ${i} of ${doc.numPages}`);
      const page = await doc.getPage(i);
      try {
        const viewport = page.getViewport({ scale });
        const { canvas, ctx } = offscreen(viewport.width, viewport.height);
        await page.render(renderParams(ctx, viewport)).promise;
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        if (inkCoverage(data) <= limit) blank.push(i - 1);
      } finally {
        page.cleanup();
      }
    }
    return blank;
  },

  async extractPageImages(handle, pageIndex, quality, targetDpi, wanted) {
    const page = await entry(handle).doc.getPage(pageIndex + 1);
    try {
      const ops = await page.getOperatorList();
      const out: ExtractedImage[] = [];

      for (const placement of imagePlacements(ops)) {
        const decoded = await decodeImage(page, placement.objId);
        // A null decode is pdf.js telling us it could not read the image
        // (JBIG2/JPX without a decoder, a broken stream). Leaving the original
        // in place is the only safe answer — PLAN §5.2.
        if (!decoded) continue;
        if (wanted && !wanted.includes(decoded.objectNumber)) continue;

        const target = targetSize(placement, decoded, targetDpi);
        const jpeg = await encodeJpeg(decoded, target, quality);
        // A mask is resampled to `target` whenever one exists, not only when the
        // *colour* image's own dimensions changed. The colour image and its
        // `/SMask` are independent XObjects — a small image can carry a
        // disproportionately large soft mask (or vice versa) — and it is the
        // caller (`rebuildCompressed`) that ultimately decides whether the
        // original mask stream's own resolution actually warrants replacing it.
        const maskBytes = decoded.mask
          ? await encodeMask(decoded.mask, decoded.width, decoded.height, target)
          : undefined;

        out.push({
          objectNumber: decoded.objectNumber,
          jpeg,
          width: target.width,
          height: target.height,
          sourceWidth: decoded.width,
          sourceHeight: decoded.height,
          hadTransparency: decoded.hadTransparency,
          maskBytes
        });
      }

      return Comlink.transfer(
        out,
        out.map(o => o.jpeg.buffer)
      );
    } finally {
      page.cleanup();
    }
  },

  async checkRegionText(handle, regions) {
    const { doc } = entry(handle);
    const results: { region: RedactionRegion; foundText: string }[] = [];

    for (const region of regions) {
      const page = await doc.getPage(region.pageIndex + 1);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const runs = await textRuns(page);
        let foundText = '';

        for (const run of runs) {
          if (!run.str.trim()) continue;

          // Same monospace approximation as findText: pdf.js does not provide
          // per-glyph advance widths, so run.width is divided evenly across
          // characters. Characters at the exact boundary of a redaction region
          // may be slightly mis-classified, which is acceptable given that
          // the redaction itself uses the same coordinate system.
          const perChar = run.width / Math.max(1, run.str.length);
          const height = run.height || run.transform[3] || 12;

          for (let i = 0; i < run.str.length; i++) {
            const charX = (run.transform[4] + i * perChar) / viewport.width;
            const charY = 1 - (run.transform[5] + height) / viewport.height;
            const charW = perChar / viewport.width;
            const charH = height / viewport.height;

            const intersects = !(
              charX >= region.x + region.width ||
              charX + charW <= region.x ||
              charY >= region.y + region.height ||
              charY + charH <= region.y
            );

            if (intersects) {
              foundText += run.str[i];
            }
          }
        }
        results.push({ region, foundText });
      } finally {
        page.cleanup();
      }
    }
    return results;
  }
};

/* ------------------------------------------------------------------ *
 * Surgical image re-encode (CMP-03)
 * ------------------------------------------------------------------ */

/** `[a, b, c, d, e, f]`, the PDF transformation matrix. */
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m` applied first, then `ctm` — pdf.js's `Util.transform(ctm, m)`. */
function concat(ctm: Matrix, m: Matrix): Matrix {
  return [
    ctm[0] * m[0] + ctm[2] * m[1],
    ctm[1] * m[0] + ctm[3] * m[1],
    ctm[0] * m[2] + ctm[2] * m[3],
    ctm[1] * m[2] + ctm[3] * m[3],
    ctm[0] * m[4] + ctm[2] * m[5] + ctm[4],
    ctm[1] * m[4] + ctm[3] * m[5] + ctm[5]
  ];
}

interface ImagePlacement {
  /** pdf.js's own object id for the image, e.g. `img_p0_1`. */
  objId: string;
  /** Largest width this image is drawn at anywhere on the page, in points. */
  widthPt: number;
  heightPt: number;
  /** False when an operator we do not model could have changed the matrix. */
  measured: boolean;
}

function isMatrix(value: unknown): value is Matrix {
  return Array.isArray(value) && value.length === 6 && value.every(n => typeof n === 'number');
}

/**
 * Walks the operator list, tracking the CTM, and reports how large each image is
 * actually drawn — the input to "downscale to displayed size".
 *
 * Getting the matrix wrong can only pick the wrong *resolution*; the image is
 * still drawn into the same unit square, so geometry cannot break. Even so the
 * tracker refuses to guess: transparency groups and annotations re-base the
 * canvas transform in ways that are not visible from the operator list, so any
 * image drawn inside one is marked unmeasured and re-encoded at source size.
 */
function imagePlacements(ops: { fnArray: number[]; argsArray: unknown[] }): ImagePlacement[] {
  const OPS = pdfjsLib.OPS;
  const found = new Map<string, ImagePlacement>();
  const stack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;

  const record = (objId: unknown, scaleX: number, scaleY: number) => {
    if (typeof objId !== 'string') return;
    const widthPt = Math.abs(scaleX) * Math.hypot(ctm[0], ctm[1]);
    const heightPt = Math.abs(scaleY) * Math.hypot(ctm[2], ctm[3]);
    const previous = found.get(objId);
    if (!previous) {
      found.set(objId, { objId, widthPt, heightPt, measured: true });
      return;
    }
    // An image drawn twice has to survive at the size of its largest use.
    previous.widthPt = Math.max(previous.widthPt, widthPt);
    previous.heightPt = Math.max(previous.heightPt, heightPt);
  };

  for (let i = 0; i < ops.fnArray.length; i++) {
    const args = ops.argsArray[i];
    switch (ops.fnArray[i]) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? IDENTITY;
        break;
      case OPS.transform:
        if (isMatrix(args)) ctm = concat(ctm, args);
        break;
      case OPS.paintFormXObjectBegin: {
        stack.push(ctm);
        const matrix = Array.isArray(args) ? args[0] : null;
        if (isMatrix(matrix)) ctm = concat(ctm, matrix);
        break;
      }
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? IDENTITY;
        break;
      case OPS.paintImageXObject:
        if (Array.isArray(args)) record(args[0], 1, 1);
        break;
      case OPS.paintImageXObjectRepeat:
        // pdf.js collapses three or more identical draws into one op carrying
        // the per-instance scale.
        if (Array.isArray(args)) record(args[0], Number(args[1]) || 1, Number(args[2]) || 1);
        break;
      default:
        break;
    }
  }

  return [...found.values()];
}

interface DecodedImage {
  objectNumber: number;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  hadTransparency: boolean;
  mask?: Uint8Array;
}

/**
 * pdf.js writes `Ref.toString()` into the decoded image, e.g. `"7R"` or `"7R2"`.
 * That object number is the only identifier shared with the pdf-lib half of the
 * pipeline, which addresses the same image as `/XObject` entry N.
 */
function refObjectNumber(ref: unknown): number {
  if (typeof ref === 'string') {
    const match = /^(\d+)R/.exec(ref);
    return match ? Number(match[1]) : -1;
  }
  if (ref && typeof ref === 'object' && typeof (ref as { num?: unknown }).num === 'number') {
    return (ref as { num: number }).num;
  }
  return -1;
}

/**
 * How long to wait for pdf.js to hand over a decoded image before giving up.
 *
 * `getOperatorList()` resolves as soon as the *operators* are known: the
 * evaluator kicks off `PDFImage.buildImage()` and deliberately does not await it,
 * so the pixels arrive tens of milliseconds later, and for a large image much
 * later than that. The previous implementation asked `store.has(name)` the
 * instant the operator list came back, always got `false`, and skipped the image
 * — which is why the surgical path silently re-encoded nothing at all.
 */
const IMAGE_DECODE_TIMEOUT_MS = 60_000;

/**
 * Waits for one decoded image.
 *
 * Which store it lands in is not knowable in advance: an image used on a single
 * page goes to `page.objs`, and one pdf.js has seen on two pages is promoted to
 * the document-wide `commonObjs`. Both are asked, and whichever answers first
 * wins.
 */
function awaitImageObject(
  page: pdfjsLib.PDFPageProxy,
  objId: string
): Promise<{ data: unknown; shared: boolean } | null> {
  // pdf.js does not export the `PDFObjects` type, so the store is taken
  // structurally — the callback form of `get` is all this needs.
  const from = (
    store: { get(id: string, callback: (data: unknown) => void): unknown },
    shared: boolean
  ) =>
    new Promise<{ data: unknown; shared: boolean }>(resolve => {
      store.get(objId, (data: unknown) => resolve({ data, shared }));
    });
  return Promise.race([
    from(page.objs, false),
    from(page.commonObjs, true),
    new Promise<null>(resolve => setTimeout(() => resolve(null), IMAGE_DECODE_TIMEOUT_MS))
  ]);
}

interface DrawableFrame {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

/**
 * pdf.js hands back one of two drawable objects, and which one depends on the
 * filter: a Flate image arrives as an `ImageBitmap`, while a DCTDecode one is
 * decoded through WebCodecs and arrives as a `VideoFrame`. The old code only
 * recognised `ImageBitmap`, so *JPEG* images — by far the most common thing in
 * a PDF worth compressing — were silently skipped.
 */
function drawableFrom(...candidates: unknown[]): DrawableFrame | null {
  for (const candidate of candidates) {
    if (candidate instanceof ImageBitmap) {
      return {
        source: candidate,
        width: candidate.width,
        height: candidate.height,
        close: () => candidate.close()
      };
    }
    if (typeof VideoFrame !== 'undefined' && candidate instanceof VideoFrame) {
      return {
        source: candidate,
        width: candidate.displayWidth,
        height: candidate.displayHeight,
        close: () => candidate.close()
      };
    }
  }
  return null;
}

/**
 * Normalises whatever pdf.js decoded into straight RGBA.
 *
 * Two shapes come back. With OffscreenCanvas available the worker returns an
 * `ImageBitmap`, whose backing store is alpha-premultiplied; `getImageData`
 * undoes that, so colour is recovered to within a level or two wherever alpha is
 * non-zero, and is lost only where alpha is zero — pixels that contribute
 * nothing to the rendered result. Otherwise raw pixels arrive with a `kind`
 * discriminant. Anything else is refused rather than guessed at.
 *
 * The colour space has already been resolved by this point: pdf.js converts
 * DeviceCMYK, Indexed, ICCBased and friends to RGB while decoding, which is why
 * those images can be re-encoded at all.
 */
async function decodeImage(
  page: pdfjsLib.PDFPageProxy,
  objId: string
): Promise<DecodedImage | null> {
  const resolved = await awaitImageObject(page, objId);
  if (!resolved || !resolved.data || typeof resolved.data !== 'object') return null;

  const img = resolved.data as {
    bitmap?: unknown;
    data?: Uint8Array | Uint8ClampedArray;
    width?: number;
    height?: number;
    kind?: number;
    ref?: unknown;
  };
  const objectNumber = refObjectNumber(img.ref);
  // Without an object number there is no way to say which XObject this replaces.
  if (objectNumber < 0) return null;

  let rgba: Uint8ClampedArray | null = null;
  let width = 0;
  let height = 0;

  const frame = drawableFrom(img.bitmap, resolved.data);
  if (frame) {
    // pdf.js reports the logical size; a VideoFrame's own coded size can be
    // padded out to whole macroblocks, so the payload's dimensions win.
    width = img.width ?? frame.width;
    height = img.height ?? frame.height;
    const { canvas, ctx } = offscreen(width, height);
    ctx.drawImage(frame.source, 0, 0, width, height);
    rgba = ctx.getImageData(0, 0, width, height).data;
    // A frame in commonObjs belongs to the document, and other pages still need
    // it; only a page-local one is ours to release early.
    if (!resolved.shared) frame.close();
    canvas.width = 0;
    canvas.height = 0;
  } else if (img.data && img.width && img.height && img.kind !== undefined) {
    width = img.width;
    height = img.height;
    rgba = toRgba(img.data, width, height, img.kind);
  }

  if (!rgba || width <= 0 || height <= 0) return null;

  const mask = extractMask(rgba, width, height);
  return { objectNumber, rgba, width, height, hadTransparency: mask !== undefined, mask };
}

/**
 * Makes the buffer opaque, and reports whether it was not.
 *
 * JPEG has no alpha, so a canvas holding transparency is composited onto black
 * on the way out — which is exactly the "black box" this ticket exists to
 * prevent, and it is worse than it looks: a half-transparent pixel would be
 * darkened once here and again when the re-attached soft mask is applied.
 *
 * So the alpha is dropped deliberately rather than by accident. The colour is
 * kept as-is (it is the *un*-premultiplied base colour), and pixels that have no
 * colour of their own — fully transparent ones — are filled from the nearest
 * pixel that does. That fill is invisible in any correct renderer, because the
 * original soft mask is re-attached to the replacement stream and hides those
 * pixels again; its job is to stop JPEG's 8×8 blocks from smearing black across
 * the edge of the mask into pixels that *are* visible.
 */
function extractMask(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): Uint8Array | undefined {
  const total = width * height;
  let transparent = 0;
  let translucent = false;
  for (let p = 0; p < total; p++) {
    const alpha = rgba[p * 4 + 3];
    if (alpha === 0) transparent += 1;
    else if (alpha !== 255) translucent = true;
  }
  if (transparent === 0 && !translucent) return undefined;

  const mask = new Uint8Array(total);
  for (let p = 0; p < total; p++) {
    mask[p] = rgba[p * 4 + 3];
  }

  // Colourless pixels borrow from their nearest coloured neighbour; with none to
  // borrow from there is nothing to do but make the buffer opaque.
  if (transparent > 0 && transparent < total) bleedColour(rgba, width, height);
  for (let p = 0; p < total; p++) rgba[p * 4 + 3] = 255;
  return mask;
}

/**
 * Breadth-first fill of fully transparent pixels from their nearest opaque
 * neighbour. Every pixel is queued at most once, so this is linear in the image.
 */
function bleedColour(rgba: Uint8ClampedArray, width: number, height: number): void {
  const total = width * height;
  const queue = new Int32Array(total);
  const filled = new Uint8Array(total);
  let head = 0;
  let tail = 0;

  for (let p = 0; p < total; p++) {
    if (rgba[p * 4 + 3] !== 0) {
      filled[p] = 1;
      queue[tail++] = p;
    }
  }

  while (head < tail) {
    const from = queue[head++];
    const x = from % width;
    const y = (from - x) / width;
    for (let n = 0; n < 4; n++) {
      const nx = x + (n === 0 ? -1 : n === 1 ? 1 : 0);
      const ny = y + (n === 2 ? -1 : n === 3 ? 1 : 0);
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const to = ny * width + nx;
      if (filled[to]) continue;
      filled[to] = 1;
      rgba[to * 4] = rgba[from * 4];
      rgba[to * 4 + 1] = rgba[from * 4 + 1];
      rgba[to * 4 + 2] = rgba[from * 4 + 2];
      queue[tail++] = to;
    }
  }
}

interface TargetSize {
  width: number;
  height: number;
}

/** Below this ratio the resample costs quality for no meaningful saving. */
const MIN_RESAMPLE_RATIO = 1.15;

/**
 * Pixel size to re-encode at: the displayed size at the target resolution,
 * never larger than the source and never below one pixel.
 */
function targetSize(
  placement: ImagePlacement,
  decoded: DecodedImage,
  targetDpi: number
): TargetSize {
  const source = { width: decoded.width, height: decoded.height };
  if (!placement.measured || targetDpi <= 0) return source;
  if (placement.widthPt <= 0 || placement.heightPt <= 0) return source;

  const wanted = {
    width: Math.round((placement.widthPt / 72) * targetDpi),
    height: Math.round((placement.heightPt / 72) * targetDpi)
  };
  const ratio = Math.min(source.width / wanted.width, source.height / wanted.height);
  if (!Number.isFinite(ratio) || ratio < MIN_RESAMPLE_RATIO) return source;

  return {
    width: Math.max(1, Math.min(source.width, wanted.width)),
    height: Math.max(1, Math.min(source.height, wanted.height))
  };
}

async function encodeJpeg(
  decoded: DecodedImage,
  target: TargetSize,
  quality: number
): Promise<Uint8Array> {
  const source = new ImageData(decoded.rgba, decoded.width, decoded.height);
  const bitmap = await createImageBitmap(source);
  try {
    const { canvas, ctx } = offscreen(target.width, target.height);
    ctx.drawImage(bitmap, 0, 0, target.width, target.height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    canvas.width = 0;
    canvas.height = 0;
    return bytes;
  } finally {
    bitmap.close();
  }
}

async function encodeMask(
  mask: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  target: TargetSize
): Promise<Uint8Array> {
  if (sourceWidth === target.width && sourceHeight === target.height) {
    return mask;
  }

  const rgba = new Uint8ClampedArray(sourceWidth * sourceHeight * 4);
  for (let p = 0; p < mask.length; p++) {
    rgba[p * 4] = mask[p];
    rgba[p * 4 + 1] = mask[p];
    rgba[p * 4 + 2] = mask[p];
    rgba[p * 4 + 3] = 255;
  }

  const source = new ImageData(rgba, sourceWidth, sourceHeight);
  const bitmap = await createImageBitmap(source);
  try {
    const { canvas, ctx } = offscreen(target.width, target.height);
    ctx.drawImage(bitmap, 0, 0, target.width, target.height);
    const { data } = ctx.getImageData(0, 0, target.width, target.height);

    const outMask = new Uint8Array(target.width * target.height);
    for (let p = 0; p < outMask.length; p++) {
      outMask[p] = data[p * 4]; // Copy back the R channel
    }

    canvas.width = 0;
    canvas.height = 0;
    return outMask;
  } finally {
    bitmap.close();
  }
}

Comlink.expose(api);

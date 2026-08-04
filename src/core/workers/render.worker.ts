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
  /** XObject name as it appears in the page's /Resources, e.g. `Im1`. */
  name: string;
  jpeg: Uint8Array;
  width: number;
  height: number;
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
  extractPageImages(
    handle: string,
    pageIndex: number,
    quality: number,
    wantedNames?: string[]
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
        pages.push((await textRuns(page)).map(run => run.str).join(''));
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

  async extractPageImages(handle, pageIndex, quality, wantedNames) {
    const page = await entry(handle).doc.getPage(pageIndex + 1);
    try {
      const ops = await page.getOperatorList();
      const out: ExtractedImage[] = [];
      const seen = new Set<string>();

      for (let i = 0; i < ops.fnArray.length; i++) {
        // Only plain image XObjects. Masks, inline images, and repeats are left
        // alone: re-encoding them needs the mask geometry we do not have here,
        // and getting it wrong is what produces black boxes.
        if (ops.fnArray[i] !== pdfjsLib.OPS.paintImageXObject) continue;
        const name = ops.argsArray[i][0];
        if (typeof name !== 'string' || seen.has(name)) continue;
        if (wantedNames && !wantedNames.includes(name)) continue;
        seen.add(name);

        const bitmap = await resolveBitmap(page, name);
        if (!bitmap) continue;
        try {
          const { canvas, ctx } = offscreen(bitmap.width, bitmap.height);
          ctx.drawImage(bitmap, 0, 0);
          const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
          out.push({
            name,
            jpeg: new Uint8Array(await blob.arrayBuffer()),
            width: bitmap.width,
            height: bitmap.height
          });
        } finally {
          bitmap.close();
        }
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

/** Resolves an image XObject from the page store or the cross-page shared store. */
async function resolveImage(page: pdfjsLib.PDFPageProxy, name: string): Promise<unknown> {
  // Images reused across pages land in commonObjs, not objs — checking only the
  // latter silently skipped every shared image.
  for (const store of [page.objs, page.commonObjs]) {
    if (!store.has(name)) continue;
    return new Promise(resolve => store.get(name, resolve));
  }
  return null;
}

/**
 * pdf.js hands back either a decoded bitmap or raw pixels with a `kind`
 * discriminant. Anything we do not recognise returns null and is skipped.
 */
async function resolveBitmap(
  page: pdfjsLib.PDFPageProxy,
  name: string
): Promise<ImageBitmap | null> {
  const data = await resolveImage(page, name);
  if (!data) return null;
  if (data instanceof ImageBitmap) return data;

  const img = data as {
    bitmap?: unknown;
    data?: Uint8Array | Uint8ClampedArray;
    width?: number;
    height?: number;
    kind?: number;
  };
  if (img.bitmap instanceof ImageBitmap) return img.bitmap;
  if (!img.data || !img.width || !img.height || img.kind === undefined) return null;

  const rgba = toRgba(img.data, img.width, img.height, img.kind);
  if (!rgba) return null;
  return createImageBitmap(new ImageData(rgba, img.width, img.height));
}

Comlink.expose(api);

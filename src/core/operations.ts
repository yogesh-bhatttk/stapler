import { cropBoxes, pagesForScope } from '../ui/tools/crop/state';
import { commit } from './history';
/**
 * Tool operations, orchestrated on the main thread but executed in workers.
 *
 * This is the layer the UI calls. It owns the progress/cancel lifecycle so no
 * component has to, and it is where the honest-reporting rules live: nothing here
 * hands the user a file it cannot stand behind.
 */
import { processWorker, renderWorker, cvWorker } from './workers';
import { createJobHandle, type JobOptions } from './workers/protocol';
import type { RedactionRegion, StampSource } from './workers/process.worker';
import type { TextRegion } from './workers/render.worker';
import {
  MEANINGFUL_SAVING,
  classifyPages,
  estimateSavings,
  type CompressionPlan
} from './compress-plan';
import {
  activeDoc,
  bytesForPages,
  sources,
  activePageIndex,
  type Annotation,
  type PageRef
} from './store';
import { getSignature } from './signatures';
import {
  watermarkSettings,
  headerFooterSettings,
  hasWatermarkContent,
  hasHeaderFooterContent,
  type WatermarkSettings
} from '../ui/tools/watermark/state';
import type { WatermarkData } from './workers/process.worker';
import { internal, unsupported, cancelled } from './errors';

/**
 * Maps the UI's `WatermarkSettings` onto the worker's `WatermarkData`. The two
 * are structurally close — this only exists because `image: WatermarkImage |
 * null` needs to become `image?: WatermarkImageData`, which pdf-lib's worker
 * boundary (Comlink, structured clone) is happy with but a strict `null` isn't.
 */
function toWatermarkData(settings: WatermarkSettings): WatermarkData {
  return {
    kind: settings.kind,
    text: settings.text,
    image: settings.image ?? undefined,
    imageScale: settings.imageScale,
    position: settings.position,
    opacity: settings.opacity,
    rotation: settings.rotation,
    fontSize: settings.fontSize,
    color: settings.color,
    startAt: settings.startAt,
    pageRange: settings.pageRange
  };
}

/** Resolves signature stamps to bytes so the worker never touches IndexedDB. */
async function resolveStamps(pages: PageRef[], annotations: Annotation[]): Promise<StampSource[]> {
  const pageKeys = new Set(pages.map(p => p.key));
  const out: StampSource[] = [];
  const signatureCache = new Map<string, Uint8Array | null>();

  for (const annotation of annotations) {
    // A stamp on a page that has since been deleted must not be drawn anywhere.
    if (!pageKeys.has(annotation.pageKey)) continue;

    let imagePng: Uint8Array | undefined;
    if (annotation.type === 'signature') {
      if (!signatureCache.has(annotation.data)) {
        const signature = await getSignature(annotation.data);
        signatureCache.set(annotation.data, signature?.png ?? null);
      }
      const png = signatureCache.get(annotation.data);
      // A stamp whose signature was deleted is skipped, not drawn as a blank box.
      if (!png) continue;
      imagePng = png;
    }

    out.push({
      pageKey: annotation.pageKey,
      type: annotation.type,
      x: annotation.x,
      y: annotation.y,
      width: annotation.width,
      height: annotation.height,
      rotation: annotation.rotation,
      text: annotation.type === 'signature' ? undefined : annotation.data,
      imagePng
    });
  }
  return out;
}

export interface ComposeRequest {
  pages: PageRef[];
  annotations: Annotation[];
  layerAnnotations?: import('./workers/process.worker').AnnotationSource[];
  cropBoxes?: Record<string, { x: number; y: number; width: number; height: number }>;
  watermark?: WatermarkSettings;
  headerFooter?: import('../ui/tools/watermark/state').HeaderFooterSettings;
  normalize?: import('../ui/tools/normalize/state').NormalizeSettings | null;
  nup?: import('../ui/tools/nup/state').NUpSettings | null;
}

/** DOC-05 — compose the current model into output bytes. */
export async function composeDocument(
  request: ComposeRequest,
  options: JobOptions = {}
): Promise<Uint8Array> {
  if (request.pages.length === 0) throw internal('There are no pages to export.');
  const stamps = await resolveStamps(request.pages, request.annotations);
  const job = createJobHandle(options);
  const mappedPages = request.pages.map(p => ({
    ...p,
    cropBox: request.cropBoxes?.[p.key]
  }));
  return processWorker.lease(api =>
    api.compose(
      mappedPages,
      bytesForPages(request.pages),
      stamps,
      request.watermark && hasWatermarkContent(request.watermark)
        ? toWatermarkData(request.watermark)
        : undefined,
      request.headerFooter && hasHeaderFooterContent(request.headerFooter)
        ? request.headerFooter
        : undefined,
      request.normalize,
      request.nup,
      request.layerAnnotations,
      job
    )
  );
}

export interface SplitRequest extends ComposeRequest {
  boundaries: number[];
  baseName: string;
}

export async function splitDocument(request: SplitRequest, options: JobOptions = {}) {
  const stamps = await resolveStamps(request.pages, request.annotations);
  const job = createJobHandle(options);
  const mappedPages = request.pages.map(p => ({
    ...p,
    cropBox: request.cropBoxes?.[p.key]
  }));
  return processWorker.lease(api =>
    api.composeSplit(
      mappedPages,
      bytesForPages(request.pages),
      request.boundaries,
      stamps,
      request.watermark && hasWatermarkContent(request.watermark)
        ? toWatermarkData(request.watermark)
        : undefined,
      request.headerFooter && hasHeaderFooterContent(request.headerFooter)
        ? request.headerFooter
        : undefined,
      request.normalize,
      request.nup,
      request.baseName,
      request.layerAnnotations,
      job
    )
  );
}

/**
 * Turns split-mode settings into page-boundary indices.
 *
 * Pure, and exported for unit tests: off-by-one errors here silently drop or
 * duplicate pages, and OPS-03's acceptance criterion is that the union of outputs
 * equals the input page set.
 */
export function splitBoundaries(
  mode: 'individual' | 'every_n' | 'custom',
  pageCount: number,
  options: { every?: number; custom?: string } = {}
): number[] {
  if (pageCount <= 1) return [];

  if (mode === 'individual') {
    return Array.from({ length: pageCount - 1 }, (_, i) => i + 1);
  }

  if (mode === 'every_n') {
    const step = Math.max(1, Math.floor(options.every ?? 1));
    const out: number[] = [];
    for (let at = step; at < pageCount; at += step) out.push(at);
    return out;
  }

  // "5, 10" means "cut after page 5 and after page 10" — 1-based page numbers from
  // the user, 0-based boundary indices for the worker.
  return [
    ...new Set(
      (options.custom ?? '')
        .split(/[,\s]+/)
        .map(part => Number.parseInt(part, 10))
        .filter(n => Number.isInteger(n) && n > 0 && n < pageCount)
    )
  ].sort((a, b) => a - b);
}

export async function getFormFields(bytes: Uint8Array) {
  return processWorker.lease(api => api.getFormFields(bytes));
}

export async function fillFormFields(
  bytes: Uint8Array,
  values: Record<string, string | string[] | boolean>,
  flatten: boolean
) {
  return processWorker.lease(api => api.fillFormFields(bytes, values, flatten));
}

/* ------------------------------------------------------------------ *
 * Compression (EPIC-5)
 * ------------------------------------------------------------------ */

export interface CompressionReport {
  plan: CompressionPlan;
  originalBytes: number;
  /** Pre-flight projection, shown before any work is committed (CMP-04). */
  estimatedBytes: number;
  estimatedFraction: number;
  /** True when the honest answer is "there is nothing worth doing here". */
  alreadyOptimized: boolean;
}

export interface CompressSettings {
  dpi: number;
  quality: number;
}

/**
 * Analyses without modifying anything, so the UI can tell the user what is
 * achievable *before* spending a minute of their time.
 */
export async function planCompression(
  bytes: Uint8Array,
  settings: CompressSettings,
  options: JobOptions = {}
): Promise<CompressionReport> {
  const job = createJobHandle(options);
  const inventory = await processWorker.lease(api => api.imageInventory(bytes, job));

  // One lease for the whole read, because a render handle belongs to the worker
  // *instance* that opened it. The pool hands each `lease()` whichever instance
  // is idle, so opening a document in one call and using the handle in the next
  // is a race the caller loses as soon as the pool has grown past one — and it
  // surfaces as "Render handle is not open" halfway through a job.
  return renderWorker.lease(async api => {
    const { handle } = await api.loadDocument(bytes);
    try {
      const text = await api.textPresence(handle, job);
      const plan = classifyPages(inventory, text, { rasterDpi: settings.dpi });
      const estimate = estimateSavings(plan, bytes.byteLength, settings.quality);
      return {
        plan,
        originalBytes: bytes.byteLength,
        ...estimate,
        alreadyOptimized: estimate.estimatedFraction < MEANINGFUL_SAVING
      };
    } finally {
      await api.closeDocument(handle);
    }
  });
}

export interface CompressionResult {
  bytes: Uint8Array;
  originalBytes: number;
  /** True when the rebuilt file was not smaller and the original was kept. */
  keptOriginal: boolean;
  plan: CompressionPlan;
}

export async function compressDocument(
  bytes: Uint8Array,
  settings: CompressSettings,
  report: CompressionReport,
  options: JobOptions = {}
): Promise<CompressionResult> {
  const job = createJobHandle(options);

  const rasterPages: Record<number, Uint8Array> = {};
  type EncodedImage = { jpeg: Uint8Array; width: number; height: number; maskBytes?: Uint8Array };
  const replacedImages: Record<number, Record<number, EncodedImage>> = {};

  // A shared image (the same object referenced from several pages) is re-encoded
  // once *per page that displays it*, not once total — the same object number
  // can legitimately be drawn at very different sizes on different pages (a logo
  // shown small on a cover and full-bleed five pages later), and keeping only
  // whichever page happened to be processed first meant every other placement
  // inherited that page's size, upscaling a tiny encode into a blurry full-page
  // image. `bestByObjectNumber` keeps the largest (by pixel area) result seen
  // across all of a shared image's pages; the per-page assignment pass below
  // then points every page that wants it at that one winning encode, so a shared
  // image still ends up embedded exactly once in the output.
  const bestByObjectNumber = new Map<number, EncodedImage>();
  const namesByPage: Record<number, { name: string; objectNumber: number }[]> = {};

  // One lease for every read, so every call reaches the instance that owns the
  // handle. See the note in `planCompression`.
  await renderWorker.lease(async api => {
    const { handle } = await api.loadDocument(bytes);
    try {
      const work = report.plan.pages.filter(p => p.route === 'raster' || p.route === 'surgical');
      for (let i = 0; i < work.length; i++) {
        const page = work[i];
        options.onProgress?.(i / Math.max(1, work.length), `Processing page ${page.pageIndex + 1}`);
        if (options.signal?.aborted) break;

        if (page.route === 'raster') {
          rasterPages[page.pageIndex] = await api.pageToImageBytes(
            handle,
            page.pageIndex,
            'jpeg',
            settings.dpi,
            settings.quality
          );
          continue;
        }

        if (page.reencode.length === 0) continue;
        namesByPage[page.pageIndex] = page.reencode;

        const extracted = await api.extractPageImages(
          handle,
          page.pageIndex,
          settings.quality,
          settings.dpi,
          page.reencode.map(e => e.objectNumber)
        );

        for (const image of extracted) {
          const encoded = {
            jpeg: image.jpeg,
            width: image.width,
            height: image.height,
            maskBytes: image.maskBytes
          };
          const existing = bestByObjectNumber.get(image.objectNumber);
          if (!existing || image.width * image.height > existing.width * existing.height) {
            bestByObjectNumber.set(image.objectNumber, encoded);
          }
        }
      }
    } finally {
      await api.closeDocument(handle);
    }
  });

  for (const [pageIndexKey, entries] of Object.entries(namesByPage)) {
    const pageIndex = Number(pageIndexKey);
    // Keyed by PDF object number, not resource name — resource names are
    // scoped per dictionary, so a page-level image and one nested inside a
    // Form XObject can legally share a local name (e.g. both named `/Im1`).
    // A name-keyed map would let one collide with and shadow the other.
    const replacements: Record<number, EncodedImage> = {};
    for (const { objectNumber } of entries) {
      const best = bestByObjectNumber.get(objectNumber);
      if (best) replacements[objectNumber] = best;
    }
    if (Object.keys(replacements).length > 0) replacedImages[pageIndex] = replacements;
  }

  const result = await processWorker.lease(api =>
    api.rebuildCompressed(bytes, rasterPages, replacedImages, job)
  );

  return {
    bytes: result.bytes,
    originalBytes: bytes.byteLength,
    keptOriginal: result.keptOriginal,
    plan: report.plan
  };
}

/* ------------------------------------------------------------------ *
 * Redaction (EPIC-7)
 * ------------------------------------------------------------------ */

export interface RegionVerdict {
  region: RedactionRegion;
  pass: boolean;
  /** Human-readable reason, shown in the report table (RED-03). */
  detail: string;
}

export interface RedactionOutcome {
  bytes: Uint8Array;
  verdicts: RegionVerdict[];
  /** Every verdict passed; the UI must block saving when false. */
  verified: boolean;
  /** Pages whose text is no longer selectable, so we can say so plainly. */
  rasterizedPages: number[];
}

export async function searchForRedaction(
  bytes: Uint8Array,
  query: string,
  matchCase: boolean,
  options: JobOptions = {}
): Promise<TextRegion[]> {
  const job = createJobHandle(options);
  return renderWorker.lease(async api => {
    const { handle } = await api.loadDocument(bytes);
    try {
      return await api.findText(handle, query, matchCase, job);
    } finally {
      await api.closeDocument(handle);
    }
  });
}

/**
 * Applies redactions and verifies the result (RED-02, RED-03).
 *
 * True operator-level content removal is used. Text intersecting the redaction region is structurally
 * removed from the content stream while keeping the rest of the page selectable.
 * We geometrically verify that no text remains in the redacted region.
 */
export async function applyRedactions(
  bytes: Uint8Array,
  regions: RedactionRegion[],
  options: JobOptions = {}
): Promise<RedactionOutcome> {
  if (regions.length === 0) throw internal('There are no regions marked for redaction.');

  const job = createJobHandle(options);

  options.onProgress?.(0.55, 'Rebuilding document');
  let output = await processWorker.lease(api => api.applyRedactions(bytes, regions, job));

  // RED-04: metadata is scrubbed as part of redaction, because redacted content
  // routinely survives in XMP, the info dictionary, and embedded thumbnails.
  options.onProgress?.(0.75, 'Stripping metadata');
  output = await processWorker.lease(api => api.scrubMetadata(output));

  options.onProgress?.(0.85, 'Verifying');
  const verdicts = await verifyRedaction(output, regions);

  return {
    bytes: output,
    verdicts,
    verified: verdicts.every(v => v.pass),
    rasterizedPages: [] // No longer rasterizing full pages
  };
}

/**
 * RED-03 — the verification gate.
 *
 * Two checks run in sequence:
 *
 *  1. Geometric: `checkRegionText` re-extracts text from the redacted output
 *     using the same coordinate system that placed the marks. Any character
 *     whose bounding box overlaps a redaction rectangle causes a failure. This
 *     catches hand-drawn regions that carry no search string as well as text
 *     operators.
 *
 *  2. String-level: if a region was found by search (so we know the exact
 *     string), that string must be absent from the entire document — not just
 *     from its original page — so that a copy of the text in a footer, a
 *     header, or another section also fails verification.
 *
 * Operator-level redaction does not blank entire pages (unlike the old raster
 * path), so a "no text at all on affected pages" check would be wrong; the
 * geometric per-region check is the correct gate.
 */
async function verifyRedaction(
  output: Uint8Array,
  regions: RedactionRegion[]
): Promise<RegionVerdict[]> {
  // Annotation `/Contents` (sticky notes, comments) and AcroForm field `/V`
  // values never appear in pdf.js's page text, so a copy of the redacted
  // string quoted in a comment elsewhere in the document would otherwise pass
  // the whole-document check below untouched.
  const offPageText = await processWorker.lease(api => api.collectOffPageText(output));

  return renderWorker.lease(async api => {
    const { handle } = await api.loadDocument(output);
    try {
      const pageText = await api.documentText(handle);
      const wholeDocument = [...pageText, ...offPageText].join('\n').toLowerCase();

      // RED-03: geometric verification — no text may remain inside any marked region.
      const regionChecks = await api.checkRegionText(handle, regions);

      return regionChecks.map(({ region, foundText }) => {
        if (foundText.trim().length > 0) {
          return {
            region,
            pass: false,
            detail: `The redacted region on page ${region.pageIndex + 1} still contains extractable text: "${foundText}".`
          };
        }

        if (region.text && wholeDocument.includes(region.text.toLowerCase())) {
          return {
            region,
            pass: false,
            detail: `The text "${region.text}" is still present elsewhere in the document.`
          };
        }

        return {
          region,
          pass: true,
          detail: region.text
            ? `"${region.text}" is absent, and the redacted region is geometrically clear.`
            : `The redacted region on page ${region.pageIndex + 1} is geometrically clear.`
        };
      });
    } finally {
      await api.closeDocument(handle);
    }
  });
}

/* ------------------------------------------------------------------ *
 * Misc operations
 * ------------------------------------------------------------------ */

export async function extractDocumentText(
  bytes: Uint8Array,
  pageIndices: number[],
  mode: 'text' | 'markdown',
  options: JobOptions = {}
): Promise<string> {
  return renderWorker.lease(async api => {
    const { handle } = await api.loadDocument(bytes);
    try {
      const parts: string[] = [];
      for (let i = 0; i < pageIndices.length; i++) {
        // `break` would exit quietly with whatever pages were already read, and
        // the caller has no way to tell that from a complete extraction — it
        // would display/save partial text as if the job had finished.
        if (options.signal?.aborted) throw cancelled();
        const pageIndex = pageIndices[i];
        options.onProgress?.(i / pageIndices.length, `Reading page ${pageIndex + 1}`);
        const text = await api.extractText(handle, pageIndex, mode);
        if (text) {
          parts.push(
            mode === 'markdown'
              ? `# Page ${pageIndex + 1}\n\n${text}`
              : `--- Page ${pageIndex + 1} ---\n\n${text}`
          );
        }
      }
      return parts.join('\n\n');
    } finally {
      await api.closeDocument(handle);
    }
  });
}

export async function detectBlankPages(
  bytes: Uint8Array,
  threshold: number,
  options: JobOptions = {}
): Promise<number[]> {
  const job = createJobHandle(options);
  return renderWorker.lease(async api => {
    const { handle } = await api.loadDocument(bytes);
    try {
      return await api.detectBlankPages(handle, threshold, job);
    } finally {
      await api.closeDocument(handle);
    }
  });
}

export async function detectSignatureLines(
  bytes: Uint8Array,
  options: JobOptions = {}
): Promise<TextRegion[]> {
  const job = createJobHandle(options);
  return renderWorker.lease(async api => {
    const { handle } = await api.loadDocument(bytes);
    try {
      return await api.detectSignatureLines(handle, job);
    } finally {
      await api.closeDocument(handle);
    }
  });
}

/** CNV-02 — pages to a ZIP of images. */
export async function pagesToImageArchive(
  bytes: Uint8Array,
  pageIndices: number[],
  format: 'png' | 'jpeg',
  dpi: number,
  options: JobOptions = {}
): Promise<Uint8Array> {
  const { zipSync } = await import('fflate');
  const files: Record<string, Uint8Array> = {};
  const pad = Math.max(2, String(Math.max(...pageIndices, 1) + 1).length);

  await renderWorker.lease(async api => {
    const { handle } = await api.loadDocument(bytes);
    try {
      for (let i = 0; i < pageIndices.length; i++) {
        // `break` would exit quietly with whatever pages were already rendered,
        // and the caller has no way to tell that from a real, complete export —
        // it would save a truncated ZIP as if the job had finished.
        if (options.signal?.aborted) throw cancelled();
        const pageIndex = pageIndices[i];
        options.onProgress?.(i / pageIndices.length, `Rendering page ${pageIndex + 1}`);
        const image = await api.pageToImageBytes(handle, pageIndex, format, dpi);
        const name = `page-${String(pageIndex + 1).padStart(pad, '0')}.${format === 'jpeg' ? 'jpg' : 'png'}`;
        files[name] = image;
      }
    } finally {
      await api.closeDocument(handle);
    }
  });

  options.onProgress?.(0.95, 'Compressing archive');
  // Store, not deflate: PNG and JPEG are already compressed, so deflating them
  // costs seconds and saves nothing.
  return zipSync(files, { level: 0 });
}

import { normalizeSettings } from '../ui/tools/normalize/state';
import { nupSettings } from '../ui/tools/nup/state';

/**
 * `applyNormalize` is only true for the normalize tool's own export — every other
 * caller (redact, compress, split, metadata) must ignore `normalizeSettings`
 * entirely, or visiting the Normalize panel once would silently resize pages on
 * every other tool's export from then on (OPS-09).
 */
export async function currentDocumentBytes(
  options: JobOptions = {},
  applyNormalize = false
): Promise<Uint8Array> {
  const doc = activeDoc.value;
  if (!doc) throw internal('No document is open.');

  const normalize = applyNormalize ? normalizeSettings.value : null;

  const untouched =
    doc.annotations.length === 0 &&
    doc.pages.length > 0 &&
    doc.pages.every((p, _i, a) => p.sourceDocId === a[0].sourceDocId) &&
    Object.values(sources.value).find(s => s.id === doc.pages[0].sourceDocId) &&
    doc.pages.length ===
      Object.values(sources.value).find(s => s.id === doc.pages[0].sourceDocId)?.pageCount &&
    doc.pages.every((p, i) => p.sourceIndex === i && p.rotation === 0) &&
    Object.keys(cropBoxes.value).length === 0 &&
    !hasWatermarkContent(watermarkSettings.value) &&
    !hasHeaderFooterContent(headerFooterSettings.value) &&
    !nupSettings.value &&
    !normalize;
  if (untouched) {
    const single = Object.values(sources.value).find(s => s.id === doc.pages[0].sourceDocId);
    if (single) return single.bytes;
  }

  return composeDocument(
    {
      pages: doc.pages,
      annotations: doc.annotations,
      cropBoxes: cropBoxes.value,
      watermark: watermarkSettings.value,
      headerFooter: headerFooterSettings.value,
      normalize,
      nup: nupSettings.value
    },
    options
  );
}

export { unsupported };

export async function autoTrimDocument(
  doc: { pages: PageRef[]; annotations: Annotation[] },
  scope: import('../ui/tools/crop/state').CropScope,
  options?: import('./workers/protocol').JobOptions
) {
  const pagesToTrim = pagesForScope(doc.pages, scope, activePageIndex.value);
  if (!pagesToTrim[0]) return;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('No 2d context');

  const updates: Record<string, { x: number; y: number; width: number; height: number }> = {};

  for (let i = 0; i < pagesToTrim.length; i++) {
    if (options?.signal?.aborted) throw cancelled();
    const page = pagesToTrim[i];
    if (options?.onProgress) options.onProgress(i / pagesToTrim.length, `Scanning page ${i + 1}`);

    const composedBytes = await composeDocument({ pages: [page], annotations: [] });

    await renderWorker.lease(async api => {
      const { handle } = await api.loadDocument(composedBytes);
      try {
        const scale = 1.0; // 72 DPI is enough for finding a bounding box
        const bitmap = await api.renderPage(handle, 0, scale);

        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        const box = await cvWorker.lease(cv => cv.trimBox(imageData));

        if (box) {
          updates[page.key] = box;
        }
      } finally {
        await api.closeDocument(handle);
      }
    });
  }

  commit();
  cropBoxes.value = { ...cropBoxes.value, ...updates };
}

export interface ImagesToPdfOptions {
  pageSize:
    | 'original'
    | 'a4'
    | 'letter'
    | { width: number; height: number }
    | { width: number; height: number }[];
  orientation: 'auto' | 'portrait' | 'landscape';
  margin: number;
  quality: number;
}

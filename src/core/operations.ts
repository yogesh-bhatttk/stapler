/**
 * Tool operations, orchestrated on the main thread but executed in workers.
 *
 * This is the layer the UI calls. It owns the progress/cancel lifecycle so no
 * component has to, and it is where the honest-reporting rules live: nothing here
 * hands the user a file it cannot stand behind.
 */
import { processWorker, renderWorker } from './workers';
import { createJobHandle, type JobOptions } from './workers/protocol';
import type { RedactionRegion, StampSource } from './workers/process.worker';
import type { TextRegion } from './workers/render.worker';
import {
  MEANINGFUL_SAVING,
  classifyPages,
  estimateSavings,
  type CompressionPlan
} from './compress-plan';
import { activeDoc, bytesForPages, sources, type Annotation, type PageRef } from './store';
import { getSignature } from './signatures';
import { internal, unsupported } from './errors';

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
      text: annotation.type === 'signature' ? undefined : annotation.data,
      imagePng
    });
  }
  return out;
}

export interface ComposeRequest {
  pages: PageRef[];
  annotations: Annotation[];
}

/** DOC-05 — compose the current model into output bytes. */
export async function composeDocument(
  request: ComposeRequest,
  options: JobOptions = {}
): Promise<Uint8Array> {
  if (request.pages.length === 0) throw internal('There are no pages to export.');
  const stamps = await resolveStamps(request.pages, request.annotations);
  const job = createJobHandle(options);
  return processWorker.lease(api =>
    api.compose(request.pages, bytesForPages(request.pages), stamps, job)
  );
}

export interface SplitRequest extends ComposeRequest {
  boundaries: number[];
  baseName: string;
}

export async function splitDocument(request: SplitRequest, options: JobOptions = {}) {
  const stamps = await resolveStamps(request.pages, request.annotations);
  const job = createJobHandle(options);
  return processWorker.lease(api =>
    api.composeSplit(
      request.pages,
      bytesForPages(request.pages),
      request.boundaries,
      stamps,
      request.baseName,
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
  const replacedImages: Record<number, Record<string, EncodedImage>> = {};
  const seenObjectNumbers = new Set<number>();
  const sharedJpegs = new Map<number, EncodedImage>();

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

        const wanted: number[] = [];
        const replacements: Record<string, EncodedImage> = {};

        for (const { name, objectNumber } of page.reencode) {
          if (seenObjectNumbers.has(objectNumber)) {
            // Encode once, reuse everywhere: the same image on ten pages is one
            // JPEG, both in time spent and in bytes written.
            const cached = sharedJpegs.get(objectNumber);
            if (cached) replacements[name] = cached;
          } else {
            wanted.push(objectNumber);
          }
        }

        if (wanted.length > 0) {
          const extracted = await api.extractPageImages(
            handle,
            page.pageIndex,
            settings.quality,
            settings.dpi,
            wanted
          );

          for (const image of extracted) {
            // Images are addressed by object number; the resource name is
            // per-page, and pdf.js does not know it at all.
            const entry = page.reencode.find(e => e.objectNumber === image.objectNumber);
            if (!entry) continue;

            seenObjectNumbers.add(entry.objectNumber);
            const encoded = {
              jpeg: image.jpeg,
              width: image.width,
              height: image.height,
              maskBytes: image.maskBytes
            };
            replacements[entry.name] = encoded;
            sharedJpegs.set(entry.objectNumber, encoded);
          }
        }

        if (Object.keys(replacements).length > 0) replacedImages[page.pageIndex] = replacements;
      }
    } finally {
      await api.closeDocument(handle);
    }
  });

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
  return renderWorker.lease(async api => {
    const { handle } = await api.loadDocument(output);
    try {
      const pageText = await api.documentText(handle);
      const wholeDocument = pageText.join('\n').toLowerCase();

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
        if (options.signal?.aborted) break;
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
        if (options.signal?.aborted) break;
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

/** The bytes the current workspace document represents, composed on demand. */
export async function currentDocumentBytes(options: JobOptions = {}): Promise<Uint8Array> {
  const doc = activeDoc.value;
  if (!doc) throw internal('No document is open.');
  // A single-source document with no stamps and no reordering is already exactly
  // its source bytes; composing it would be a pointless re-encode.
  const single = sources.value[doc.pages[0]?.sourceDocId ?? ''];
  const untouched =
    single &&
    doc.annotations.length === 0 &&
    doc.pages.length === single.pageCount &&
    doc.pages.every(
      (p, i) => p.sourceDocId === single.id && p.sourceIndex === i && p.rotation === 0
    );
  if (untouched) return single.bytes;

  return composeDocument({ pages: doc.pages, annotations: doc.annotations }, options);
}

export { unsupported };

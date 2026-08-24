import { cropBoxes, pagesForScope } from '../ui/tools/crop/state';
import { commit } from './history';
/**
 * Tool operations, orchestrated on the main thread but executed in workers.
 *
 * This is the layer the UI calls. It owns the progress/cancel lifecycle so no
 * component has to, and it is where the honest-reporting rules live: nothing here
 * hands the user a file it cannot stand behind.
 */
import * as Comlink from 'comlink';
import { processWorker, renderWorker, cvWorker } from './workers';
import { createJobHandle, type JobOptions } from './workers/protocol';
import { detectHeadingOutline, type HeadingPage, type OutlineCandidate } from './outline-detect';
import type {
  ExtractedImages,
  RedactionRegion,
  ScrubSettings,
  StampSource,
  ImageAltInfo,
  ImageRedactionRequest,
  RedactedImageReplacements
} from './workers/process.worker';
import type { ProtectionSettings } from './pdf/encrypt';
import type {
  PatternSuggestion,
  RedactedImageInspection,
  RegionPixelResidue,
  TextRegion
} from './workers/render.worker';
import type { ImageResultStat } from './compress-report';
import {
  MEANINGFUL_SAVING,
  classifyPages,
  estimateSavings,
  type CompressionPlan
} from './compress-plan';
import {
  MAX_TARGET_TRIALS,
  searchForTargetSize,
  type TargetRung,
  type TargetTrial
} from './compress-target';
import {
  activeDoc,
  bytesForPages,
  sources,
  activePageIndex,
  type Annotation,
  type PageRef
} from './store';
import { readSourceBytes } from './opfs';
import { bitmapToJpeg } from './image';
import { bitmapKey, thumbnailCache } from './render-cache';
import { getSignature } from './signatures';
import {
  watermarkSettings,
  headerFooterSettings,
  hasWatermarkContent,
  hasHeaderFooterContent,
  type WatermarkSettings
} from '../ui/tools/watermark/state';
import type { WatermarkData } from './workers/process.worker';
import { internal, unsupported, cancelled, isCancellation, fromUnknown } from './errors';

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

/**
 * Hands a buffer *to* the worker instead of cloning it (AUDIT-FINDINGS §4).
 *
 * A structured clone of a 200MB document doubles peak memory for the duration
 * of the call, and every inbound worker call in this file used to do it. A
 * transfer costs nothing — but it **detaches** the caller's buffer, so it is
 * only ever correct for bytes this module owns outright and will not read
 * again.
 *
 * That rules out the biggest callers — `compose`, `rebuildCompressed` and
 * `applyRedactions` — which are all given the *document store's* canonical bytes
 * (`bytesForPages`, `currentDocumentBytes`). Detaching those would empty the
 * open document: precisely the silent corruption this codebase refuses to ship.
 * They keep the clone.
 *
 * A second pass tried to narrow that to "transfer when it is provably the only
 * holder", and built the instrument to decide it: `store.canTransferSourceBytes`
 * counts owners across open documents, undo/redo snapshots and render-worker
 * handles. The measurement says the answer is essentially always "no", for
 * reasons that are features rather than oversights:
 *
 *  • all three operations end in `replaceWithSource`, which calls `commit()` —
 *    they are *undoable*, so the pre-operation bytes must survive the call;
 *  • `currentDocumentBytes`'s untouched fast path returns `source.bytes` by
 *    identity, so the common "one whole file, unedited" case is exactly the case
 *    where the buffer belongs to the store;
 *  • any document with a thumbnail on screen has a render handle keyed on that
 *    same array.
 *
 * So the gate stays, unused, as a guard rather than an optimisation. See
 * `docs/AUDIT-FINDINGS.md` §4 for what would have to change to open it.
 *
 * Use this only on bytes that came out of a worker one line earlier and die at
 * this call.
 */
function handOver(bytes: Uint8Array): Uint8Array {
  return Comlink.transfer(bytes, [bytes.buffer as ArrayBuffer]);
}

/** Resolves signature stamps to bytes so the worker never touches IndexedDB. */
async function resolveStamps(pages: PageRef[], annotations: Annotation[]): Promise<StampSource[]> {
  const pageKeys = new Set(pages.map(p => p.key));
  const out: StampSource[] = [];
  const signatureCache = new Map<string, Uint8Array | null>();

  for (const annotation of annotations) {
    // A stamp on a page that has since been deleted must not be drawn anywhere.
    if (!pageKeys.has(annotation.pageKey)) continue;
    if (
      annotation.type === 'form-text' ||
      annotation.type === 'form-checkbox' ||
      annotation.type === 'form-radio'
    )
      continue;

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

export interface NewFormField {
  pageKey: string;
  type:
    | 'text'
    | 'checkbox'
    | 'radio'
    | 'TextField'
    | 'CheckBox'
    | 'RadioGroup'
    | 'form-text'
    | 'form-checkbox'
    | 'form-radio';
  name: string;
  exportValue?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function extractFormFieldsToCreate(annotations: Annotation[]): NewFormField[] {
  const fields: NewFormField[] = [];
  for (const ann of annotations) {
    if (ann.type === 'form-text' || ann.type === 'form-checkbox' || ann.type === 'form-radio') {
      fields.push({
        pageKey: ann.pageKey,
        type: ann.type,
        name: ann.fieldName || ann.data || 'field',
        exportValue: ann.exportValue,
        x: ann.x,
        y: ann.y,
        width: ann.width,
        height: ann.height
      });
    }
  }
  return fields;
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
  /** OPS-10 — replaces the document's outline with this tree, indexed on `pages`. */
  outline?: import('./workers/process.worker').OutlineNode[];
  /** OPS-11 — a Bates stamp for every exported page. */
  bates?: import('./workers/process.worker').BatesData;
  /** OPS-18 — a QR/barcode stamp for every targeted page. */
  barcodeStamp?: import('./workers/process.worker').BarcodeStampData;
  formFieldsToCreate?: NewFormField[];
  /**
   * Sign and Annotate only: compose an XFA document even though its dynamic-form
   * payload cannot survive the rebuild. Stamping on top of a flattened XFA form
   * is what the product tells the user to do; merging one silently is not.
   */
  allowXfaLoss?: boolean;
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
  const bytes = await bytesForPages(request.pages);
  for (const [id, buf] of Object.entries(bytes)) {
    bytes[id] = Comlink.transfer(buf, [buf.buffer as ArrayBuffer]);
  }

  return processWorker.lease(api =>
    api.compose(
      mappedPages,
      bytes,
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
      job,
      {
        outline: request.outline,
        bates: request.bates,
        barcodeStamp: request.barcodeStamp,
        allowXfaLoss: request.allowXfaLoss,
        formFieldsToCreate:
          request.formFieldsToCreate ?? extractFormFieldsToCreate(request.annotations)
      }
    )
  );
}

export interface SplitRequest extends ComposeRequest {
  boundaries: number[];
  baseName: string;
  /** OPS-12 — one filename stem per output slice, in slice order. */
  fileNames?: string[];
}

export async function splitDocument(request: SplitRequest, options: JobOptions = {}) {
  const stamps = await resolveStamps(request.pages, request.annotations);
  const job = createJobHandle(options);
  const mappedPages = request.pages.map(p => ({
    ...p,
    cropBox: request.cropBoxes?.[p.key]
  }));
  const bytes = await bytesForPages(request.pages);
  for (const [id, buf] of Object.entries(bytes)) {
    bytes[id] = Comlink.transfer(buf, [buf.buffer as ArrayBuffer]);
  }

  return processWorker.lease(api =>
    api.composeSplit(
      mappedPages,
      bytes,
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
      job,
      {
        bates: request.bates,
        barcodeStamp: request.barcodeStamp,
        fileNames: request.fileNames,
        formFieldsToCreate:
          request.formFieldsToCreate ?? extractFormFieldsToCreate(request.annotations)
      }
    )
  );
}

/** OPS-10 — reads a document's existing `/Outlines` tree. */
export async function readDocumentOutline(bytes: Uint8Array) {
  return processWorker.lease(api => api.readOutline(bytes));
}

/**
 * A filesystem-safe stem for a file named after a bookmark title (OPS-12).
 *
 * Path separators, the Windows-reserved `<>:"|?*`, and control characters are
 * replaced rather than stripped, so two distinct titles stay distinct; a title that
 * sanitizes to nothing falls back to the caller's default. Length is capped well
 * under the 255-byte limit every filesystem in play imposes.
 */
export function sanitizeFileStem(title: string, fallback: string): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex -- control characters are exactly what must go
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/[/\\<>:"|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

/**
 * Turns split-mode settings into page-boundary indices.
 *
 * Pure, and exported for unit tests: off-by-one errors here silently drop or
 * duplicate pages, and OPS-03's acceptance criterion is that the union of outputs
 * equals the input page set.
 */
export function splitBoundaries(
  mode: 'individual' | 'every_n' | 'custom' | 'bookmarks',
  pageCount: number,
  options: { every?: number; custom?: string; bookmarkStarts?: number[] } = {}
): number[] {
  if (pageCount <= 1) return [];

  if (mode === 'bookmarks') {
    // OPS-12: one file per top-level bookmark, so the cuts are the bookmarks' start
    // pages — minus the first. Anything before the first bookmark (a cover, a table
    // of contents) belongs to that first file rather than to a nameless extra one,
    // which is also what makes the output count exactly N for N bookmarks.
    const starts = [
      ...new Set(
        (options.bookmarkStarts ?? []).filter(
          index => Number.isInteger(index) && index >= 0 && index < pageCount
        )
      )
    ].sort((a, b) => a - b);
    return starts.slice(1);
  }

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

export interface SizeSplitPlan {
  boundaries: number[];
  /**
   * Ranges that still exceed the target after being composed alone — always a
   * single page, since anything wider would have been bisected further. The
   * caller has to disclose these; the target was not actually honoured for them.
   */
  oversized: { pageIndex: number; bytes: number }[];
}

/**
 * OPS-15 — recursively bisects `[0, pageCount)` down to ranges that either fit
 * the target or cannot be split any further (a single page), calling `measure`
 * (the real composed byte size of a page range) only on the ranges it actually
 * needs to decide about.
 *
 * A first version of this summed each page's *individually*-composed size as a
 * cheap stand-in for a combined slice's real size, reasoning that a single-page
 * file re-embeds its own copy of anything a multi-page slice would share once —
 * true, but on a document where pages share a large resource (one big image
 * behind every page, say) that "safe" over-estimate was wrong by an order of
 * magnitude: it split a document that fit comfortably as a single ~5MB file into
 * ten ~5MB files, because each page's *isolated* cost included its own copy of
 * the image the real combined file only pays for once. Measuring the actual
 * candidate range — not a sum of isolated pages — is what a shared resource
 * shows up correctly in either direction: this asks "does the whole document
 * already fit?" before ever considering a cut, and only narrows when the real
 * answer is no.
 *
 * Exported for unit tests with a synthetic `measure`, mirroring how
 * `splitBoundaries` is pure and directly testable.
 */
export async function planRangesBySize(
  pageCount: number,
  targetBytes: number,
  measure: (from: number, to: number) => Promise<number>
): Promise<SizeSplitPlan> {
  if (pageCount <= 1 || targetBytes <= 0) return { boundaries: [], oversized: [] };

  const ranges: { from: number; to: number; bytes: number }[] = [];

  async function plan(from: number, to: number): Promise<void> {
    const bytes = await measure(from, to);
    if (bytes <= targetBytes || to - from <= 1) {
      ranges.push({ from, to, bytes });
      return;
    }
    const mid = from + Math.floor((to - from) / 2);
    await plan(from, mid);
    await plan(mid, to);
  }
  await plan(0, pageCount);

  return {
    boundaries: ranges.slice(1).map(r => r.from),
    oversized: ranges
      .filter(r => r.bytes > targetBytes)
      .map(r => ({ pageIndex: r.from, bytes: r.bytes }))
  };
}

/**
 * OPS-15 — `planRangesBySize` wired to real composed byte sizes: each candidate
 * range is composed on its own (no internal boundaries, so it comes back as one
 * file) through the same `splitDocument`/`composeSplit` path the actual split
 * will use, so what gets measured is exactly what would be produced.
 */
export async function planSizeSplitBoundaries(
  request: Omit<SplitRequest, 'boundaries' | 'baseName' | 'fileNames'>,
  targetBytes: number,
  options: JobOptions = {}
): Promise<SizeSplitPlan> {
  const pageCount = request.pages.length;
  const measure = async (from: number, to: number): Promise<number> => {
    const result = await splitDocument(
      {
        ...request,
        pages: request.pages.slice(from, to),
        boundaries: [],
        baseName: 'page'
      },
      options
    );
    return result.bytes.byteLength;
  };
  return planRangesBySize(pageCount, targetBytes, measure);
}

export async function getFormFields(bytes: Uint8Array, options: JobOptions = {}) {
  const job = createJobHandle(options);
  return processWorker.lease(api => api.getFormFields(bytes, job));
}

/** SGN-09 — structural signature/tamper check, no progress needed (one parse pass). */
export async function checkSignatureIntegrity(bytes: Uint8Array) {
  return processWorker.lease(api => api.checkSignatureIntegrity(bytes));
}

/** DOC-12 — which fonts referenced by the document are not embedded. */
export async function checkFontEmbedding(bytes: Uint8Array) {
  return processWorker.lease(api => api.checkFontEmbedding(bytes));
}

/** DOC-12 — re-embeds every non-embedded occurrence of `baseFont`. */
export async function embedMissingFont(bytes: Uint8Array, baseFont: string) {
  return processWorker.lease(api => api.embedMissingFont(bytes, baseFont));
}

export async function fillFormFields(
  bytes: Uint8Array,
  values: Record<string, string | string[] | boolean>,
  flatten: boolean,
  options: JobOptions = {}
) {
  const job = createJobHandle(options);
  return processWorker.lease(api => api.fillFormFields(bytes, values, flatten, job));
}

/**
 * SGN-05 — bakes form fields and annotations into static page content.
 *
 * Run last, on already-composed bytes: `compose` rebuilds the page tree with
 * `copyPages`, which carries `/Annots` through, so flattening before a compose
 * would have the annotations copied straight back in.
 */
export async function flattenDocument(bytes: Uint8Array, options: JobOptions = {}) {
  const job = createJobHandle(options);
  // The caller's `bytes` are the just-composed export, not the open document,
  // and the composed bytes are never read again — the flattened result replaces
  // them. See `handOver` for why the compose call itself cannot do this.
  return processWorker.lease(api => api.flattenDocument(handOver(bytes), job));
}

/**
 * RED-06 — encrypts already-exported bytes. Takes a job handle for the same
 * reason everything else here does: on a large document the AES pass is
 * seconds of work, and it used to run with no progress and no way to stop it.
 */
export async function protectDocument(
  bytes: Uint8Array,
  settings: ProtectionSettings,
  options: JobOptions = {}
) {
  const job = createJobHandle(options);
  return processWorker.lease(api => api.protectDocument(bytes, settings, job));
}

/** RED-04 — metadata scrub, with progress and cancellation like every other op. */
export async function scrubDocumentMetadata(
  bytes: Uint8Array,
  settings: ScrubSettings | undefined,
  options: JobOptions = {}
) {
  const job = createJobHandle(options);
  return processWorker.lease(api => api.scrubMetadata(bytes, settings, job));
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
  /**
   * True when the original bytes were returned unchanged — either because the
   * rebuild was not smaller, or because no image was actually re-encoded and no
   * page rasterised, so there was no compression work to report savings for.
   */
  keptOriginal: boolean;
  plan: CompressionPlan;
  /** CMP-06 — measured per-image before/after sizes, straight from the rebuild. */
  imageStats: ImageResultStat[];
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

  // A shared image (the same object referenced from several pages) is decoded,
  // downscaled and encoded **once**, at the largest size any page displays it at.
  //
  // It used to be encoded once per page that displays it, and all but the largest
  // result was discarded — a logo on ten pages cost ten decodes and ten JPEG
  // encodes to embed one stream, i.e. work proportional to page count for no
  // benefit. `extractSharedImages` chooses the winning size for every image
  // before any pixel work starts (the same "largest use wins" rule the per-page
  // pass applied afterwards, so the chosen size is unchanged), which is also what
  // stops a page that shows the logo full-bleed from inheriting a thumbnail-sized
  // encode. The per-page assignment below then points every page that wants the
  // image at that one encode, so it is still embedded exactly once in the output.
  const encodedByObjectNumber = new Map<number, EncodedImage>();
  const namesByPage: Record<number, { name: string; objectNumber: number }[]> = {};

  // One lease for every read, so every call reaches the instance that owns the
  // handle. See the note in `planCompression`.
  await renderWorker.lease(async api => {
    const { handle } = await api.loadDocument(bytes);
    try {
      const work = report.plan.pages.filter(p => p.route === 'raster' || p.route === 'surgical');
      const surgical: { pageIndex: number; objectNumbers: number[] }[] = [];

      for (let i = 0; i < work.length; i++) {
        const page = work[i];
        options.onProgress?.(
          (i / Math.max(1, work.length)) * 0.6,
          `Processing page ${page.pageIndex + 1}`
        );
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
        surgical.push({
          pageIndex: page.pageIndex,
          objectNumbers: page.reencode.map(e => e.objectNumber)
        });
      }

      if (surgical.length > 0 && !options.signal?.aborted) {
        options.onProgress?.(0.6, 'Re-encoding images');
        // One call for the whole document, not one per page: the encode-once rule
        // can only be enforced where every page's placements are visible at once.
        const extracted = await api.extractSharedImages(
          handle,
          surgical,
          settings.quality,
          settings.dpi,
          job
        );
        for (const image of extracted) {
          encodedByObjectNumber.set(image.objectNumber, {
            jpeg: image.jpeg,
            width: image.width,
            height: image.height,
            maskBytes: image.maskBytes
          });
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
      const encoded = encodedByObjectNumber.get(objectNumber);
      if (encoded) replacements[objectNumber] = encoded;
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
    plan: report.plan,
    imageStats: result.imageStats ?? []
  };
}

/**
 * DOC-07 — the result of a target-size search, described in measured bytes.
 *
 * `achievedBytes` is always `bytes.byteLength`: there is no field here that a
 * model produced. When `reachedTarget` is false, `bytes` is still the smallest
 * output the search managed to produce (the floor rung) — the caller decides
 * whether to offer it, and must not present it as having met the target.
 */
export interface TargetCompressionResult {
  bytes: Uint8Array;
  originalBytes: number;
  targetBytes: number;
  achievedBytes: number;
  reachedTarget: boolean;
  /** Settings that produced `bytes`, or null when no work was needed. */
  settings: TargetRung | null;
  /** True when this run's own safety net discarded a larger output (CMP-04). */
  keptOriginal: boolean;
  /** Every real render+encode pass run, in order — the search's evidence. */
  trials: TargetTrial[];
  /** Plan of the run that produced `bytes`; null when no work was needed. */
  plan: CompressionPlan | null;
  /** CMP-06 — measured per-image sizes of the trial that produced `bytes`. */
  imageStats: ImageResultStat[];
}

/**
 * DOC-07 — compresses towards `targetBytes`, measuring every step.
 *
 * Each trial is a complete `planCompression` + `compressDocument` pass, so each
 * one independently obeys CMP-04's safety net (an output that is not smaller
 * than the input is discarded and the original returned) and CMP-01's skip
 * rules. Nothing here loosens either: the search only chooses *which* settings
 * the existing pipeline runs at.
 *
 * Progress spans the whole search rather than restarting per trial, and the
 * abort signal is checked between trials as well as inside them, so cancelling
 * mid-search stops at the end of the current page rather than after the run.
 */
export async function compressToTargetSize(
  bytes: Uint8Array,
  targetBytes: number,
  options: JobOptions = {}
): Promise<TargetCompressionResult> {
  if (!(targetBytes > 0)) throw internal('A target size must be greater than zero.');

  // Nothing to do, and doing it anyway could only make the file worse.
  if (bytes.byteLength <= targetBytes) {
    return {
      bytes,
      originalBytes: bytes.byteLength,
      targetBytes,
      achievedBytes: bytes.byteLength,
      reachedTarget: true,
      settings: null,
      keptOriginal: true,
      trials: [],
      plan: null,
      imageStats: []
    };
  }

  let completed = 0;
  const outcome = await searchForTargetSize<CompressionResult>({
    targetBytes,
    signal: options.signal,
    onTrial: (index, maxTrials, settings) => {
      options.onProgress?.(
        index / maxTrials,
        `Trying ${settings.dpi} DPI at ${Math.round(settings.quality * 100)}% (attempt ${index + 1} of up to ${maxTrials})`
      );
    },
    run: async (settings, index) => {
      const base = index / MAX_TARGET_TRIALS;
      const trialJob: JobOptions = {
        signal: options.signal,
        onProgress: (fraction, label) =>
          options.onProgress?.(
            base + (fraction ?? 0) / MAX_TARGET_TRIALS,
            `${settings.dpi} DPI at ${Math.round(settings.quality * 100)}% — ${label}`
          )
      };
      const report = await planCompression(bytes, settings, trialJob);
      const result = await compressDocument(bytes, settings, report, trialJob);
      completed++;
      return {
        output: result,
        byteLength: result.bytes.byteLength,
        keptOriginal: result.keptOriginal
      };
    }
  });
  options.onProgress?.(1, `Finished after ${completed} attempt(s)`);

  const chosen = outcome.chosen;
  return {
    bytes: chosen.output.bytes,
    originalBytes: bytes.byteLength,
    targetBytes,
    achievedBytes: chosen.output.bytes.byteLength,
    reachedTarget: outcome.reached,
    settings: chosen.settings,
    keptOriginal: chosen.keptOriginal,
    trials: outcome.trials,
    plan: chosen.output.plan,
    imageStats: chosen.output.imageStats
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
}

/**
 * Locates every occurrence of `query` and returns its page-normalised box.
 *
 * Was `searchForRedaction`; renamed when ANN-03 became its second caller. RED's
 * find-and-mark turns these regions into redaction marks, ANN-03 turns the same
 * regions into highlight annotations, and neither owns a search of its own.
 */
export async function findTextRegions(
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
 * RED-05 — proposes redaction marks from patterns in the page text.
 *
 * Returns suggestions only. Nothing is marked, and nothing is removed, until the
 * user accepts one in the panel; from that point it is an ordinary mark on the
 * RED-02 path.
 */
export async function scanForPatterns(
  bytes: Uint8Array,
  options: JobOptions = {}
): Promise<PatternSuggestion[]> {
  const job = createJobHandle(options);
  return renderWorker.lease(async api => {
    const { handle } = await api.loadDocument(bytes);
    try {
      return await api.findPatterns(handle, job);
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

  // RED-02 — an image a mark only *partly* covers cannot be dropped (the rest of
  // it is content the user kept) and must not be left intact under a black
  // rectangle (an overlay is not a redaction). Its pixels are destroyed instead,
  // which needs pdf.js to decode the image and pdf-lib to substitute it — two
  // workers, so the plan is computed first and the pixel work handed across.
  options.onProgress?.(0.4, 'Checking images');
  const imageRequests = await processWorker.lease(api => api.planImageRedactions(bytes, regions));
  const imageReplacements = await redactOverlappedImages(bytes, imageRequests, options);

  options.onProgress?.(0.55, 'Rebuilding document');
  let output = await processWorker.lease(api =>
    api.applyRedactions(bytes, regions, imageReplacements, job)
  );

  // RED-04: metadata is scrubbed as part of redaction, because redacted content
  // routinely survives in XMP, the info dictionary, and embedded thumbnails.
  options.onProgress?.(0.75, 'Stripping metadata');
  // `output` is the redaction worker's own result, reassigned on the next line:
  // nothing else can ever read this buffer, so it is handed over rather than
  // copied.
  output = await processWorker.lease(api => api.scrubMetadata(handOver(output), undefined, job));

  // Verification is the last 15% of the bar and reports inside it region by
  // region and page by page, so a long pass is not a frozen "Verifying" tick —
  // and `signal` reaches every loop inside it, so it can be cancelled like any
  // other stage.
  const verdicts = await verifyRedaction(output, regions, {
    signal: options.signal,
    onProgress: (fraction, label) =>
      options.onProgress?.(0.85 + 0.15 * Math.min(1, Math.max(0, fraction ?? 0)), label)
  });

  // No `rasterizedPages`: this pipeline is operator-level throughout — content
  // streams are edited and partly-covered images have their pixels replaced.
  // Nothing is ever flattened to a page raster, so there is no such list to
  // report. It used to be returned as a hardcoded `[]` and printed verbatim,
  // which told the user "Pages  are now images" on every single run.
  return {
    bytes: output,
    verdicts,
    verified: verdicts.every(v => v.pass)
  };
}

/**
 * Blacks out the covered part of every partly-overlapped image, in the pdf.js
 * worker, and returns the substitutions keyed the way `applyRedactions` wants
 * them.
 *
 * An image pdf.js cannot decode is *not* skipped: it throws, so the redaction
 * fails loudly and the user's document is left untouched, rather than producing
 * a file that says "verified" over an image that still holds the secret.
 */
async function redactOverlappedImages(
  bytes: Uint8Array,
  requests: ImageRedactionRequest[],
  options: JobOptions
): Promise<RedactedImageReplacements> {
  const replacements: RedactedImageReplacements = {};
  if (requests.length === 0) return replacements;

  const byPage = new Map<number, ImageRedactionRequest[]>();
  for (const request of requests) {
    const list = byPage.get(request.pageIndex);
    if (list) list.push(request);
    else byPage.set(request.pageIndex, [request]);
  }

  return renderWorker.lease(async api => {
    const { handle } = await api.loadDocument(bytes);
    try {
      let done = 0;
      for (const [pageIndex, pageRequests] of byPage) {
        // Decoding and re-encoding a page's images is the slowest part of a
        // redaction on a scanned document, so it is a cancellation point like
        // every other multi-page loop.
        if (options.signal?.aborted) throw cancelled();
        options.onProgress?.(
          0.4 + (done / byPage.size) * 0.15,
          `Redacting images on page ${pageIndex + 1}`
        );
        done += 1;
        const results = await api.redactPageImages(
          handle,
          pageIndex,
          pageRequests.map(r => ({ objectNumber: r.objectNumber, rects: r.rects }))
        );
        const byObjectNumber = new Map(results.map(r => [r.objectNumber, r]));
        for (const request of pageRequests) {
          const result = byObjectNumber.get(request.objectNumber);
          if (!result?.image) {
            throw unsupported(
              `An image on page ${pageIndex + 1} is only partly covered by a redaction mark and ` +
                `its pixels could not be removed. ${result?.reason ?? 'The image could not be decoded.'} ` +
                'Drawing a black box over it would leave the original image inside the file, so ' +
                'nothing was saved and your document is untouched. Cover the whole image with ' +
                'the mark, or rasterise the page first.'
            );
          }
          const page = (replacements[pageIndex] ??= {});
          page[request.name] = result.image;
        }
      }
      return replacements;
    } finally {
      await api.closeDocument(handle);
    }
  });
}

/**
 * RED-03 — how much of a verification region may differ from the redaction fill
 * before the region is treated as still holding content.
 *
 * Not zero, because the mark's edge is anti-aliased and a page that was JPEG
 * compressed at some point in its life carries ringing; see
 * `render.worker.ts`'s `FILL_CHANNEL_TOLERANCE` and `AA_INSET_FRACTION` for the
 * two conservatisms applied before a pixel is even counted. 2% of the *interior*
 * of a mark is far less than any glyph, rule, or image fragment a reader could
 * recover: a single 8pt character inside a 150x20pt mark is already ~2%.
 */
export const MAX_RESIDUE_FRACTION = 0.02;

/**
 * RED-03 — how much of a region may sit on a hard edge before it is treated as
 * holding a shape rather than a fill.
 *
 * An order of magnitude below `MAX_RESIDUE_FRACTION` because an edge is a
 * *perimeter*, not an area: a surviving 8pt glyph covering 2% of a mark is
 * perhaps half a percent of it in outline. A correctly filled region has no
 * interior edges at all, so the floor below — not this fraction — is what keeps a
 * handful of stray rasteriser pixels in a small mark from blocking a save.
 */
export const MAX_EDGE_FRACTION = 0.005;

/** Edge pixels below which a region is too small for the reading to mean anything. */
export const MIN_EDGE_PIXELS = 12;

/**
 * RED-03 — how much of a blacked-out *image* area may read as non-black.
 *
 * Looser than `MAX_RESIDUE_FRACTION` for a measured reason: the image is
 * re-encoded as JPEG after its pixels are destroyed, and JPEG's blocks smear the
 * hard boundary between the black square and the content around it several pixels
 * inward. On a high-frequency photograph that halo is ~2% of a small covered area
 * even after the proportional inset `measureRectsBlacked` already trims. A true
 * failure is not marginal — an unpainted area reads near 100% — so the headroom
 * costs nothing, and `MAX_IMAGE_BRIGHT_FRACTION` covers the small-but-readable
 * case this fraction alone would miss.
 */
export const MAX_IMAGE_RESIDUE_FRACTION = 0.05;

/**
 * How much of a blacked-out image area may be bright enough to *read*.
 *
 * The JPEG halo above is dark: measured at ≤46/255 inside the inset. Content is
 * not, so this is the tighter of the two margins and the one that catches a leak
 * too small to move the fraction — a sliver of a face or a signature left at the
 * edge of what was painted.
 */
export const MAX_IMAGE_BRIGHT_FRACTION = 0.01;

/**
 * Grades one region's rendered pixels. Pure, and exported so the policy can be
 * tested without a worker; the measurement itself lives in the render worker.
 *
 * Three readings, in order of how directly they answer "is content still
 * visible here": distance from the fill we painted, departure from whatever
 * colour actually covers the region, and hard edges inside it. The last two are
 * independent of the fill colour, which is what makes them a second signal rather
 * than a restatement of the first.
 */
export function residueFailure(residue: RegionPixelResidue): string | null {
  // Nothing could be sampled: the region is sub-pixel at verification DPI, so
  // there is no room inside it for content a reader could recover. The text and
  // string checks still apply to it.
  if (residue.sampled === 0) return null;

  if (residue.fraction > MAX_RESIDUE_FRACTION) {
    const percent = (residue.fraction * 100).toFixed(1);
    return (
      `${percent}% of the pixels inside the mark are not the redaction fill ` +
      `(worst pixel is ${residue.maxDeviation}/255 away from it), so content is still visible there.`
    );
  }

  const { content } = residue;
  if (content.offDominantFraction > MAX_RESIDUE_FRACTION) {
    const percent = (content.offDominantFraction * 100).toFixed(1);
    return (
      `the mark does not render as one flat colour — ${percent}% of its pixels differ from the ` +
      'colour covering the rest of it, so something is still drawn inside it.'
    );
  }

  if (content.edges >= MIN_EDGE_PIXELS && content.edgeFraction > MAX_EDGE_FRACTION) {
    return (
      `${content.edges} pixels inside the mark sit on a hard edge, which a flat fill has none ` +
      'of, so an outline or a shape is still drawn inside it.'
    );
  }

  return null;
}

/**
 * RED-03 — grades one image the output still draws under a mark.
 *
 * This is the reading that sees *underneath* the cover rectangle. Everything else
 * in the gate looks at the page: the composited render (which an overlay
 * satisfies) and the text layer (which a photograph does not have). This looks at
 * the image XObject's own pixels, so it answers the question those two cannot —
 * "would `pdfimages` still get the secret out of this file".
 */
export function imageResidueFailure(inspection: RedactedImageInspection): string | null {
  if (inspection.reason) {
    return (
      `an image on page ${inspection.pageIndex + 1} that a mark covers could not be inspected, ` +
      `so its removal is unproven. ${inspection.reason}`
    );
  }
  const residue = inspection.residue;
  // Sub-pixel coverage of a tiny image: nothing recoverable fits in it, and the
  // measurement deliberately samples inside the painted area only.
  if (!residue || residue.sampled === 0) return null;

  const offBlack = residue.fraction > MAX_IMAGE_RESIDUE_FRACTION;
  const readable = residue.brightFraction > MAX_IMAGE_BRIGHT_FRACTION;
  if (!offBlack && !readable) return null;

  const percent = ((readable ? residue.brightFraction : residue.fraction) * 100).toFixed(1);
  return (
    `an image on page ${inspection.pageIndex + 1} still holds its original pixels where a mark ` +
    `covers it — ${percent}% of the covered area is ` +
    `${readable ? 'bright enough to read' : 'not blacked out'} (brightest pixel ` +
    `${residue.maxLevel}/255) — so the mark only hides it, and the image comes straight back ` +
    'out of any image extractor.'
  );
}

/**
 * RED-03 — the verification gate.
 *
 * Three independent checks run against the *output* bytes:
 *
 *  1. Geometric: `checkRegionText` re-extracts text from the redacted output
 *     using the same coordinate system that placed the marks. Any character
 *     whose bounding box overlaps a redaction rectangle causes a failure. This
 *     catches hand-drawn regions that carry no search string as well as text
 *     operators.
 *
 *  2. Pixels: `checkRegionPixels` renders each region as a viewer would draw it
 *     and grades it twice — against the opaque redaction fill, and against
 *     whatever colour actually covers it, plus the hard edges inside it. Text
 *     extraction is blind to a vector shape and to an inline image; the
 *     fill-agnostic half of this reading is what catches content the fill never
 *     covered, whatever colour it happens to be.
 *
 *  3. Buried images: `inspectRedactedImages` reads the *embedded pixels* of every
 *     image the output still draws under a mark and checks the covered area was
 *     really destroyed. This is the only check that sees underneath the cover
 *     rectangle. Rendering cannot: an intact image under an opaque black
 *     rectangle renders as solid black and measures as perfectly clean, which is
 *     exactly the failure an overlay-only "redaction" produces. Neither can text
 *     extraction, because a photograph or a scan has no text layer at all — so
 *     for a redaction over an image this is the whole of the protection.
 *
 *  4. String-level: if a region was found by search (so we know the exact
 *     string), that string must be absent from the entire document — not just
 *     from its original page — so that a copy of the text in a footer, a
 *     header, or another section also fails verification.
 *
 * Operator-level redaction does not blank entire pages (unlike the old raster
 * path), so a "no text at all on affected pages" check would be wrong; the
 * per-region checks are the correct gate.
 *
 * A check that cannot run fails closed. A region whose pixels could not be
 * rendered is reported as unverified, not as verified — `applyRedactions`'s
 * caller blocks the save on any failing verdict, which is the only safe reading
 * of "we could not look".
 *
 * Every step reports progress into `job` and is cancellable at each region and
 * each page: verification renders and decodes as much as the redaction itself
 * did, and "cancellable with determinate progress" is not satisfied by one tick
 * before a minute of silence.
 */
async function verifyRedaction(
  output: Uint8Array,
  regions: RedactionRegion[],
  options: JobOptions = {}
): Promise<RegionVerdict[]> {
  /**
   * A worker-side handle whose 0..1 progress lands in `[from, to]` of this pass.
   *
   * Built with `createJobHandle` per band rather than `subJob`: `subJob` returns a
   * plain object holding closures, which is fine inside a worker but cannot be
   * structured-cloned *across* the Comlink boundary — the functions would be
   * dropped and the worker would report progress into nothing.
   */
  const band = (from: number, to: number) =>
    createJobHandle({
      signal: options.signal,
      onProgress: (fraction, label) =>
        options.onProgress?.(from + (to - from) * Math.min(1, Math.max(0, fraction ?? 0)), label)
    });

  /** Main-thread cancellation point between the worker calls below. */
  const tick = (fraction: number, label: string) => {
    if (options.signal?.aborted) throw cancelled();
    options.onProgress?.(fraction, label);
  };

  tick(0, 'Verifying: reading the saved document');
  // Annotation `/Contents` (sticky notes, comments) and AcroForm field `/V`
  // values never appear in pdf.js's page text, so a copy of the redacted
  // string quoted in a comment elsewhere in the document would otherwise pass
  // the whole-document check below untouched.
  const offPageText = await processWorker.lease(api => api.collectOffPageText(output));

  // Which images the *output* still draws under a mark, and which of their pixels
  // the mark covers — the same plan the redaction worked from, recomputed against
  // what was actually written. A throw here is a refusal to answer, so it is
  // carried to every region as a failure rather than swallowed.
  let imagePlan: ImageRedactionRequest[] = [];
  let imagePlanError: string | null = null;
  tick(0.1, 'Verifying: locating images under the marks');
  try {
    imagePlan = await processWorker.lease(api => api.planImageRedactions(output, regions));
  } catch (error) {
    if (isCancellation(error)) throw error;
    imagePlanError = error instanceof Error ? error.message : String(error);
  }

  return renderWorker.lease(async api => {
    const { handle } = await api.loadDocument(output);
    try {
      const pageText = await api.documentText(handle, band(0.15, 0.35));
      const wholeDocument = [...pageText, ...offPageText].join('\n').toLowerCase();

      // RED-03: geometric verification — no text may remain inside any marked region.
      const regionChecks = await api.checkRegionText(handle, regions, band(0.35, 0.55));

      // RED-03: pixel verification — the region must actually *render* blank.
      // Failing closed on an error here is deliberate: an unrenderable page is
      // a reason to refuse the save, not to declare the redaction sound.
      let pixelChecks: { region: RedactionRegion; residue: RegionPixelResidue }[] | null = null;
      let pixelError: string | null = null;
      try {
        pixelChecks = await api.checkRegionPixels(handle, regions, band(0.55, 0.8));
      } catch (error) {
        // A cancellation is the user's answer, not a verification result: it must
        // abort the pass, never be reported as a region that failed to verify.
        if (isCancellation(error)) throw error;
        pixelError = error instanceof Error ? error.message : String(error);
      }

      // RED-03: the buried-image check. Attributed by page, not by mark: the plan
      // says which image on which page still carries content, and mapping that
      // back to one specific mark would mean threading mark identity through the
      // content-stream filter. Blaming every mark on the page over-reports which
      // mark is at fault and never under-reports that the document is unsafe,
      // which is the direction that matters — and in the ordinary case of one mark
      // over the image it is exact.
      const imageFailuresByPage = new Map<number, string>();
      if (imagePlanError) {
        for (const region of regions) {
          imageFailuresByPage.set(
            region.pageIndex,
            'the images under the marks on this page could not be checked, so their removal is ' +
              `unproven. ${imagePlanError}`
          );
        }
      } else if (imagePlan.length > 0) {
        try {
          const inspections = await api.inspectRedactedImages(
            handle,
            imagePlan.map(r => ({
              pageIndex: r.pageIndex,
              objectNumber: r.objectNumber,
              rects: r.rects
            })),
            band(0.8, 1)
          );
          for (const inspection of inspections) {
            const failure = imageResidueFailure(inspection);
            if (failure && !imageFailuresByPage.has(inspection.pageIndex)) {
              imageFailuresByPage.set(inspection.pageIndex, failure);
            }
          }
        } catch (error) {
          if (isCancellation(error)) throw error;
          const message = error instanceof Error ? error.message : String(error);
          for (const request of imagePlan) {
            imageFailuresByPage.set(
              request.pageIndex,
              `an image under a mark on this page could not be inspected, so its removal is ` +
                `unproven. ${message}`
            );
          }
        }
      }

      return regionChecks.map(({ region, foundText }, index) => {
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

        if (!pixelChecks) {
          return {
            region,
            pass: false,
            detail:
              `The redacted region on page ${region.pageIndex + 1} carries no extractable text, but it ` +
              `could not be rendered to check its pixels, so the redaction is unproven. ${pixelError ?? ''}`.trim()
          };
        }

        // Paired by position: `checkRegionPixels` answers in the order it was
        // asked, one entry per region, the same contract `checkRegionText` has.
        const pixels = pixelChecks[index];
        if (!pixels || pixels.region.pageIndex !== region.pageIndex) {
          return {
            region,
            pass: false,
            detail:
              `The pixel check returned no result for the region on page ${region.pageIndex + 1}, ` +
              'so the redaction is unproven.'
          };
        }

        const residueDetail = residueFailure(pixels.residue);
        if (residueDetail) {
          return {
            region,
            pass: false,
            detail: `The redacted region on page ${region.pageIndex + 1} does not render blank: ${residueDetail}`
          };
        }

        // Last, because it is the only check that can fail a region whose page
        // *renders* perfectly: the cover hides the image, and only the image's own
        // pixels say whether it was destroyed.
        const imageDetail = imageFailuresByPage.get(region.pageIndex);
        if (imageDetail) {
          return {
            region,
            pass: false,
            detail: `The redaction on page ${region.pageIndex + 1} is not proven: ${imageDetail}`
          };
        }

        return {
          region,
          pass: true,
          detail: region.text
            ? `"${region.text}" is absent, the redacted region is geometrically clear, it renders as solid fill, and any image underneath it has had its covered pixels destroyed.`
            : `The redacted region on page ${region.pageIndex + 1} is geometrically clear, renders as solid fill, and any image underneath it has had its covered pixels destroyed.`
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

/**
 * OPS-14 — reads every page's text items and proposes a heading-based outline.
 * Read-only: nothing here writes `/Outlines` or touches the document.
 */
export async function proposeOutlineFromHeadings(
  bytes: Uint8Array,
  pageCount: number,
  options: JobOptions = {}
): Promise<OutlineCandidate[]> {
  const pages: HeadingPage[] = [];
  for (let i = 0; i < pageCount; i++) {
    if (options.signal?.aborted) throw cancelled();
    options.onProgress?.(i / Math.max(1, pageCount), `Reading page ${i + 1} of ${pageCount}`);
    const items = await extractPageTextItems(bytes, i);
    pages.push({ pageIndex: i, items });
  }
  return detectHeadingOutline(pages);
}

export async function extractPageTextItems(
  bytes: Uint8Array,
  pageIndex: number
): Promise<{ text: string; x: number; y: number; width: number; height: number }[]> {
  return renderWorker.lease(async api => {
    const { handle } = await api.loadDocument(bytes);
    try {
      return await api.extractPageTextItems(handle, pageIndex);
    } finally {
      await api.closeDocument(handle);
    }
  });
}

/**
 * ACC-02/ACC-03 — one page's own reading-order text, with no per-page header.
 * `extractDocumentText` below wraps every page in a `--- Page N ---` banner
 * meant for a concatenated multi-page export; read-aloud and reflow view read
 * one page at a time and would otherwise have to strip that banner back off.
 */
export async function extractPageText(
  bytes: Uint8Array,
  pageIndex: number,
  mode: 'text' | 'markdown' = 'text'
): Promise<string> {
  return renderWorker.lease(async api => {
    const { handle } = await api.loadDocument(bytes);
    try {
      return await api.extractText(handle, pageIndex, mode);
    } finally {
      await api.closeDocument(handle);
    }
  });
}

/** SCN-04 — resolution barcode scanning renders at. Lower than OCR's 300 DPI: a
 * barcode's modules are far coarser than printed glyphs, and scanning every
 * page of a long document is a per-page cost worth keeping small. */
export const BARCODE_SCAN_DPI = 200;

export interface PageBarcodes {
  pageIndex: number;
  barcodes: import('./barcode').DecodedBarcode[];
  /**
   * Set when this page could not be rendered/scanned at all (e.g. a page
   * large enough that {@link BARCODE_SCAN_DPI} produces a canvas past the
   * browser's own size limit). An empty `barcodes` array on its own means
   * "checked, found nothing" — this field is what tells that apart from
   * "not checked", so a page that could not be examined is never silently
   * reported as barcode-free.
   */
  reason?: string;
}

/**
 * SCN-04 — scans each of `pageIndices` for barcodes/QR codes, reusing the
 * same render pipeline SCN-01/02's cleanup preview renders pages through.
 * A page with none reports an empty array, not an absent entry — "checked,
 * found nothing" and "not checked" are different facts a caller may need to
 * tell apart.
 *
 * One page failing to render (a canvas past the browser's pixel-area limit,
 * most likely on an oversized custom page size) does not abort the rest of
 * the scan — the other pages are still worth checking, and the caller finds
 * out which page was skipped and why via `reason` rather than the whole
 * operation failing with no result at all.
 */
export async function scanDocumentBarcodes(
  bytes: Uint8Array,
  pageIndices: number[],
  options: JobOptions = {}
): Promise<PageBarcodes[]> {
  return renderWorker.lease(async api => {
    const { handle } = await api.loadDocument(bytes);
    try {
      const results: PageBarcodes[] = [];
      for (let i = 0; i < pageIndices.length; i++) {
        if (options.signal?.aborted) throw cancelled();
        const pageIndex = pageIndices[i];
        options.onProgress?.(i / pageIndices.length, `Scanning page ${pageIndex + 1}`);
        try {
          const barcodes = await api.decodePageBarcodes(handle, pageIndex, BARCODE_SCAN_DPI);
          results.push({ pageIndex, barcodes });
        } catch (err) {
          if (isCancellation(err)) throw err;
          results.push({
            pageIndex,
            barcodes: [],
            reason: `Could not render this page to scan it: ${fromUnknown(err).message}`
          });
        }
      }
      return results;
    } finally {
      await api.closeDocument(handle).catch(() => {});
    }
  });
}

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

/**
 * CNV-06 — the embedded image XObjects themselves, as a ZIP.
 *
 * Distinct from `pagesToImageArchive` above, which *rasterises pages* through
 * pdf.js: nothing here is rendered, decoded, or re-encoded where the source is
 * already a file format, so the extracted JPEG is the same bytes the document
 * carries. The report says, per image, what happened to it.
 */
export async function extractEmbeddedImages(
  bytes: Uint8Array,
  pageIndices: number[],
  options: JobOptions = {}
): Promise<ExtractedImages> {
  const job = createJobHandle(options);
  return processWorker.lease(api => api.extractImages(bytes, pageIndices, job));
}

/** ACC-01 — returns thumbnails of all images for the alt-text editor */
export async function findImagesForAltText(
  bytes: Uint8Array,
  options: JobOptions = {}
): Promise<ImageAltInfo[]> {
  const job = createJobHandle(options);
  return processWorker.lease(api => api.findImagesForAltText(bytes, job));
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
    if (single) return await readSourceBytes(single.id);
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

/**
 * DOC-09 — contact sheet export.
 *
 * Renders every page in `bytes` at thumbnail scale (150 dpi) and tiles them
 * into a grid of `cols` columns on A4 portrait pages.  Reuses any thumbnail
 * bitmaps already in memory, then falls back to the shared render worker and
 * seeds the same cache the thumbnail UI uses.
 */
export async function exportContactSheet(
  sourceId: string,
  bytes: Uint8Array,
  cols: number,
  options?: JobOptions
): Promise<Uint8Array> {
  const job = createJobHandle(options);

  const jpegPages: Uint8Array[] = [];

  await renderWorker.lease(async api => {
    const { handle, pageCount } = await api.loadDocument(bytes);
    try {
      const scale = 150 / 72;
      for (let i = 0; i < pageCount; i++) {
        options?.onProgress?.(i / pageCount, `Rendering page ${i + 1} of ${pageCount}`);
        const key = bitmapKey(sourceId, i, scale);
        const cached = thumbnailCache.get(key);
        if (cached) {
          thumbnailCache.retain(key);
          try {
            jpegPages.push(await bitmapToJpeg(cached, 0.8));
          } finally {
            thumbnailCache.release(key);
          }
          continue;
        }

        const bitmap = await api.renderPage(handle, i, scale);
        try {
          const jpeg = await bitmapToJpeg(bitmap, 0.8);
          thumbnailCache.set(key, bitmap);
          jpegPages.push(jpeg);
        } catch (err) {
          bitmap.close();
          throw err;
        }
      }
    } finally {
      await api.closeDocument(handle).catch(() => {});
    }
  });

  return processWorker.lease(pApi => pApi.contactSheetExport(jpegPages, cols, job));
}

export {
  exportAnnotationSummary,
  exportAnnotationSummaryText,
  type SummaryAnnotation
} from './annotation-summary';

export {
  exportVisualDiff,
  type PageDiffResult,
  type ExportVisualDiffOptions
} from './visual-diff-export';

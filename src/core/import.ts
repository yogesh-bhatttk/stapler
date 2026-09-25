/**
 * DOC-02 — the one import pipeline.
 *
 * There were three near-identical copies of this (DropZone, Canvas drop handler,
 * OptionsPanel "Add PDF"), and they had drifted: the one on the front door built
 * `PageRef`s with `sourceDocId: file.name` while registering the document under a
 * `crypto.randomUUID()`. Nothing could ever resolve those refs, so thumbnails
 * never rendered and every export failed with "missing source bytes". One pipeline,
 * one place for that to be right.
 */
import * as Comlink from 'comlink';
import { processWorker, renderWorker } from './workers';
import { createJobHandle, type JobOptions } from './workers/protocol';
import type { RenderJob } from './workers/render.worker';
import type { DocumentFacts } from './workers/process.worker';
import { cancelled, corrupt, fromUnknown, isCancellation, logEvent, unsupported } from './errors';
import {
  makePageRefs,
  markSourcePending,
  registerSource,
  releasePendingSources,
  type PageRef,
  type SourceDocument
} from './store';
import { deleteSourceBytes, usesMemoryFallback, writeSourceBytes } from './opfs';
import { imageFileToPdfImages, isSupportedImage } from './image';
import { hasXfaMarker, XFA_MESSAGE } from './pdf/xfa';
import { tPlural, translate } from './i18n';

/** Warn rather than refuse — the plan has no size limit, only a warning (§5.1). */
export const LARGE_FILE_BYTES = 100 * 1024 * 1024;

/** The formats `importFiles` accepts, named once so every message agrees. */
export const SUPPORTED_FORMATS = 'PDF, PNG, JPEG, WebP, GIF, TIFF, and HEIC';

/**
 * The oversized warning, or `null` below the threshold.
 *
 * Split out of `importPdf` so the boundary is testable without allocating a
 * 100MB buffer in a test.
 */
export function largeFileWarning(byteLength: number): string | null {
  if (byteLength <= LARGE_FILE_BYTES) return null;
  return translate('{size}MB is a large document — operations on it will be slower.', {
    size: (byteLength / 1024 / 1024).toFixed(0)
  });
}

export interface ImportedFile {
  originalFile: File;
  source: SourceDocument;
  pages: PageRef[];
  /** Non-fatal things the user should know: XFA, very large, mixed page sizes. */
  warnings: string[];
}

export interface ImportOutcome {
  imported: ImportedFile[];
  /** One entry per file that could not be imported, with its reason. */
  failures: { name: string; message: string }[];
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF

export function looksLikePdf(bytes: Uint8Array): boolean {
  // A PDF may carry junk before the header, so scan the first KB as viewers do.
  const limit = Math.min(bytes.length, 1024);
  for (let i = 0; i + 4 <= limit; i++) {
    if (PDF_MAGIC.every((b, k) => bytes[i + k] === b)) return true;
  }
  return false;
}

export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

/**
 * Imports one PDF: validates it, records its page geometry, and returns refs.
 * Throws a typed `StaplerError` describing exactly what is wrong, so the caller
 * can report per-file rather than failing the batch.
 */
async function importPdf(
  file: File,
  options: JobOptions,
  onPending: (id: string) => void = () => {}
): Promise<ImportedFile> {
  /**
   * Cancellation point. Import is a handful of awaits, not a loop, so the honest
   * granularity is "between stages": reading the file, parsing it with pdf.js,
   * inspecting it with pdf-lib. Each stage also reports where it actually is, which
   * is why this reports a fraction rather than jumping 0 → 100 at the end.
   */
  const stage = (fraction: number, label: string) => {
    if (options.signal?.aborted) throw cancelled();
    options.onProgress?.(fraction, label);
  };

  stage(0, translate('Checking {name}', { name: file.name }));
  // RT-16 — the header is sniffed from the first KB *before* the whole file is
  // read. A 2 GB video renamed to `.pdf` used to be read into memory in full
  // just to be told it was not a PDF.
  if (file.size === 0) throw corrupt('The file is empty.');
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  if (!looksLikePdf(head)) {
    throw corrupt('The file does not start with a PDF header, so it is not a PDF.');
  }
  stage(0.05, translate('Reading {name}', { name: file.name }));
  const bytes = new Uint8Array(await file.arrayBuffer());
  stage(0.15, translate('Checking {name}', { name: file.name }));
  if (bytes.length === 0) throw corrupt('The file is empty.');

  const warnings: string[] = [];

  // SGN-03: XFA is decided here, on the raw bytes, before pdf.js or pdf-lib gets a
  // say. Both parsers answer a narrower question than "is this an XFA form" — see
  // `core/pdf/xfa.ts` — and both answer it only after a parse that may have
  // dropped the evidence.
  const rawXfa = hasXfaMarker(bytes);

  const oversized = largeFileWarning(bytes.length);
  if (oversized) warnings.push(oversized);

  // The render worker owns validation because pdf.js distinguishes encrypted from
  // corrupt from XFA, and it is the parse we need anyway for page sizes.
  //
  // load and close must go through the same pool instance — `pin()` guarantees
  // that, where two independent `lease()` calls could land on different
  // instances and leave the close a silent no-op on the wrong one.
  //
  // RT-16 — the pdf.js parse is closed as soon as its page count and sizes are
  // read, *before* pdf-lib inspects the bytes, rather than held open across the
  // inspection: that was three full copies alive at once (this thread's, the
  // render worker's and the process worker's). Now at most two are.
  const client = renderWorker.pin();
  let info: Awaited<ReturnType<RenderJob['loadDocument']>>;
  try {
    stage(0.25, translate('Parsing {name}', { name: file.name }));
    info = await client.lease(api => api.loadDocument(bytes));
    // Release the pdf.js parse; the workspace re-opens documents on demand through
    // the render cache, which knows how to evict them. Guarded: a close that
    // fails (a worker that died after answering) must neither mask the real
    // outcome nor fail an otherwise good import.
    await client
      .lease(api => api.closeDocument(info.handle))
      .catch(err => logEvent('warn', 'import', `Closing the parse failed: ${String(err)}`));
  } finally {
    client.release();
  }

  if (info.pageCount === 0) throw corrupt('The document contains no pages.');
  const isXfa = rawXfa || info.isXfa;
  if (isXfa) warnings.push(translate(XFA_MESSAGE));

  // Pending from before the bytes land until the caller has had its chance to
  // add the document (RT-5) — see `importFiles`.
  const id = crypto.randomUUID();
  stage(0.5, `Saving ${file.name}`);
  markSourcePending(id);
  onPending(id);
  await writeSourceBytes(id, bytes);

  let facts: DocumentFacts;
  try {
    stage(0.7, translate('Inspecting {name}', { name: file.name }));
    // RT-16 — with the bytes safely in OPFS, this thread's copy has no reader
    // left, so it is *transferred* to the process worker rather than cloned.
    // Not in memory-fallback mode, where the store holds this very array.
    const transferable = !(await usesMemoryFallback());
    facts = await processWorker.lease(api =>
      api.inspect(transferable ? Comlink.transfer(bytes, [bytes.buffer]) : bytes)
    );
    stage(0.9, translate('Registering {name}', { name: file.name }));
  } catch (err) {
    // Never registered, so nothing else will ever free these bytes.
    await deleteSourceBytes(id).catch(() => {});
    throw err;
  }

  // An XFA document's AcroForm shadow fields are not fillable, so they are never
  // advertised as such — offering them is how the fill path got entered at all.
  if (facts.hasAcroForm && !isXfa) {
    warnings.push(tPlural('Contains {count} fillable form fields.', facts.fieldCount));
  }
  // `facts.permissionRestrictions` is `null` here too — this is the one
  // case that isn't "nothing to preserve" and must not read as one:
  // this file may well have arrived with real restrictions this codebase
  // failed to parse, and — unlike the ordinary case — an export of it
  // will silently not carry them forward unless the user is told now.
  if (facts.permissionRestrictionsUnknown) {
    warnings.push(
      translate(
        "This document's original permission restrictions could not be read, so they will not be reapplied when you export it."
      )
    );
  }

  const source: SourceDocument = {
    id,
    name: file.name,
    pageCount: info.pageCount,
    pageSizes: info.pageSizes,
    // Import is the only moment these are readable: opening a
    // permission-restricted PDF decrypts it, and a decrypted document has
    // no `/Encrypt` dictionary left to read them back from. Every export
    // of this document re-applies them (see `ui/tools/commit.ts`), so a
    // file that arrived unprintable does not leave printable.
    ...(facts.permissionRestrictions !== null && facts.permissionRestrictions !== undefined
      ? { restrictions: facts.permissionRestrictions }
      : {})
  };
  registerSource(source);
  options.onProgress?.(1, translate('Imported {name}', { name: file.name }));
  // `makePageRefs` takes the same id the source was registered under; that
  // coupling is the whole point of doing this in one function.
  return { originalFile: file, source, pages: makePageRefs(id, info.pageCount), warnings };
}

import type { ImagesToPdfOptions } from './operations';

/**
 * Decodes a set of image files and composes them into one PDF's bytes.
 *
 * Split out of `importImages` so the images-to-pdf tool (CNV-01) can produce a
 * standalone PDF — save to disk, no workspace document — without duplicating the
 * per-image decode/cancel/warning loop that opening images as a document also needs.
 */
export async function imagesToPdfBytes(
  files: File[],
  options: JobOptions,
  imageOptions?: ImagesToPdfOptions
): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const job = createJobHandle(options);
  // JPEG, or PNG on the lossless path — `imagesToPdf` sniffs which (CONV-10).
  const images: Uint8Array[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < files.length; i++) {
    // Per-image cancellation point: decoding a 120MB TIFF is the slow part, and the
    // user must not have to wait for the whole set to finish before cancel takes.
    if (options.signal?.aborted) throw cancelled();
    options.onProgress?.(
      i / files.length,
      translate('Decoding image {n} of {total}', { n: i + 1, total: files.length })
    );
    // The size warning is about the source bytes, so it is raised per image: a
    // 120MB TIFF is as slow to decode as a 120MB PDF is to parse.
    const oversized = largeFileWarning(files[i].size);
    if (oversized) {
      warnings.push(translate('{name}: {warning}', { name: files[i].name, warning: oversized }));
    }
    images.push(
      ...(await imageFileToPdfImages(files[i], imageOptions?.quality ?? 0.9, options.signal))
    );
  }

  const bytes = await processWorker.lease(api => api.imagesToPdf(images, imageOptions, job));
  return { bytes, warnings };
}

/**
 * Imports a set of images as one document. Grouping them is deliberate: 20 phone
 * photos should become one 20-page PDF (CNV-01), not 20 tabs.
 */
async function importImages(
  files: File[],
  options: JobOptions,
  imageOptions?: ImagesToPdfOptions,
  onPending: (id: string) => void = () => {}
): Promise<ImportedFile> {
  const { bytes, warnings } = await imagesToPdfBytes(files, options, imageOptions);
  const client = renderWorker.pin();
  try {
    const info = await client.lease(api => api.loadDocument(bytes));
    try {
      const id = crypto.randomUUID();
      const source: SourceDocument = {
        id,
        name: files.length === 1 ? replaceExtension(files[0].name) : 'Images.pdf',
        pageCount: info.pageCount,
        pageSizes: info.pageSizes
      };
      markSourcePending(id);
      onPending(id);
      await writeSourceBytes(id, bytes);
      registerSource(source, files);
      return {
        originalFile: files[0],
        source,
        pages: makePageRefs(id, info.pageCount),
        warnings
      };
    } finally {
      // Guarded (RT-16): a failed close must not replace the real outcome.
      await client
        .lease(api => api.closeDocument(info.handle))
        .catch(err => logEvent('warn', 'import', 'Closing the parse failed: ' + String(err)));
    }
  } finally {
    client.release();
  }
}

/**
 * Registers bytes an operation produced (a font fix, say) as a new source:
 * parses them once for the page count and sizes, stores them, and returns the
 * registered source for the caller to point pages at.
 *
 * RT-22 — the parse is opened and closed on one pinned render-worker
 * instance. `FontEmbeddingSection` used two independent `lease()` calls, which
 * can land on different pool instances; the close then silently missed and
 * the parsed document leaked for the rest of the session.
 */
export async function registerSourceFromBytes(
  bytes: Uint8Array,
  name: string
): Promise<SourceDocument> {
  const client = renderWorker.pin();
  let info: Awaited<ReturnType<RenderJob['loadDocument']>>;
  try {
    info = await client.lease(api => api.loadDocument(bytes));
    await client
      .lease(api => api.closeDocument(info.handle))
      .catch(err => logEvent('warn', 'import', `Closing the parse failed: ${String(err)}`));
  } finally {
    client.release();
  }
  const source: SourceDocument = {
    id: crypto.randomUUID(),
    name,
    pageCount: info.pageCount,
    pageSizes: info.pageSizes
  };
  await writeSourceBytes(source.id, bytes);
  registerSource(source);
  return source;
}

function replaceExtension(name: string): string {
  return `${name.replace(/\.[^.]+$/, '')}.pdf`;
}

/**
 * Imports a mixed set of files. One bad file never aborts the rest — its reason is
 * returned alongside the successes so the UI can report per file.
 */
export async function importFiles(
  files: File[],
  options: JobOptions = {},
  imageOptions?: ImagesToPdfOptions
): Promise<ImportOutcome> {
  const pdfs = files.filter(isPdfFile);
  const images = files.filter(f => !isPdfFile(f) && isSupportedImage(f));
  const rejected = files.filter(f => !isPdfFile(f) && !isSupportedImage(f));

  const imported: ImportedFile[] = [];
  const failures: ImportOutcome['failures'] = rejected.map(file => ({
    name: file.name,
    message: unsupported(
      translate('{type} cannot be imported. Stapler accepts {formats}.', {
        type: file.type || translate('This file type'),
        formats: SUPPORTED_FORMATS
      })
    ).message
  }));

  const total = pdfs.length + (images.length > 0 ? 1 : 0);
  let done = 0;

  // RT-5 — every source this call registers stays "pending" (live to
  // `closeDocument`'s GC) until the caller has consumed the outcome. Every
  // caller adds the documents/pages, or sets its comparison source,
  // synchronously in the continuation right after `await importFiles(...)`;
  // that continuation is a microtask, so releasing on a macrotask after this
  // call settles is guaranteed to run after it. A source the caller then
  // discards is ordinary garbage again for the next close.
  const pendingIds: string[] = [];
  const onPending = (id: string) => pendingIds.push(id);
  try {
    return await importAll();
  } finally {
    setTimeout(() => releasePendingSources(pendingIds), 0);
  }

  async function importAll(): Promise<ImportOutcome> {
    for (const file of pdfs) {
      if (options.signal?.aborted) break;
      try {
        imported.push(
          await importPdf(
            file,
            {
              signal: options.signal,
              onProgress: (fraction, label) =>
                options.onProgress?.(
                  (done + (fraction ?? 0)) / total,
                  translate('{name}: {label}', { name: file.name, label })
                )
            },
            onPending
          )
        );
      } catch (err) {
        // A cancelled import is not a per-file failure: the user asked for it, and
        // listing "Operation cancelled" against every remaining file is noise.
        if (isCancellation(err)) break;
        failures.push({ name: file.name, message: fromUnknown(err).message });
      }
      done += 1;
      options.onProgress?.(done / total, translate('Imported {done} of {total}', { done, total }));
    }

    if (images.length > 0 && !options.signal?.aborted) {
      try {
        imported.push(
          await importImages(
            images,
            {
              signal: options.signal,
              onProgress: (fraction, label) =>
                options.onProgress?.((done + (fraction ?? 0)) / total, label)
            },
            imageOptions,
            onPending
          )
        );
      } catch (err) {
        if (!isCancellation(err)) {
          failures.push({
            name: tPlural('{count} images', images.length),
            message: fromUnknown(err).message
          });
        }
      }
    }

    return { imported, failures };
  }
}

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
import { processWorker, renderWorker } from './workers';
import { createJobHandle, type JobOptions } from './workers/protocol';
import { cancelled, corrupt, fromUnknown, isCancellation, unsupported } from './errors';
import { makePageRefs, registerSource, type PageRef, type SourceDocument } from './store';
import { writeSourceBytes } from './opfs';
import { imageFileToJpegs, isSupportedImage } from './image';
import { hasXfaMarker, XFA_MESSAGE } from './pdf/xfa';

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
  return `${(byteLength / 1024 / 1024).toFixed(0)}MB is a large document — operations on it will be slower.`;
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

function looksLikePdf(bytes: Uint8Array): boolean {
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
async function importPdf(file: File, options: JobOptions): Promise<ImportedFile> {
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

  stage(0, `Reading ${file.name}`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  stage(0.15, `Checking ${file.name}`);
  if (bytes.length === 0) throw corrupt('The file is empty.');
  if (!looksLikePdf(bytes)) {
    throw corrupt('The file does not start with a PDF header, so it is not a PDF.');
  }

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
  const client = renderWorker.pin();
  try {
    stage(0.25, `Parsing ${file.name}`);
    const info = await client.lease(api => api.loadDocument(bytes));
    try {
      if (info.pageCount === 0) throw corrupt('The document contains no pages.');
      const isXfa = rawXfa || info.isXfa;
      if (isXfa) warnings.push(XFA_MESSAGE);

      stage(0.7, `Inspecting ${file.name}`);
      const facts = await processWorker.lease(api => api.inspect(bytes));
      stage(0.9, `Registering ${file.name}`);
      // An XFA document's AcroForm shadow fields are not fillable, so they are never
      // advertised as such — offering them is how the fill path got entered at all.
      if (facts.hasAcroForm && !isXfa) {
        warnings.push(`Contains ${facts.fieldCount} fillable form field(s).`);
      }

      const id = crypto.randomUUID();
      const source: SourceDocument = {
        id,
        name: file.name,
        pageCount: info.pageCount,
        pageSizes: info.pageSizes
      };
      await writeSourceBytes(id, bytes);
      registerSource(source);
      options.onProgress?.(1, `Imported ${file.name}`);
      // `makePageRefs` takes the same id the source was registered under; that
      // coupling is the whole point of doing this in one function.
      return { originalFile: file, source, pages: makePageRefs(id, info.pageCount), warnings };
    } finally {
      // Release the pdf.js parse; the workspace re-opens documents on demand through
      // the render cache, which knows how to evict them. Runs on the cancellation
      // path too — an aborted import must not leak a pdf.js document handle.
      await client.lease(api => api.closeDocument(info.handle));
    }
  } finally {
    client.release();
  }
}

import type { ImagesToPdfOptions } from './operations';

/**
 * Imports a set of images as one document. Grouping them is deliberate: 20 phone
 * photos should become one 20-page PDF (CNV-01), not 20 tabs.
 */
async function importImages(
  files: File[],
  options: JobOptions,
  imageOptions?: ImagesToPdfOptions
): Promise<ImportedFile> {
  const job = createJobHandle(options);
  const jpegs: Uint8Array[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < files.length; i++) {
    // Per-image cancellation point: decoding a 120MB TIFF is the slow part, and the
    // user must not have to wait for the whole set to finish before cancel takes.
    if (options.signal?.aborted) throw cancelled();
    options.onProgress?.(i / files.length, `Decoding image ${i + 1} of ${files.length}`);
    // The size warning is about the source bytes, so it is raised per image: a
    // 120MB TIFF is as slow to decode as a 120MB PDF is to parse.
    const oversized = largeFileWarning(files[i].size);
    if (oversized) warnings.push(`${files[i].name}: ${oversized}`);
    jpegs.push(...(await imageFileToJpegs(files[i], imageOptions?.quality ?? 0.9)));
  }

  const bytes = await processWorker.lease(api => api.imagesToPdf(jpegs, imageOptions, job));
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
      await writeSourceBytes(id, bytes);
      registerSource(source);
      return {
        originalFile: files[0],
        source,
        pages: makePageRefs(id, info.pageCount),
        warnings
      };
    } finally {
      await client.lease(api => api.closeDocument(info.handle));
    }
  } finally {
    client.release();
  }
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
      `${file.type || 'This file type'} cannot be imported. Stapler accepts ${SUPPORTED_FORMATS}.`
    ).message
  }));

  const total = pdfs.length + (images.length > 0 ? 1 : 0);
  let done = 0;

  for (const file of pdfs) {
    if (options.signal?.aborted) break;
    try {
      imported.push(
        await importPdf(file, {
          signal: options.signal,
          onProgress: (fraction, label) =>
            options.onProgress?.((done + (fraction ?? 0)) / total, `${file.name}: ${label}`)
        })
      );
    } catch (err) {
      // A cancelled import is not a per-file failure: the user asked for it, and
      // listing "Operation cancelled" against every remaining file is noise.
      if (isCancellation(err)) break;
      failures.push({ name: file.name, message: fromUnknown(err).message });
    }
    done += 1;
    options.onProgress?.(done / total, `Imported ${done} of ${total}`);
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
          imageOptions
        )
      );
    } catch (err) {
      if (!isCancellation(err)) {
        failures.push({ name: `${images.length} image(s)`, message: fromUnknown(err).message });
      }
    }
  }

  return { imported, failures };
}

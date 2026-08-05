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
import { corrupt, fromUnknown, unsupported } from './errors';
import { makePageRefs, registerSource, type PageRef, type SourceDocument } from './store';
import { imageFileToJpeg, isSupportedImage } from './image';
import { hasXfaMarker, XFA_MESSAGE } from './pdf/xfa';

/** Warn rather than refuse — the plan has no size limit, only a warning (§5.1). */
export const LARGE_FILE_BYTES = 100 * 1024 * 1024;

export interface ImportedFile {
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

function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

/**
 * Imports one PDF: validates it, records its page geometry, and returns refs.
 * Throws a typed `StaplerError` describing exactly what is wrong, so the caller
 * can report per-file rather than failing the batch.
 */
async function importPdf(file: File, options: JobOptions): Promise<ImportedFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
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

  if (bytes.length > LARGE_FILE_BYTES) {
    warnings.push(
      `${(bytes.length / 1024 / 1024).toFixed(0)}MB is a large document — operations on it will be slower.`
    );
  }

  // The render worker owns validation because pdf.js distinguishes encrypted from
  // corrupt from XFA, and it is the parse we need anyway for page sizes.
  const info = await renderWorker.lease(api => api.loadDocument(bytes));
  try {
    if (info.pageCount === 0) throw corrupt('The document contains no pages.');
    const isXfa = rawXfa || info.isXfa;
    if (isXfa) warnings.push(XFA_MESSAGE);

    const facts = await processWorker.lease(api => api.inspect(bytes));
    // An XFA document's AcroForm shadow fields are not fillable, so they are never
    // advertised as such — offering them is how the fill path got entered at all.
    if (facts.hasAcroForm && !isXfa) {
      warnings.push(`Contains ${facts.fieldCount} fillable form field(s).`);
    }

    const id = crypto.randomUUID();
    const source: SourceDocument = {
      id,
      name: file.name,
      bytes,
      pageCount: info.pageCount,
      pageSizes: info.pageSizes
    };
    registerSource(source);
    // `makePageRefs` takes the same id the source was registered under; that
    // coupling is the whole point of doing this in one function.
    return { source, pages: makePageRefs(id, info.pageCount), warnings };
  } finally {
    // Release the pdf.js parse; the workspace re-opens documents on demand through
    // the render cache, which knows how to evict them.
    await renderWorker.lease(api => api.closeDocument(info.handle));
    void options;
  }
}

/**
 * Imports a set of images as one document. Grouping them is deliberate: 20 phone
 * photos should become one 20-page PDF (CNV-01), not 20 tabs.
 */
async function importImages(files: File[], options: JobOptions): Promise<ImportedFile> {
  const job = createJobHandle(options);
  const jpegs: Uint8Array[] = [];
  for (let i = 0; i < files.length; i++) {
    options.onProgress?.(i / files.length, `Decoding image ${i + 1} of ${files.length}`);
    jpegs.push(await imageFileToJpeg(files[i]));
  }

  const bytes = await processWorker.lease(api => api.imagesToPdf(jpegs, job));
  const info = await renderWorker.lease(api => api.loadDocument(bytes));
  try {
    const id = crypto.randomUUID();
    const source: SourceDocument = {
      id,
      name: files.length === 1 ? replaceExtension(files[0].name) : 'Images.pdf',
      bytes,
      pageCount: info.pageCount,
      pageSizes: info.pageSizes
    };
    registerSource(source);
    return { source, pages: makePageRefs(id, info.pageCount), warnings: [] };
  } finally {
    await renderWorker.lease(api => api.closeDocument(info.handle));
  }
}

function replaceExtension(name: string): string {
  return `${name.replace(/\.[^.]+$/, '')}.pdf`;
}

/**
 * Imports a mixed set of files. One bad file never aborts the rest — its reason is
 * returned alongside the successes so the UI can report per file.
 */
export async function importFiles(files: File[], options: JobOptions = {}): Promise<ImportOutcome> {
  const pdfs = files.filter(isPdfFile);
  const images = files.filter(f => !isPdfFile(f) && isSupportedImage(f));
  const rejected = files.filter(f => !isPdfFile(f) && !isSupportedImage(f));

  const imported: ImportedFile[] = [];
  const failures: ImportOutcome['failures'] = rejected.map(file => ({
    name: file.name,
    message: unsupported(
      `${file.type || 'This file type'} cannot be imported. Stapler accepts PDF, PNG, JPEG, WebP, GIF, and HEIC.`
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
      failures.push({ name: file.name, message: fromUnknown(err).message });
    }
    done += 1;
    options.onProgress?.(done / total, `Imported ${done} of ${total}`);
  }

  if (images.length > 0 && !options.signal?.aborted) {
    try {
      imported.push(
        await importImages(images, {
          signal: options.signal,
          onProgress: (fraction, label) =>
            options.onProgress?.((done + (fraction ?? 0)) / total, label)
        })
      );
    } catch (err) {
      failures.push({ name: `${images.length} image(s)`, message: fromUnknown(err).message });
    }
  }

  return { imported, failures };
}

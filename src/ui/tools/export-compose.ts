/**
 * AUDIT-2026-10-10 M2/M3 — what goes into a PDF, decided in one place.
 *
 * Two different questions were being answered by one function
 * (`currentDocumentBytes`) and by a dozen hand-written `composeDocument`
 * calls, each picking its own subset of the user's pending edits:
 *
 *  • **"What does the document look like, exported?"** — every pending edit,
 *    baked in: pages, rotation, stamps, crop boxes, Annotate marks, the
 *    watermark and header/footer, an edited outline, Bates numbers, the
 *    QR/barcode stamp, N-up while that tool is open. Sign, Cleanup,
 *    Accessibility and Split used to drop the crop and every overlay;
 *    Compress, Metadata, Grayscale, PDF→images and OCR dropped the Annotate
 *    marks, the outline, Bates and the barcode — and each of those exports
 *    then refreshed the baseline, marking work clean that was never written.
 *    {@link exportComposeRequest} / {@link exportDocumentBytes} answer this,
 *    for every PDF export.
 *
 *  • **"What is on the page?"** — the content a rewrite (redaction, face blur,
 *    font embedding) operates on and then *replaces the document's pages
 *    with*. Feeding those the exported bytes baked the watermark and
 *    header/footer into the new source while the settings stayed on, so the
 *    next export drew them a second time; font embedding repointed pages at
 *    bytes that already carried the crop and the stamps, so both were applied
 *    twice. {@link documentContentBytes} answers this: the pages and,
 *    optionally, the stamps — never a global overlay, a crop or an Annotate
 *    mark, which all stay live, keyed by page, and are applied once, at export.
 */
import { activeDoc, sources, type PageRef, type StaplerDoc } from '../../core/store';
import { composeDocument, type ComposeRequest } from '../../core/operations';
import { readSourceBytes } from '../../core/opfs';
import { internal } from '../../core/errors';
import type { JobOptions } from '../../core/workers/protocol';
import type { AnnotationSource } from '../../core/workers/process.worker';
import { cropBoxes } from './crop/state';
import {
  barcodeStampSettings,
  batesSettings,
  hasHeaderFooterContent,
  hasWatermarkContent,
  headerFooterSettings,
  watermarkSettings
} from './watermark/state';
import { entriesToNodes, outlineDocId, outlineEdited, outlineTree } from './outline/state';
import { nupSettings } from './nup/state';
import { normalizeSettings } from './normalize/state';
import { pageAnnotations } from './annotate/state';

/** The Annotate tool's marks on `pages`, in the shape `compose` draws. */
export function layerAnnotationsFor(pages: readonly PageRef[]): AnnotationSource[] {
  const result: AnnotationSource[] = [];
  for (const { key } of pages) {
    for (const annotation of pageAnnotations.value[key] ?? []) {
      result.push({ ...annotation, pageKey: key });
    }
  }
  return result;
}

/** OPS-11 — the Bates stamp, or nothing when the user has not switched it on. */
export function batesStamp() {
  const settings = batesSettings.value;
  if (!settings.enabled) return undefined;
  return {
    prefix: settings.prefix,
    digits: settings.digits,
    start: settings.start,
    position: settings.position,
    fontSize: settings.fontSize
  };
}

/** OPS-18 — the QR/barcode stamp, or nothing when disabled or empty. */
export function barcodeStamp() {
  const settings = barcodeStampSettings.value;
  if (!settings.enabled || !settings.text.trim()) return undefined;
  return {
    kind: settings.kind,
    text: settings.text,
    position: settings.position,
    scale: settings.scale
  };
}

/**
 * OPS-10 — the edited outline, or `undefined` to leave the document's own alone.
 *
 * Only the tree loaded *for this document*, and only once the user has actually
 * changed it. `outlineTree` is a single signal, so another document's bookmarks
 * would point at pages that are not in this one; and an unedited tree must not be
 * written back at all, because it was read from the first page's source document
 * and would silently drop the outlines a second, merged-in document contributed
 * through OPS-01.
 */
export function editedOutline(doc: StaplerDoc, pages: readonly PageRef[]) {
  if (outlineDocId.value !== doc.id || !outlineEdited.value) return undefined;
  return entriesToNodes(
    outlineTree.value,
    pages.map(page => page.key)
  );
}

export interface ExportComposeOptions {
  /**
   * Default true. False only for an export that addresses the result by
   * *document* page index (Split's boundaries), which N-up's sheets would
   * renumber. N-up is only ever set while its own panel is open.
   */
  nup?: boolean;
  /**
   * Default true. False only where one outline cannot describe the output
   * (Split writes several files from one compose).
   */
  outline?: boolean;
  /** OPS-09 — Normalize is applied only by its own tool. Default false. */
  normalize?: boolean;
  /** Default true. False builds a review's "before" without the Annotate marks. */
  layerAnnotations?: boolean;
  /** Sign and Annotate only — see `ComposeRequest.allowXfaLoss`. */
  allowXfaLoss?: boolean;
}

/**
 * The one compose request every PDF export of `doc` starts from: every
 * pending edit on `pages` (default: the document's own), baked in.
 */
export function exportComposeRequest(
  doc: StaplerDoc,
  pages: PageRef[] = doc.pages,
  options: ExportComposeOptions = {}
): ComposeRequest {
  return {
    pages,
    annotations: doc.annotations,
    cropBoxes: cropBoxes.value,
    watermark: watermarkSettings.value,
    headerFooter: headerFooterSettings.value,
    normalize: options.normalize ? normalizeSettings.value : null,
    nup: options.nup === false ? null : nupSettings.value,
    layerAnnotations: options.layerAnnotations === false ? undefined : layerAnnotationsFor(pages),
    outline: options.outline === false ? undefined : editedOutline(doc, pages),
    bates: batesStamp(),
    barcodeStamp: barcodeStamp(),
    allowXfaLoss: options.allowXfaLoss
  };
}

/**
 * The single source a document's pages all come from, in order and unrotated
 * — the case where its own file's bytes *are* the page content — or null.
 */
function wholeUnrotatedSource(pages: readonly PageRef[]): string | null {
  const first = pages[0];
  if (!first) return null;
  const source = sources.value[first.sourceDocId];
  if (!source || source.pageCount !== pages.length) return null;
  const inOrder = pages.every(
    (page, index) =>
      page.sourceDocId === first.sourceDocId && page.sourceIndex === index && page.rotation === 0
  );
  return inOrder ? source.id : null;
}

/**
 * True when composing `request` would add nothing to the source file: no
 * stamp, crop, mark, overlay, outline edit, stamp or layout. The export is
 * then the file's own bytes, untouched by a pdf-lib rebuild.
 */
export function composeAddsNothing(request: ComposeRequest): boolean {
  return (
    request.annotations.length === 0 &&
    !request.pages.some(page => request.cropBoxes?.[page.key]) &&
    (request.layerAnnotations?.length ?? 0) === 0 &&
    !(request.watermark && hasWatermarkContent(request.watermark)) &&
    !(request.headerFooter && hasHeaderFooterContent(request.headerFooter)) &&
    !request.nup &&
    !request.normalize &&
    !request.outline &&
    !request.bates &&
    !request.barcodeStamp
  );
}

function requireActiveDoc(): StaplerDoc {
  const doc = activeDoc.value;
  if (!doc) throw internal('No document is open.');
  return doc;
}

/**
 * M3 — the active document, exported: {@link exportComposeRequest} composed,
 * or the file's own bytes when there is nothing to add to them.
 */
export async function exportDocumentBytes(
  job: JobOptions = {},
  options: ExportComposeOptions & { pages?: PageRef[] } = {}
): Promise<Uint8Array> {
  const doc = requireActiveDoc();
  const request = exportComposeRequest(doc, options.pages ?? doc.pages, options);
  const single = wholeUnrotatedSource(request.pages);
  if (single && composeAddsNothing(request)) return readSourceBytes(single);
  return composeDocument(request, job);
}

/**
 * M2 — the page content of the active document's `pages` (default: all of
 * them), with the stamps (`doc.annotations`) when `stamps` is true and
 * nothing else: no crop, no Annotate mark, no watermark, header/footer,
 * Bates, barcode, outline or N-up.
 *
 * For an operation whose result *replaces the document's pages*: everything
 * left out here stays keyed to the same pages (`replaceWithSource` and
 * `repointPage` keep page keys) and is applied once, at export. Pass
 * `stamps: true` only when the caller then drops the stamps from the
 * document (`replaceWithSource` does by default); `repointPage` keeps them,
 * so a font fix passes false.
 *
 * Page indices in the result are the indices of `pages`, and its geometry is
 * the page as the single-page view shows it — which is the frame redaction
 * marks are drawn in, so a text search over these bytes lands where the
 * user sees the words (the exported bytes carried the crop box, which moved
 * every normalised coordinate on a cropped page).
 */
export async function documentContentBytes(
  job: JobOptions = {},
  options: { stamps: boolean; pages?: PageRef[] }
): Promise<Uint8Array> {
  const doc = requireActiveDoc();
  const pages = options.pages ?? doc.pages;
  const annotations = options.stamps ? doc.annotations : [];
  const single = wholeUnrotatedSource(pages);
  if (single && annotations.length === 0) return readSourceBytes(single);
  return composeDocument(
    { pages, annotations, ...(options.stamps ? {} : { formFieldsToCreate: [] }) },
    job
  );
}

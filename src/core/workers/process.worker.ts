export interface WatermarkData {
  text: string;
  position: string;
  opacity: number;
  rotation: number;
  fontSize: number;
  color: string;
}
/**
 * The pdf-lib worker: everything that *writes* a PDF.
 *
 * Two rules govern this file, both from PLAN §5.2:
 *
 *  1. Never silently corrupt. Content streams are handled as bytes via Latin-1
 *     round-tripping, never through a UTF-8 decode (which replaces every byte
 *     above 0x7F with U+FFFD and destroys the stream on re-encode).
 *  2. Never emit more than we can account for. pdf-lib's `save()` writes every
 *     indirect object in its context, including ones no longer referenced — so
 *     "remove a page" or "replace an image" leaves the old bytes in the file.
 *     Any operation meant to shrink a document therefore rebuilds it into a fresh
 *     document, where `copyPages` walks only the live reference graph.
 */
import * as Comlink from 'comlink';
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  degrees,
  StandardFonts,
  rgb
} from 'pdf-lib';
import { zipSync } from 'fflate';
import { checkpoint, type JobHandle } from './protocol';
import { corrupt, encrypted, internal, unsupported } from '../errors';
import { DOC_HAIRLINE_RGB, DOC_INK_RGB, DOC_REDACT_RGB } from '../doc-colors';
import { normalizeRotation } from '../rotation';
import {
  tokenizeContentStream,
  parseContentStream,
  filterContentStream,
  serializeStatements,
  decodeStream
} from '../pdf/interpreter';
import type { Rect } from '../pdf/interpreter';

/** A page in the output, pointing back at the bytes it came from. */
export interface PageSource {
  key: string;
  sourceDocId: string;
  sourceIndex: number;
  rotation: number;
  cropBox?: { x: number; y: number; width: number; height: number };
}

export interface StampSource {
  pageKey: string;
  type: 'signature' | 'text' | 'date' | 'check';
  /** Normalised to the page, origin top-left. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Text to draw, for non-image stamps. */
  text?: string;
  /** Resolved PNG bytes, for signature stamps. The worker never reads the DB. */
  imagePng?: Uint8Array;
  /** Clockwise rotation in degrees. */
  rotation?: number;
}

export interface DocumentFacts {
  pageCount: number;
  isXfa: boolean;
  isEncrypted: boolean;
  hasAcroForm: boolean;
  fieldCount: number;
}

export interface ImageFacts {
  name: string;
  /** Object number, so an image reused across pages is counted once. */
  objectNumber: number;
  width: number;
  height: number;
  bitsPerComponent: number;
  /** `DeviceRGB`, `DeviceCMYK`, `Indexed`, … or `unknown`. */
  colorSpace: string;
  /** Outermost stream filter, e.g. `DCTDecode`, `JPXDecode`, `JBIG2Decode`. */
  filter: string;
  hasSMask: boolean;
  hasMask: boolean;
  /**
   * How this image is masked, which decides whether it can be re-encoded:
   *
   *  • `none` — no mask.
   *  • `soft` — an `/SMask` stream, or a `/Mask` pointing at a stencil stream.
   *    The mask is a separate object, so the base image can be re-encoded and
   *    the mask re-attached byte-for-byte.
   *  • `colorKey` — `/Mask` as an array of colour ranges. Transparency is
   *    defined by *exact sample values* in the image's own colour space, which a
   *    lossy re-encode into DeviceRGB destroys outright.
   *  • `preblended` — an `/SMask` carrying `/Matte`, i.e. colour pre-multiplied
   *    against a matte. pdf.js un-blends it while decoding, so re-attaching the
   *    original mask would tell a viewer to un-blend data that no longer is.
   */
  maskKind: 'none' | 'soft' | 'colorKey' | 'preblended';
  /** A 1-bit stencil (`/ImageMask true`), which paints the fill colour, not pixels. */
  isImageMask: boolean;
  /** Encoded size of the image stream in bytes. */
  byteLength: number;
}

export interface PageImageInventory {
  pageIndex: number;
  images: ImageFacts[];
  /** Page box in points, for computing displayed-vs-stored resolution. */
  width: number;
  height: number;
}

export interface FormFieldData {
  name: string;
  type: 'TextField' | 'CheckBox' | 'RadioGroup' | 'Dropdown' | 'OptionList' | 'Unknown';
  value: string | string[] | boolean;
  options?: string[];
  isReadOnly: boolean;
  rects: { pageIndex: number; x: number; y: number; width: number; height: number }[];
}

export interface MetadataFindings {
  title?: string;
  author?: string;
  subject?: string;
  creator?: string;
  producer?: string;
  creationDate?: string;
  modificationDate?: string;
  keywords?: string;
  hasXmp: boolean;
  hasEmbeddedJavaScript: boolean;
  hasOpenAction: boolean;
  hasAdditionalActions: boolean;
  hasEmbeddedFiles: boolean;
  hasPageThumbnails: boolean;
  hasOptionalContent: boolean;
  hasCustomInfo: boolean;
}

export interface ScrubSettings {
  title?: boolean;
  author?: boolean;
  subject?: boolean;
  creator?: boolean;
  producer?: boolean;
  creationDate?: boolean;
  modificationDate?: boolean;
  keywords?: boolean;
  hasXmp?: boolean;
  hasEmbeddedJavaScript?: boolean;
  hasOpenAction?: boolean;
  hasAdditionalActions?: boolean;
  hasEmbeddedFiles?: boolean;
  hasPageThumbnails?: boolean;
  hasOptionalContent?: boolean;
  customInfo?: boolean;
}

export interface RedactionRegion {
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
}

/** A region rasterised by the render worker, ready to stamp over a page. */
export interface RegionStamp {
  pageIndex: number;
  png: Uint8Array;
}

export interface SplitResult {
  bytes: Uint8Array;
  isZip: boolean;
  fileCount: number;
}

export interface ProcessJob {
  inspect(bytes: Uint8Array): Promise<DocumentFacts>;
  imageInventory(bytes: Uint8Array, job?: JobHandle): Promise<PageImageInventory[]>;
  getFormFields(bytes: Uint8Array): Promise<{ isXfa: boolean; fields: FormFieldData[] }>;
  fillFormFields(
    bytes: Uint8Array,
    values: Record<string, string | boolean | string[]>,
    flatten: boolean
  ): Promise<Uint8Array>;
  compose(
    pages: PageSource[],
    sources: Record<string, Uint8Array>,
    stamps: StampSource[],
    watermark?: WatermarkData,
    normalize?: import('../../ui/tools/normalize/state').NormalizeSettings | null,
    nup?: import('../../ui/tools/nup/state').NUpSettings | null,
    job?: JobHandle
  ): Promise<Uint8Array>;
  composeSplit(
    pages: PageSource[],
    sources: Record<string, Uint8Array>,
    boundaries: number[],
    stamps: StampSource[],
    watermark?: WatermarkData,
    normalize?: import('../../ui/tools/normalize/state').NormalizeSettings | null,
    nup?: import('../../ui/tools/nup/state').NUpSettings | null,
    baseName?: string,
    job?: JobHandle
  ): Promise<{ isZip: boolean; bytes: Uint8Array }>;
  /**
   * Rebuilds `bytes` with the given pages replaced by rasters and the given image
   * XObjects re-encoded. Returns the original bytes untouched if the result is
   * not smaller (CMP-04).
   */
  rebuildCompressed(
    bytes: Uint8Array,
    rasterPages: Record<number, Uint8Array>,
    replacedImages: Record<
      number,
      Record<string, { jpeg: Uint8Array; width: number; height: number; maskBytes?: Uint8Array }>
    >,
    job?: JobHandle
  ): Promise<{ bytes: Uint8Array; keptOriginal: boolean }>;
  imagesToPdf(images: Uint8Array[], job?: JobHandle): Promise<Uint8Array>;
  readMetadata(bytes: Uint8Array): Promise<MetadataFindings>;
  scrubMetadata(bytes: Uint8Array, settings?: ScrubSettings): Promise<Uint8Array>;
  /**
   * Applies redactions through operator-level content removal, removing intersecting text
   * and image objects from the content stream while keeping the rest of the page selectable.
   */
  applyRedactions(
    bytes: Uint8Array,
    regions: RedactionRegion[],
    job?: JobHandle
  ): Promise<Uint8Array>;
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

/**
 * `ignoreEncryption: true` was used throughout the previous implementation, which
 * meant encrypted documents were half-processed into garbage instead of refused.
 * Encryption is a hard stop with an explanation (PLAN §1.1, §5.2).
 */
async function load(bytes: Uint8Array, allowEncrypted = false): Promise<PDFDocument> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, {
      ignoreEncryption: allowEncrypted,
      updateMetadata: false
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/encrypt/i.test(message)) {
      throw encrypted('The document is encrypted, so its contents cannot be rewritten.');
    }
    throw corrupt(`The PDF could not be parsed: ${message}`);
  }
  if (doc.isEncrypted && !allowEncrypted) {
    throw encrypted('The document is encrypted, so its contents cannot be rewritten.');
  }
  return doc;
}

/** pdf-lib Colors built from the document-colour tuples, made once. */
const DOC_INK = rgb(...DOC_INK_RGB);
const DOC_REDACT = rgb(...DOC_REDACT_RGB);

function transfer(bytes: Uint8Array): Uint8Array {
  return Comlink.transfer(bytes, [bytes.buffer]);
}

/* ------------------------------------------------------------------ *
 * Composition
 * ------------------------------------------------------------------ */

/**
 * Loads each source document once and hands out cached instances, so merging ten
 * files parses ten documents rather than one per page.
 */
function sourceCache(sources: Record<string, Uint8Array>) {
  const loaded = new Map<string, PDFDocument>();
  return async (id: string): Promise<PDFDocument> => {
    const cached = loaded.get(id);
    if (cached) return cached;
    const bytes = sources[id];
    if (!bytes) {
      throw internal('A page refers to a document whose bytes were not provided', {
        sourceDocId: id
      });
    }
    const doc = await load(bytes);
    loaded.set(id, doc);
    return doc;
  };
}

/** Text stamps use one embedded font per output document, not one per stamp. */
async function stampFont(
  doc: PDFDocument,
  cache: { font?: Awaited<ReturnType<PDFDocument['embedFont']>> }
) {
  if (!cache.font) cache.font = await doc.embedFont(StandardFonts.Helvetica);
  return cache.font;
}

/**
 * Helvetica is WinAnsi-only. Drawing a character it cannot encode throws, which
 * would abort an export over one pasted em-dash, so unsupported characters are
 * replaced and the caller is warned rather than losing the whole document.
 */
function toWinAnsi(text: string): { text: string; lostCharacters: boolean } {
  let lost = false;
  const out = [...text]
    .map(ch => {
      const code = ch.codePointAt(0) ?? 0;
      if (code === 0x2019 || code === 0x2018) return "'";
      if (code === 0x201c || code === 0x201d) return '"';
      if (code === 0x2013 || code === 0x2014) return '-';
      if (code === 0x2026) return '...';
      if (code < 0x20) return ' ';
      if (code > 0xff) {
        lost = true;
        return '?';
      }
      return ch;
    })
    .join('');
  return { text: out, lostCharacters: lost };
}

async function drawStamps(
  outDoc: PDFDocument,
  page: ReturnType<PDFDocument['addPage']>,
  stamps: StampSource[],
  fontCache: { font?: Awaited<ReturnType<PDFDocument['embedFont']>> },
  imageCache: Map<string, Awaited<ReturnType<PDFDocument['embedPng']>>>
) {
  if (stamps.length === 0) return;
  const { width, height } = page.getSize();

  for (const stamp of stamps) {
    // PDF space is bottom-left origin; stamp coordinates are top-left.
    const x = stamp.x * width;
    const y = height - stamp.y * height - stamp.height * height;
    const w = stamp.width * width;
    const h = stamp.height * height;
    const rot = stamp.rotation ?? 0;

    // CSS clockwise rotation mapped to PDF counter-clockwise rotation
    const rad = (-rot * Math.PI) / 180;

    // Center of the unrotated stamp box
    const cx = x + w / 2;
    const cy = y + h / 2;

    // Calculate the new bottom-left origin in page space such that
    // the center of the rotated box remains at (cx, cy)
    const dx = (w / 2) * Math.cos(rad) - (h / 2) * Math.sin(rad);
    const dy = (w / 2) * Math.sin(rad) + (h / 2) * Math.cos(rad);
    const drawX = cx - dx;
    const drawY = cy - dy;

    if (stamp.type === 'signature') {
      if (!stamp.imagePng) continue;
      // An identical signature placed on 20 pages must embed one image object.
      const key = fingerprintBytes(stamp.imagePng);
      let image = imageCache.get(key);
      if (!image) {
        image = await outDoc.embedPng(stamp.imagePng);
        imageCache.set(key, image);
      }
      page.drawImage(image, { x: drawX, y: drawY, width: w, height: h, rotate: degrees(-rot) });
      continue;
    }

    const raw = stamp.type === 'check' ? '✓' : (stamp.text ?? '');
    if (!raw) continue;

    // Transform a local point (origin at unrotated bottom-left) to rotated page coordinates
    const transform = (lx: number, ly: number) => ({
      x: drawX + lx * Math.cos(rad) - ly * Math.sin(rad),
      y: drawY + lx * Math.sin(rad) + ly * Math.cos(rad)
    });

    // The check glyph is not in WinAnsi; draw it as a vector tick instead of a
    // question mark.
    if (stamp.type === 'check') {
      const t = Math.max(1, Math.min(w, h) * 0.12);
      page.drawLine({
        start: transform(w * 0.15, h * 0.5),
        end: transform(w * 0.42, h * 0.2),
        thickness: t,
        color: DOC_INK
      });
      page.drawLine({
        start: transform(w * 0.42, h * 0.2),
        end: transform(w * 0.85, h * 0.8),
        thickness: t,
        color: DOC_INK
      });
      continue;
    }

    const { text } = toWinAnsi(raw);
    const font = await stampFont(outDoc, fontCache);
    const size = Math.max(4, h * 0.7);

    // Baseline start in local coordinates
    const tx = 0;
    const ty = (h - size) / 2 + size * 0.18;
    const tp = transform(tx, ty);

    page.drawText(text, {
      x: tp.x,
      y: tp.y,
      size,
      font,
      color: DOC_INK,
      rotate: degrees(-rot)
    });
  }
}

/** Cheap content hash, enough to dedupe identical embedded images. */
function fingerprintBytes(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h1 ^= bytes[i];
    h1 = Math.imul(h1, 0x01000193);
  }
  return `${bytes.length}:${(h1 >>> 0).toString(36)}`;
}

async function applyNUp(
  outDoc: PDFDocument,
  settings: import('../../ui/tools/nup/state').NUpSettings,
  job: JobHandle | undefined
): Promise<PDFDocument> {
  const originalPages = outDoc.getPages();
  if (originalPages.length === 0) return outDoc;

  const firstPage = originalPages[0];
  const { width: pw, height: ph } = firstPage.getSize();
  const W = Math.max(pw, ph);
  const H = Math.min(pw, ph);

  const { layout, margin, gutter, drawBorders } = settings;
  const isBooklet = layout === 'booklet';
  const is2up = layout === '2-up';

  const cols = is2up || isBooklet ? 2 : 2;
  const rows = is2up || isBooklet ? 1 : 2;
  const sheetW = is2up || isBooklet ? W : H;
  const sheetH = is2up || isBooklet ? H : W;

  const cellW = (sheetW - margin * 2 - gutter * (cols - 1)) / cols;
  const cellH = (sheetH - margin * 2 - gutter * (rows - 1)) / rows;

  const ordering: number[] = [];

  if (isBooklet) {
    const totalPages = Math.ceil(originalPages.length / 4) * 4;
    for (let i = 0; i < totalPages / 2; i++) {
      if (i % 2 === 0) {
        ordering.push(totalPages - i - 1, i);
      } else {
        ordering.push(i, totalPages - i - 1);
      }
    }
  } else {
    for (let i = 0; i < Math.ceil(originalPages.length / (cols * rows)) * (cols * rows); i++) {
      ordering.push(i);
    }
  }

  const finalDoc = await PDFDocument.create();

  for (let i = 0; i < ordering.length; i += cols * rows) {
    if (job)
      await checkpoint(
        job,
        i / ordering.length,
        `Imposing sheet ${Math.floor(i / (cols * rows)) + 1}`
      );
    const sheet = finalDoc.addPage([sheetW, sheetH]);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = ordering[i + r * cols + c];
        if (idx === undefined || idx >= originalPages.length) continue;

        const original = originalPages[idx];
        const embedded = await finalDoc.embedPage(original);

        const scaleX = cellW / embedded.width;
        const scaleY = cellH / embedded.height;
        const scale = Math.min(scaleX, scaleY);

        const actualW = embedded.width * scale;
        const actualH = embedded.height * scale;

        // Center within cell
        const x = margin + c * (cellW + gutter) + (cellW - actualW) / 2;
        // In PDF coordinates, Y=0 is bottom. So row 0 is top.
        const y = sheetH - margin - r * (cellH + gutter) - cellH + (cellH - actualH) / 2;

        sheet.drawPage(embedded, {
          x,
          y,
          width: actualW,
          height: actualH
        });

        if (drawBorders) {
          sheet.drawRectangle({
            x,
            y,
            width: actualW,
            height: actualH,
            borderWidth: 1,
            borderColor: rgb(...DOC_HAIRLINE_RGB)
          });
        }
      }
    }
  }

  return finalDoc;
}

async function composePages(
  pages: PageSource[],
  sources: Record<string, Uint8Array>,
  stamps: StampSource[],
  watermark: WatermarkData | undefined,
  normalize: import('../../ui/tools/normalize/state').NormalizeSettings | undefined | null,
  nup: import('../../ui/tools/nup/state').NUpSettings | undefined | null,
  job: JobHandle | undefined,
  label: string
): Promise<PDFDocument> {
  const outDoc = await PDFDocument.create();
  const getSource = sourceCache(sources);
  const fontCache: { font?: Awaited<ReturnType<PDFDocument['embedFont']>> } = {};
  const imageCache = new Map<string, Awaited<ReturnType<PDFDocument['embedPng']>>>();

  let watermarkFont: import('pdf-lib').PDFFont | undefined;
  if (watermark?.text) {
    watermarkFont = await outDoc.embedStandardFont(StandardFonts.HelveticaBold);
  }

  const stampsByPage = new Map<string, StampSource[]>();
  for (const stamp of stamps) {
    const list = stampsByPage.get(stamp.pageKey);
    if (list) list.push(stamp);
    else stampsByPage.set(stamp.pageKey, [stamp]);
  }

  for (let i = 0; i < pages.length; i++) {
    const ref = pages[i];
    await checkpoint(job, i / pages.length, `${label} ${i + 1} of ${pages.length}`);

    const srcDoc = await getSource(ref.sourceDocId);
    if (ref.sourceIndex < 0 || ref.sourceIndex >= srcDoc.getPageCount()) {
      throw internal('A page refers to an index outside its source document', {
        sourceIndex: ref.sourceIndex,
        sourcePageCount: srcDoc.getPageCount()
      });
    }

    const [copied] = await outDoc.copyPages(srcDoc, [ref.sourceIndex]);
    if (ref.rotation !== 0) {
      // /Rotate must be a non-negative multiple of 90; the previous code could
      // produce -90 by taking a plain modulo of a negative sum.
      copied.setRotation(degrees(normalizeRotation(copied.getRotation().angle + ref.rotation)));
    }

    if (normalize) {
      const { width, height } = copied.getSize();
      let targetW = 595.28; // A4 default
      let targetH = 841.89;
      if (normalize.targetSize === 'Letter') {
        targetW = 612;
        targetH = 792;
      } else if (normalize.targetSize === 'Legal') {
        targetW = 612;
        targetH = 1008;
      }

      // If page is landscape, target should be landscape
      if (width > height) {
        const temp = targetW;
        targetW = targetH;
        targetH = temp;
      }

      let factor = 1;
      const scaleX = targetW / width;
      const scaleY = targetH / height;

      if (normalize.scaleMode === 'fit') {
        factor = Math.min(scaleX, scaleY);
      } else if (normalize.scaleMode === 'fill') {
        factor = Math.max(scaleX, scaleY);
      }

      if (factor !== 1) {
        copied.scale(factor, factor);
      }

      const scaledW = width * factor;
      const scaledH = height * factor;

      // translateContent shifts the origin so the content is centered
      const dx = (targetW - scaledW) / 2;
      const dy = (targetH - scaledH) / 2;

      if (dx !== 0 || dy !== 0) {
        copied.translateContent(dx, dy);
      }

      // Override the boxes to match the target size exactly
      copied.setSize(targetW, targetH);
      copied.setCropBox(0, 0, targetW, targetH);
    }

    outDoc.addPage(copied);

    if (ref.cropBox) {
      // PDF-lib coordinates are bottom-left. The incoming cropBox is top-left normalized [0,1].
      const { width, height } = copied.getSize();
      const cropX = ref.cropBox.x * width;
      const cropY = (1 - (ref.cropBox.y + ref.cropBox.height)) * height;
      const cropW = ref.cropBox.width * width;
      const cropH = ref.cropBox.height * height;
      copied.setCropBox(cropX, cropY, cropW, cropH);
    }

    if (watermark?.text && watermarkFont) {
      const { width, height } = copied.getSize();
      const displayText = watermark.text
        .replace(/{n}/g, String(i + 1))
        .replace(/{total}/g, String(pages.length));

      const textWidth = watermarkFont.widthOfTextAtSize(displayText, watermark.fontSize);
      const textHeight = watermarkFont.heightAtSize(watermark.fontSize);

      const [vertical, horizontal] = watermark.position.split('-');

      const padding = 36; // 0.5 inch
      let x = padding;
      if (horizontal === 'center' || (vertical === 'center' && !horizontal)) {
        x = (width - textWidth) / 2;
      } else if (horizontal === 'right') {
        x = width - textWidth - padding;
      }

      let y = height - textHeight - padding;
      if (vertical === 'center') {
        y = (height - textHeight) / 2;
      } else if (vertical === 'bottom') {
        y = padding;
      }

      const hex = watermark.color.replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16) / 255;
      const g = parseInt(hex.substring(2, 4), 16) / 255;
      const b = parseInt(hex.substring(4, 6), 16) / 255;

      copied.drawText(displayText, {
        x,
        y,
        size: watermark.fontSize,
        font: watermarkFont,
        color: rgb(r, g, b),
        opacity: watermark.opacity,
        rotate: degrees(watermark.rotation)
      });
    }

    await drawStamps(outDoc, copied, stampsByPage.get(ref.key) ?? [], fontCache, imageCache);
  }

  if (nup) {
    return applyNUp(outDoc, nup, job);
  }

  return outDoc;
}

/* ------------------------------------------------------------------ *
 * Image inventory (CMP-01)
 * ------------------------------------------------------------------ */

function nameOf(value: unknown): string {
  if (value instanceof PDFName) return value.asString().replace(/^\//, '');
  if (value instanceof PDFArray) {
    const first = value.get(0);
    return first instanceof PDFName ? first.asString().replace(/^\//, '') : 'array';
  }
  return 'unknown';
}

function numberOf(dict: PDFDict, key: string, fallback: number): number {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFNumber ? value.asNumber() : fallback;
}

/** Which flavour of transparency an image carries — see `ImageFacts.maskKind`. */
function maskKindOf(smask: PDFStream | undefined, mask: unknown): ImageFacts['maskKind'] {
  if (smask) {
    return smask.dict.get(PDFName.of('Matte')) !== undefined ? 'preblended' : 'soft';
  }
  if (mask instanceof PDFArray) return 'colorKey';
  if (mask instanceof PDFStream) return 'soft';
  if (mask !== undefined) return 'colorKey';
  return 'none';
}

/* ------------------------------------------------------------------ *
 * Metadata (RED-04)
 * ------------------------------------------------------------------ */

const JS_KEYS = ['JavaScript', 'JS'] as const;

function catalogHas(doc: PDFDocument, key: string): boolean {
  return doc.catalog.get(PDFName.of(key)) !== undefined;
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

const api: ProcessJob = {
  async inspect(bytes) {
    // Inspection must be able to report on a file it cannot rewrite, so this is
    // the one place encryption is tolerated — read-only, and reported.
    const doc = await load(bytes, true);
    const form = doc.getForm();
    const isXfa = form.hasXFA();
    return {
      pageCount: doc.getPageCount(),
      isXfa,
      isEncrypted: doc.isEncrypted,
      hasAcroForm: !isXfa && form.getFields().length > 0,
      fieldCount: isXfa ? 0 : form.getFields().length
    };
  },

  async imageInventory(bytes, job) {
    const doc = await load(bytes, true);
    const pages = doc.getPages();
    const out: PageImageInventory[] = [];

    for (let i = 0; i < pages.length; i++) {
      await checkpoint(job, i / pages.length, `Inspecting page ${i + 1} of ${pages.length}`);
      const page = pages[i];
      const size = page.getSize();
      const images: ImageFacts[] = [];

      const resources = page.node.Resources();
      const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);

      if (xobjects) {
        for (const [key, value] of xobjects.entries()) {
          const ref = value instanceof PDFRef ? value : undefined;
          const stream = xobjects.lookup(key);
          if (!(stream instanceof PDFStream)) continue;
          const dict = stream.dict;
          if (nameOf(dict.get(PDFName.of('Subtype'))) !== 'Image') continue;

          const smask = dict.lookupMaybe(PDFName.of('SMask'), PDFStream);
          const mask = dict.lookup(PDFName.of('Mask'));
          const isImageMask = dict.lookup(PDFName.of('ImageMask')) === PDFBool.True;

          images.push({
            name: key.asString().replace(/^\//, ''),
            objectNumber: ref?.objectNumber ?? -1,
            width: numberOf(dict, 'Width', 0),
            height: numberOf(dict, 'Height', 0),
            // A stencil mask has no /BitsPerComponent of its own; it is 1 by
            // definition, and defaulting it to 8 would let a stencil through the
            // re-encode gate as if it were a photograph.
            bitsPerComponent: numberOf(dict, 'BitsPerComponent', isImageMask ? 1 : 8),
            colorSpace: nameOf(dict.get(PDFName.of('ColorSpace'))),
            filter: nameOf(dict.get(PDFName.of('Filter'))),
            hasSMask: dict.get(PDFName.of('SMask')) !== undefined,
            hasMask: dict.get(PDFName.of('Mask')) !== undefined,
            maskKind: maskKindOf(smask, mask),
            isImageMask,
            byteLength:
              stream instanceof PDFRawStream ? stream.contents.length : stream.sizeInBytes()
          });
        }
      }

      out.push({ pageIndex: i, images, width: size.width, height: size.height });
    }

    return out;
  },

  async getFormFields(bytes) {
    const doc = await load(bytes, true);
    const form = doc.getForm();
    if (form.hasXFA()) return { isXfa: true, fields: [] };

    const pages = doc.getPages();
    const fields: FormFieldData[] = [];

    for (const field of form.getFields()) {
      const kind = field.constructor.name;
      let type: FormFieldData['type'] = 'Unknown';
      let value: string | string[] | boolean = '';
      let options: string[] | undefined;

      // pdf-lib exposes value accessors only on the subclasses, and its exported
      // union type does not narrow by constructor name.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyField = field as any;
      if (kind === 'PDFTextField') {
        type = 'TextField';
        value = anyField.getText() ?? '';
      } else if (kind === 'PDFCheckBox') {
        type = 'CheckBox';
        value = anyField.isChecked();
      } else if (kind === 'PDFRadioGroup') {
        type = 'RadioGroup';
        value = anyField.getSelected() ?? '';
        options = anyField.getOptions();
      } else if (kind === 'PDFDropdown') {
        type = 'Dropdown';
        value = anyField.getSelected() ?? [];
        options = anyField.getOptions();
      } else if (kind === 'PDFOptionList') {
        type = 'OptionList';
        value = anyField.getSelected() ?? [];
        options = anyField.getOptions();
      }

      const rects: FormFieldData['rects'] = [];
      for (const widget of field.acroField.getWidgets()) {
        const pageRef = widget.P();
        const pageIndex = pageRef ? pages.findIndex(p => p.ref === pageRef) : -1;
        if (pageIndex < 0) continue;
        const rect = widget.getRectangle();
        const { width, height } = pages[pageIndex].getSize();
        rects.push({
          pageIndex,
          x: rect.x / width,
          y: 1 - (rect.y + rect.height) / height,
          width: rect.width / width,
          height: rect.height / height
        });
      }

      fields.push({
        name: field.getName(),
        type,
        value,
        options,
        isReadOnly: field.isReadOnly(),
        rects
      });
    }

    return { isXfa: false, fields };
  },

  async fillFormFields(bytes, values, flatten) {
    const doc = await load(bytes);
    const form = doc.getForm();
    if (form.hasXFA()) {
      throw unsupported(
        'This is an XFA form. Its fields live in an XML payload that pdf-lib cannot ' +
          'fill. Use the stamp tools to place text and signatures on top instead.'
      );
    }

    for (const [name, value] of Object.entries(values)) {
      const field = form.getFieldMaybe(name);
      if (!field) continue;
      const kind = field.constructor.name;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyField = field as any;
      if (kind === 'PDFTextField') anyField.setText(String(value));
      else if (kind === 'PDFCheckBox') {
        if (value) anyField.check();
        else anyField.uncheck();
      } else if (kind === 'PDFRadioGroup') anyField.select(String(value));
      else if (kind === 'PDFDropdown' || kind === 'PDFOptionList') {
        anyField.select(Array.isArray(value) ? value : [String(value)]);
      }
    }

    if (flatten) form.flatten();
    return transfer(await doc.save({ useObjectStreams: true }));
  },

  async compose(pages, sources, stamps, watermark, normalize, nup, job) {
    if (pages.length === 0) throw internal('Nothing to export: the page list is empty');
    const outDoc = await composePages(
      pages,
      sources,
      stamps,
      watermark,
      normalize,
      nup,
      job,
      'Composing page'
    );
    await checkpoint(job, 0.95, 'Writing file');
    return transfer(await outDoc.save({ useObjectStreams: true }));
  },

  async composeSplit(pages, sources, boundaries, stamps, watermark, normalize, nup, baseName, job) {
    if (pages.length === 0) throw internal('Nothing to export: the page list is empty');

    const cuts = [...new Set(boundaries)]
      .filter(b => Number.isInteger(b) && b > 0 && b < pages.length)
      .sort((a, b) => a - b);

    const slices: PageSource[][] = [];
    let from = 0;
    for (const cut of cuts) {
      slices.push(pages.slice(from, cut));
      from = cut;
    }
    slices.push(pages.slice(from));

    if (slices.length === 1) {
      const outDoc = await composePages(
        slices[0],
        sources,
        stamps,
        watermark,
        normalize,
        nup,
        job,
        'Composing page'
      );
      return {
        bytes: transfer(await outDoc.save({ useObjectStreams: true })),
        isZip: false,
        fileCount: 1
      };
    }

    const files: Record<string, Uint8Array> = {};
    const pad = Math.max(2, String(slices.length).length);
    for (let i = 0; i < slices.length; i++) {
      await checkpoint(job, i / slices.length, `Writing file ${i + 1} of ${slices.length}`);
      const outDoc = await composePages(
        slices[i],
        sources,
        stamps,
        watermark,
        normalize,
        nup,
        job,
        'Composing page'
      );
      files[`${baseName}-${String(i + 1).padStart(pad, '0')}.pdf`] = await outDoc.save({
        useObjectStreams: true
      });
    }

    await checkpoint(job, 0.95, 'Compressing archive');
    const zipped = zipSync(files);
    return { bytes: transfer(zipped), isZip: true, fileCount: slices.length };
  },

  async rebuildCompressed(bytes, rasterPages, replacedImages, job) {
    const source = await load(bytes);

    // Image replacement happens on the source document first: once the page's
    // /XObject entry points at the new stream, the old image is unreachable and
    // copyPages will not carry it into the output. Mutating and re-saving in
    // place would keep both copies, which is how "compression" grew files.
    const pages = source.getPages();

    // One replacement stream per *original* image, keyed by its object number.
    // A logo on ten pages is one object in the input, and embedding it once per
    // page would write ten copies of the same JPEG — a shared image has to stay
    // shared or the "compressed" file grows a tenfold image table.
    const embedded = new Map<number, PDFRef>();
    for (const [pageIndexKey, byName] of Object.entries(replacedImages)) {
      const pageIndex = Number(pageIndexKey);
      const page = pages[pageIndex];
      if (!page) continue;
      const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      if (!xobjects) continue;

      for (const [name, encoded] of Object.entries(byName)) {
        const key = PDFName.of(name);
        if (!xobjects.has(key)) continue;
        const oldRef = xobjects.get(key);
        if (!(oldRef instanceof PDFRef)) continue;

        const reused = embedded.get(oldRef.objectNumber);
        if (reused) {
          xobjects.set(key, reused);
          continue;
        }

        const oldStream = source.context.lookupMaybe(oldRef, PDFStream);
        if (!oldStream) continue;

        const smaskRef = oldStream.dict.get(PDFName.of('SMask'));
        const maskRef = oldStream.dict.get(PDFName.of('Mask'));

        // The replacement JPEG holds base colour only, so a mask that cannot be
        // carried across means the image would render opaque — the black box
        // this whole path exists to avoid. The classifier already refuses these,
        // and this is the second lock on the same door: leave the original.
        const carriable = (value: unknown) => value === undefined || value instanceof PDFRef;
        if (!carriable(smaskRef) || !carriable(maskRef)) continue;

        const image = await source.embedJpg(encoded.jpeg);
        // `embedJpg` only reserves a reference; the stream itself is written on
        // save. Forcing it now is what makes the object exist to hang the mask
        // off — without this the lookup below returns undefined and the mask is
        // quietly dropped.
        await image.embed();
        const newStream = source.context.lookup(image.ref);
        if (!(newStream instanceof PDFStream)) continue;

        let finalSmaskRef = smaskRef;
        if (smaskRef && encoded.maskBytes) {
          const smaskStream = source.context.flateStream(encoded.maskBytes, {
            Type: 'XObject',
            Subtype: 'Image',
            Width: encoded.width,
            Height: encoded.height,
            ColorSpace: 'DeviceGray',
            BitsPerComponent: 8
          });
          finalSmaskRef = source.context.register(smaskStream);
        }

        // Re-attached untouched (or updated): the mask keeps its own resolution, filter and
        // bytes, so only the colour data is ever rewritten, unless we explicitly resampled it.
        if (finalSmaskRef) newStream.dict.set(PDFName.of('SMask'), finalSmaskRef);
        if (maskRef) newStream.dict.set(PDFName.of('Mask'), maskRef);

        embedded.set(oldRef.objectNumber, image.ref);
        xobjects.set(key, image.ref);
      }
    }

    const out = await PDFDocument.create();
    const total = source.getPageCount();

    // Every kept page is copied in one call. pdf-lib builds a fresh object
    // copier per `copyPages` call, so copying page by page duplicates anything
    // the pages share — a logo on ten pages came out as ten identical JPEGs,
    // undoing the whole point of encoding it once.
    const kept: number[] = [];
    for (let i = 0; i < total; i++) if (!rasterPages[i]) kept.push(i);
    await checkpoint(job, 0.5, 'Rebuilding pages');
    const copies = await out.copyPages(source, kept);
    const copyByIndex = new Map(kept.map((pageIndex, at) => [pageIndex, copies[at]]));

    for (let i = 0; i < total; i++) {
      await checkpoint(job, 0.5 + (i / total) * 0.4, `Rebuilding page ${i + 1} of ${total}`);
      const raster = rasterPages[i];
      const copied = copyByIndex.get(i);
      if (raster) {
        // A rasterised page keeps its box and its /Rotate, so the output lines up
        // with what the grid showed.
        const original = pages[i];
        const { width, height } = original.getSize();
        const page = out.addPage([width, height]);
        page.setRotation(original.getRotation());
        const image = await out.embedJpg(raster);
        page.drawImage(image, { x: 0, y: 0, width, height });
      } else if (copied) {
        out.addPage(copied);
      }
    }

    await checkpoint(job, 0.95, 'Writing file');
    const rebuilt = await out.save({ useObjectStreams: true });

    // CMP-04: a "compressed" file that is not smaller is not saved. Returning the
    // original bytes is the only honest outcome.
    if (rebuilt.byteLength >= bytes.byteLength) {
      return { bytes: transfer(new Uint8Array(bytes)), keptOriginal: true };
    }
    return { bytes: transfer(rebuilt), keptOriginal: false };
  },

  async imagesToPdf(images, job) {
    const doc = await PDFDocument.create();
    for (let i = 0; i < images.length; i++) {
      await checkpoint(job, i / images.length, `Adding image ${i + 1} of ${images.length}`);
      // Images are normalised to JPEG before they reach the worker.
      const embedded = await doc.embedJpg(images[i]);
      const page = doc.addPage([embedded.width, embedded.height]);
      page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
    }
    return transfer(await doc.save({ useObjectStreams: true }));
  },

  async readMetadata(bytes) {
    const doc = await load(bytes, true);
    const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
    const asString = (value: string | undefined) => (value ? value : undefined);
    const asDate = (value: Date | undefined) => (value ? value.toISOString() : undefined);

    let hasAdditionalActions = false;
    let hasPageThumbnails = false;
    for (const page of doc.getPages()) {
      if (page.node.get(PDFName.of('AA')) !== undefined) hasAdditionalActions = true;
      if (page.node.get(PDFName.of('Thumb')) !== undefined) hasPageThumbnails = true;
    }

    let hasCustomInfo = false;
    const info = doc.context.lookupMaybe(doc.context.trailerInfo.Info, PDFDict);
    if (info) {
      for (const [key] of info.entries()) {
        const name = key.asString().replace(/^\//, '');
        if (
          ![
            'Title',
            'Author',
            'Subject',
            'Creator',
            'Producer',
            'CreationDate',
            'ModDate',
            'Keywords'
          ].includes(name)
        ) {
          hasCustomInfo = true;
          break;
        }
      }
    }

    return {
      title: asString(doc.getTitle()),
      author: asString(doc.getAuthor()),
      subject: asString(doc.getSubject()),
      creator: asString(doc.getCreator()),
      producer: asString(doc.getProducer()),
      creationDate: asDate(doc.getCreationDate()),
      modificationDate: asDate(doc.getModificationDate()),
      keywords: asString(doc.getKeywords()),
      hasXmp: catalogHas(doc, 'Metadata'),
      hasEmbeddedJavaScript:
        JS_KEYS.some(k => names?.get(PDFName.of(k)) !== undefined) ||
        doc.context
          .enumerateIndirectObjects()
          .some(([, obj]) => obj instanceof PDFDict && isJavaScriptAction(obj)),
      hasOpenAction: catalogHas(doc, 'OpenAction'),
      hasAdditionalActions: hasAdditionalActions || catalogHas(doc, 'AA'),
      hasEmbeddedFiles: names?.get(PDFName.of('EmbeddedFiles')) !== undefined,
      hasPageThumbnails,
      hasOptionalContent: catalogHas(doc, 'OCProperties'),
      hasCustomInfo
    };
  },

  async scrubMetadata(bytes, settings) {
    const doc = await load(bytes);

    const s = settings || {
      title: true,
      author: true,
      subject: true,
      creator: true,
      producer: true,
      creationDate: true,
      modificationDate: true,
      keywords: true,
      hasXmp: true,
      hasEmbeddedJavaScript: true,
      hasOpenAction: true,
      hasAdditionalActions: true,
      hasEmbeddedFiles: true,
      hasPageThumbnails: true,
      hasOptionalContent: true,
      customInfo: true
    };

    const info = doc.context.lookupMaybe(doc.context.trailerInfo.Info, PDFDict);
    if (info) {
      for (const [key] of info.entries()) {
        const name = key.asString().replace(/^\//, '');
        const isStandard = [
          'Title',
          'Author',
          'Subject',
          'Creator',
          'Producer',
          'Keywords',
          'CreationDate',
          'ModDate'
        ].includes(name);

        if (name === 'Title' && s.title) info.delete(key);
        else if (name === 'Author' && s.author) info.delete(key);
        else if (name === 'Subject' && s.subject) info.delete(key);
        else if (name === 'Creator' && s.creator) info.delete(key);
        else if (name === 'Producer' && s.producer) info.delete(key);
        else if (name === 'Keywords' && s.keywords) info.delete(key);
        else if (name === 'CreationDate' && s.creationDate) info.delete(key);
        else if (name === 'ModDate' && s.modificationDate) info.delete(key);
        else if (!isStandard && s.customInfo) info.delete(key);
      }
    }

    if (s.hasXmp) doc.catalog.delete(PDFName.of('Metadata'));
    doc.catalog.delete(PDFName.of('PieceInfo'));
    if (s.hasOpenAction) doc.catalog.delete(PDFName.of('OpenAction'));
    if (s.hasAdditionalActions) doc.catalog.delete(PDFName.of('AA'));
    if (s.hasOptionalContent) doc.catalog.delete(PDFName.of('OCProperties'));

    const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
    if (names) {
      if (s.hasEmbeddedJavaScript) {
        for (const key of JS_KEYS) names.delete(PDFName.of(key));
      }
      if (s.hasEmbeddedFiles) names.delete(PDFName.of('EmbeddedFiles'));
    }

    for (const page of doc.getPages()) {
      if (s.hasPageThumbnails) page.node.delete(PDFName.of('Thumb'));
      page.node.delete(PDFName.of('PieceInfo'));
      if (s.hasAdditionalActions) page.node.delete(PDFName.of('AA'));
      if (s.hasXmp) page.node.delete(PDFName.of('Metadata'));
    }

    if (s.hasEmbeddedJavaScript) {
      for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        if (obj instanceof PDFDict && isJavaScriptAction(obj)) doc.context.delete(ref);
      }
    }

    const out = await PDFDocument.create();
    const copied = await out.copyPages(doc, doc.getPageIndices());
    for (const page of copied) out.addPage(page);

    const outInfo =
      out.context.lookup(out.context.trailerInfo.Info, PDFDict) || out.context.obj({});
    if (!out.context.lookupMaybe(out.context.trailerInfo.Info, PDFDict)) {
      out.context.trailerInfo.Info = out.context.register(outInfo);
    }

    if (info) {
      for (const [key, val] of info.entries()) {
        outInfo.set(key, val);
      }
    }

    return transfer(await out.save({ useObjectStreams: true }));
  },

  async applyRedactions(bytes, regions, job) {
    const source = await load(bytes);
    const sourcePages = source.getPages();
    const regionsByPage = new Map<number, RedactionRegion[]>();
    for (const region of regions) {
      const list = regionsByPage.get(region.pageIndex);
      if (list) list.push(region);
      else regionsByPage.set(region.pageIndex, [region]);
    }

    const out = await PDFDocument.create();
    const total = sourcePages.length;

    for (let i = 0; i < total; i++) {
      await checkpoint(job, i / total, `Redacting page ${i + 1} of ${total}`);

      if (!regionsByPage.has(i)) {
        const [copied] = await out.copyPages(source, [i]);
        out.addPage(copied);
        continue;
      }

      // 1. Copy the page
      const [copied] = await out.copyPages(source, [i]);
      out.addPage(copied);

      // 2. Perform operator-level content removal
      if (regionsByPage.has(i)) {
        const regions = regionsByPage.get(i)!;
        const { width, height } = copied.getSize();

        // Convert regions from normalized to PDF coordinates (bottom-left origin)
        const rects: Rect[] = regions.map(r => ({
          x: r.x * width,
          y: height - r.y * height - r.height * height,
          width: r.width * width,
          height: r.height * height
        }));

        // /Contents may be a single stream reference or an array of streams
        // (common in documents assembled by Adobe Acrobat or LibreOffice). The
        // previous code only filtered get(0), silently leaving all other streams
        // intact — a bypass. Collect every stream, filter each, then collapse
        // them into one new FlateDecode stream so the output is always a scalar.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawContents: any = copied.node.Contents();
        const streamRefs: unknown[] = [];
        if (rawContents) {
          if (rawContents.constructor.name === 'PDFArray') {
            for (let k = 0; k < rawContents.size(); k++) {
              streamRefs.push(rawContents.get(k));
            }
          } else {
            streamRefs.push(rawContents);
          }
        }

        if (streamRefs.length > 0) {
          const filteredChunks: Uint8Array[] = [];

          for (const ref of streamRefs) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const stream: any = source.context.lookup(ref as never);
            if (
              !stream ||
              (stream.constructor.name !== 'PDFRawStream' &&
                stream.constructor.name !== 'PDFStream')
            ) {
              continue;
            }

            let rawBytes: Uint8Array = stream.getContents ? stream.getContents() : stream.contents;

            // Decompress if needed. decodeStream tries both zlib-wrapped and
            // raw-deflate and throws on anything else — we propagate the error
            // rather than silently filtering compressed bytes (Bug 1).
            const filter = stream.dict.get(PDFName.of('Filter'));
            const isFlate =
              filter === PDFName.of('FlateDecode') ||
              (filter instanceof PDFArray && filter.get(0) === PDFName.of('FlateDecode'));
            if (isFlate) {
              rawBytes = await decodeStream(rawBytes);
            }

            const tokens = tokenizeContentStream(rawBytes);
            const statements = parseContentStream(tokens);
            const filtered = filterContentStream(statements, rects);
            filteredChunks.push(serializeStatements(filtered));
          }

          if (filteredChunks.length > 0) {
            // Merge all filtered chunks separated by a newline and write a
            // single FlateDecode stream, which is always valid.
            let totalLen = 0;
            for (const c of filteredChunks) totalLen += c.length + 1;
            const merged = new Uint8Array(totalLen);
            let pos = 0;
            for (const c of filteredChunks) {
              merged.set(c, pos);
              pos += c.length;
              merged[pos++] = 0x0a;
            }
            const newStream = out.context.flateStream(merged.slice(0, pos));
            copied.node.set(PDFName.of('Contents'), out.context.register(newStream));
          }
        }
      }

      // 3. Draw the opaque marks on top as well, so the redaction is unmistakable
      // even if the raster were somehow produced without them.
      for (const region of regionsByPage.get(i) ?? []) {
        const { width, height } = copied.getSize();
        copied.drawRectangle({
          x: region.x * width,
          y: height - region.y * height - region.height * height,
          width: region.width * width,
          height: region.height * height,
          color: DOC_REDACT,
          borderWidth: 0
        });
      }
    }

    await checkpoint(job, 0.95, 'Writing file');
    return transfer(await out.save({ useObjectStreams: true }));
  }
};

function isJavaScriptAction(dict: PDFDict): boolean {
  const type = dict.get(PDFName.of('Type'));
  const action = dict.get(PDFName.of('S'));
  const isAction = type === undefined || type === PDFName.of('Action');
  return isAction && action === PDFName.of('JavaScript');
}

Comlink.expose(api);
export const processWorkerImpl = api;

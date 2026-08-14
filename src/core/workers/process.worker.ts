/** A user-supplied raster for an image watermark, resolved to bytes by the caller. */
export interface WatermarkImageData {
  bytes: Uint8Array;
  format: 'png' | 'jpeg';
  /** Natural pixel dimensions, so the placed box keeps the image's aspect ratio. */
  width: number;
  height: number;
}

export interface WatermarkData {
  /** `image` draws `image` instead of `text` — the two are mutually exclusive. */
  kind: 'text' | 'image';
  text: string;
  image?: WatermarkImageData;
  /** Fraction of the page width the image should occupy (kind: 'image' only). */
  imageScale: number;
  position: string;
  opacity: number;
  rotation: number;
  fontSize: number;
  color: string;
  startAt: number;
  pageRange: string;
}

/**
 * A running header and/or footer, distinct from `WatermarkData`: fixed to the
 * top/bottom margin band, never rotated, and independently page-range targeted.
 */
export interface HeaderFooterData {
  headerText: string;
  headerAlign: 'left' | 'center' | 'right';
  footerText: string;
  footerAlign: 'left' | 'center' | 'right';
  fontSize: number;
  pageRange: string;
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
  PDFButton,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFNumber,
  PDFObjectCopier,
  PDFOptionList,
  PDFPage,
  PDFRadioGroup,
  PDFRawStream,
  PDFRef,
  PDFSignature,
  PDFStream,
  PDFString,
  PDFHexString,
  PDFTextField,
  degrees,
  StandardFonts,
  rgb
} from 'pdf-lib';
import type { PDFField, PDFImage, PDFContext } from 'pdf-lib';
import { zipSync } from 'fflate';
import type { JobHandle } from './protocol';
import { checkpoint } from './protocol';
import { corrupt, encrypted, internal, unsupported } from '../errors';
import type { ImagesToPdfOptions } from '../operations';
import { DOC_HAIRLINE_RGB, DOC_INK_RGB, DOC_REDACT_RGB } from '../doc-colors';
import { markdownToPdfBytes } from '../markdown-to-pdf';
import { normalizeRotation } from '../rotation';
import {
  tokenizeContentStream,
  parseContentStream,
  filterContentStream,
  serializeStatements,
  decodeStream
} from '../pdf/interpreter';
import type { Rect, GraphicsState, Matrix } from '../pdf/interpreter';
import { hasXfaMarker, XFA_MESSAGE } from '../pdf/xfa';
import { encryptPdf, type ProtectionSettings } from '../pdf/encrypt';

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

export interface AnnotationSource {
  pageKey: string;
  type: 'freehand' | 'highlight' | 'rectangle' | 'text' | 'sticky' | 'whiteout';
  color: string;
  strokeWidth: number;
  points?: { x: number; y: number }[];
  rect?: { x: number; y: number; width: number; height: number };
  text?: string;
  fontSize?: number;
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
  /**
   * The *image-defining* filter, e.g. `DCTDecode`, `JPXDecode`, `JBIG2Decode` —
   * the last entry of a `/Filter` chain, since filters apply in order and it is
   * the final one that produces the image samples.
   */
  filter: string;
  /**
   * Every filter in the chain, in application order. `/Filter` is legally an
   * array (`[/ASCII85Decode /JPXDecode]` is what several producers emit), and
   * reading only its head reported such an image as `ASCII85Decode` — a name no
   * skip list matches, so a JPX image behind an ASCII85 wrapper was classified
   * as an ordinary re-encode candidate. Safety checks test the whole chain.
   *
   * Optional only so a hand-built `ImageFacts` still type-checks; the inventory
   * always fills it in.
   */
  filters?: string[];
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

/**
 * A filesystem path found in the document, with the scrub category that removes it.
 * A Windows user path (`C:\Users\…`) is the single most common accidental disclosure
 * in a PDF and it hides in several places at once — the Producer string, a custom
 * Info key a Word plugin wrote, and the XMP packet — so the inspector has to name
 * *where* it found each one, otherwise the user cannot tell which toggle clears it.
 */
export interface MetadataPathFinding {
  /** Human-readable source, e.g. `Producer` or `SourceFile (custom property)`. */
  source: string;
  value: string;
  /** The `ScrubSettings` key whose removal takes this path with it. */
  settingKey: keyof ScrubSettings;
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
  /** Every non-standard Info dictionary entry, with its value, so it can be shown. */
  customInfo: { key: string; value: string }[];
  /** Filesystem paths found anywhere in the metadata (Info values and the XMP packet). */
  filesystemPaths: MetadataPathFinding[];
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
    headerFooter?: HeaderFooterData,
    normalize?: import('../../ui/tools/normalize/state').NormalizeSettings | null,
    nup?: import('../../ui/tools/nup/state').NUpSettings | null,
    annotations?: AnnotationSource[],
    job?: JobHandle
  ): Promise<Uint8Array>;
  composeSplit(
    pages: PageSource[],
    sources: Record<string, Uint8Array>,
    boundaries: number[],
    stamps: StampSource[],
    watermark?: WatermarkData,
    headerFooter?: HeaderFooterData,
    normalize?: import('../../ui/tools/normalize/state').NormalizeSettings | null,
    nup?: import('../../ui/tools/nup/state').NUpSettings | null,
    baseName?: string,
    annotations?: AnnotationSource[],
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
      Record<number, { jpeg: Uint8Array; width: number; height: number; maskBytes?: Uint8Array }>
    >,
    job?: JobHandle
  ): Promise<{ bytes: Uint8Array; keptOriginal: boolean }>;
  imagesToPdf(
    images: Uint8Array[],
    options?: ImagesToPdfOptions,
    job?: JobHandle
  ): Promise<Uint8Array>;
  markdownToPdf(markdown: string): Promise<Uint8Array>;
  readMetadata(bytes: Uint8Array): Promise<MetadataFindings>;
  scrubMetadata(bytes: Uint8Array, settings?: ScrubSettings): Promise<Uint8Array>;
  /**
   * RED-06 — encrypts the *exported* bytes. The document in the workspace is
   * never touched; this runs on the copy that is about to be written to disk.
   */
  protectDocument(bytes: Uint8Array, settings: ProtectionSettings): Promise<Uint8Array>;
  /**
   * Applies redactions through operator-level content removal, removing intersecting text
   * and image objects from the content stream while keeping the rest of the page selectable.
   */
  applyRedactions(
    bytes: Uint8Array,
    regions: RedactionRegion[],
    job?: JobHandle
  ): Promise<Uint8Array>;
  /**
   * RED-03's string-level check re-extracts pdf.js *page text* only, which never
   * sees annotation `/Contents` (sticky notes, comments) or AcroForm field `/V`
   * values — so a copy of a redacted string quoted in a comment on another page
   * passed verification untouched. Returns every such string found anywhere in
   * the document so the caller can fold them into the same whole-document check.
   */
  collectOffPageText(bytes: Uint8Array): Promise<string[]>;
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

/**
 * `toWinAnsi`, but refusing outright instead of silently drawing `?` — shared by
 * the watermark and header/footer text paths so a document with characters the
 * built-in font cannot write is never half-corrupted into export.
 */
function toWinAnsiOrThrow(text: string, context: string): string {
  const { text: out, lostCharacters } = toWinAnsi(text);
  if (lostCharacters) {
    throw unsupported(
      `This ${context} contains characters that the built-in PDF font cannot write. ` +
        'Use Latin text, or remove the unsupported characters before exporting.'
    );
  }
  return out;
}

/**
 * Given a box's center and its (unrotated) width/height, returns the bottom-left
 * origin such that rotating the box by `angleDegrees` about that origin — as
 * pdf-lib's `rotate` draw option does — leaves the box's center fixed at
 * `(cx, cy)`. Shared by `drawStamps` (stamp rotation) and the image watermark,
 * which both need a box to spin in place rather than around its bottom-left
 * corner.
 */
function centerPreservingOrigin(
  cx: number,
  cy: number,
  w: number,
  h: number,
  angleDegrees: number
): { x: number; y: number } {
  const rad = (angleDegrees * Math.PI) / 180;
  const dx = (w / 2) * Math.cos(rad) - (h / 2) * Math.sin(rad);
  const dy = (w / 2) * Math.sin(rad) + (h / 2) * Math.cos(rad);
  return { x: cx - dx, y: cy - dy };
}

async function drawStamps(
  outDoc: PDFDocument,
  page: ReturnType<PDFDocument['addPage']>,
  stamps: StampSource[],
  fontCache: { font?: Awaited<ReturnType<PDFDocument['embedFont']>> },
  imageCache: Map<string, PDFImage>
) {
  if (stamps.length === 0) return;
  // `page.getSize()` is always the raw, unrotated MediaBox — pdf-lib never factors
  // in `/Rotate` there. Stamp coordinates come from the sign UI, which places them
  // against the page as pdf.js *displays* it, i.e. already rotated. On a page whose
  // total rotation (source + the rotate tool) is 90 or 270, treating those two
  // frames as the same one put every stamp at a transposed, wrong-sized position.
  const { width, height } = page.getSize();
  const pageRotation = normalizeRotation(page.getRotation().angle);
  const swapped = pageRotation === 90 || pageRotation === 270;
  const displayWidth = swapped ? height : width;
  const displayHeight = swapped ? width : height;

  for (const stamp of stamps) {
    // PDF space is bottom-left origin; stamp coordinates are top-left, both in the
    // *displayed* (post-rotation) frame.
    const w = stamp.width * displayWidth;
    const h = stamp.height * displayHeight;
    const displayCenterX = stamp.x * displayWidth + w / 2;
    const displayCenterY = stamp.y * displayHeight + h / 2;

    // Map that display-space center back into the page's own unrotated content
    // space — the inverse of the four `/Rotate` cases pdf.js's PageViewport
    // applies (viewBox width/height, not the swapped display ones).
    let cx: number, cy: number;
    switch (pageRotation) {
      case 90:
        cx = displayCenterY;
        cy = displayCenterX;
        break;
      case 180:
        cx = width - displayCenterX;
        cy = displayCenterY;
        break;
      case 270:
        cx = width - displayCenterY;
        cy = height - displayCenterX;
        break;
      default:
        cx = displayCenterX;
        cy = height - displayCenterY;
    }

    const rot = stamp.rotation ?? 0;

    // The user's clockwise on-screen rotation `rot` must survive the page's own
    // display rotation too: content drawn at angle (pageRotation - rot) here comes
    // out as a clockwise `rot` once the viewer applies /Rotate on top of it. This
    // reduces to the original `-rot` when pageRotation is 0.
    const rad = ((pageRotation - rot) * Math.PI) / 180;

    // The new bottom-left origin in page space such that the center of the
    // rotated box remains at (cx, cy).
    const { x: drawX, y: drawY } = centerPreservingOrigin(cx, cy, w, h, pageRotation - rot);

    if (stamp.type === 'signature') {
      if (!stamp.imagePng) continue;
      // An identical signature placed on 20 pages must embed one image object.
      const key = fingerprintBytes(stamp.imagePng);
      let image = imageCache.get(key);
      if (!image) {
        image = await outDoc.embedPng(stamp.imagePng);
        imageCache.set(key, image);
      }
      page.drawImage(image, {
        x: drawX,
        y: drawY,
        width: w,
        height: h,
        rotate: degrees(pageRotation - rot)
      });
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

    // Use the strict encoder: if the stamp text contains glyphs outside WinAnsi
    // (e.g. Arabic or CJK characters from a localised date format), throw rather
    // than silently drawing '???' on the page. The caller's per-file try/catch in
    // compose() will surface this as a job error the user can action.
    const text = toWinAnsiOrThrow(raw, 'stamp');
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
      rotate: degrees(pageRotation - rot)
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

  // Imposition must be sized from every source page, not page 1. A Letter cover
  // followed by an A3 appendix previously scaled the appendix to a Letter-sized
  // cell and clipped its CropBox. The CropBox is also the printed page boundary:
  // embedding the MediaBox leaks margins that the user explicitly cropped away.
  let W = 0;
  let H = 0;
  for (const original of originalPages) {
    const crop = original.getCropBox();
    W = Math.max(W, crop.width, crop.height);
    H = Math.max(H, Math.min(crop.width, crop.height));
  }

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
        const crop = original.getCropBox();
        const embedded = await finalDoc.embedPage(original, {
          left: crop.x,
          bottom: crop.y,
          right: crop.x + crop.width,
          top: crop.y + crop.height
        });

        // embedPage's XObject carries only the content stream + CropBox — pdf-lib
        // never bakes /Rotate into it (see PDFPageEmbedder). Without reproducing the
        // rotation ourselves here, a rotated source page lands sideways in its cell.
        const rotationDeg = normalizeRotation(original.getRotation().angle);
        const swapped = rotationDeg === 90 || rotationDeg === 270;
        const visualW = swapped ? embedded.height : embedded.width;
        const visualH = swapped ? embedded.width : embedded.height;

        const scale = Math.min(cellW / visualW, cellH / visualH);
        const actualVisualW = visualW * scale;
        const actualVisualH = visualH * scale;
        const unrotW = embedded.width * scale;
        const unrotH = embedded.height * scale;

        // Center of the cell, in sheet coordinates (Y=0 at the bottom; row 0 is top).
        const cx = margin + c * (cellW + gutter) + cellW / 2;
        const cy = sheetH - margin - r * (cellH + gutter) - cellH / 2;

        // drawPage rotates its unrotated content about (x, y); solve for the origin
        // that keeps the rotated box centered on the cell, same trick as drawStamps.
        const rad = (-rotationDeg * Math.PI) / 180;
        const dx = (unrotW / 2) * Math.cos(rad) - (unrotH / 2) * Math.sin(rad);
        const dy = (unrotW / 2) * Math.sin(rad) + (unrotH / 2) * Math.cos(rad);
        const x = cx - dx;
        const y = cy - dy;

        sheet.drawPage(embedded, {
          x,
          y,
          width: unrotW,
          height: unrotH,
          rotate: degrees(-rotationDeg)
        });

        if (drawBorders) {
          sheet.drawRectangle({
            x: cx - actualVisualW / 2,
            y: cy - actualVisualH / 2,
            width: actualVisualW,
            height: actualVisualH,
            borderWidth: 1,
            borderColor: rgb(...DOC_HAIRLINE_RGB)
          });
        }
      }
    }
  }

  return finalDoc;
}

/* ------------------------------------------------------------------ *
 * AcroForm survival across a compose (SGN-03)
 * ------------------------------------------------------------------ */

/** Keys that belong to the *field*, and are inherited by its widget kids. */
const FIELD_KEYS = ['T', 'TU', 'TM', 'FT', 'Ff', 'V', 'DV', 'Q', 'MaxLen', 'Opt', 'AA'] as const;

function acroFormDictOf(doc: PDFDocument): PDFDict | undefined {
  return doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
}

function textOf(value: unknown): string | undefined {
  // PDFString and PDFHexString both expose decodeText(); neither is exported as a
  // common base, so this is duck-typed rather than instanceof-checked.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyValue = value as any;
  return typeof anyValue?.decodeText === 'function' ? String(anyValue.decodeText()) : undefined;
}

/** Walks /Parent to the top of a field chain, returning the outermost ref. */
function fieldRootRef(doc: PDFDocument, widgetRef: PDFRef, widget: PDFDict): PDFRef {
  let rootRef = widgetRef;
  let dict = widget;
  const seen = new Set<string>([widgetRef.toString()]);
  for (;;) {
    const parent = dict.get(PDFName.of('Parent'));
    if (!(parent instanceof PDFRef) || seen.has(parent.toString())) return rootRef;
    const parentDict = doc.context.lookupMaybe(parent, PDFDict);
    if (!parentDict) return rootRef;
    seen.add(parent.toString());
    rootRef = parent;
    dict = parentDict;
  }
}

/**
 * Makes `ref` a pure widget under a freshly created field parent, moving the
 * inherited field keys up. Needed when two copies of the same field must become
 * two widgets of one field: a field that has /Kids may not itself be a widget.
 */
function splitTerminalField(doc: PDFDocument, ref: PDFRef, dict: PDFDict): PDFRef {
  const parent = doc.context.obj({}) as PDFDict;
  for (const key of FIELD_KEYS) {
    const name = PDFName.of(key);
    const value = dict.get(name);
    if (value === undefined) continue;
    parent.set(name, value);
    // /FT and /V must live on exactly one node or a viewer may read a stale copy.
    dict.delete(name);
  }
  const parentRef = doc.context.register(parent);
  parent.set(PDFName.of('Kids'), doc.context.obj([ref]) as PDFArray);
  dict.set(PDFName.of('Parent'), parentRef);
  return parentRef;
}

/**
 * The *field* kids of a field node. A field node's `/Kids` may hold either child
 * fields or widget annotations; a child field carries `/T` (its partial name),
 * a widget does not.
 */
function childFieldsOf(
  doc: PDFDocument,
  dict: PDFDict
): { ref: PDFRef; dict: PDFDict; name: string }[] {
  const kids = dict.lookupMaybe(PDFName.of('Kids'), PDFArray);
  if (!kids) return [];
  const out: { ref: PDFRef; dict: PDFDict; name: string }[] = [];
  for (let i = 0; i < kids.size(); i++) {
    const ref = kids.get(i);
    if (!(ref instanceof PDFRef)) continue;
    const kid = doc.context.lookupMaybe(ref, PDFDict);
    if (!kid) continue;
    const name = textOf(kid.get(PDFName.of('T')));
    if (name === undefined) continue; // a widget, not a field
    out.push({ ref, dict: kid, name });
  }
  return out;
}

/** Ensures `ref`/`dict` is a node that can host `/Kids`, returning the host ref. */
function hostForKids(doc: PDFDocument, ref: PDFRef, dict: PDFDict): PDFRef {
  if (dict.lookupMaybe(PDFName.of('Kids'), PDFArray)) return ref;
  // A dict that is both field and widget cannot take kids; split it so the field
  // half can. Otherwise it is simply a field with no kids yet.
  if (nameOf(dict.get(PDFName.of('Subtype'))) === 'Widget') {
    return splitTerminalField(doc, ref, dict);
  }
  dict.set(PDFName.of('Kids'), doc.context.obj([]) as PDFArray);
  return ref;
}

/**
 * Merges `dupRef` into `keepRef` — two field nodes at the same depth carrying the
 * same partial name, so by definition the same field.
 *
 * Moving every kid across in one step is not enough, and that shortcut is how a
 * hierarchical field name survived a compose twice. pdf-lib names a field by
 * joining the `/T` of every node from the root down, so `name.first` is two nodes
 * deep. Deduping only at the root leaves one `name` node with two `first` kids —
 * two terminal fields with an identical fully-qualified name, which is exactly the
 * state where filling by name reaches one of them and drops the other's value
 * without saying so. The merge therefore recurses to the terminal node, where the
 * two nodes' widget annotations finally combine into one field with two widgets.
 */
function mergeFieldNode(doc: PDFDocument, keepRef: PDFRef, dupRef: PDFRef): void {
  const keep = doc.context.lookupMaybe(keepRef, PDFDict);
  const dup = doc.context.lookupMaybe(dupRef, PDFDict);
  if (!keep || !dup) return;

  const dupChildren = childFieldsOf(doc, dup);
  if (dupChildren.length === 0) {
    mergeTerminalWidgets(doc, keepRef, dupRef);
    return;
  }

  const byName = new Map<string, PDFRef>();
  for (const child of childFieldsOf(doc, keep)) byName.set(child.name, child.ref);

  const hostRef = hostForKids(doc, keepRef, keep);
  const host = doc.context.lookup(hostRef, PDFDict);
  const hostKids = host.lookupMaybe(PDFName.of('Kids'), PDFArray);
  if (!hostKids) return;

  for (const child of dupChildren) {
    const existing = byName.get(child.name);
    if (existing) {
      mergeFieldNode(doc, existing, child.ref);
      continue;
    }
    hostKids.push(child.ref);
    child.dict.set(PDFName.of('Parent'), hostRef);
    byName.set(child.name, child.ref);
  }
}

/** Moves every widget under `dupRef`'s terminal field into `keepRef`'s field. */
function mergeTerminalWidgets(doc: PDFDocument, keepRef: PDFRef, dupRef: PDFRef): void {
  const keep = doc.context.lookupMaybe(keepRef, PDFDict);
  const dup = doc.context.lookupMaybe(dupRef, PDFDict);
  if (!keep || !dup) return;

  const kidsToMove: PDFRef[] = [];
  const dupKids = dup.lookupMaybe(PDFName.of('Kids'), PDFArray);
  if (dupKids) {
    for (let i = 0; i < dupKids.size(); i++) {
      const kid = dupKids.get(i);
      if (kid instanceof PDFRef) kidsToMove.push(kid);
    }
  } else {
    // The duplicate is a merged field+widget dict: it becomes a widget kid, so
    // the field keys it carries must not stay behind to shadow the survivor's.
    for (const key of FIELD_KEYS) dup.delete(PDFName.of(key));
    kidsToMove.push(dupRef);
  }
  if (kidsToMove.length === 0) return;

  let keepKids = keep.lookupMaybe(PDFName.of('Kids'), PDFArray);
  if (!keepKids) {
    // The survivor is a merged field+widget dict too, so it cannot host kids.
    const splitRef = splitTerminalField(doc, keepRef, keep);
    const split = doc.context.lookup(splitRef, PDFDict);
    keepKids = split.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (!keepKids) return;
    keepRef = splitRef;
  }
  for (const kid of kidsToMove) {
    keepKids.push(kid);
    doc.context.lookupMaybe(kid, PDFDict)?.set(PDFName.of('Parent'), keepRef);
  }
}

/**
 * Rebuilds `/AcroForm` on a composed document.
 *
 * `copyPages` copies each page's `/Annots`, so widget annotations and their
 * `/Parent` field dicts do survive a compose — but `/AcroForm` lives in the
 * *catalog*, which is not copied, and every copied widget's `/P` still points at
 * the source page object. The result is a document whose fields are invisible to
 * every consumer: `getForm().getFields()` returns `[]`, so filling it afterwards
 * matched nothing and threw the user's typed values away while reporting success.
 * That is the SGN-03 data-loss bug.
 *
 * This walks the composed pages, re-points each widget's `/P`, collects the field
 * roots into a fresh `/Fields`, and copies the source form's `/DA`/`/DR` across so
 * appearance generation still has its default font resources.
 *
 * XFA is never carried: a composed document is a new page tree, and the XML
 * payload's page references would no longer mean anything. Callers detect XFA up
 * front and refuse (see `core/pdf/xfa.ts`), so reaching here with one is already
 * a refusal path.
 */
/**
 * OPS-01 — bookmark (outline) preservation.
 *
 * pdf-lib has no outline API at all, so this walks the raw `/Outlines` tree by
 * hand. Deliberately narrow: only a direct page-reference destination (the
 * common case pdf-lib itself and most authoring tools produce) is followed —
 * a named destination (resolved through `/Root/Names/Dests`, a name tree) or
 * any action other than a plain `/GoTo` is left out rather than guessed at. A
 * bookmark whose page was not copied into this output (extracted away, or a
 * source that contributed no pages) is dropped, not guessed at either. An
 * item with no resolvable destination but retained children is kept as a
 * bare heading, since dropping it would silently flatten the outline's
 * grouping structure.
 */
interface RetainedOutlineItem {
  title: string;
  destPageRef?: PDFRef;
  children: RetainedOutlineItem[];
}

/** Every page's object number to its index within `doc`, for /Dest resolution. */
function pageRefIndex(doc: PDFDocument): Map<number, number> {
  const map = new Map<number, number>();
  doc.getPages().forEach((page, i) => map.set(page.ref.objectNumber, i));
  return map;
}

/** Resolves an outline item's destination to a source page index, if it can. */
function resolveDestPageIndex(item: PDFDict, refIndex: Map<number, number>): number | undefined {
  let dest = item.lookup(PDFName.of('Dest'));
  if (dest === undefined) {
    const action = item.lookupMaybe(PDFName.of('A'), PDFDict);
    if (action && nameOf(action.get(PDFName.of('S'))) === 'GoTo') {
      dest = action.lookup(PDFName.of('D'));
    }
  }
  if (!(dest instanceof PDFArray) || dest.size() === 0) return undefined;
  const target = dest.get(0);
  if (!(target instanceof PDFRef)) return undefined; // named destination — not resolved here
  return refIndex.get(target.objectNumber);
}

/** Walks one level of `/First`→`/Next` siblings under `parent`, recursing into each's own children. */
function walkSourceOutline(
  parent: PDFDict,
  refIndex: Map<number, number>,
  pageRefMap: Map<string, PDFRef>,
  sourceDocId: string,
  visited: Set<PDFDict>
): RetainedOutlineItem[] {
  const result: RetainedOutlineItem[] = [];
  let cur = parent.lookupMaybe(PDFName.of('First'), PDFDict);
  while (cur && !visited.has(cur)) {
    visited.add(cur);
    const titleValue = cur.lookup(PDFName.of('Title'));
    const title =
      titleValue instanceof PDFString || titleValue instanceof PDFHexString
        ? titleValue.decodeText()
        : 'Untitled';
    const sourceIndex = resolveDestPageIndex(cur, refIndex);
    const destPageRef =
      sourceIndex !== undefined ? pageRefMap.get(`${sourceDocId}:${sourceIndex}`) : undefined;
    const children = walkSourceOutline(cur, refIndex, pageRefMap, sourceDocId, visited);
    if (destPageRef || children.length > 0) {
      result.push({ title, destPageRef, children });
    }
    cur = cur.lookupMaybe(PDFName.of('Next'), PDFDict);
  }
  return result;
}

/** Registers `items` as a `/First`↔`/Next`↔`/Last` sibling chain under `parentRef`. Returns the total item count for `/Count`. */
function registerOutlineSiblings(
  ctx: PDFContext,
  items: RetainedOutlineItem[],
  parentRef: PDFRef
): { firstRef?: PDFRef; lastRef?: PDFRef; count: number } {
  let firstRef: PDFRef | undefined;
  let lastRef: PDFRef | undefined;
  let prevRef: PDFRef | undefined;
  let count = 0;

  for (const item of items) {
    const dict = ctx.obj({ Title: PDFString.of(item.title), Parent: parentRef }) as PDFDict;
    if (item.destPageRef) {
      dict.set(PDFName.of('Dest'), ctx.obj([item.destPageRef, PDFName.of('Fit')]));
    }
    const ref = ctx.register(dict);
    if (!firstRef) firstRef = ref;
    if (prevRef) {
      ctx.lookup(prevRef, PDFDict).set(PDFName.of('Next'), ref);
      dict.set(PDFName.of('Prev'), prevRef);
    }
    lastRef = ref;
    prevRef = ref;
    count += 1;

    const kids = registerOutlineSiblings(ctx, item.children, ref);
    if (kids.firstRef) {
      dict.set(PDFName.of('First'), kids.firstRef);
      dict.set(PDFName.of('Last'), kids.lastRef!);
      dict.set(PDFName.of('Count'), PDFNumber.of(kids.count));
      count += kids.count;
    }
  }
  return { firstRef, lastRef, count };
}

/**
 * Copies bookmarks whose destination page survived into `outDoc`. Each
 * contributing source document's own top-level outline items become
 * top-level siblings in document order; a source with no `/Outlines`, or none
 * of whose bookmarks resolved, contributes nothing (never an empty heading).
 */
function copyOutlines(
  outDoc: PDFDocument,
  contributorDocIds: Map<PDFDocument, string>,
  pageRefMap: Map<string, PDFRef>
): void {
  const allRetained: RetainedOutlineItem[] = [];
  for (const [srcDoc, docId] of contributorDocIds) {
    const srcOutlines = srcDoc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
    if (!srcOutlines) continue;
    const refIndex = pageRefIndex(srcDoc);
    const retained = walkSourceOutline(
      srcOutlines,
      refIndex,
      pageRefMap,
      docId,
      new Set<PDFDict>()
    );
    allRetained.push(...retained);
  }
  if (allRetained.length === 0) return;

  const ctx = outDoc.context;
  const outlinesDict = ctx.obj({ Type: 'Outlines' }) as PDFDict;
  const outlinesRef = ctx.register(outlinesDict);
  const { firstRef, lastRef, count } = registerOutlineSiblings(ctx, allRetained, outlinesRef);
  if (!firstRef) return;
  outlinesDict.set(PDFName.of('First'), firstRef);
  outlinesDict.set(PDFName.of('Last'), lastRef!);
  outlinesDict.set(PDFName.of('Count'), PDFNumber.of(count));
  outDoc.catalog.set(PDFName.of('Outlines'), outlinesRef);
}

function reattachAcroForm(outDoc: PDFDocument, contributors: PDFDocument[]): void {
  const fields: PDFRef[] = [];
  const seenRoots = new Set<string>();
  const rootByName = new Map<string, PDFRef>();

  for (const page of outDoc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      if (!(ref instanceof PDFRef)) continue;
      const widget = outDoc.context.lookupMaybe(ref, PDFDict);
      if (!widget) continue;
      if (nameOf(widget.get(PDFName.of('Subtype'))) !== 'Widget') continue;

      // /P survived the copy pointing at the *source* page object, which is not
      // in the output page tree. Left alone, viewers and our own field-geometry
      // lookup cannot tell which page a field is on.
      widget.set(PDFName.of('P'), page.ref);

      const rootRef = fieldRootRef(outDoc, ref, widget);
      if (seenRoots.has(rootRef.toString())) continue;
      const rootDict = outDoc.context.lookupMaybe(rootRef, PDFDict);
      if (!rootDict) continue;

      // pdf-lib builds a fresh object copier per `copyPages` call, so a field
      // with widgets on two output pages arrives as two independent field dicts
      // with the same name. Two same-named entries in /Fields is a form where
      // filling by name reaches only one of them — merge them into one field.
      const name = textOf(rootDict.get(PDFName.of('T')));
      const existing = name === undefined ? undefined : rootByName.get(name);
      if (existing) {
        mergeFieldNode(outDoc, existing, rootRef);
        seenRoots.add(rootRef.toString());
        continue;
      }

      seenRoots.add(rootRef.toString());
      if (name !== undefined) rootByName.set(name, rootRef);
      fields.push(rootRef);
    }
  }

  if (fields.length === 0) return;

  const form = outDoc.context.obj({}) as PDFDict;
  form.set(PDFName.of('Fields'), outDoc.context.obj(fields) as PDFArray);

  // /DR (the default resource dictionary) is referenced only from /AcroForm, so
  // it was never copied with the pages. Without it pdf-lib cannot resolve the
  // font named in a field's /DA and appearance generation fails on flatten.
  for (const contributor of contributors) {
    const srcForm = acroFormDictOf(contributor);
    if (!srcForm) continue;
    const copier = PDFObjectCopier.for(contributor.context, outDoc.context);
    for (const key of ['DA', 'DR', 'Q', 'NeedAppearances', 'SigFlags'] as const) {
      const value = srcForm.get(PDFName.of(key));
      if (value === undefined || form.get(PDFName.of(key)) !== undefined) continue;
      form.set(PDFName.of(key), copier.copy(srcForm.lookup(PDFName.of(key))!));
    }
  }

  outDoc.catalog.set(PDFName.of('AcroForm'), outDoc.context.register(form));
}

/** True when a watermark is actually configured — not merely "the signal exists". */
function hasWatermarkContent(watermark: WatermarkData | undefined): boolean {
  if (!watermark) return false;
  return watermark.kind === 'image' ? !!watermark.image : !!watermark.text;
}

/** True when a header or footer is actually configured. */
function hasHeaderFooterContent(headerFooter: HeaderFooterData | undefined): boolean {
  if (!headerFooter) return false;
  return !!headerFooter.headerText.trim() || !!headerFooter.footerText.trim();
}

/**
 * The bottom-left origin of a `boxWidth` x `boxHeight` box placed against the
 * 9-point position grid, before any rotation. Shared by the text and image
 * watermark so the two draw against the same grid rather than duplicating the
 * center/edge math.
 */
function positionOrigin(
  position: string,
  pageWidth: number,
  pageHeight: number,
  boxWidth: number,
  boxHeight: number,
  padding: number
): { x: number; y: number } {
  const [vertical, horizontal] = position.split('-');

  let x = padding;
  if (horizontal === 'center' || (vertical === 'center' && !horizontal)) {
    x = (pageWidth - boxWidth) / 2;
  } else if (horizontal === 'right') {
    x = pageWidth - boxWidth - padding;
  }

  let y = pageHeight - boxHeight - padding;
  if (vertical === 'center') {
    y = (pageHeight - boxHeight) / 2;
  } else if (vertical === 'bottom') {
    y = padding;
  }

  return { x, y };
}

async function drawAnnotations(
  outDoc: PDFDocument,
  page: ReturnType<PDFDocument['addPage']>,
  annotations: AnnotationSource[],
  fontCache: { font?: Awaited<ReturnType<PDFDocument['embedFont']>> }
) {
  if (annotations.length === 0) return;

  const { width, height } = page.getSize();

  // Convert hex color to rgb
  const hexToRgb = (hex: string) => {
    hex = hex.replace('#', '');
    return rgb(
      parseInt(hex.substring(0, 2), 16) / 255,
      parseInt(hex.substring(2, 4), 16) / 255,
      parseInt(hex.substring(4, 6), 16) / 255
    );
  };

  for (const ann of annotations) {
    const color = hexToRgb(ann.color);

    // PDF coordinates are from bottom-left
    if (
      (ann.type === 'freehand' || ann.type === 'highlight') &&
      ann.points &&
      ann.points.length > 0
    ) {
      // Build an SVG path
      // M x y L x y L x y
      let path = `M ${ann.points[0].x * width} ${height - ann.points[0].y * height}`;
      for (let i = 1; i < ann.points.length; i++) {
        path += ` L ${ann.points[i].x * width} ${height - ann.points[i].y * height}`;
      }
      page.drawSvgPath(path, {
        borderColor: color,
        // `strokeWidth` is stored as a fraction of page width (matching x/y),
        // so it reproduces the same relative thickness the user drew on
        // screen regardless of which zoom level that was at.
        borderWidth: ann.strokeWidth * width,
        opacity: ann.type === 'highlight' ? 0.5 : 1.0
      });
    } else if (ann.type === 'rectangle' && ann.rect) {
      page.drawRectangle({
        x: ann.rect.x * width,
        y: height - ann.rect.y * height - ann.rect.height * height,
        width: ann.rect.width * width,
        height: ann.rect.height * height,
        borderColor: color,
        // `strokeWidth` is stored as a fraction of page width (matching x/y),
        // so it reproduces the same relative thickness the user drew on
        // screen regardless of which zoom level that was at.
        borderWidth: ann.strokeWidth * width,
        opacity: 1.0
      });
    } else if (ann.type === 'text' && ann.text && ann.rect) {
      if (!fontCache.font) {
        fontCache.font = await outDoc.embedFont(StandardFonts.Helvetica);
      }
      page.drawText(ann.text, {
        x: ann.rect.x * width,
        y: height - ann.rect.y * height - (ann.fontSize || 16),
        size: ann.fontSize || 16,
        color: color,
        font: fontCache.font
      });
    } else if (ann.type === 'whiteout' && ann.rect) {
      // A solid cover, not a redaction: this hides content visually in the
      // output without touching the underlying content stream. RED-02 is the
      // tool for actual content removal.
      page.drawRectangle({
        x: ann.rect.x * width,
        y: height - ann.rect.y * height - ann.rect.height * height,
        width: ann.rect.width * width,
        height: ann.rect.height * height,
        color,
        opacity: 1.0
      });
    } else if (ann.type === 'sticky' && ann.rect) {
      if (!fontCache.font) {
        fontCache.font = await outDoc.embedFont(StandardFonts.Helvetica);
      }
      const rectX = ann.rect.x * width;
      const rectY = height - ann.rect.y * height - ann.rect.height * height;
      const rectW = ann.rect.width * width;
      const rectH = ann.rect.height * height;
      page.drawRectangle({
        x: rectX,
        y: rectY,
        width: rectW,
        height: rectH,
        color,
        borderColor: DOC_INK,
        borderWidth: 1,
        opacity: 1.0,
        borderOpacity: 0.3
      });
      if (ann.text) {
        const size = ann.fontSize || 12;
        const lines = wrapTextForPdf(ann.text, fontCache.font, size, rectW - 12);
        let cursorY = rectY + rectH - size - 4;
        for (const line of lines) {
          if (cursorY < rectY) break;
          page.drawText(line, {
            x: rectX + 6,
            y: cursorY,
            size,
            color: DOC_INK,
            font: fontCache.font
          });
          cursorY -= size * 1.2;
        }
      }
    }
  }
}

/** Word-wraps `text` to fit within `maxWidth` using `font`'s real metrics. */
function wrapTextForPdf(
  text: string,
  font: import('pdf-lib').PDFFont,
  size: number,
  maxWidth: number
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Draws a fixed, unrotated header and/or footer line — small running text in the
 * top/bottom margin band, distinct from the single positioned/rotatable
 * watermark stamp above.
 */
function drawHeaderFooter(
  page: ReturnType<PDFDocument['addPage']>,
  font: import('pdf-lib').PDFFont,
  settings: HeaderFooterData,
  pageIndex: number,
  totalPages: number
): void {
  const { width, height } = page.getSize();
  const margin = 24; // ~1/3 inch band from the page edge
  const size = settings.fontSize;

  const draw = (raw: string, align: 'left' | 'center' | 'right', y: number, context: string) => {
    if (!raw.trim()) return;
    const displayText = raw
      .replace(/{n}/g, String(pageIndex + 1))
      .replace(/{total}/g, String(totalPages));
    const text = toWinAnsiOrThrow(displayText, context);
    const textWidth = font.widthOfTextAtSize(text, size);
    const x =
      align === 'center'
        ? (width - textWidth) / 2
        : align === 'right'
          ? width - textWidth - margin
          : margin;
    page.drawText(text, { x, y, size, font, color: DOC_INK });
  };

  draw(settings.headerText, settings.headerAlign, height - margin - size * 0.8, 'header');
  draw(settings.footerText, settings.footerAlign, margin, 'footer');
}

async function composePages(
  pages: PageSource[],
  sources: Record<string, Uint8Array>,
  stamps: StampSource[],
  watermark: WatermarkData | undefined,
  headerFooter: HeaderFooterData | undefined,
  normalize: import('../../ui/tools/normalize/state').NormalizeSettings | undefined | null,
  nup: import('../../ui/tools/nup/state').NUpSettings | undefined | null,
  annotations: AnnotationSource[] | undefined,
  job: JobHandle | undefined,
  label: string,
  pageOffset: number = 0,
  globalTotal: number = pages.length
): Promise<PDFDocument> {
  const outDoc = await PDFDocument.create();
  const getSource = sourceCache(sources);
  const fontCache: { font?: Awaited<ReturnType<PDFDocument['embedFont']>> } = {};
  const imageCache = new Map<string, PDFImage>();

  const watermarkActive = hasWatermarkContent(watermark);
  const headerFooterActive = hasHeaderFooterContent(headerFooter);

  let watermarkFont: import('pdf-lib').PDFFont | undefined;
  if (watermarkActive && watermark?.kind !== 'image') {
    watermarkFont = await outDoc.embedStandardFont(StandardFonts.HelveticaBold);
  }

  // A plain (non-bold) face, visually distinct from the diagonal watermark stamp —
  // headers/footers read like print-document running text, not a stamp.
  let headerFooterFont: import('pdf-lib').PDFFont | undefined;
  if (headerFooterActive) {
    headerFooterFont = await outDoc.embedStandardFont(StandardFonts.Helvetica);
  }

  const watermarkPages =
    watermarkActive && watermark ? parsePageRange(watermark.pageRange, pages.length) : null;
  const headerFooterPages =
    headerFooterActive && headerFooter
      ? parsePageRange(headerFooter.pageRange, pages.length)
      : null;

  const stampsByPage = new Map<string, StampSource[]>();
  for (const stamp of stamps) {
    const list = stampsByPage.get(stamp.pageKey) || [];
    list.push(stamp);
    stampsByPage.set(stamp.pageKey, list);
  }

  const annotationsByPage = new Map<string, AnnotationSource[]>();
  for (const ann of annotations || []) {
    const list = annotationsByPage.get(ann.pageKey) || [];
    list.push(ann);
    annotationsByPage.set(ann.pageKey, list);
  }

  /** Every source document that contributed a page, for the /AcroForm rebuild. */
  const contributors: PDFDocument[] = [];
  /** Same, keyed by the doc id the /Outlines copy needs to look up pages by. */
  const contributorDocIds = new Map<PDFDocument, string>();
  /** `${sourceDocId}:${sourceIndex}` → the copied page's ref in `outDoc`, for OPS-01. */
  const pageRefMap = new Map<string, PDFRef>();

  for (let i = 0; i < pages.length; i++) {
    const ref = pages[i];
    await checkpoint(job, i / pages.length, `${label} ${i + 1} of ${pages.length}`);

    const srcDoc = await getSource(ref.sourceDocId);
    if (!contributors.includes(srcDoc)) {
      contributors.push(srcDoc);
      contributorDocIds.set(srcDoc, ref.sourceDocId);
    }
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

      // /Rotate is a display-only transform — content stays in the page's raw
      // (unrotated) MediaBox. A 595x842 page with /Rotate 90 displays as
      // landscape even though width < height in raw content space; the
      // portrait/landscape decision (and the target box we ultimately write)
      // must go by what's actually displayed, or a rotated page normalizes to
      // the wrong orientation.
      const rotation = normalizeRotation(copied.getRotation().angle);
      const swapped = rotation === 90 || rotation === 270;
      const displayedWidth = swapped ? height : width;
      const displayedHeight = swapped ? width : height;

      let targetW = 595.28; // A4 default
      let targetH = 841.89;
      if (normalize.targetSize === 'Letter') {
        targetW = 612;
        targetH = 792;
      } else if (normalize.targetSize === 'Legal') {
        targetW = 612;
        targetH = 1008;
      }

      // If the displayed page is landscape, the displayed target should be too.
      if (displayedWidth > displayedHeight) {
        const temp = targetW;
        targetW = targetH;
        targetH = temp;
      }

      let factor = 1;
      const scaleX = targetW / displayedWidth;
      const scaleY = targetH / displayedHeight;

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

      // The target box, mapped back from displayed orientation to the raw
      // (unrotated) content space that setSize/translateContent operate in.
      const rawTargetW = swapped ? targetH : targetW;
      const rawTargetH = swapped ? targetW : targetH;

      // translateContent shifts the origin so the content is centered
      const dx = (rawTargetW - scaledW) / 2;
      const dy = (rawTargetH - scaledH) / 2;

      if (dx !== 0 || dy !== 0) {
        copied.translateContent(dx, dy);
      }

      // Override the boxes to match the target size exactly
      copied.setSize(rawTargetW, rawTargetH);
      copied.setCropBox(0, 0, rawTargetW, rawTargetH);
    }

    outDoc.addPage(copied);
    pageRefMap.set(`${ref.sourceDocId}:${ref.sourceIndex}`, copied.ref);

    if (ref.cropBox) {
      // PDF-lib coordinates are bottom-left. The incoming cropBox is top-left normalized [0,1].
      const { width, height } = copied.getSize();
      const cropX = ref.cropBox.x * width;
      const cropY = (1 - (ref.cropBox.y + ref.cropBox.height)) * height;
      const cropW = ref.cropBox.width * width;
      const cropH = ref.cropBox.height * height;
      copied.setCropBox(cropX, cropY, cropW, cropH);
    }

    if (watermarkActive && watermark && (watermarkPages === null || watermarkPages.has(i))) {
      const { width, height } = copied.getSize();
      const padding = 36; // 0.5 inch

      if (watermark.kind === 'image' && watermark.image) {
        const key = fingerprintBytes(watermark.image.bytes);
        let image = imageCache.get(key);
        if (!image) {
          image =
            watermark.image.format === 'jpeg'
              ? await outDoc.embedJpg(watermark.image.bytes)
              : await outDoc.embedPng(watermark.image.bytes);
          imageCache.set(key, image);
        }

        const boxW = width * watermark.imageScale;
        const boxH = boxW * (watermark.image.height / watermark.image.width);
        const { x, y } = positionOrigin(watermark.position, width, height, boxW, boxH, padding);
        const cx = x + boxW / 2;
        const cy = y + boxH / 2;
        const { x: drawX, y: drawY } =
          watermark.rotation === 0
            ? { x, y }
            : centerPreservingOrigin(cx, cy, boxW, boxH, watermark.rotation);

        copied.drawImage(image, {
          x: drawX,
          y: drawY,
          width: boxW,
          height: boxH,
          opacity: watermark.opacity,
          rotate: degrees(watermark.rotation)
        });
      } else if (watermarkFont && watermark.text) {
        const requestedText = watermark.text
          .replace(/{n}/g, String(watermark.startAt + pageOffset + i))
          .replace(/{total}/g, String(globalTotal));
        const displayText = toWinAnsiOrThrow(requestedText, 'watermark');

        const textWidth = watermarkFont.widthOfTextAtSize(displayText, watermark.fontSize);
        const textHeight = watermarkFont.heightAtSize(watermark.fontSize);
        const { x, y } = positionOrigin(
          watermark.position,
          width,
          height,
          textWidth,
          textHeight,
          padding
        );

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
    }

    if (
      headerFooterActive &&
      headerFooter &&
      headerFooterFont &&
      (headerFooterPages === null || headerFooterPages.has(i))
    ) {
      drawHeaderFooter(copied, headerFooterFont, headerFooter, pageOffset + i, globalTotal);
    }

    await drawStamps(outDoc, copied, stampsByPage.get(ref.key) ?? [], fontCache, imageCache);
    await drawAnnotations(outDoc, copied, annotationsByPage.get(ref.key) ?? [], fontCache);
  }

  if (nup) {
    // N-up rebuilds every page as an embedded form XObject, so widgets no longer
    // have a page of their own to sit on. Carrying /AcroForm there would point
    // fields at pages that no longer exist — worse than losing them.
    return applyNUp(outDoc, nup, job);
  }

  reattachAcroForm(outDoc, contributors);
  copyOutlines(outDoc, contributorDocIds, pageRefMap);
  return outDoc;
}

/**
 * Converts a user-facing 1-based page list into output page indexes. Invalid
 * fragments are ignored: an empty/invalid list must not silently watermark every
 * page, while ranges are clamped to the document that is actually being exported.
 */
function parsePageRange(value: string | undefined, pageCount: number): Set<number> | null {
  if (!value || value.trim().toLowerCase() === 'all') return null;
  const selected = new Set<number>();
  for (const part of value.split(',')) {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) continue;
    const from = Number(match[1]);
    const to = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) continue;
    for (
      let page = Math.max(1, Math.min(from, to));
      page <= Math.min(pageCount, Math.max(from, to));
      page++
    ) {
      selected.add(page - 1);
    }
  }
  return selected;
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

/**
 * Every filter name in a `/Filter` chain, in application order.
 *
 * Replaces a `nameOf`-based reading that collapsed an array to its *first*
 * entry — the wrong end. A chain applies left to right, so
 * `[/ASCII85Decode /JPXDecode]` is a JPEG2000 image wrapped in ASCII85, and
 * reading its head reported `ASCII85Decode`: a name `UNDECODABLE_FILTERS`
 * cannot match, which routed the image into the surgical re-encode the JPX skip
 * exists to keep it out of. Each entry is dereferenced individually, since an
 * array of indirect names is legal too, as is `/Filter 7 0 R` for the array.
 */
function filterNamesOf(value: unknown, context: PDFContext): string[] {
  const resolved: unknown = value instanceof PDFRef ? context.lookup(value) : value;
  if (resolved === undefined || resolved === null) return [];
  if (resolved instanceof PDFArray) {
    const names: string[] = [];
    for (let i = 0; i < resolved.size(); i++) {
      let entry: unknown = resolved.get(i);
      if (entry instanceof PDFRef) entry = context.lookup(entry);
      names.push(entry instanceof PDFName ? entry.asString().replace(/^\//, '') : 'unknown');
    }
    return names;
  }
  return [resolved instanceof PDFName ? resolved.asString().replace(/^\//, '') : 'unknown'];
}

/**
 * `nameOf` alone misidentifies a colour space every time a producer encodes it
 * the normal way rather than as a bare direct name: an indirect `/ColorSpace 7
 * 0 R` resolves to neither `PDFName` nor `PDFArray` (it's a `PDFRef`) and falls
 * through to `'unknown'`; a resource-scoped name like `/CS0` *is* a `PDFName`,
 * so `nameOf` happily returns `'CS0'` — a string `UNSAFE_COLOR_SPACES` can never
 * match, so a `/Separation` ink plate behind either encoding was silently
 * flattened to RGB and destroyed. Both are pdf-lib's own defaults for anything
 * beyond a plain device colour space (InDesign/Acrobat routinely emit both),
 * so this was close to dead code for the exact spot colours it exists to catch.
 */
function colorSpaceNameOf(
  value: unknown,
  resources: PDFDict | undefined,
  context: PDFContext
): string {
  let resolved: unknown = value;

  if (resolved instanceof PDFName) {
    const csDict = resources?.lookupMaybe(PDFName.of('ColorSpace'), PDFDict);
    const named = csDict?.get(resolved);
    if (named !== undefined) resolved = named;
  }

  if (resolved instanceof PDFRef) resolved = context.lookup(resolved);

  if (resolved instanceof PDFName) return resolved.asString().replace(/^\//, '');
  if (resolved instanceof PDFArray) {
    let first: unknown = resolved.get(0);
    if (first instanceof PDFRef) first = context.lookup(first);
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

/**
 * Walks a `/Resources/XObject` dict, recursing into nested Form XObjects
 * exactly like `collectImages`, and returns every `{dict, key}` pair whose
 * entry is an Image XObject — tagged with the object number it points at.
 *
 * This replaces an earlier version that matched by resource *name* alone
 * (`findImageContainer`). Resource names are scoped per dictionary: a page's
 * own `/Resources/XObject` and a nested Form's own `/Resources/XObject` can
 * legally reuse the same local name (e.g. both call an image `/Im1`) — a
 * letterhead Form and an unrelated photo on the same page is a realistic
 * case. Matching by name alone could attach a re-encoded JPEG to the wrong
 * container, silently swapping one image's content onto another's placement.
 * Object numbers are unique across the document, so matching on those is
 * collision-free; a page can also legitimately reference the same image
 * object through more than one name/container, so every match is returned.
 */
function collectImageRefs(
  xobjects: PDFDict,
  context: PDFContext,
  visited: Set<number>,
  depth = 0
): { dict: PDFDict; key: PDFName; ref: PDFRef }[] {
  if (depth > 8) return [];
  const found: { dict: PDFDict; key: PDFName; ref: PDFRef }[] = [];

  for (const [key, value] of xobjects.entries()) {
    const ref = value instanceof PDFRef ? value : undefined;
    const stream = xobjects.lookup(key);
    if (!(stream instanceof PDFStream)) continue;
    const subtype = nameOf(stream.dict.get(PDFName.of('Subtype')));

    if (subtype === 'Image') {
      if (ref) found.push({ dict: xobjects, key, ref });
      continue;
    }
    if (subtype !== 'Form') continue;

    if (ref) {
      if (visited.has(ref.objectNumber)) continue;
      visited.add(ref.objectNumber);
    }
    const formResourcesRaw = stream.dict.get(PDFName.of('Resources'));
    const formResources =
      formResourcesRaw instanceof PDFDict
        ? formResourcesRaw
        : formResourcesRaw instanceof PDFRef
          ? context.lookupMaybe(formResourcesRaw, PDFDict)
          : undefined;
    const formXObjects = formResources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (formXObjects) {
      found.push(...collectImageRefs(formXObjects, context, visited, depth + 1));
    }
  }
  return found;
}

/**
 * Walks a `/Resources/XObject` dict, collecting `ImageFacts` for every Image it
 * finds — recursing into Form XObjects along the way. A page whose only photo
 * lives inside a Form (a common pattern for stamps, watermarks, and reusable
 * letterhead art) used to be invisible to this scan entirely: only the page's
 * own `/Resources/XObject` was read, so the image was never compressed, and the
 * page was reported "already optimized" even though it carried an
 * uncompressed photo one indirection down.
 *
 * `visited` guards against a Form that (directly or through a cycle) refers to
 * itself, and against re-listing the same shared image twice if it is somehow
 * reachable through two different paths on one page.
 */
function collectImages(
  xobjects: PDFDict,
  resources: PDFDict | undefined,
  doc: PDFDocument,
  images: ImageFacts[],
  visited: Set<number>,
  depth = 0
): void {
  if (depth > 8) return;

  for (const [key, value] of xobjects.entries()) {
    const ref = value instanceof PDFRef ? value : undefined;
    if (ref) {
      if (visited.has(ref.objectNumber)) continue;
      visited.add(ref.objectNumber);
    }

    const stream = xobjects.lookup(key);
    if (!(stream instanceof PDFStream)) continue;
    const dict = stream.dict;
    const subtype = nameOf(dict.get(PDFName.of('Subtype')));

    if (subtype === 'Form') {
      // A Form without its own /Resources inherits the resources of whatever
      // invokes it — here, the scope we were called with.
      const formResourcesRaw = dict.get(PDFName.of('Resources'));
      const formResources =
        formResourcesRaw instanceof PDFDict
          ? formResourcesRaw
          : formResourcesRaw instanceof PDFRef
            ? doc.context.lookupMaybe(formResourcesRaw, PDFDict)
            : resources;
      const formXObjects = formResources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      if (formXObjects) {
        collectImages(formXObjects, formResources, doc, images, visited, depth + 1);
      }
      continue;
    }

    if (subtype !== 'Image') continue;

    const smask = dict.lookupMaybe(PDFName.of('SMask'), PDFStream);
    const mask = dict.lookup(PDFName.of('Mask'));
    const isImageMask = dict.lookup(PDFName.of('ImageMask')) === PDFBool.True;
    const filters = filterNamesOf(dict.get(PDFName.of('Filter')), doc.context);

    images.push({
      name: key.asString().replace(/^\//, ''),
      objectNumber: ref?.objectNumber ?? -1,
      width: numberOf(dict, 'Width', 0),
      height: numberOf(dict, 'Height', 0),
      // A stencil mask has no /BitsPerComponent of its own; it is 1 by
      // definition, and defaulting it to 8 would let a stencil through the
      // re-encode gate as if it were a photograph.
      bitsPerComponent: numberOf(dict, 'BitsPerComponent', isImageMask ? 1 : 8),
      colorSpace: colorSpaceNameOf(dict.get(PDFName.of('ColorSpace')), resources, doc.context),
      filter: filters[filters.length - 1] ?? 'unknown',
      filters,
      hasSMask: dict.get(PDFName.of('SMask')) !== undefined,
      hasMask: dict.get(PDFName.of('Mask')) !== undefined,
      maskKind: maskKindOf(smask, mask),
      isImageMask,
      byteLength: stream instanceof PDFRawStream ? stream.contents.length : stream.sizeInBytes()
    });
  }
}

/* ------------------------------------------------------------------ *
 * Metadata (RED-04)
 * ------------------------------------------------------------------ */

/**
 * Names a field kind for a user-facing message.
 *
 * Deliberately a lookup against pdf-lib's exported classes rather than
 * `field.constructor.name`. That property was how the whole form path used to
 * identify a field, and it is empty of meaning in a production build: the bundler
 * renames the class, so `constructor.name` is a mangled identifier that matches no
 * expected string. Every field therefore came back `Unknown` — the overlay drew a
 * box reading "Unsupported" over each one and nothing could be typed into it, and
 * a fill would have refused every field. It worked in tests and in dev only
 * because neither minifies. `instanceof` survives minification.
 */
function describeFieldKind(field: PDFField): string {
  if (field instanceof PDFSignature) return 'a signature field';
  if (field instanceof PDFButton) return 'a button';
  return 'an unrecognised field type';
}

const JS_KEYS = ['JavaScript', 'JS'] as const;

function catalogHas(doc: PDFDocument, key: string): boolean {
  return doc.catalog.get(PDFName.of(key)) !== undefined;
}

const STANDARD_INFO_KEYS = [
  'Title',
  'Author',
  'Subject',
  'Creator',
  'Producer',
  'Keywords',
  'CreationDate',
  'ModDate'
] as const;

/** Info key -> the `ScrubSettings` field that removes it. */
const INFO_KEY_SETTING: Record<string, keyof ScrubSettings> = {
  Title: 'title',
  Author: 'author',
  Subject: 'subject',
  Creator: 'creator',
  Producer: 'producer',
  Keywords: 'keywords',
  CreationDate: 'creationDate',
  ModDate: 'modificationDate'
};

/**
 * Windows drive paths, UNC shares, and POSIX home paths. Deliberately conservative:
 * a false positive here is a scary-looking row in the inspector for a string that is
 * not a path, so the pattern requires a real path separator and at least one segment.
 *
 * The drive-letter branch is guarded by a lookbehind because a URL scheme ends the same
 * way: `https://github.com/…` contains `s://`, and without the guard pdf-lib's own
 * Producer string was reported as a filesystem path on every document it had ever
 * written.
 */
const PATH_PATTERN =
  /(?:(?<![A-Za-z])[A-Za-z]:[\\/][^\s"'<>)]{1,200}|\\\\[A-Za-z0-9._-]+\\[^\s"'<>)]{1,200}|\/(?:Users|home)\/[^\s"'<>)]{1,200})/g;

function findPaths(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const match of text.matchAll(PATH_PATTERN)) {
    const value = match[0].replace(/[.,;]+$/, '');
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * The XMP packet as text, or `''`. The packet is conventionally stored unfiltered, so
 * the raw contents are read directly and only decoded when a `/Filter` says to; if it
 * cannot be decoded, presence is still reported by `hasXmp` and only the path scan
 * loses resolution — never a throw that would break the whole inspection.
 */
async function readXmpText(doc: PDFDocument): Promise<string> {
  const stream = doc.catalog.lookup(PDFName.of('Metadata'));
  if (!(stream instanceof PDFRawStream)) return '';
  const raw = stream.getContents();
  const filter = stream.dict.get(PDFName.of('Filter'));
  try {
    const bytes = filter === undefined ? raw : await decodeStream(raw);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
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
    // Raw-byte evidence first: see `core/pdf/xfa.ts` for why the parsed answer
    // alone lets hybrid XFA forms through as ordinary AcroForms.
    const isXfa = hasXfaMarker(bytes) || form.hasXFA();
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
      if (xobjects) collectImages(xobjects, resources, doc, images, new Set());

      out.push({ pageIndex: i, images, width: size.width, height: size.height });
    }

    return out;
  },

  async getFormFields(bytes) {
    // Checked before the parse, and before any field is reported: enumerating an
    // XFA form's shadow fields is what led the UI to offer them as fillable.
    if (hasXfaMarker(bytes)) return { isXfa: true, fields: [] };

    const doc = await load(bytes, true);
    const form = doc.getForm();
    if (form.hasXFA()) return { isXfa: true, fields: [] };

    const pages = doc.getPages();
    const fields: FormFieldData[] = [];

    for (const field of form.getFields()) {
      let type: FormFieldData['type'] = 'Unknown';
      let value: string | string[] | boolean = '';
      let options: string[] | undefined;

      if (field instanceof PDFTextField) {
        type = 'TextField';
        value = field.getText() ?? '';
      } else if (field instanceof PDFCheckBox) {
        type = 'CheckBox';
        value = field.isChecked();
      } else if (field instanceof PDFRadioGroup) {
        type = 'RadioGroup';
        value = field.getSelected() ?? '';
        options = field.getOptions();
      } else if (field instanceof PDFDropdown) {
        type = 'Dropdown';
        value = field.getSelected() ?? [];
        options = field.getOptions();
      } else if (field instanceof PDFOptionList) {
        type = 'OptionList';
        value = field.getSelected() ?? [];
        options = field.getOptions();
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
    // XFA is checked on the raw bytes *first*: a hybrid form answers `false` to
    // every parsed check while its real fields live in XML we cannot write.
    if (hasXfaMarker(bytes)) throw unsupported(XFA_MESSAGE);

    const doc = await load(bytes);
    const form = doc.getForm();
    if (form.hasXFA()) throw unsupported(XFA_MESSAGE);

    // A name we were asked to fill but cannot find is silent data loss: the user
    // typed a value, the export "succeeded", and the value is nowhere in the
    // output. Collect them and refuse rather than saving a lie.
    const missing: string[] = [];
    const unsupportedKinds: string[] = [];

    for (const [name, value] of Object.entries(values)) {
      const field = form.getFieldMaybe(name);
      if (!field) {
        missing.push(name);
        continue;
      }
      if (field instanceof PDFTextField) field.setText(String(value));
      else if (field instanceof PDFCheckBox) {
        if (value) field.check();
        else field.uncheck();
      } else if (field instanceof PDFRadioGroup) field.select(String(value));
      else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
        field.select(Array.isArray(value) ? value : [String(value)]);
      } else {
        unsupportedKinds.push(`${name} (${describeFieldKind(field)})`);
      }
    }

    if (missing.length > 0) {
      throw corrupt(
        `The document has no form field named ${missing.map(n => `"${n}"`).join(', ')}, so ` +
          'those values could not be written. Nothing was saved — your document is untouched.',
        { missingFields: missing.join(', ') }
      );
    }
    if (unsupportedKinds.length > 0) {
      throw unsupported(
        `Stapler cannot write to ${unsupportedKinds.join(', ')}. Nothing was saved. Use the ` +
          'stamp tools to place text on top of the page instead.'
      );
    }

    if (flatten) {
      try {
        form.flatten();
      } catch (err) {
        // Flatten generates an appearance stream per field; a form with a broken
        // /DA or a missing /DR font throws here. Half a flatten is a mangled
        // document, so this is a refusal, not a fallback.
        throw corrupt(
          'The filled values could not be drawn into the page (the form’s default ' +
            `appearance is unusable): ${err instanceof Error ? err.message : String(err)}. ` +
            'Nothing was saved.'
        );
      }
    }
    return transfer(await doc.save({ useObjectStreams: true }));
  },

  async compose(pages, sources, stamps, watermark, headerFooter, normalize, nup, annotations, job) {
    if (pages.length === 0) throw internal('Nothing to export: the page list is empty');
    const outDoc = await composePages(
      pages,
      sources,
      stamps,
      watermark,
      headerFooter,
      normalize,
      nup,
      annotations,
      job,
      'Composing page'
    );
    await checkpoint(job, 0.95, 'Writing file');
    return transfer(await outDoc.save({ useObjectStreams: true }));
  },

  async composeSplit(
    pages,
    sources,
    boundaries,
    stamps,
    watermark,
    headerFooter,
    normalize,
    nup,
    baseName,
    annotations,
    job
  ) {
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
        headerFooter,
        normalize,
        nup,
        annotations,
        job,
        'Composing page',
        0,
        pages.length
      );
      return {
        bytes: transfer(await outDoc.save({ useObjectStreams: true })),
        isZip: false,
        fileCount: 1
      };
    }

    const files: Record<string, Uint8Array> = {};
    const pad = Math.max(2, String(slices.length).length);
    let currentOffset = 0;
    for (let i = 0; i < slices.length; i++) {
      await checkpoint(job, i / slices.length, `Writing file ${i + 1} of ${slices.length}`);
      const outDoc = await composePages(
        slices[i],
        sources,
        stamps,
        watermark,
        headerFooter,
        normalize,
        nup,
        annotations,
        job,
        'Composing page',
        currentOffset,
        pages.length
      );
      currentOffset += slices[i].length;
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
    for (const [pageIndexKey, byObjectNumber] of Object.entries(replacedImages)) {
      const pageIndex = Number(pageIndexKey);
      const page = pages[pageIndex];
      if (!page) continue;
      const pageXObjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      if (!pageXObjects) continue;

      // Every Image entry reachable from this page, tagged with the object
      // number it points at — resolved once per page, since a page can carry
      // several images to replace and each needs the same full scan.
      const refs = collectImageRefs(pageXObjects, source.context, new Set());

      for (const [objectNumberKey, encoded] of Object.entries(byObjectNumber)) {
        const objectNumber = Number(objectNumberKey);
        // All entries pointing at this object number share the same underlying
        // stream, so they are replaced together with one embedded JPEG.
        const matches = refs.filter(r => r.ref.objectNumber === objectNumber);
        if (matches.length === 0) continue;
        const oldRef = matches[0].ref;

        const reused = embedded.get(oldRef.objectNumber);
        if (reused) {
          for (const { dict, key } of matches) dict.set(key, reused);
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
        //
        // The value is *resolved* before it is judged. `/Mask` as an array of
        // colour ranges is a colour-key mask, whose transparency is defined by
        // exact sample values that a lossy re-encode destroys; written the
        // ordinary way (`/Mask 12 0 R`, pointing at an array) it is a `PDFRef`,
        // so an unresolved check called it carriable and copied it verbatim onto
        // a downscaled JPEG whose samples no longer match any of those ranges.
        const carriable = (value: unknown) => {
          if (value === undefined) return true;
          if (!(value instanceof PDFRef)) return false;
          return !(source.context.lookup(value) instanceof PDFArray);
        };
        if (!carriable(smaskRef) || !carriable(maskRef)) continue;

        // A `/Matte` soft mask is pre-blended against a matte colour, and pdf.js
        // un-blends it while decoding: re-attaching the original mask would tell
        // a viewer to un-blend data that no longer is. A stencil (`/ImageMask
        // true`) paints the fill colour through a 1-bit shape and is not a
        // picture JPEG can carry at all. Both are on the classifier's refuse
        // list; both are re-checked here so the lock does not depend on the
        // classifier having reached the same conclusion.
        const smaskStreamNow =
          smaskRef instanceof PDFRef
            ? source.context.lookupMaybe(smaskRef, PDFStream)
            : smaskRef instanceof PDFStream
              ? smaskRef
              : undefined;
        if (smaskStreamNow?.dict.get(PDFName.of('Matte')) !== undefined) continue;
        if (oldStream.dict.lookup(PDFName.of('ImageMask')) === PDFBool.True) continue;

        const image = await source.embedJpg(encoded.jpeg);
        // `embedJpg` only reserves a reference; the stream itself is written on
        // save. Forcing it now is what makes the object exist to hang the mask
        // off — without this the lookup below returns undefined and the mask is
        // quietly dropped.
        await image.embed();
        const newStream = source.context.lookup(image.ref);
        if (!(newStream instanceof PDFStream)) continue;

        let finalSmaskRef = smaskRef;
        if (smaskRef instanceof PDFRef && encoded.maskBytes) {
          // The colour image and its `/SMask` are independent XObjects with
          // independent resolutions — a small image can carry a disproportionately
          // large soft mask. Whether *this* image got downscaled says nothing about
          // whether its mask needs to be; the mask's own stored size against the
          // new colour target is what decides it.
          const originalSmask = source.context.lookupMaybe(smaskRef, PDFStream);
          const originalWidth = originalSmask?.dict
            .lookupMaybe(PDFName.of('Width'), PDFNumber)
            ?.asNumber();
          const originalHeight = originalSmask?.dict
            .lookupMaybe(PDFName.of('Height'), PDFNumber)
            ?.asNumber();
          // Only *shrinking* the mask is worth the swap. `encodeMask` resamples
          // to `encoded`'s target regardless of direction, so a mask smaller
          // than the base image's new target — a disproportionately small mask
          // behind a large image, the opposite of the case this exists for —
          // would otherwise get inflated to match it: legal, but pure bloat on
          // a path whose only job is making the file smaller. A one-directional
          // check keeps the resample when it removes pixels and discards it
          // when it would only add them (an SMask is stretched to the image's
          // box at render time regardless of its own resolution, so keeping the
          // original small mask costs nothing visually).
          const smaskOversized =
            (originalWidth ?? 0) > encoded.width || (originalHeight ?? 0) > encoded.height;

          if (smaskOversized) {
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
        }

        // Re-attached untouched (or resampled to match the new colour target): the
        // mask keeps its own resolution, filter and bytes unless it needed resizing.
        if (finalSmaskRef) newStream.dict.set(PDFName.of('SMask'), finalSmaskRef);
        if (maskRef) newStream.dict.set(PDFName.of('Mask'), maskRef);

        // `embedJpg` builds a bare Image XObject dict with only what pdf-lib
        // itself needs — every other entry the original carried is dropped.
        // `/OC` (optional content — a layer's visibility toggle) and
        // `/StructParent` (this image's link back into the tagged-PDF structure
        // tree) are exactly the kind of thing nothing re-derives afterwards:
        // losing `/OC` makes a hideable layer permanently visible, and losing
        // `/StructParent` breaks the structure tree's link to this image with
        // no error, silently degrading accessibility for anyone using assistive
        // tech on the "compressed" file.
        const oc = oldStream.dict.get(PDFName.of('OC'));
        if (oc !== undefined) newStream.dict.set(PDFName.of('OC'), oc);
        const structParent = oldStream.dict.get(PDFName.of('StructParent'));
        if (structParent !== undefined) {
          newStream.dict.set(PDFName.of('StructParent'), structParent);
        }

        embedded.set(oldRef.objectNumber, image.ref);
        for (const { dict, key } of matches) dict.set(key, image.ref);
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

    reattachAcroForm(out, [source]);
    await checkpoint(job, 0.95, 'Writing file');
    const rebuilt = await out.save({ useObjectStreams: true });

    // CMP-04: a "compressed" file that is not smaller is not saved. Returning the
    // original bytes is the only honest outcome.
    if (rebuilt.byteLength >= bytes.byteLength) {
      return { bytes: transfer(new Uint8Array(bytes)), keptOriginal: true };
    }
    return { bytes: transfer(rebuilt), keptOriginal: false };
  },

  async markdownToPdf(markdown: string): Promise<Uint8Array> {
    return await markdownToPdfBytes(markdown);
  },

  async imagesToPdf(images, options, job) {
    const doc = await PDFDocument.create();
    for (let i = 0; i < images.length; i++) {
      await checkpoint(job, i / images.length, `Adding image ${i + 1} of ${images.length}`);
      // Images are normalised to JPEG before they reach the worker.
      const embedded = await doc.embedJpg(images[i]);

      let pageWidth = embedded.width;
      let pageHeight = embedded.height;
      const margin = options?.margin ?? 0;

      if (options?.pageSize && typeof options.pageSize === 'object') {
        const size = Array.isArray(options.pageSize) ? options.pageSize[i] : options.pageSize;
        if (size) {
          pageWidth = size.width;
          pageHeight = size.height;
        }
      } else if (options?.pageSize === 'a4') {
        pageWidth = 595.28;
        pageHeight = 841.89;
      } else if (options?.pageSize === 'letter') {
        pageWidth = 612;
        pageHeight = 792;
      }

      const isLandscape = embedded.width > embedded.height;
      if (
        options?.pageSize &&
        typeof options.pageSize === 'string' &&
        options.pageSize !== 'original'
      ) {
        if (
          options?.orientation === 'landscape' ||
          (options?.orientation === 'auto' && isLandscape)
        ) {
          const temp = pageWidth;
          pageWidth = pageHeight;
          pageHeight = temp;
        }
      }

      const page = doc.addPage([pageWidth, pageHeight]);
      const availableWidth = pageWidth - margin * 2;
      const availableHeight = pageHeight - margin * 2;

      const scale = Math.min(1, availableWidth / embedded.width, availableHeight / embedded.height);

      const drawWidth = embedded.width * scale;
      const drawHeight = embedded.height * scale;
      const x = margin + (availableWidth - drawWidth) / 2;
      const y = margin + (availableHeight - drawHeight) / 2;

      page.drawImage(embedded, { x, y, width: drawWidth, height: drawHeight });
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

    const customInfo: { key: string; value: string }[] = [];
    const filesystemPaths: MetadataPathFinding[] = [];
    const info = doc.context.lookupMaybe(doc.context.trailerInfo.Info, PDFDict);
    if (info) {
      for (const [key, rawValue] of info.entries()) {
        const name = key.asString().replace(/^\//, '');
        const value = doc.context.lookup(rawValue);
        // PDFString and PDFHexString share no exported base class, so the readable
        // form is reached through the two concrete types, as elsewhere in this file.
        const text =
          value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : '';
        const isStandard = (STANDARD_INFO_KEYS as readonly string[]).includes(name);
        if (!isStandard) customInfo.push({ key: name, value: text });
        for (const path of findPaths(text)) {
          filesystemPaths.push({
            source: isStandard ? name : `${name} (custom property)`,
            value: path,
            settingKey: isStandard ? INFO_KEY_SETTING[name] : 'customInfo'
          });
        }
      }
    }
    for (const path of findPaths(await readXmpText(doc))) {
      filesystemPaths.push({ source: 'XMP packet', value: path, settingKey: 'hasXmp' });
    }
    const hasCustomInfo = customInfo.length > 0;

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
      hasCustomInfo,
      customInfo,
      filesystemPaths
    };
  },

  async protectDocument(bytes, settings) {
    return encryptPdf(bytes, settings);
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
        const isStandard = (STANDARD_INFO_KEYS as readonly string[]).includes(name);

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

    await doc.flush();
    const out = await PDFDocument.create();
    /*
     * One copier for the whole rebuild rather than pdf-lib's per-`copyPages` instance.
     * Kept catalog entries — an /OCProperties tree, an embedded-file name tree — point
     * at the same objects the pages point at, and a second copier would clone those
     * into separate output objects: layer dictionaries that no longer match the /OC
     * marks left in the page content.
     */
    const copier = PDFObjectCopier.for(doc.context, out.context);
    for (const page of doc.getPages()) {
      const leaf = copier.copy(page.node);
      const ref = out.context.register(leaf);
      out.addPage(PDFPage.of(leaf, ref, out));
    }

    /*
     * Carry across the catalog entries the user chose to keep. The rebuild starts from
     * an empty catalog, so before this every catalog-level toggle was strip-only: an
     * embedded file, a hidden layer, an open action or the XMP packet was removed
     * whether or not its checkbox was ticked. Per-item control has to mean both
     * directions or it is not control.
     */
    const carry = (key: string, stripped: boolean | undefined) => {
      if (stripped) return;
      const value = doc.catalog.get(PDFName.of(key));
      if (value !== undefined) out.catalog.set(PDFName.of(key), copier.copy(value));
    };
    carry('Metadata', s.hasXmp);
    carry('OpenAction', s.hasOpenAction);
    carry('AA', s.hasAdditionalActions);
    carry('OCProperties', s.hasOptionalContent);
    // The stripped subtrees were deleted from /Names above, so whatever is left — kept
    // JavaScript, kept embedded files, and unrelated entries such as /Dests — carries.
    if (names && names.entries().length > 0) carry('Names', false);

    const outInfo =
      out.context.lookup(out.context.trailerInfo.Info, PDFDict) || out.context.obj({});
    if (!out.context.lookupMaybe(out.context.trailerInfo.Info, PDFDict)) {
      out.context.trailerInfo.Info = out.context.register(outInfo);
    }

    // `PDFDocument.create()` stamps its own Producer/Creator/CreationDate/ModDate, so a
    // document whose Producer was just stripped came back carrying pdf-lib's instead —
    // the stripped category was populated again in the output the user inspects.
    for (const name of STANDARD_INFO_KEYS) {
      if (s[INFO_KEY_SETTING[name]]) outInfo.delete(PDFName.of(name));
    }

    if (info) {
      for (const [key, val] of info.entries()) {
        outInfo.set(key, val);
      }
    }

    reattachAcroForm(out, [doc]);
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

      const cropBox = copied.getCropBox();

      // pdf.js applies /Rotate when building the viewport, so the normalized
      // coordinates the UI produced are in the *rotated* frame. We must apply
      // the inverse rotation to map them back to unrotated PDF content-space
      // before passing them to filterContentStream or drawRectangle.
      const rotateVal = copied.node.get(PDFName.of('Rotate'));
      const rotateDeg =
        rotateVal instanceof PDFNumber ? normalizeRotation(rotateVal.asNumber()) : 0;

      function normalizedToContentSpace(r: RedactionRegion): Rect {
        // Start in the rotated frame: (r.x, r.y) are top-left fractions.
        // Convert to cropBox-relative unrotated coordinates.
        let rx: number, ry: number, rw: number, rh: number;
        if (rotateDeg === 0) {
          rx = r.x;
          ry = r.y;
          rw = r.width;
          rh = r.height;
        } else if (rotateDeg === 90) {
          // pdf.js rotates 90° CW: its x-axis = page y-axis, y-axis = inverted page x-axis
          rx = r.y;
          ry = 1 - r.x - r.width;
          rw = r.height;
          rh = r.width;
        } else if (rotateDeg === 180) {
          rx = 1 - r.x - r.width;
          ry = 1 - r.y - r.height;
          rw = r.width;
          rh = r.height;
        } else {
          // 270
          rx = 1 - r.y - r.height;
          ry = r.x;
          rw = r.height;
          rh = r.width;
        }
        // Convert normalized fractions (top-left origin) to PDF user-space (bottom-left origin).
        return {
          x: cropBox.x + rx * cropBox.width,
          y: cropBox.y + cropBox.height * (1 - ry - rh),
          width: rw * cropBox.width,
          height: rh * cropBox.height
        };
      }

      // 2. Perform operator-level content removal
      if (regionsByPage.has(i)) {
        const pageRegions = regionsByPage.get(i)!;

        // Convert regions from normalized (fraction of the CropBox, y from top)
        // to PDF content-space coordinates (bottom-left origin, offset by the
        // CropBox's own origin within the page's default user space).
        const rects: Rect[] = pageRegions.map(normalizedToContentSpace);

        const rawContents = copied.node.Contents();
        const streamRefs: unknown[] = [];
        if (rawContents) {
          if (rawContents instanceof PDFArray) {
            for (let k = 0; k < rawContents.size(); k++) {
              streamRefs.push(rawContents.get(k));
            }
          } else {
            streamRefs.push(rawContents);
          }
        }

        // Collect all XObject names stripped across all content stream chunks so
        // we can remove them from /Resources/XObject after processing.
        const allStrippedXObjectNames: string[] = [];

        // A Form XObject's true extent is its own /BBox (through its own
        // /Matrix) — nothing like an image's implicit unit square. Without this,
        // every Form invocation was measured as a bogus tiny box and could never
        // be detected as overlapping a redaction region, however large it
        // actually painted on the page, leaving whatever text it drew untouched.
        const pageResourcesRaw = copied.node.get(PDFName.of('Resources'));
        const pageResourceDict =
          pageResourcesRaw instanceof PDFDict
            ? pageResourcesRaw
            : pageResourcesRaw instanceof PDFRef
              ? (out.context.lookup(pageResourcesRaw) as PDFDict | undefined)
              : undefined;
        const pageXObjectDictRaw = pageResourceDict?.get(PDFName.of('XObject'));
        const pageXObjectDict =
          pageXObjectDictRaw instanceof PDFDict
            ? pageXObjectDictRaw
            : pageXObjectDictRaw instanceof PDFRef
              ? (out.context.lookup(pageXObjectDictRaw) as PDFDict | undefined)
              : undefined;

        const resolveXObject = (name: string) => {
          const entry = pageXObjectDict?.get(PDFName.of(name));
          const resolved = entry instanceof PDFRef ? out.context.lookup(entry) : entry;
          const dict =
            resolved instanceof PDFDict
              ? resolved
              : resolved instanceof PDFStream || resolved instanceof PDFRawStream
                ? resolved.dict
                : undefined;
          if (!dict) return undefined;
          const subtypeName = dict.get(PDFName.of('Subtype'));
          const subtype =
            subtypeName === PDFName.of('Form')
              ? ('Form' as const)
              : subtypeName === PDFName.of('Image')
                ? ('Image' as const)
                : ('Unknown' as const);
          if (subtype !== 'Form') return { subtype };

          const bboxArr = dict.get(PDFName.of('BBox'));
          const bbox =
            bboxArr instanceof PDFArray && bboxArr.size() === 4
              ? ([
                  (bboxArr.get(0) as PDFNumber).asNumber(),
                  (bboxArr.get(1) as PDFNumber).asNumber(),
                  (bboxArr.get(2) as PDFNumber).asNumber(),
                  (bboxArr.get(3) as PDFNumber).asNumber()
                ] as [number, number, number, number])
              : undefined;

          const matrixArr = dict.get(PDFName.of('Matrix'));
          const matrix =
            matrixArr instanceof PDFArray && matrixArr.size() === 6
              ? (Array.from({ length: 6 }, (_, k) =>
                  (matrixArr.get(k) as PDFNumber).asNumber()
                ) as Matrix)
              : undefined;

          return { subtype, bbox, matrix };
        };

        if (streamRefs.length > 0) {
          const filteredChunks: Uint8Array[] = [];
          let carryState: GraphicsState | undefined;

          for (const ref of streamRefs) {
            const stream = out.context.lookup(ref as never);
            if (!(stream instanceof PDFStream)) continue;

            let rawBytes: Uint8Array = stream.getContents();

            const filter = stream.dict.get(PDFName.of('Filter'));
            const isFlate =
              filter === PDFName.of('FlateDecode') ||
              (filter instanceof PDFArray && filter.get(0) === PDFName.of('FlateDecode'));
            if (isFlate) {
              rawBytes = await decodeStream(rawBytes);
            }

            const tokens = tokenizeContentStream(rawBytes);
            const statements = parseContentStream(tokens);
            const { filtered, finalState, strippedXObjectNames } = filterContentStream(
              statements,
              rects,
              carryState,
              resolveXObject
            );
            carryState = finalState;
            allStrippedXObjectNames.push(...strippedXObjectNames);
            filteredChunks.push(serializeStatements(filtered));
          }

          if (filteredChunks.length > 0) {
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

        // 2b. Strip image XObject streams from /Resources/XObject whose `Do`
        // operators were removed. Two layers of removal are required:
        //
        //   1. Remove the name from the dict — this kills the named reference.
        //   2. Delete the underlying indirect object from out.context — pdf-lib's
        //      save() serialises every object in the context, regardless of whether
        //      anything still points to it. Without this step the image bytes remain
        //      recoverable via pdfimages/qpdf even though no live reference exists.
        //
        // Shared images (same PDFRef referenced from multiple pages' /Resources)
        // must NOT be deleted from the context — only the per-page dict entry is
        // removed; the remaining pages' references keep the stream alive correctly.
        if (allStrippedXObjectNames.length > 0) {
          const resources = copied.node.get(PDFName.of('Resources'));
          const resourceDict =
            resources instanceof PDFDict
              ? resources
              : resources instanceof PDFRef
                ? (out.context.lookup(resources) as PDFDict | undefined)
                : undefined;
          if (resourceDict) {
            const xObjectDict = resourceDict.get(PDFName.of('XObject'));
            const xObjects =
              xObjectDict instanceof PDFDict
                ? xObjectDict
                : xObjectDict instanceof PDFRef
                  ? (out.context.lookup(xObjectDict) as PDFDict | undefined)
                  : undefined;
            if (xObjects) {
              for (const name of allStrippedXObjectNames) {
                const pdfName = PDFName.of(name);
                // Capture the ref (if indirect) before deleting, so we can
                // remove it from the context object table below.
                const entry = xObjects.get(pdfName);
                xObjects.delete(pdfName);

                // Only purge the object from the context if it is an indirect
                // ref (i.e. it has an object number we can look up) and it is
                // not still referenced by any other page's XObject dictionary.
                if (entry instanceof PDFRef) {
                  let stillReferenced = false;
                  for (const page of out.getPages()) {
                    const pgResources = page.node.get(PDFName.of('Resources'));
                    const pgResourceDict =
                      pgResources instanceof PDFDict
                        ? pgResources
                        : pgResources instanceof PDFRef
                          ? (out.context.lookup(pgResources) as PDFDict | undefined)
                          : undefined;
                    if (!pgResourceDict) continue;
                    const pgXObjectRaw = pgResourceDict.get(PDFName.of('XObject'));
                    const pgXObjects =
                      pgXObjectRaw instanceof PDFDict
                        ? pgXObjectRaw
                        : pgXObjectRaw instanceof PDFRef
                          ? (out.context.lookup(pgXObjectRaw) as PDFDict | undefined)
                          : undefined;
                    if (!pgXObjects) continue;
                    for (let xi = 0; xi < pgXObjects.keys().length; xi++) {
                      if (pgXObjects.get(pgXObjects.keys()[xi]) === entry) {
                        stillReferenced = true;
                        break;
                      }
                    }
                    if (stillReferenced) break;
                  }
                  if (!stillReferenced) {
                    // Remove the object from the context's indirect-object table
                    // so pdf-lib's serialiser does not write orphaned image bytes.
                    // `indirectObjects` is private on PDFContext, but the underlying
                    // Map is the only way to surgically remove one object without
                    // rebuilding the whole context. The cast is intentional.
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (out.context as any).indirectObjects.delete(entry);
                  }
                }
              }
            }
          }
        }

        // 2c. Strip PDF annotations that overlap a redacted region.
        const annotsRaw = copied.node.get(PDFName.of('Annots'));
        const annotsRef = annotsRaw instanceof PDFRef ? annotsRaw : null;
        const annotsArray =
          annotsRaw instanceof PDFArray
            ? annotsRaw
            : annotsRef
              ? (out.context.lookup(annotsRef) as PDFArray | undefined)
              : undefined;

        if (annotsArray) {
          const keptAnnotRefs: unknown[] = [];
          for (let a = 0; a < annotsArray.size(); a++) {
            const annotRef = annotsArray.get(a);
            const annotDict =
              annotRef instanceof PDFDict
                ? annotRef
                : annotRef instanceof PDFRef
                  ? (out.context.lookup(annotRef) as PDFDict | undefined)
                  : undefined;

            if (!annotDict) {
              keptAnnotRefs.push(annotRef);
              continue;
            }

            const rectArr = annotDict.get(PDFName.of('Rect'));
            if (!(rectArr instanceof PDFArray) || rectArr.size() < 4) {
              keptAnnotRefs.push(annotRef);
              continue;
            }

            const llx = (rectArr.get(0) as PDFNumber).asNumber();
            const lly = (rectArr.get(1) as PDFNumber).asNumber();
            const urx = (rectArr.get(2) as PDFNumber).asNumber();
            const ury = (rectArr.get(3) as PDFNumber).asNumber();
            const annotBox: Rect = {
              x: Math.min(llx, urx),
              y: Math.min(lly, ury),
              width: Math.abs(urx - llx),
              height: Math.abs(ury - lly)
            };

            let annotOverlaps = false;
            for (const r of rects) {
              if (!(
                annotBox.x >= r.x + r.width ||
                annotBox.x + annotBox.width <= r.x ||
                annotBox.y >= r.y + r.height ||
                annotBox.y + annotBox.height <= r.y
              )) {
                annotOverlaps = true;
                break;
              }
            }

            if (!annotOverlaps) {
              keptAnnotRefs.push(annotRef);
            }
          }

          // Rebuild the Annots array with only the surviving refs.
          // Use a PDFArray directly rather than context.obj() to avoid the
          // LiteralArray overload mismatch (keptAnnotRefs is unknown[]).
          const newAnnots = PDFArray.withContext(out.context);
          for (const ref of keptAnnotRefs) {
            newAnnots.push(ref as PDFRef);
          }
          copied.node.set(PDFName.of('Annots'), newAnnots);
        }
      }

      // 3. Draw the opaque marks on top as well
      for (const region of regionsByPage.get(i) ?? []) {
        const cs = normalizedToContentSpace(region);
        copied.drawRectangle({
          x: cs.x,
          y: cs.y,
          width: cs.width,
          height: cs.height,
          color: DOC_REDACT,
          borderWidth: 0
        });
      }
    }

    reattachAcroForm(out, [source]);
    await checkpoint(job, 0.95, 'Writing file');
    return transfer(await out.save({ useObjectStreams: true }));
  },

  async collectOffPageText(bytes) {
    const doc = await load(bytes);
    const found: string[] = [];

    const decode = (value: unknown): string | undefined => {
      if (value instanceof PDFString || value instanceof PDFHexString) {
        try {
          return value.decodeText();
        } catch {
          return undefined;
        }
      }
      return undefined;
    };

    for (const page of doc.getPages()) {
      const annotsRaw = page.node.get(PDFName.of('Annots'));
      const annots =
        annotsRaw instanceof PDFArray
          ? annotsRaw
          : annotsRaw instanceof PDFRef
            ? doc.context.lookupMaybe(annotsRaw, PDFArray)
            : undefined;
      if (!annots) continue;
      for (let i = 0; i < annots.size(); i++) {
        const ref = annots.get(i);
        const dict = ref instanceof PDFDict ? ref : doc.context.lookupMaybe(ref, PDFDict);
        if (!dict) continue;
        const contents = decode(dict.get(PDFName.of('Contents')));
        if (contents) found.push(contents);
      }
    }

    try {
      const form = doc.getForm();
      for (const field of form.getFields()) {
        if (field instanceof PDFTextField) {
          const text = field.getText();
          if (text) found.push(text);
        } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
          found.push(...field.getSelected());
        }
      }
    } catch {
      // No AcroForm, or a malformed one — nothing to collect.
    }

    return found;
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

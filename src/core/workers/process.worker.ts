import { pseudoLinearize } from '../pdf/linearize';
/**
 * DOC-12 — vendored, not fetched: `?inline` forces Vite to bundle this as a
 * base64 data URI at build time, so there is no `fetch()`/network call of any
 * kind to load it (the OCR font asset's own `fetch()` of a bundled file is
 * only permitted because `src/core/ocr/` is explicitly carved out of the
 * invariant hook's network-API ban — this avoids needing that exemption at
 * all). Liberation Sans Regular, metric-compatible with Arial and already
 * vendored via `pdfjs-dist` for pdf.js's own non-embedded-font rendering path
 * (see `pdfjs-setup.ts`) — copied into `src/core/pdf/assets/` alongside its
 * license text rather than imported across the `node_modules` boundary.
 */
import liberationSansRegularDataUrl from '../pdf/assets/LiberationSans-Regular.ttf?inline';
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
  decodePDFRawStream,
  StandardFonts,
  LineCapStyle,
  rgb,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState
} from 'pdf-lib';
import type { PDFField, PDFImage, PDFContext, PDFEmbeddedPage } from 'pdf-lib';
import { Encodings, Font as StandardFontMetrics, FontNames } from '@pdf-lib/standard-fonts';
import type { IFontNames } from '@pdf-lib/standard-fonts';
import { zipSync } from 'fflate';
import type { JobHandle } from './protocol';
import { checkpoint, subJob } from './protocol';
import { corrupt, encrypted, internal, unsupported } from '../errors';
import type { ImagesToPdfOptions } from '../operations';
import type { ImageResultStat } from '../compress-report';
import { DOC_HAIRLINE_RGB, DOC_INK_RGB, DOC_REDACT_RGB } from '../doc-colors';
import { markdownToPdfBytes, hadUnsupportedCharacter } from '../markdown-to-pdf';
import { batesLabel } from '../bates';
import { generateQrRaster, encodeCode128Bars } from '../barcode';
import { encodePng } from '../png';
import { addOcrTextLayerToDocument } from '../ocr/textLayer';
import type { OcrLayerReport, OcrPageLayer } from '../ocr/types';
import {
  normalizeRotation,
  displayFrame,
  displayPointToPage,
  placeDisplayBox,
  type DisplayFrame
} from '../rotation';
import {
  tokenizeContentStream,
  parseContentStream,
  filterContentStream,
  serializeStatements,
  decodeStream,
  areaTouches
} from '../pdf/interpreter';
import type { Rect, RedactionArea, GraphicsState, Matrix } from '../pdf/interpreter';
import { hasXfaMarker, XFA_COMPOSE_MESSAGE, XFA_MESSAGE } from '../pdf/xfa';
import { encryptPdf, type ProtectionSettings } from '../pdf/encrypt';
import { applyAltTextToDoc } from '../pdf/accessibility';

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
  type:
    'freehand' | 'highlight' | 'rectangle' | 'ellipse' | 'arrow' | 'text' | 'sticky' | 'whiteout';
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
 * SGN-09 — one `/Sig` field's own `/ByteRange` and whether it reaches the
 * current end of file. A structural check, not PAdES/CMS cryptographic
 * validation: it answers "were bytes appended after this signature was
 * applied", not "is the signature's cryptographic hash valid".
 */
export interface SignatureFieldIntegrity {
  fieldName: string;
  byteRange: [number, number, number, number];
  reachesEndOfFile: boolean;
}

/**
 * DOC-12 — one non-embedded font, with a subset tag (`ABCDEF+`) already stripped
 * from `baseFont` so `Arial` reads as `Arial`, not `EOODIA+Arial`.
 */
export interface FontEmbeddingFinding {
  baseFont: string;
  /** 0-based pages where this font appears without being embedded. */
  pages: number[];
  /**
   * A pdf-lib standard-14 font name this can be safely re-embedded as, or
   * `null` when there is none. Only the standard 14 are offered: substituting
   * an arbitrary font program risks a glyph-mapping mismatch this codebase's
   * "never silently corrupt a document" rule cannot allow — see the ticket
   * writeup for why a real local-font-file match is deliberately not attempted.
   */
  standardFontMatch: string | null;
}

export interface FontEmbeddingReport {
  findings: FontEmbeddingFinding[];
}

export interface SignatureIntegrityReport {
  hasSignature: boolean;
  /**
   * Whether the *outermost* signature (the one whose `/ByteRange` covers the
   * most of the file — the last one applied, for a document signed more than
   * once) reaches the file's current end. `null` when there is no signature to
   * judge. An earlier signature's own range legitimately stops short once a
   * later signature adds more bytes after it, so only the outermost one's
   * reach matters for "was anything appended after signing".
   */
  intact: boolean | null;
  signatures: SignatureFieldIntegrity[];
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
  /**
   * RED-07 — a freehand/polygon mark's outline, in the same normalised
   * page-fraction space (origin top-left) as `x`/`y`/`width`/`height`, which
   * continue to hold its bounding box.
   *
   * Deliberately an optional field on the one region shape rather than a second
   * kind of mark: everything that only understands rectangles — `groupRegionsByPage`,
   * the pixel verifier's render window, the annotation sweep's box test, the UI's
   * mark list and arrow-key nudging — keeps working on the bounding box, and only
   * the three predicates that decide what is *inside* a mark learn about shapes.
   */
  points?: { x: number; y: number }[];
}

/**
 * One image XObject that a redaction mark partly covers, and the part of it that
 * has to be destroyed.
 *
 * `name` addresses it from the page (stable across the copy into the output
 * document); `objectNumber` addresses the same image in the *source* bytes,
 * which is the only identifier pdf.js and pdf-lib agree on. Both are needed
 * because the pixel work happens in the pdf.js worker and the substitution in
 * this one.
 */
export interface ImageRedactionRequest {
  pageIndex: number;
  name: string;
  objectNumber: number;
  /**
   * Covered areas in the image's own unit square, y upwards from bottom-left.
   * A shaped mark (RED-07) carries its polygon alongside the bounding box.
   */
  rects: RedactionArea[];
}

/** A re-encoded image with the covered pixels painted opaque black. */
export interface RedactedImage {
  bytes: Uint8Array;
  format: 'png' | 'jpeg';
  width: number;
  height: number;
}

/** `pageIndex → /XObject resource name → replacement`. */
export type RedactedImageReplacements = Record<number, Record<string, RedactedImage>>;

/**
 * RED-08 — one image XObject a page draws, addressed both ways.
 *
 * Same two-identifier problem `ImageRedactionRequest` has: `name` addresses it
 * from the page for pdf-lib, `objectNumber` addresses the same stream for
 * pdf.js. An image reused on twenty pages appears once per page here, with the
 * same `objectNumber` every time — which is what lets the caller decode and
 * encode it exactly once.
 */
export interface PageImageRef {
  pageIndex: number;
  name: string;
  objectNumber: number;
}

export interface TextLayerParams {
  scale: number;
  width: number;
  height: number;
}

export interface ImageAltInfo {
  pageIndex: number;
  objectNumber: number;
  name: string;
  width: number;
  height: number;
  ext: string;
  bytes: Uint8Array;
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

/**
 * OPS-10 — one `/Outlines` entry, flattened to what this codebase can round-trip.
 *
 * `pageIndex` is an index into the document's page list, or `-1` when the entry has
 * no destination this code resolves. That is the same narrow reading OPS-01's
 * `copyOutlines` documents: a named destination (a name-tree lookup pdf-lib has no
 * API for) or a non-`GoTo` action is *reported* as unresolved rather than guessed
 * at, so the editor can say so instead of silently repointing it at page 1.
 */
export interface OutlineNode {
  title: string;
  pageIndex: number;
  children: OutlineNode[];
}

/** OPS-11 — a Bates stamp, resolved to what the drawing code needs. */
export interface BatesData {
  prefix: string;
  digits: number;
  start: number;
  /** One of the nine `positionOrigin` grid points, e.g. `bottom-right`. */
  position: string;
  fontSize: number;
}

/**
 * OPS-18 — a QR/barcode stamp, drawn by the same OPS-08 grid engine as Bates,
 * and like Bates applied to every exported page — no page-range targeting.
 */
export interface BarcodeStampData {
  kind: 'qr' | 'code128';
  text: string;
  /** One of the nine `positionOrigin` grid points, e.g. `bottom-right`. */
  position: string;
  /** Fraction of the page width the stamp should occupy. */
  scale: number;
}

/**
 * Late-added, optional composition inputs.
 *
 * A bag rather than four more positional parameters: `compose` already takes nine,
 * and appending to that list means every existing call site (and every test) has to
 * be re-counted to keep `job` in the right slot. Structured-clones fine over Comlink.
 */
export interface ComposeExtras {
  /**
   * OPS-10. `undefined` keeps OPS-01's behaviour of carrying the source documents'
   * outlines through; an array (including an empty one) *replaces* them with exactly
   * this tree, whose `pageIndex` values index the composed output's pages.
   */
  outline?: OutlineNode[];
  /** OPS-11. Stamped on every page, numbered from `start` in output page order. */
  bates?: BatesData;
  /** OPS-18. A QR/barcode stamp, encoding `barcodeStamp.text` on every targeted page. */
  barcodeStamp?: BarcodeStampData;
  /**
   * OPS-12. One filename per output slice, used instead of `${baseName}-NN.pdf`.
   * Split only; ignored by `compose`.
   */
  fileNames?: string[];
  formFieldsToCreate?: import('../operations').NewFormField[];
  /**
   * Composes an XFA document anyway, accepting that its dynamic-form payload is
   * lost and the export becomes a static page. Set only by the tools that offer
   * exactly that as the workaround (sign and annotate); every other path refuses
   * rather than hand back a form whose fields have quietly stopped working.
   */
  allowXfaLoss?: boolean;
}

export interface ProcessJob {
  inspect(bytes: Uint8Array): Promise<DocumentFacts>;
  imageInventory(bytes: Uint8Array, job?: JobHandle): Promise<PageImageInventory[]>;
  getFormFields(
    bytes: Uint8Array,
    job?: JobHandle
  ): Promise<{ isXfa: boolean; fields: FormFieldData[] }>;
  /** SGN-09 — structural signature/tamper check. See `SignatureIntegrityReport`. */
  checkSignatureIntegrity(bytes: Uint8Array): Promise<SignatureIntegrityReport>;
  /** DOC-12 — which fonts are not embedded. See `FontEmbeddingReport`. */
  checkFontEmbedding(bytes: Uint8Array): Promise<FontEmbeddingReport>;
  /** DOC-12 — re-embeds every non-embedded occurrence of `baseFont` as its standard-14 match. */
  embedMissingFont(bytes: Uint8Array, baseFont: string): Promise<Uint8Array>;
  fillFormFields(
    bytes: Uint8Array,
    values: Record<string, string | boolean | string[]>,
    flatten: boolean,
    job?: JobHandle
  ): Promise<Uint8Array>;
  /**
   * SGN-05 — bakes interactive content into the page and removes it.
   *
   * Separate from `fillFormFields`'s `flatten` argument, which only reaches the
   * form: this also flattens annotation dictionaries the document already
   * carried. Returns the report alongside the bytes so the caller states what
   * was lost (a link's clickability) instead of asserting success.
   */
  flattenDocument(
    bytes: Uint8Array,
    job?: JobHandle
  ): Promise<{ bytes: Uint8Array } & FlattenReport>;
  flattenBackground(
    bytes: Uint8Array,
    pageIndex: number | 'all',
    hexColor: string,
    job?: JobHandle
  ): Promise<{ bytes: Uint8Array; changed: boolean }>;
  compose(
    pages: PageSource[],
    sources: Record<string, Uint8Array>,
    stamps: StampSource[],
    watermark?: WatermarkData,
    headerFooter?: HeaderFooterData,
    normalize?: import('../../ui/tools/normalize/state').NormalizeSettings | null,
    nup?: import('../../ui/tools/nup/state').NUpSettings | null,
    annotations?: AnnotationSource[],
    job?: JobHandle,
    extras?: ComposeExtras
  ): Promise<Uint8Array>;
  /** OPS-10 — the document's existing outline, as an editable tree. */
  readOutline(bytes: Uint8Array): Promise<OutlineNode[]>;
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
    job?: JobHandle,
    extras?: ComposeExtras
  ): Promise<{ isZip: boolean; bytes: Uint8Array }>;
  /**
   * Rebuilds `bytes` with the given pages replaced by rasters and the given image
   * XObjects re-encoded. Returns the original bytes untouched if the result is
   * not smaller (CMP-04), or if no image was actually re-encoded and no page
   * rasterised — a rebuild with no compression work in it changes the byte length
   * through re-serialisation alone, and reporting that as a saving would credit
   * compression for something it did not do.
   *
   * `imageStats` is the measured per-image breakdown CMP-06's sidecar prints:
   * every image the caller asked about, with the original stream's stored byte
   * length, the replacement's, and why anything skipped was skipped.
   */
  rebuildCompressed(
    bytes: Uint8Array,
    rasterPages: Record<number, Uint8Array>,
    replacedImages: Record<
      number,
      Record<number, { jpeg: Uint8Array; width: number; height: number; maskBytes?: Uint8Array }>
    >,
    job?: JobHandle
  ): Promise<{ bytes: Uint8Array; keptOriginal: boolean; imageStats: ImageResultStat[] }>;
  imagesToPdf(
    images: Uint8Array[],
    options?: ImagesToPdfOptions,
    job?: JobHandle
  ): Promise<Uint8Array>;
  /**
   * CNV-06 — every embedded image XObject as its own file, in a ZIP. Never
   * re-renders and never re-encodes; an image it cannot hand over natively is
   * reported in `entries` rather than written out approximately.
   */
  extractImages(
    bytes: Uint8Array,
    pageIndices: number[] | null,
    job?: JobHandle
  ): Promise<ExtractedImages>;
  /** ACC-01 — returns thumbnails of all images for the alt-text editor */
  findImagesForAltText(bytes: Uint8Array, job: JobHandle): Promise<ImageAltInfo[]>;
  /** ACC-01 — applies alt-text mapping and rewrites the Structure Tree */
  applyAltText(
    bytes: Uint8Array,
    altTexts: Record<string, string>,
    job?: JobHandle
  ): Promise<Uint8Array>;

  markdownToPdf(
    markdown: string
  ): Promise<{ bytes: Uint8Array; hadUnsupportedCharacters: boolean }>;
  readMetadata(bytes: Uint8Array): Promise<MetadataFindings>;
  scrubMetadata(bytes: Uint8Array, settings?: ScrubSettings, job?: JobHandle): Promise<Uint8Array>;
  /**
   * RED-06 — encrypts the *exported* bytes. The document in the workspace is
   * never touched; this runs on the copy that is about to be written to disk.
   */
  protectDocument(
    bytes: Uint8Array,
    settings: ProtectionSettings,
    job?: JobHandle
  ): Promise<Uint8Array>;
  /**
   * Applies redactions through operator-level content removal, removing intersecting text
   * and image objects from the content stream while keeping the rest of the page selectable.
   */
  applyRedactions(
    bytes: Uint8Array,
    regions: RedactionRegion[],
    imageReplacements?: RedactedImageReplacements,
    job?: JobHandle
  ): Promise<Uint8Array>;
  /**
   * Every image XObject a redaction mark only *partly* covers, with the covered
   * area in the image's own unit space.
   *
   * Run before {@link ProcessJob.applyRedactions}: the caller decodes each one
   * with pdf.js, paints those rectangles opaque black into the pixels, and hands
   * the result back as `imageReplacements`. Without that round trip a partly
   * covered image keeps its original pixels — the black rectangle drawn on the
   * page is an overlay, and the "redacted" content comes straight back out of
   * `pdfimages`.
   */
  planImageRedactions(
    bytes: Uint8Array,
    regions: RedactionRegion[]
  ): Promise<ImageRedactionRequest[]>;
  /**
   * RED-08 — every image XObject the given pages draw.
   *
   * Unlike {@link ProcessJob.planImageRedactions} this is not driven by marks:
   * face blur has to look at every embedded image, because that is where a face
   * can be. A direct (non-indirect) image XObject is skipped rather than
   * refused — it cannot be addressed by object number, so pdf.js and pdf-lib
   * could not agree on which stream it is, and reporting "0 faces found" for a
   * page that has one would be the silent failure this ticket exists to avoid.
   * The skipped names come back so the caller can say so out loud.
   */
  planPageImages(
    bytes: Uint8Array,
    pageIndices?: number[]
  ): Promise<{ images: PageImageRef[]; unaddressablePages: number[] }>;
  /**
   * RED-08 — substitutes image XObjects and changes nothing else.
   *
   * Deliberately *not* a rebuild through `PDFDocument.create()` + `copyPages`
   * the way {@link ProcessJob.applyRedactions} is. Face blur touches pixels
   * only: every content stream, font, annotation and vector on the page must
   * come out byte-identical, and the cheapest way to guarantee that is to never
   * take them apart. The old image streams are purged once nothing names them,
   * so the unblurred original does not stay in the file.
   */
  replacePageImages(
    bytes: Uint8Array,
    replacements: RedactedImageReplacements,
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
  /**
   * OCR-01 — writes recognised words back as an invisible text layer.
   *
   * Additive only: nothing already in the file is rewritten, so the page still
   * draws exactly what it drew before (see `core/ocr/textLayer.ts`). Returns the
   * original bytes unchanged when there was nothing to add, rather than round-
   * tripping the document through a save for no reason.
   */
  addOcrTextLayer(
    bytes: Uint8Array,
    layers: OcrPageLayer[],
    job?: JobHandle
  ): Promise<{ bytes: Uint8Array } & OcrLayerReport>;
  /**
   * DOC-09 — contact sheet export.
   *
   * Tiles pre-rendered JPEG page images into a grid of `cols` columns on
   * A4 portrait PDF pages. The caller (operations.ts) renders the bitmaps
   * via the render worker first; this function only does the PDF assembly.
   */
  contactSheetExport(jpegPages: Uint8Array[], cols: number, job?: JobHandle): Promise<Uint8Array>;
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

/** OPS-18 — a CODE128 stamp never draws shorter than this, in points (~0.28in). */
const CODE128_MIN_STAMP_HEIGHT_PT = 20;

/**
 * OPS-18 — a CODE128 stamp never draws a single module (bar or space)
 * narrower than this, in points (~0.014in, inside the usual 10-20 mil
 * "X-dimension" quality guidance for general-purpose barcode scanning).
 * Below this, a moderate-length value squeezed into a small "Size" setting
 * degrades to a fraction of a device pixel per module at ordinary print/scan
 * resolutions and a real decoder cannot tell one bar width from another —
 * confirmed live: the same "Size" slider that gives a QR code a clean,
 * decodable stamp produced an undecodable CODE128 at its default and even
 * its 20%-of-page-width settings for a 14-character value, purely from module
 * width, not from anything wrong in how the bars were drawn.
 */
const CODE128_MIN_MODULE_WIDTH_PT = 1;

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

async function drawStamps(
  outDoc: PDFDocument,
  page: ReturnType<PDFDocument['addPage']>,
  stamps: StampSource[],
  fontCache: { font?: Awaited<ReturnType<PDFDocument['embedFont']>> },
  imageCache: Map<string, PDFImage>,
  frame: DisplayFrame
) {
  if (stamps.length === 0) return;
  // `page.getSize()` is always the raw, unrotated MediaBox — pdf-lib never factors
  // in `/Rotate` there. Stamp coordinates come from the sign UI, which places them
  // against the page as pdf.js *displays* it, i.e. already rotated. Treating those
  // two frames as the same one put every stamp at a transposed, wrong-sized
  // position; `frame` is the shared inverse mapping between them.
  const { displayWidth, displayHeight } = frame;

  for (const stamp of stamps) {
    // Stamp coordinates are top-left origin in display space; `placeDisplayBox`
    // takes a bottom-left origin, so flip y once here.
    const w = stamp.width * displayWidth;
    const h = stamp.height * displayHeight;
    const left = stamp.x * displayWidth;
    const bottom = displayHeight - (stamp.y * displayHeight + h);

    const rot = stamp.rotation ?? 0;

    // The user's clockwise on-screen rotation `rot` must survive the page's own
    // display rotation too: content drawn at angle (frame.rotation - rot) here
    // comes out as a clockwise `rot` once the viewer applies /Rotate on top of it.
    // This reduces to the original `-rot` when the page is unrotated.
    const {
      x: drawX,
      y: drawY,
      rotate: drawAngle
    } = placeDisplayBox(frame, left, bottom, w, h, -rot);
    const rad = (drawAngle * Math.PI) / 180;

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
        rotate: degrees(drawAngle)
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
      rotate: degrees(drawAngle)
    });
  }
}

/** Cheap content hash, enough to dedupe identical embedded images. */
/**
 * A ZIP entry name that has not been used yet.
 *
 * OPS-12 names files after bookmark titles, and two chapters legitimately share a
 * title ("Appendix" twice) — a `Record` keyed by name would silently keep only the
 * last of them, i.e. lose a slice of the user's document. Collisions get a numeric
 * suffix instead.
 */
function uniqueName(used: Set<string>, preferred: string | undefined, fallback: string): string {
  const stem = (preferred ?? '').trim() || fallback;
  let candidate = `${stem}.pdf`;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${stem}-${counter}.pdf`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

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
/**
 * Every named destination in a document, as name → destination array.
 *
 * Both spellings are read: the pre-1.2 `/Dests` dictionary in the catalog, and
 * the `/Names /Dests` name tree (which is what every modern producer writes, and
 * which nests through `/Kids`). Without this, `resolveDestPageIndex` saw a name
 * rather than a page reference and gave up — so every bookmark in a document
 * whose outline uses named destinations, which is most of them, was dropped from
 * merged, split and organised output without a word.
 */
function namedDestinations(doc: PDFDocument): Map<string, PDFArray> {
  const found = new Map<string, PDFArray>();

  const record = (key: string, value: unknown) => {
    const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
    // A destination is either the array itself or a dict with a /D entry.
    const array =
      resolved instanceof PDFArray
        ? resolved
        : resolved instanceof PDFDict
          ? resolved.lookupMaybe(PDFName.of('D'), PDFArray)
          : undefined;
    if (array && !found.has(key)) found.set(key, array);
  };

  const legacy = doc.catalog.lookupMaybe(PDFName.of('Dests'), PDFDict);
  for (const [key, value] of legacy?.entries() ?? []) {
    record(key.asString().replace(/^\//, ''), value);
  }

  const walkTree = (node: PDFDict | undefined, depth: number) => {
    if (!node || depth > 32) return;
    const names = node.lookupMaybe(PDFName.of('Names'), PDFArray);
    for (let i = 0; names && i + 1 < names.size(); i += 2) {
      const key = names.lookup(i);
      if (key instanceof PDFString || key instanceof PDFHexString) {
        record(key.decodeText(), names.get(i + 1));
      }
    }
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    for (let i = 0; kids && i < kids.size(); i++) {
      walkTree(kids.lookupMaybe(i, PDFDict), depth + 1);
    }
  };
  walkTree(
    doc.catalog
      .lookupMaybe(PDFName.of('Names'), PDFDict)
      ?.lookupMaybe(PDFName.of('Dests'), PDFDict),
    0
  );

  return found;
}

function resolveDestPageIndex(
  item: PDFDict,
  refIndex: Map<number, number>,
  named?: Map<string, PDFArray>
): number | undefined {
  let dest = item.lookup(PDFName.of('Dest'));
  if (dest === undefined) {
    const action = item.lookupMaybe(PDFName.of('A'), PDFDict);
    if (action && nameOf(action.get(PDFName.of('S'))) === 'GoTo') {
      dest = action.lookup(PDFName.of('D'));
    }
  }

  // A named destination: `/Dest /chapter1` or `/Dest (chapter1)`, resolved
  // through the document's own name table.
  if (dest instanceof PDFName || dest instanceof PDFString || dest instanceof PDFHexString) {
    const key = dest instanceof PDFName ? dest.asString().replace(/^\//, '') : dest.decodeText();
    dest = named?.get(key);
  }

  if (!(dest instanceof PDFArray) || dest.size() === 0) return undefined;
  const target = dest.get(0);
  // A page *index* is legal in a remote destination, but here the first element
  // is a reference to a page in this document.
  if (!(target instanceof PDFRef)) return undefined;
  return refIndex.get(target.objectNumber);
}

/** Walks one level of `/First`→`/Next` siblings under `parent`, recursing into each's own children. */
function walkSourceOutline(
  parent: PDFDict,
  refIndex: Map<number, number>,
  pageRefMap: Map<string, PDFRef>,
  sourceDocId: string,
  visited: Set<PDFDict>,
  named?: Map<string, PDFArray>
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
    const sourceIndex = resolveDestPageIndex(cur, refIndex, named);
    const destPageRef =
      sourceIndex !== undefined ? pageRefMap.get(`${sourceDocId}:${sourceIndex}`) : undefined;
    const children = walkSourceOutline(cur, refIndex, pageRefMap, sourceDocId, visited, named);
    if (destPageRef || children.length > 0) {
      result.push({ title, destPageRef, children });
    }
    cur = cur.lookupMaybe(PDFName.of('Next'), PDFDict);
  }
  return result;
}

/**
 * Reads one level of `/First`→`/Next` siblings as editable `OutlineNode`s (OPS-10).
 *
 * Unlike `walkSourceOutline`, nothing is dropped: an entry whose destination this
 * code cannot resolve comes back with `pageIndex: -1` so the editor can show it and
 * say what is wrong with it, rather than the entry vanishing from the user's tree.
 */
function readOutlineNodes(
  parent: PDFDict,
  refIndex: Map<number, number>,
  visited: Set<PDFDict>,
  named?: Map<string, PDFArray>
): OutlineNode[] {
  const result: OutlineNode[] = [];
  let cur = parent.lookupMaybe(PDFName.of('First'), PDFDict);
  while (cur && !visited.has(cur)) {
    visited.add(cur);
    const titleValue = cur.lookup(PDFName.of('Title'));
    const title =
      titleValue instanceof PDFString || titleValue instanceof PDFHexString
        ? titleValue.decodeText()
        : 'Untitled';
    result.push({
      title,
      pageIndex: resolveDestPageIndex(cur, refIndex, named) ?? -1,
      children: readOutlineNodes(cur, refIndex, visited, named)
    });
    cur = cur.lookupMaybe(PDFName.of('Next'), PDFDict);
  }
  return result;
}

/**
 * A title string safe to write back.
 *
 * Always hex/UTF-16BE: `PDFString.of` writes its argument between parentheses
 * without escaping, so a user-typed title containing `)` or `\` would produce a
 * syntactically broken outline dictionary, and any non-Latin-1 character would be
 * mangled on the way out.
 */
function outlineTitle(text: string): PDFHexString {
  return PDFHexString.fromText(text);
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
    const dict = ctx.obj({ Title: outlineTitle(item.title), Parent: parentRef }) as PDFDict;
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
      new Set<PDFDict>(),
      namedDestinations(srcDoc)
    );
    allRetained.push(...retained);
  }
  attachOutline(outDoc, allRetained);
}

/** Writes `items` as `outDoc`'s `/Outlines`, or leaves the catalog alone if empty. */
function attachOutline(outDoc: PDFDocument, items: RetainedOutlineItem[]): void {
  if (items.length === 0) return;
  const ctx = outDoc.context;
  const outlinesDict = ctx.obj({ Type: 'Outlines' }) as PDFDict;
  const outlinesRef = ctx.register(outlinesDict);
  const { firstRef, lastRef, count } = registerOutlineSiblings(ctx, items, outlinesRef);
  if (!firstRef) return;
  outlinesDict.set(PDFName.of('First'), firstRef);
  outlinesDict.set(PDFName.of('Last'), lastRef!);
  outlinesDict.set(PDFName.of('Count'), PDFNumber.of(count));
  outDoc.catalog.set(PDFName.of('Outlines'), outlinesRef);
}

/**
 * OPS-10 — writes a user-authored outline over the composed document.
 *
 * `pageIndex` addresses the *output* pages, so an entry whose page was deleted or
 * whose index is out of range becomes a bare heading rather than a dangling
 * destination; an entry the editor never resolved (`-1`) stays a heading too.
 */
function writeOutline(outDoc: PDFDocument, nodes: OutlineNode[]): void {
  const pages = outDoc.getPages();
  const convert = (node: OutlineNode): RetainedOutlineItem => ({
    title: node.title,
    destPageRef: pages[node.pageIndex]?.ref,
    children: node.children.map(convert)
  });
  attachOutline(outDoc, nodes.map(convert));
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

/**
 * Gives an `/AcroForm` the default resources its fields' `/DA` strings assume.
 *
 * pdf-lib's `form.createTextField()` writes each field a `/DA` of
 * `0 0 0 rg /Helvetica 15 Tf` and builds an `/AcroForm` containing nothing but
 * `/Fields`. `/Helvetica` is a *resource name*, looked up in the form's `/DR`
 * — which does not exist — so the only reason a freshly created field renders
 * at all is the appearance stream pdf-lib happens to bake at `addToPage` time.
 * The moment anything regenerates appearances (a viewer honouring
 * `/NeedAppearances`, a fill, our own flatten in `flattenDocument`) the font
 * resolves nowhere and the field draws blank or throws.
 *
 * So: one Helvetica, registered under both the name pdf-lib emits
 * (`/Helvetica`) and the name every other producer emits (`/Helv`), plus a
 * document-level `/DA` for fields that carry none of their own.
 *
 * Idempotent, and never overwrites a `/DR` or `/DA` carried in from a source
 * document — an inherited form's own defaults are more correct than ours.
 */
function ensureAcroFormDefaults(doc: PDFDocument): void {
  const form = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!form) return;

  let dr = form.lookupMaybe(PDFName.of('DR'), PDFDict);
  if (!dr) {
    dr = doc.context.obj({}) as PDFDict;
    form.set(PDFName.of('DR'), dr);
  }
  let fonts = dr.lookupMaybe(PDFName.of('Font'), PDFDict);
  if (!fonts) {
    fonts = doc.context.obj({}) as PDFDict;
    dr.set(PDFName.of('Font'), fonts);
  }

  const missing = ['Helvetica', 'Helv'].filter(n => fonts!.get(PDFName.of(n)) === undefined);
  if (missing.length > 0) {
    const helvetica = doc.embedStandardFont(StandardFonts.Helvetica);
    for (const name of missing) fonts.set(PDFName.of(name), helvetica.ref);
  }

  if (form.get(PDFName.of('DA')) === undefined) {
    form.set(PDFName.of('DA'), PDFString.of('/Helv 0 Tf 0 g'));
  }
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
      // The path is written in SVG coordinates — origin top-left, y downwards —
      // which is what `drawSvgPath` expects: it emits `1 0 0 -1 0 y cm`, flipping
      // the y axis about the `y` option. Passing `y: height` therefore maps
      // SVG y to PDF y = height - y.
      //
      // This was `height - y * height` with no `y` option at all, so the same flip
      // was applied to already-flipped coordinates and every freehand stroke and
      // highlight landed at *negative* y — off the page, invisible in the export.
      // ANN-03's e2e test reads the drawn segment's coordinates back out of the
      // exported page and would fail on the old form.
      let path = `M ${ann.points[0].x * width} ${ann.points[0].y * height}`;
      for (let i = 1; i < ann.points.length; i++) {
        path += ` L ${ann.points[i].x * width} ${ann.points[i].y * height}`;
      }
      page.drawSvgPath(path, {
        x: 0,
        y: height,
        borderColor: color,
        // Round caps and joins, matching the canvas overlay (`ctx.lineCap`), so
        // what is exported is the stroke the user saw while drawing it.
        borderLineCap: LineCapStyle.Round,
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
        borderWidth: ann.strokeWidth * width,
        opacity: 1.0
      });
    } else if (ann.type === 'ellipse' && ann.rect) {
      page.drawEllipse({
        x: ann.rect.x * width + (ann.rect.width * width) / 2,
        y: height - ann.rect.y * height - (ann.rect.height * height) / 2,
        xScale: Math.abs(ann.rect.width * width) / 2,
        yScale: Math.abs(ann.rect.height * height) / 2,
        borderColor: color,
        borderWidth: ann.strokeWidth * width,
        opacity: 1.0
      });
    } else if (ann.type === 'arrow' && ann.points && ann.points.length >= 2) {
      const start = ann.points[0];
      const end = ann.points[ann.points.length - 1];
      const x1 = start.x * width;
      const y1 = height - start.y * height;
      const x2 = end.x * width;
      const y2 = height - end.y * height;

      page.drawLine({
        start: { x: x1, y: y1 },
        end: { x: x2, y: y2 },
        thickness: ann.strokeWidth * width,
        color: color,
        opacity: 1.0
      });

      const angle = Math.atan2(y2 - y1, x2 - x1);
      const headlen = 10 + ann.strokeWidth * width;
      const h1x = x2 - headlen * Math.cos(angle - Math.PI / 6);
      const h1y = y2 - headlen * Math.sin(angle - Math.PI / 6);
      const h2x = x2 - headlen * Math.cos(angle + Math.PI / 6);
      const h2y = y2 - headlen * Math.sin(angle + Math.PI / 6);

      const path = `M ${x2} ${height - y2} L ${h1x} ${height - h1y} M ${x2} ${height - y2} L ${h2x} ${height - h2y}`;
      page.drawSvgPath(path, {
        x: 0,
        y: height,
        borderColor: color,
        borderWidth: ann.strokeWidth * width,
        borderLineCap: LineCapStyle.Round
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
 * Catalog entries that mean the same thing however the pages were rearranged:
 * none of them is indexed by page number or points at a page object.
 */
const PAGE_INDEPENDENT_CATALOG_KEYS = [
  'ViewerPreferences',
  'MarkInfo',
  'Lang',
  'SpiderInfo',
  'PieceInfo',
  'OutputIntents',
  'Perms',
  'Legal'
];

/**
 * Everything worth carrying when the output holds the same pages, in the same
 * order, as the input — a watermark, a crop, a rotate. `/Outlines` is absent
 * deliberately: the outline is rebuilt page-ref by page-ref afterwards, and
 * copying the source's dictionary as well would leave a second, stale one in the
 * file.
 */
const FULL_CATALOG_KEYS = [
  ...PAGE_INDEPENDENT_CATALOG_KEYS,
  'StructTreeRoot',
  'OCProperties',
  'PageLabels',
  'Names',
  'Dests'
];

const REDACTION_CATALOG_KEYS = [...PAGE_INDEPENDENT_CATALOG_KEYS, 'PageLabels'];

function preserveDocumentCatalog(
  source: PDFDocument,
  out: PDFDocument,
  copier?: PDFObjectCopier,
  keys: string[] = ['Outlines', ...FULL_CATALOG_KEYS]
): void {
  const c = copier ?? PDFObjectCopier.for(source.context, out.context);
  const keysToCopy = keys;
  for (const key of keysToCopy) {
    const val = source.catalog.get(PDFName.of(key));
    if (val !== undefined && out.catalog.get(PDFName.of(key)) === undefined) {
      out.catalog.set(PDFName.of(key), c.copy(val));
    }
  }
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
  totalPages: number,
  frame: DisplayFrame
): void {
  // The top of the page is the top the *viewer* shows, not `getSize().height`:
  // laid out in display space, then mapped back through /Rotate. On a /Rotate 90
  // page the old raw-MediaBox layout put the "header" down the left-hand edge.
  const { displayWidth, displayHeight } = frame;
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
        ? (displayWidth - textWidth) / 2
        : align === 'right'
          ? displayWidth - textWidth - margin
          : margin;
    // A zero-size box: `drawText` rotates about its own anchor, so the baseline
    // start is the only point that needs mapping.
    const placed = placeDisplayBox(frame, x, y, 0, 0);
    page.drawText(text, {
      x: placed.x,
      y: placed.y,
      size,
      font,
      color: DOC_INK,
      rotate: degrees(placed.rotate)
    });
  };

  draw(settings.headerText, settings.headerAlign, displayHeight - margin - size * 0.8, 'header');
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
  globalTotal: number = pages.length,
  extras: ComposeExtras = {}
): Promise<PDFDocument> {
  // An XFA form's fields live in an XML payload hanging off /AcroForm, which no
  // page-copying rebuild carries: composing one produced a document whose
  // dynamic form was gone, with every field blank, and said nothing. The tools
  // that *deliberately* flatten an XFA form to a static page — sign and
  // annotate, which is what XFA_MESSAGE tells the user to do — opt in.
  if (!extras.allowXfaLoss) {
    for (const docId of new Set(pages.map(p => p.sourceDocId))) {
      const raw = sources[docId];
      if (raw && hasXfaMarker(raw)) throw unsupported(XFA_COMPOSE_MESSAGE);
    }
  }

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

  // OPS-11. Bold, because a Bates number is an identifier that has to stay legible
  // on a photocopy — and its own font object, so it is unaffected by whether a
  // header/footer or watermark happens to be configured too.
  const bates = extras.bates;
  const batesFont = bates ? await outDoc.embedStandardFont(StandardFonts.HelveticaBold) : undefined;

  // OPS-18 — built once here rather than once per page, the same way the image
  // watermark's `imageCache` avoids re-embedding an identical image.
  //
  // QR embeds as a raster (`generateQrRaster`): its Reed-Solomon error
  // correction tolerates the antialiasing a raster picks up between here and
  // whatever DPI a viewer/printer/scanner finally renders the page at.
  // CODE128 does not get that tolerance — a 1D barcode decodes by comparing
  // *relative bar widths*, and rasterising it the same way measurably broke
  // real-decoder round-trips in testing (the two widened/narrowed just enough
  // under antialiasing + resampling to misread as different bar codes). It is
  // built instead as a tiny one-page PDF of vector bars — geometrically exact
  // at any render resolution — and embedded as a reusable form the same way
  // `embedPng` makes a reusable image.
  const barcodeStamp = extras.barcodeStamp;
  let barcodeImage: { image: PDFImage; aspect: number } | undefined;
  let barcodeForm: { form: PDFEmbeddedPage; aspect: number; unitWidth: number } | undefined;
  if (barcodeStamp && barcodeStamp.text.trim()) {
    if (barcodeStamp.kind === 'qr') {
      const raster = generateQrRaster(barcodeStamp.text);
      const image = await outDoc.embedPng(raster.pngBytes);
      barcodeImage = { image, aspect: raster.height / raster.width };
    } else {
      const bars = encodeCode128Bars(barcodeStamp.text);
      const quiet = 10;
      const barsDoc = await PDFDocument.create();
      // Height is an arbitrary internal unit — `drawPage` below stretches it
      // to whatever `boxH` the grid places it at, uniformly, so it carries no
      // meaning of its own beyond giving the bars something to span.
      const unitHeight = 100;
      const unitWidth = bars.length + quiet * 2;
      const barsPage = barsDoc.addPage([unitWidth, unitHeight]);
      for (let i = 0; i < bars.length; i++) {
        if (bars[i] !== '1') continue;
        barsPage.drawRectangle({
          x: quiet + i,
          y: 0,
          width: 1,
          height: unitHeight,
          color: DOC_INK
        });
      }
      const [form] = await outDoc.embedPdf(barsDoc);
      barcodeForm = { form, aspect: unitHeight / unitWidth, unitWidth };
    }
  }

  // Page ranges are the user's *document* page numbers, so they are parsed and
  // matched against the whole export (`pageOffset + i`), never against a slice's
  // own indexes. Matching on the slice-local index meant "pages 1-3" watermarked
  // the first three pages of *every* file a split produced.
  const watermarkPages =
    watermarkActive && watermark ? parsePageRange(watermark.pageRange, globalTotal) : null;
  const headerFooterPages =
    headerFooterActive && headerFooter ? parsePageRange(headerFooter.pageRange, globalTotal) : null;

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
  const copiers = new Map<PDFDocument, PDFObjectCopier>();

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

    const srcPageKey = `${ref.sourceDocId}:${ref.sourceIndex}`;
    const isDuplicatePage = pageRefMap.has(srcPageKey);
    let copier = isDuplicatePage
      ? PDFObjectCopier.for(srcDoc.context, outDoc.context)
      : copiers.get(srcDoc);
    if (!copier) {
      copier = PDFObjectCopier.for(srcDoc.context, outDoc.context);
      copiers.set(srcDoc, copier);
    }

    const srcPage = srcDoc.getPage(ref.sourceIndex);
    const leaf = copier.copy(srcPage.node);
    const leafRef = outDoc.context.register(leaf);
    const copied = PDFPage.of(leaf, leafRef, outDoc);

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
    // First instance wins. A page placed twice used to overwrite its own entry,
    // so every bookmark pointing at it resolved to the *last* copy — the reader
    // jumped to the duplicate at the end of the document instead of the page the
    // outline names.
    if (!pageRefMap.has(srcPageKey)) pageRefMap.set(srcPageKey, copied.ref);

    // Every placement below — crop, watermark, header/footer, Bates, stamps —
    // works in this one frame, because that is the frame the UI overlay the user
    // drew against was rendered in.
    //
    // It deliberately carries the *source* /Rotate only, not `ref.rotation` from
    // the workspace rotate tool: `SinglePageView` nests its overlay layer inside
    // the element it applies the tool rotation to, so overlay coordinates are
    // relative to page content and stay there. Including the tool rotation here
    // (as stamp placement used to) made a page rotated after signing move and
    // spin its signature.
    const { width: rawW, height: rawH } = copied.getSize();
    const sourceRotation = normalizeRotation(copied.getRotation().angle - ref.rotation);
    const frame = displayFrame(rawW, rawH, sourceRotation);

    if (ref.cropBox) {
      // The incoming cropBox is top-left normalised [0,1] in display space.
      // Mapping two opposite corners and taking the extents is rotation-agnostic:
      // whichever corner ends up bottom-left in page space, min/max finds it.
      const c0 = displayPointToPage(
        frame,
        ref.cropBox.x * frame.displayWidth,
        ref.cropBox.y * frame.displayHeight
      );
      const c1 = displayPointToPage(
        frame,
        (ref.cropBox.x + ref.cropBox.width) * frame.displayWidth,
        (ref.cropBox.y + ref.cropBox.height) * frame.displayHeight
      );
      const cropX = Math.min(c0.x, c1.x);
      const cropY = Math.min(c0.y, c1.y);
      copied.setCropBox(cropX, cropY, Math.abs(c1.x - c0.x), Math.abs(c1.y - c0.y));
    }

    // Edge-anchored furniture — the 9-point watermark grid, the header/footer
    // band, the Bates number — is positioned against the page the reader will
    // actually see, i.e. the crop box. Laying it out against the MediaBox is how
    // a Bates number ended up outside the crop the same export had just applied,
    // clipped away with no warning. With no crop these are the same box, so an
    // uncropped page is unaffected.
    const visible = copied.getCropBox();
    const marginFrame = displayFrame(
      visible.width,
      visible.height,
      sourceRotation,
      visible.x,
      visible.y
    );

    const documentPageIndex = pageOffset + i;

    if (
      watermarkActive &&
      watermark &&
      (watermarkPages === null || watermarkPages.has(documentPageIndex))
    ) {
      // Display space, not the raw MediaBox: "bottom-right" has to mean the
      // bottom-right corner the reader sees. On a /Rotate 90 page the two are a
      // quarter turn apart, which is how a watermark ended up sideways in the
      // wrong corner.
      const { displayWidth: width, displayHeight: height } = marginFrame;
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
        const placed = placeDisplayBox(marginFrame, x, y, boxW, boxH, watermark.rotation);

        copied.drawImage(image, {
          x: placed.x,
          y: placed.y,
          width: boxW,
          height: boxH,
          opacity: watermark.opacity,
          rotate: degrees(placed.rotate)
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

        // `drawText` rotates about its own anchor, so only the baseline start
        // point needs mapping — hence the 0x0 box.
        const placed = placeDisplayBox(marginFrame, x, y, 0, 0, watermark.rotation);

        copied.drawText(displayText, {
          x: placed.x,
          y: placed.y,
          size: watermark.fontSize,
          font: watermarkFont,
          color: rgb(r, g, b),
          opacity: watermark.opacity,
          rotate: degrees(placed.rotate)
        });
      }
    }

    if (
      headerFooterActive &&
      headerFooter &&
      headerFooterFont &&
      (headerFooterPages === null || headerFooterPages.has(documentPageIndex))
    ) {
      drawHeaderFooter(
        copied,
        headerFooterFont,
        headerFooter,
        pageOffset + i,
        globalTotal,
        marginFrame
      );
    }

    if (bates && batesFont) {
      // `pageOffset` is what keeps a split run sequential across its output files:
      // the numbering follows the whole production set, not each file's own pages.
      const label = toWinAnsiOrThrow(batesLabel(bates, pageOffset + i), 'Bates number');
      const { displayWidth: width, displayHeight: height } = marginFrame;
      const textWidth = batesFont.widthOfTextAtSize(label, bates.fontSize);
      const textHeight = batesFont.heightAtSize(bates.fontSize);
      const { x, y } = positionOrigin(bates.position, width, height, textWidth, textHeight, 24);
      const placed = placeDisplayBox(marginFrame, x, y, 0, 0);
      copied.drawText(label, {
        x: placed.x,
        y: placed.y,
        size: bates.fontSize,
        font: batesFont,
        color: DOC_INK,
        rotate: degrees(placed.rotate)
      });
    }

    if (barcodeImage && barcodeStamp) {
      const { displayWidth: width, displayHeight: height } = marginFrame;
      const boxW = Math.min(width * barcodeStamp.scale, Math.max(0, width - 48));
      const boxH = boxW * barcodeImage.aspect;
      const { x, y } = positionOrigin(barcodeStamp.position, width, height, boxW, boxH, 24);
      const placed = placeDisplayBox(marginFrame, x, y, boxW, boxH);
      copied.drawImage(barcodeImage.image, {
        x: placed.x,
        y: placed.y,
        width: boxW,
        height: boxH,
        rotate: degrees(placed.rotate)
      });
    }

    if (barcodeForm && barcodeStamp) {
      const { displayWidth: width, displayHeight: height } = marginFrame;
      // Width floors at a safe module width — see `CODE128_MIN_MODULE_WIDTH_PT`
      // — before the "Size" fraction is even considered, so a long value at a
      // small setting still scans; the setting can only make it *bigger*.
      // Then ceilinged to the page's own margin frame: a long enough value
      // (e.g. a full URL) needs more width than the floor guarantees to stay
      // scannable, and without this a barcode comfortably wider than the page
      // was clipped at the edge — invisible past the crop, not merely small.
      // Fitting on the page wins over the scannability floor when the two
      // genuinely conflict; a barcode that runs off the page scans as nothing
      // regardless of its module width.
      const boxW = Math.min(
        Math.max(width * barcodeStamp.scale, barcodeForm.unitWidth * CODE128_MIN_MODULE_WIDTH_PT),
        Math.max(0, width - 48)
      );
      // A 1D barcode's scannable height has nothing to do with how many
      // characters it encodes, unlike a QR code, which must stay square: a
      // long value at a modest width slider would otherwise scale down to a
      // sliver under a scanner's reliable read height. A fixed floor keeps it
      // legible regardless of scale or text length.
      const boxH = Math.max(boxW * barcodeForm.aspect, CODE128_MIN_STAMP_HEIGHT_PT);
      const { x, y } = positionOrigin(barcodeStamp.position, width, height, boxW, boxH, 24);
      const placed = placeDisplayBox(marginFrame, x, y, boxW, boxH);
      copied.drawPage(barcodeForm.form, {
        x: placed.x,
        y: placed.y,
        width: boxW,
        height: boxH,
        rotate: degrees(placed.rotate)
      });
    }

    await drawStamps(outDoc, copied, stampsByPage.get(ref.key) ?? [], fontCache, imageCache, frame);
    await drawAnnotations(outDoc, copied, annotationsByPage.get(ref.key) ?? [], fontCache);
  }

  if (nup) {
    // N-up rebuilds every page as an embedded form XObject, so widgets no longer
    // have a page of their own to sit on. Carrying /AcroForm there would point
    // fields at pages that no longer exist — worse than losing them.
    return applyNUp(outDoc, nup, job);
  }

  reattachAcroForm(outDoc, contributors);

  if (extras.formFieldsToCreate && extras.formFieldsToCreate.length > 0) {
    const form = outDoc.getForm();
    for (const fieldSpec of extras.formFieldsToCreate) {
      const pageIndex = pages.findIndex(p => p.key === fieldSpec.pageKey);
      if (pageIndex < 0 || pageIndex >= outDoc.getPageCount()) continue;
      const page = outDoc.getPage(pageIndex);
      const ref = pages[pageIndex];
      const crop = page.getCropBox();
      // Field annotations come from the same top-left, displayed overlay as
      // stamps. Widget rectangles themselves stay axis-aligned in raw PDF
      // space, so map both display corners and take their extents.
      const fieldFrame = displayFrame(
        crop.width,
        crop.height,
        normalizeRotation(page.getRotation().angle - ref.rotation),
        crop.x,
        crop.y
      );
      const topLeft = displayPointToPage(
        fieldFrame,
        fieldSpec.x * fieldFrame.displayWidth,
        fieldSpec.y * fieldFrame.displayHeight
      );
      const bottomRight = displayPointToPage(
        fieldFrame,
        (fieldSpec.x + fieldSpec.width) * fieldFrame.displayWidth,
        (fieldSpec.y + fieldSpec.height) * fieldFrame.displayHeight
      );
      const pdfX = Math.min(topLeft.x, bottomRight.x);
      const pdfY = Math.min(topLeft.y, bottomRight.y);
      const pdfW = Math.abs(bottomRight.x - topLeft.x);
      const pdfH = Math.abs(bottomRight.y - topLeft.y);

      const name = fieldSpec.name || 'field';
      const type = fieldSpec.type.toLowerCase();
      const existing = form.getFields().find(field => field.getName() === name);

      if (type === 'text' || type === 'textfield' || type === 'form-text') {
        if (existing && !(existing instanceof PDFTextField)) {
          throw unsupported(
            `Cannot create text field "${name}": that name is already used by a different field type.`
          );
        }
        const textField = existing ?? form.createTextField(name);
        textField.addToPage(page, { x: pdfX, y: pdfY, width: pdfW, height: pdfH });
      } else if (type === 'checkbox' || type === 'form-checkbox') {
        if (existing && !(existing instanceof PDFCheckBox)) {
          throw unsupported(
            `Cannot create checkbox "${name}": that name is already used by a different field type.`
          );
        }
        const checkBox = existing ?? form.createCheckBox(name);
        checkBox.addToPage(page, { x: pdfX, y: pdfY, width: pdfW, height: pdfH });
      } else if (type === 'radio' || type === 'radiogroup' || type === 'form-radio') {
        if (existing && !(existing instanceof PDFRadioGroup)) {
          throw unsupported(
            `Cannot create radio group "${name}": that name is already used by a different field type.`
          );
        }
        const radioGroup = existing ?? form.createRadioGroup(name);
        const exportValue = fieldSpec.exportValue || 'Choice';
        radioGroup.addOptionToPage(exportValue, page, {
          x: pdfX,
          y: pdfY,
          width: pdfW,
          height: pdfH
        });
      }
    }
  }

  // Whether the form was carried in from a source document or built here, its
  // fields name a font that has to resolve somewhere. Runs after both paths.
  ensureAcroFormDefaults(outDoc);

  // The document catalog, which `copyPages` does not carry: without this,
  // merging, splitting, organising or watermarking silently dropped the tagged
  // structure tree (/StructTreeRoot), the page-label scheme, optional-content
  // layers, named destinations and PDF/A output intents.
  //
  // Only from a single contributor: one input's structure tree or page-label
  // scheme describes that input, and stapling it onto a document assembled from
  // several would be a confident lie. And only in full when the pages came
  // through unchanged in number and order — /PageLabels is indexed by page
  // position, and a structure tree that references pages this export left behind
  // would drag them back into the file as orphans.
  if (contributors.length === 1) {
    const only = contributors[0];
    const docId = contributorDocIds.get(only);
    const unchanged =
      pages.length === only.getPageCount() &&
      pages.every((p, index) => p.sourceDocId === docId && p.sourceIndex === index);
    preserveDocumentCatalog(
      only,
      outDoc,
      copiers.get(only),
      unchanged ? FULL_CATALOG_KEYS : PAGE_INDEPENDENT_CATALOG_KEYS
    );
  }

  // An explicit outline (even an empty one, meaning "the user deleted them all")
  // replaces the carried-through source outlines rather than adding to them.
  if (extras.outline) writeOutline(outDoc, extras.outline);
  else copyOutlines(outDoc, contributorDocIds, pageRefMap);
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

/** A resource-dictionary key as it reads in a report: `Im0`, not `/Im0`. */
function nameKey(key: PDFName): string {
  return key.asString().replace(/^\//, '');
}

/**
 * What an image stream costs in the file: its *stored* bytes, after its own
 * filters, which is the number a replacement has to beat.
 *
 * `getContents()` on a stream loaded from a file returns exactly those bytes. A
 * stream pdf-lib built in memory can throw instead, in which case the size is
 * unknown and reported as 0 — callers treat 0 as "do not judge on size".
 */
function storedStreamBytes(stream: PDFStream): number {
  try {
    return stream.getContents().byteLength;
  } catch {
    return 0;
  }
}

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
interface ImageRef {
  dict: PDFDict;
  key: PDFName;
  ref: PDFRef;
  /**
   * The resource dictionary this image was reached through, needed to resolve a
   * resource-scoped `/ColorSpace` name (`/CS0`) — see `colorSpaceNameOf`. Only
   * CNV-06's extractor reads it; CMP-03 matches purely on object number.
   */
  resources: PDFDict | undefined;
}

function collectImageRefs(
  xobjects: PDFDict,
  context: PDFContext,
  visited: Set<number>,
  resources?: PDFDict,
  depth = 0
): ImageRef[] {
  if (depth > 8) return [];
  const found: ImageRef[] = [];

  for (const [key, value] of xobjects.entries()) {
    const ref = value instanceof PDFRef ? value : undefined;
    const stream = xobjects.lookup(key);
    if (!(stream instanceof PDFStream)) continue;
    const subtype = nameOf(stream.dict.get(PDFName.of('Subtype')));

    if (subtype === 'Image') {
      if (ref) found.push({ dict: xobjects, key, ref, resources });
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
          : // A Form with no /Resources of its own inherits the invoking scope,
            // exactly as `collectImages` already assumes.
            resources;
    const formXObjects = formResources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (formXObjects) {
      found.push(...collectImageRefs(formXObjects, context, visited, formResources, depth + 1));
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
 * Embedded image extraction (CNV-06)
 * ------------------------------------------------------------------ */

/**
 * How an image's samples are modelled once its colour space is resolved.
 *
 * `unsupported` is a first-class outcome, not an error: CNV-06 extracts *native*
 * data, and a DeviceCMYK or /Separation raster has no lossless single-file
 * raster format to land in (PNG cannot carry either). Converting it to RGB would
 * be a re-encode of exactly the kind this ticket exists to avoid — and, for a
 * named ink plate, the same destruction `compress-plan.ts` refuses — so the
 * image is reported and left in the document instead.
 */
type ImageColorModel =
  | { kind: 'gray' }
  | { kind: 'rgb' }
  | { kind: 'indexed'; palette: Uint8Array }
  | { kind: 'unsupported'; reason: string };

/** Bytes behind a `/Indexed` lookup, which is legally a string or a stream. */
function lookupTableBytes(value: unknown, context: PDFContext): Uint8Array | undefined {
  let resolved: unknown = value;
  if (resolved instanceof PDFRef) resolved = context.lookup(resolved);
  if (resolved instanceof PDFRawStream) {
    try {
      return decodePDFRawStream(resolved).decode();
    } catch {
      return undefined;
    }
  }
  if (resolved instanceof PDFHexString || resolved instanceof PDFString) {
    return resolved.asBytes();
  }
  return undefined;
}

/** Component count declared by an `/ICCBased` stream's `/N`. */
function iccComponents(value: unknown, context: PDFContext): number {
  let resolved: unknown = value;
  if (resolved instanceof PDFRef) resolved = context.lookup(resolved);
  if (resolved instanceof PDFStream) {
    const n = resolved.dict.get(PDFName.of('N'));
    if (n instanceof PDFNumber) return n.asNumber();
  }
  return 0;
}

/**
 * Resolves an image's `/ColorSpace` into the sample model PNG needs.
 *
 * Goes further than `colorSpaceNameOf` (which only needs a name for the
 * compression skip lists) because extraction has to know the component count and,
 * for `/Indexed`, the actual palette bytes. The same two encodings that function
 * documents — an indirect reference, and a resource-scoped name — are handled
 * here for the same reason.
 */
function resolveColorModel(
  value: unknown,
  resources: PDFDict | undefined,
  context: PDFContext,
  depth = 0
): ImageColorModel {
  if (depth > 4) return { kind: 'unsupported', reason: 'colour space nested too deeply' };
  let resolved: unknown = value;

  if (resolved instanceof PDFName) {
    const csDict = resources?.lookupMaybe(PDFName.of('ColorSpace'), PDFDict);
    const named = csDict?.get(resolved);
    if (named !== undefined) resolved = named;
  }
  if (resolved instanceof PDFRef) resolved = context.lookup(resolved);

  if (resolved instanceof PDFName) {
    const name = resolved.asString().replace(/^\//, '');
    if (name === 'DeviceGray' || name === 'CalGray' || name === 'G') return { kind: 'gray' };
    if (name === 'DeviceRGB' || name === 'CalRGB' || name === 'RGB') return { kind: 'rgb' };
    if (name === 'DeviceCMYK' || name === 'CMYK') {
      return { kind: 'unsupported', reason: 'DeviceCMYK raster (no lossless CMYK raster format)' };
    }
    return { kind: 'unsupported', reason: `${name} colour space` };
  }

  if (!(resolved instanceof PDFArray)) {
    return { kind: 'unsupported', reason: 'unreadable colour space' };
  }

  let head: unknown = resolved.get(0);
  if (head instanceof PDFRef) head = context.lookup(head);
  const family = head instanceof PDFName ? head.asString().replace(/^\//, '') : 'unknown';

  if (family === 'ICCBased') {
    const n = iccComponents(resolved.get(1), context);
    if (n === 1) return { kind: 'gray' };
    if (n === 3) return { kind: 'rgb' };
    if (n === 4) {
      return { kind: 'unsupported', reason: 'ICCBased CMYK raster (4 components)' };
    }
    return {
      kind: 'unsupported',
      reason: `ICCBased colour space with ${n || 'unknown'} components`
    };
  }

  if (family === 'CalGray') return { kind: 'gray' };
  if (family === 'CalRGB') return { kind: 'rgb' };
  if (family === 'DeviceGray') return { kind: 'gray' };
  if (family === 'DeviceRGB') return { kind: 'rgb' };

  if (family === 'Indexed' || family === 'I') {
    const base = resolveColorModel(resolved.get(1), resources, context, depth + 1);
    if (base.kind === 'unsupported') {
      return {
        kind: 'unsupported',
        reason: `Indexed image over an unsupported base (${base.reason})`
      };
    }
    if (base.kind === 'indexed') {
      return { kind: 'unsupported', reason: 'Indexed image over an Indexed base' };
    }
    let hival: unknown = resolved.get(2);
    if (hival instanceof PDFRef) hival = context.lookup(hival);
    const entries = hival instanceof PDFNumber ? Math.round(hival.asNumber()) + 1 : 0;
    const table = lookupTableBytes(resolved.get(3), context);
    if (entries <= 0 || !table) {
      return { kind: 'unsupported', reason: 'Indexed image with an unreadable palette' };
    }
    const components = base.kind === 'rgb' ? 3 : 1;
    if (table.length < entries * components) {
      return { kind: 'unsupported', reason: 'Indexed image with a truncated palette' };
    }
    // PNG's PLTE is always RGB triples, so a greyscale base is widened by
    // repeating each value — the same colour, not a converted one.
    const palette = new Uint8Array(entries * 3);
    for (let i = 0; i < entries; i++) {
      if (components === 3) {
        palette.set(table.subarray(i * 3, i * 3 + 3), i * 3);
      } else {
        palette.fill(table[i], i * 3, i * 3 + 3);
      }
    }
    return { kind: 'indexed', palette };
  }

  return { kind: 'unsupported', reason: `${family} colour space` };
}

/** `/Decode` as plain numbers, or undefined when the key is absent. */
function decodeArrayOf(dict: PDFDict, context: PDFContext): number[] | undefined {
  let value: unknown = dict.get(PDFName.of('Decode'));
  if (value instanceof PDFRef) value = context.lookup(value);
  if (!(value instanceof PDFArray)) return undefined;
  const out: number[] = [];
  for (let i = 0; i < value.size(); i++) {
    let entry: unknown = value.get(i);
    if (entry instanceof PDFRef) entry = context.lookup(entry);
    out.push(entry instanceof PDFNumber ? entry.asNumber() : Number.NaN);
  }
  return out;
}

/** True when `decode` is the identity mapping for `components` components. */
function isDefaultDecode(decode: number[] | undefined, components: number): boolean {
  if (!decode) return true;
  if (decode.length !== components * 2) return false;
  for (let i = 0; i < components; i++) {
    if (decode[i * 2] !== 0 || decode[i * 2 + 1] !== 1) return false;
  }
  return true;
}

/** Filters that are pure byte transforms, i.e. not an image codec. */
const TRANSPORT_FILTERS = new Set([
  'FlateDecode',
  'Fl',
  'LZWDecode',
  'LZW',
  'ASCII85Decode',
  'A85',
  'ASCIIHexDecode',
  'AHx',
  'RunLengthDecode',
  'RL'
]);

/**
 * Strips the transport filters wrapping a codec payload (`[/ASCII85Decode
 * /DCTDecode]` is a JPEG inside ASCII85), leaving the codec's own bytes.
 *
 * Done by handing pdf-lib a synthetic stream carrying only the wrapper filters,
 * rather than reimplementing ASCII85/LZW/Flate — the decoders are already there
 * and already exercised; `decodePDFRawStream` simply refuses to run a chain that
 * ends in an image codec.
 */
function stripTransportFilters(
  contents: Uint8Array,
  wrappers: string[],
  context: PDFContext
): Uint8Array {
  if (wrappers.length === 0) return contents;
  const filters = PDFArray.withContext(context);
  for (const name of wrappers) filters.push(PDFName.of(name));
  const dict = PDFDict.withContext(context);
  dict.set(PDFName.of('Filter'), filters);
  return decodePDFRawStream(PDFRawStream.of(dict, contents)).decode();
}

export interface ExtractedImageEntry {
  pageIndex: number;
  /** 1-based position of the image in the page's resources, in resource order. */
  position: number;
  /** Resource name (`Im1`), for matching the file back to the document. */
  name: string;
  objectNumber: number;
  width: number;
  height: number;
  /** ZIP entry name; absent when nothing was written. */
  fileName?: string;
  /** Sibling file carrying the image's `/SMask` or stencil `/Mask`, if any. */
  maskFileName?: string;
  /** Bytes written for this image (excluding any mask sibling). */
  byteLength: number;
  status: 'extracted' | 'duplicate' | 'skipped';
  /** Why it was skipped, or which file a duplicate points at. Always human-readable. */
  note?: string;
}

export interface ExtractedImages {
  /** A ZIP of every extracted file. Empty ZIP when nothing could be extracted. */
  bytes: Uint8Array;
  entries: ExtractedImageEntry[];
}

interface ExtractedFile {
  bytes: Uint8Array;
  /** File extension, without the dot. */
  ext: string;
}

type ExtractOutcome = { ok: true; file: ExtractedFile } | { ok: false; reason: string };

/**
 * The heart of CNV-06: the image object's *own* encoded bytes, wherever the
 * source format is already a file format, and an exact PNG re-frame where it is
 * a raw raster.
 *
 * Three outcomes, and nothing in between:
 *
 *  • `/DCTDecode` → the stream is a complete JFIF/Adobe JPEG. Written out
 *    byte-for-byte, including a CMYK JPEG's Adobe APP14 marker: no decode
 *    happens, so nothing can be lost.
 *  • `/JPXDecode` → likewise a complete JPEG 2000 codestream, written as `.jp2`.
 *    CMP-03 refuses these because pdf.js cannot re-encode them; extraction can
 *    hand them over untouched precisely *because* it never decodes them.
 *  • Transport filters only (Flate/LZW/ASCII85/ASCIIHex/RunLength, or none) →
 *    the decoded samples are the raw raster, re-framed into PNG at the same bit
 *    depth, sample order and palette (`core/png.ts`).
 *
 * Everything else — JBIG2 (whose stream is an embedded segment sequence with its
 * globals in a separate object, not a standalone file), CCITT (a fax codestream
 * with no container), CMYK and /Separation rasters, a non-identity `/Decode` — is
 * refused with a reason. Following CMP-03's precedent: skip cleanly and report,
 * never write a file that claims to be the image and is not.
 */
function extractImageFile(
  stream: PDFStream,
  resources: PDFDict | undefined,
  context: PDFContext
): ExtractOutcome {
  if (!(stream instanceof PDFRawStream)) {
    return { ok: false, reason: 'the image stream could not be read as raw bytes' };
  }
  const dict = stream.dict;
  const width = numberOf(dict, 'Width', 0);
  const height = numberOf(dict, 'Height', 0);
  if (width <= 0 || height <= 0) return { ok: false, reason: 'the image declares no pixels' };

  const filters = filterNamesOf(dict.get(PDFName.of('Filter')), context);
  const codec = filters.length > 0 ? filters[filters.length - 1] : '';
  const wrappers = filters.slice(0, -1);
  const wrappersAreTransport = wrappers.every(name => TRANSPORT_FILTERS.has(name));

  if (codec === 'DCTDecode' || codec === 'DCT' || codec === 'JPXDecode') {
    if (!wrappersAreTransport) {
      return { ok: false, reason: `an unsupported filter chain (${filters.join(' → ')})` };
    }
    try {
      const payload = stripTransportFilters(stream.contents, wrappers, context);
      return {
        ok: true,
        file: {
          // A copy, not a view into the parsed file's buffer: these bytes outlive
          // the document and are transferred to the main thread.
          bytes: new Uint8Array(payload),
          ext: codec === 'JPXDecode' ? 'jp2' : 'jpg'
        }
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `its wrapper filters could not be decoded (${message})` };
    }
  }

  if (codec === 'JBIG2Decode') {
    return {
      ok: false,
      reason:
        'JBIG2 data is an embedded segment sequence whose symbol dictionary lives in a separate /JBIG2Globals object, so it is not a standalone image file'
    };
  }
  if (codec === 'CCITTFaxDecode' || codec === 'CCF') {
    return {
      ok: false,
      reason: 'CCITT fax data is a bare codestream with no image-file container in the PDF'
    };
  }
  if (codec !== '' && !TRANSPORT_FILTERS.has(codec)) {
    return { ok: false, reason: `an unsupported filter (${codec})` };
  }

  let samples: Uint8Array;
  try {
    samples = decodePDFRawStream(stream).decode();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `its stream could not be decoded (${message})` };
  }

  const isImageMask = dict.lookup(PDFName.of('ImageMask')) === PDFBool.True;
  const decode = decodeArrayOf(dict, context);

  if (isImageMask) {
    if (decode && !isDefaultDecode(decode, 1) && !(decode.length === 2 && decode[0] === 1)) {
      return { ok: false, reason: 'a stencil mask with a /Decode array we do not model' };
    }
    const inverted = decode?.[0] === 1;
    // A stencil's 1-bit samples map straight onto a 1-bit greyscale PNG: sample 0
    // paints (black here), sample 1 leaves the page (white). /Decode [1 0] swaps
    // that meaning, so the bits are flipped rather than the file being mislabelled.
    const bits = inverted ? samples.map(byte => byte ^ 0xff) : samples;
    try {
      return {
        ok: true,
        file: {
          bytes: encodePng({ width, height, bitDepth: 1, colorType: 0, samples: bits }),
          ext: 'png'
        }
      };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  const model = resolveColorModel(dict.get(PDFName.of('ColorSpace')), resources, context);
  if (model.kind === 'unsupported') {
    return { ok: false, reason: model.reason };
  }

  const bpc = numberOf(dict, 'BitsPerComponent', 8);
  if (bpc !== 1 && bpc !== 2 && bpc !== 4 && bpc !== 8 && bpc !== 16) {
    return { ok: false, reason: `an unsupported bit depth (${bpc})` };
  }
  const components = model.kind === 'rgb' ? 3 : 1;
  if (!isDefaultDecode(decode, components)) {
    return {
      ok: false,
      reason: 'a non-default /Decode array, which remaps sample values on display'
    };
  }
  if (model.kind === 'indexed' && bpc === 16) {
    return { ok: false, reason: 'a 16-bit indexed image, which PNG cannot express' };
  }

  try {
    return {
      ok: true,
      file: {
        bytes: encodePng({
          width,
          height,
          bitDepth: bpc,
          colorType: model.kind === 'rgb' ? 2 : model.kind === 'indexed' ? 3 : 0,
          samples,
          palette: model.kind === 'indexed' ? model.palette : undefined
        }),
        ext: 'png'
      }
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
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
 * Flatten (SGN-05)
 * ------------------------------------------------------------------ */

/** `/F` bit 2 — Hidden. The annotation is not drawn, so baking it would add ink. */
const ANNOT_FLAG_HIDDEN = 1 << 1;
/** `/F` bit 6 — NoView. Drawn only when printing, so on-screen it is not there. */
const ANNOT_FLAG_NOVIEW = 1 << 5;

/**
 * The indirect reference to an annotation's *normal* appearance stream, or
 * `undefined` when it has none to draw.
 *
 * `/AP /N` is either the stream itself or a sub-dictionary keyed by appearance
 * state — a checkbox's `/Off` and `/Yes`, a stamp's single entry. `/AS` names
 * which state is current; a sub-dictionary with exactly one entry and no `/AS`
 * is unambiguous, so it is used, but an ambiguous one is left alone rather than
 * guessed at (drawing the wrong state is a visual lie, and this ticket's whole
 * point is that the flattened result is what the user saw).
 *
 * A directly-embedded stream is registered so it can be referenced as an
 * XObject; `newXObject` needs a ref, not an inline object.
 */
function normalAppearanceRef(doc: PDFDocument, annot: PDFDict): PDFRef | undefined {
  const ap = annot.lookupMaybe(PDFName.of('AP'), PDFDict);
  if (!ap) return undefined;

  const asRef = (value: unknown): PDFRef | undefined => {
    if (value instanceof PDFRef) {
      return doc.context.lookupMaybe(value, PDFStream) ? value : undefined;
    }
    return value instanceof PDFStream ? doc.context.register(value) : undefined;
  };

  const normal = ap.get(PDFName.of('N'));
  const direct = asRef(normal);
  if (direct) return direct;

  const states = normal instanceof PDFRef ? doc.context.lookupMaybe(normal, PDFDict) : normal;
  if (!(states instanceof PDFDict)) return undefined;

  const current = annot.get(PDFName.of('AS'));
  if (current instanceof PDFName) return asRef(states.get(current));
  const keys = states.keys();
  return keys.length === 1 ? asRef(states.get(keys[0])) : undefined;
}

/** `[x1, y1, x2, y2]` from an annotation's `/Rect`, normalised so x1<x2, y1<y2. */
function annotationRect(annot: PDFDict): [number, number, number, number] | undefined {
  const rect = annot.lookupMaybe(PDFName.of('Rect'), PDFArray);
  if (!rect || rect.size() < 4) return undefined;
  const values: number[] = [];
  for (let i = 0; i < 4; i++) {
    const value = rect.lookup(i);
    if (!(value instanceof PDFNumber)) return undefined;
    values.push(value.asNumber());
  }
  const [a, b, c, d] = values;
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

/** Four numbers from a stream dictionary array, or `undefined`. */
function numberArray(dict: PDFDict, key: string, count: number): number[] | undefined {
  const array = dict.lookupMaybe(PDFName.of(key), PDFArray);
  if (!array || array.size() < count) return undefined;
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const value = array.lookup(i);
    if (!(value instanceof PDFNumber)) return undefined;
    values.push(value.asNumber());
  }
  return values;
}

/**
 * The matrix that maps an appearance stream onto its annotation's `/Rect`.
 *
 * This is PDF 32000-1 §12.5.5's algorithm, not a plain translate: the form
 * XObject's `/BBox` is transformed by its own `/Matrix`, the *bounding box of
 * that result* is fitted to `/Rect`, and only the fitting transform is pushed —
 * the viewer applies `/Matrix` itself when it executes the `Do`. Skipping the
 * `/Matrix` step (or just translating to the rect's corner) puts a rotated or
 * scaled appearance in the wrong place and at the wrong size, which is exactly
 * the "looks fine until it doesn't" failure this codebase refuses to ship.
 */
function appearanceMatrix(
  stream: PDFStream,
  rect: [number, number, number, number]
): [number, number, number, number, number, number] {
  const [rx1, ry1, rx2, ry2] = rect;
  const bbox = numberArray(stream.dict, 'BBox', 4);
  // /BBox is required for a form XObject. Without one there is nothing to fit,
  // so fall back to placing the stream's own origin at the rect's corner.
  if (!bbox) return [1, 0, 0, 1, rx1, ry1];

  const [a, b, c, d, e, f] = numberArray(stream.dict, 'Matrix', 6) ?? [1, 0, 0, 1, 0, 0];
  const corners: [number, number][] = [
    [bbox[0], bbox[1]],
    [bbox[2], bbox[1]],
    [bbox[2], bbox[3]],
    [bbox[0], bbox[3]]
  ].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);

  const xs = corners.map(p => p[0]);
  const ys = corners.map(p => p[1]);
  const bx1 = Math.min(...xs);
  const by1 = Math.min(...ys);
  const spanX = Math.max(...xs) - bx1;
  const spanY = Math.max(...ys) - by1;

  // A degenerate span would divide by zero; 1 leaves the appearance unscaled
  // rather than producing NaN operands that would break the content stream.
  const sx = spanX === 0 ? 1 : (rx2 - rx1) / spanX;
  const sy = spanY === 0 ? 1 : (ry2 - ry1) / spanY;
  return [sx, 0, 0, sy, rx1 - bx1 * sx, ry1 - by1 * sy];
}

/** Counts from one flatten, so the UI can report what happened. */
export interface FlattenReport {
  /** Interactive form fields removed; their values are now page content. */
  fields: number;
  /** Annotations whose appearance stream was drawn into the page content. */
  annotationsBaked: number;
  /** Annotations removed that drew nothing: links, popups, hidden marks. */
  annotationsDropped: number;
}

/**
 * Draws every annotation's appearance into its page's content stream and then
 * removes `/Annots` entirely.
 *
 * `form.flatten()` only handles *widget* annotations — the form's own. A
 * document that has been through another tool carries `/FreeText`, `/Square`,
 * `/Highlight`, `/Stamp` and `/Link` dictionaries that `copyPages` faithfully
 * carries through every compose, so a "flattened" export still handed the
 * recipient annotations they could move, edit, or delete. This is the other
 * half of SGN-05's "no annotation dictionaries remaining".
 *
 * Annotations with nothing to draw (a `/Link`'s hotspot, a `/Popup`'s window,
 * anything flagged hidden) are removed rather than baked, and counted
 * separately so the caller can say so out loud — a flatten does lose a link's
 * clickability, and that is a fact to report, not to bury.
 */
function flattenAnnotations(doc: PDFDocument): { baked: number; dropped: number } {
  let baked = 0;
  let dropped = 0;

  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;

    for (const entry of annots.asArray()) {
      const annot =
        entry instanceof PDFDict ? entry : doc.context.lookupMaybe(entry, PDFDict) || undefined;
      if (!annot) {
        dropped++;
        continue;
      }

      const flagValue = annot.lookup(PDFName.of('F'));
      const flags = flagValue instanceof PDFNumber ? flagValue.asNumber() : 0;
      const invisible = (flags & ANNOT_FLAG_HIDDEN) !== 0 || (flags & ANNOT_FLAG_NOVIEW) !== 0;

      const apRef = invisible ? undefined : normalAppearanceRef(doc, annot);
      const stream = apRef ? doc.context.lookupMaybe(apRef, PDFStream) : undefined;
      const rect = annotationRect(annot);
      if (nameOf(annot.get(PDFName.of('Subtype'))) === 'Popup' || !apRef || !stream || !rect) {
        dropped++;
        continue;
      }

      const key = page.node.newXObject('FlatAnnot', apRef);
      page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(...appearanceMatrix(stream, rect)),
        drawObject(key),
        popGraphicsState()
      );
      baked++;
    }

    page.node.delete(PDFName.of('Annots'));
  }

  return { baked, dropped };
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

  async getFormFields(bytes, job) {
    // Checked before the parse, and before any field is reported: enumerating an
    // XFA form's shadow fields is what led the UI to offer them as fillable.
    await checkpoint(job, 0, 'Reading the form');
    if (hasXfaMarker(bytes)) return { isXfa: true, fields: [] };

    const doc = await load(bytes, true);
    const form = doc.getForm();
    if (form.hasXFA()) return { isXfa: true, fields: [] };

    const pages = doc.getPages();
    const fields: FormFieldData[] = [];

    // A 2000-widget government form walks every widget and searches the page
    // list for each; on a 300-page document that is genuinely slow, and it used
    // to be uninterruptible with no progress at all.
    const allFields = form.getFields();
    let fieldIndex = 0;
    for (const field of allFields) {
      await checkpoint(
        job,
        allFields.length === 0 ? 1 : fieldIndex / allFields.length,
        `Reading field ${fieldIndex + 1} of ${allFields.length}`
      );
      fieldIndex++;
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
      const radioExportValues =
        field instanceof PDFRadioGroup ? field.acroField.getExportValues() : undefined;
      for (const [widgetIndex, widget] of field.acroField.getWidgets().entries()) {
        const pageRef = widget.P();
        const pageIndex = pageRef ? pages.findIndex(p => p.ref === pageRef) : -1;
        if (pageIndex < 0) continue;
        const rect = widget.getRectangle();
        const { width, height } = pages[pageIndex].getSize();
        if (field instanceof PDFRadioGroup) {
          const onValue = widget.getOnValue();
          if (!onValue) continue;
          const exportValue =
            radioExportValues?.[widgetIndex]?.decodeText() ?? onValue.decodeText();
          if (!exportValue) continue;
          options ??= [];
          options.push(exportValue);
        }
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

    await checkpoint(job, 1, 'Form read');
    return { isXfa: false, fields };
  },

  /**
   * SGN-09 — a `/Sig` field's `/ByteRange` names the exact byte spans that were
   * hashed at signing time; the gap between the two spans is where `/Contents`
   * (the signature itself) sits, excluded from its own hash. Standard PDF
   * incremental-update signing has that second span run to the end of the file
   * *as it was when signed* — so if the file has grown since (a later edit
   * appended without re-signing), the current length no longer matches, and
   * that mismatch is exactly what "modified after signing" means structurally,
   * without needing to verify the cryptographic hash itself. Reading raw
   * dictionary values here, not pdf-lib's own signature API, which does not
   * expose one — `/Sig` fields are typically absent from `form.getFields()`
   * entirely on the documents this was checked against.
   */
  async checkSignatureIntegrity(bytes) {
    const doc = await load(bytes, true);
    const acroFormDict = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
    const signatures: SignatureFieldIntegrity[] = [];

    const qualifiedName = (field: PDFDict): string => {
      const parts: string[] = [];
      let current: PDFDict | undefined = field;
      const seen = new Set<PDFDict>();
      while (current && !seen.has(current)) {
        seen.add(current);
        const t = current.get(PDFName.of('T'));
        if (t instanceof PDFString || t instanceof PDFHexString) parts.unshift(t.decodeText());
        const parent = current.get(PDFName.of('Parent'));
        current = parent instanceof PDFRef ? doc.context.lookupMaybe(parent, PDFDict) : undefined;
      }
      return parts.join('.') || '(unnamed)';
    };

    const walk = (fieldsArray: PDFArray | undefined): void => {
      if (!fieldsArray) return;
      for (let i = 0; i < fieldsArray.size(); i++) {
        const ref = fieldsArray.get(i);
        const field = ref instanceof PDFRef ? doc.context.lookupMaybe(ref, PDFDict) : undefined;
        if (!field) continue;

        const ft = field.get(PDFName.of('FT'));
        if (ft instanceof PDFName && ft === PDFName.of('Sig')) {
          const vRef = field.get(PDFName.of('V'));
          const sigDict =
            vRef instanceof PDFRef ? doc.context.lookupMaybe(vRef, PDFDict) : undefined;
          const byteRangeArr = sigDict?.lookupMaybe(PDFName.of('ByteRange'), PDFArray);
          if (sigDict && byteRangeArr && byteRangeArr.size() === 4) {
            const nums = [0, 1, 2, 3].map(i => {
              const n = byteRangeArr.lookup(i, PDFNumber);
              return n.asNumber();
            }) as [number, number, number, number];
            signatures.push({
              fieldName: qualifiedName(field),
              byteRange: nums,
              reachesEndOfFile: nums[2] + nums[3] === bytes.length
            });
          }
        }

        const kids = field.lookupMaybe(PDFName.of('Kids'), PDFArray);
        if (kids) walk(kids);
      }
    };

    walk(acroFormDict?.lookupMaybe(PDFName.of('Fields'), PDFArray));

    if (signatures.length === 0) return { hasSignature: false, intact: null, signatures: [] };

    const outermost = signatures.reduce((a, b) =>
      a.byteRange[2] + a.byteRange[3] >= b.byteRange[2] + b.byteRange[3] ? a : b
    );
    return { hasSignature: true, intact: outermost.reachesEndOfFile, signatures };
  },

  /**
   * DOC-12 — walks every page's `/Resources/Font`, grouping by `/BaseFont`
   * (subset tag stripped) across the whole document: the same font is
   * typically referenced by every page, and a document can also legitimately
   * carry two different font *objects* under one family name, one embedded on
   * some pages, one not — a finding's `pages` names exactly the pages where
   * *this* font is not embedded, not everywhere the name appears.
   */
  async checkFontEmbedding(bytes) {
    const doc = await load(bytes, true);
    const pages = doc.getPages();
    const byFont = new Map<string, { embedded: Set<number>; missing: Set<number> }>();

    for (let i = 0; i < pages.length; i++) {
      const fontsDict = pageFontDictOf(pages[i], doc.context);
      if (!fontsDict) continue;
      for (const [, ref] of fontsDict.entries()) {
        const fontDict = asDict(ref, doc.context);
        if (!fontDict) continue;
        const baseFont = baseFontNameOf(fontDict);
        const entry = byFont.get(baseFont) ?? { embedded: new Set(), missing: new Set() };
        (isFontEmbedded(fontDict, doc.context) ? entry.embedded : entry.missing).add(i);
        byFont.set(baseFont, entry);
      }
    }

    const findings: FontEmbeddingFinding[] = [];
    for (const [baseFont, { missing }] of byFont) {
      if (missing.size === 0) continue;
      findings.push({
        baseFont,
        pages: [...missing].sort((a, b) => a - b),
        standardFontMatch: standardFontFor(baseFont)
      });
    }
    findings.sort((a, b) => a.baseFont.localeCompare(b.baseFont));
    return { findings };
  },

  /**
   * DOC-12 — re-embeds `baseFont` as its standard-14 match and repoints every
   * non-embedded occurrence's resource-name entry at it. The resource *names*
   * (`/F1`, `/F2`, …) are untouched, so no content-stream operator changes —
   * only what each name resolves to.
   */
  async embedMissingFont(bytes, baseFont) {
    const doc = await load(bytes);
    const substitute = standardFontFor(baseFont);
    if (!substitute) {
      throw unsupported(
        `"${baseFont}" has no safe standard-font substitute — nothing was changed.`
      );
    }
    // CJS interop matches `embedDevanagariFont`'s own reasoning: bundled, this
    // resolves to the module's default export; a bare dynamic `import()` of a
    // CJS package carries it on `.default` and not on the namespace itself.
    const fontkitModule = (await import('fontkit')) as unknown as {
      default?: Parameters<PDFDocument['registerFontkit']>[0];
    } & Parameters<PDFDocument['registerFontkit']>[0];
    doc.registerFontkit(fontkitModule.default ?? fontkitModule);
    const fontBytes = dataUrlToBytes(liberationSansRegularDataUrl);
    // No subsetting: which glyphs are used would mean parsing every content
    // stream that references this font first, and the whole point here is a
    // small, safe fix — not a second content-stream analysis pass.
    const embedded = await doc.embedFont(fontBytes, { subset: false });

    let replaced = 0;
    for (const page of doc.getPages()) {
      const fontsDict = pageFontDictOf(page, doc.context);
      if (!fontsDict) continue;
      for (const [name, ref] of fontsDict.entries()) {
        const fontDict = asDict(ref, doc.context);
        if (!fontDict) continue;
        if (baseFontNameOf(fontDict) !== baseFont) continue;
        if (isFontEmbedded(fontDict, doc.context)) continue;
        fontsDict.set(name, embedded.ref);
        replaced++;
      }
    }
    if (replaced === 0) {
      throw internal(`"${baseFont}" is not a non-embedded font in this document.`);
    }
    return transfer(await pseudoLinearize(doc).save({ useObjectStreams: true }));
  },

  async fillFormFields(bytes, values, flatten, job) {
    // XFA is checked on the raw bytes *first*: a hybrid form answers `false` to
    // every parsed check while its real fields live in XML we cannot write.
    await checkpoint(job, 0, 'Reading the form');
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
      await checkpoint(job, 0.6, 'Drawing values into the page');
      // A field's /DA names a font that has to resolve in the form's /DR, which
      // a form Stapler built itself does not have. Supply it before the
      // appearance pass rather than letting the pass fail and refuse.
      ensureAcroFormDefaults(doc);
      try {
        try {
          form.updateFieldAppearances();
        } catch {
          // ignore appearance generation fallback errors
        }
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
    await checkpoint(job, 0.9, 'Writing file');
    return transfer(await pseudoLinearize(doc).save({ useObjectStreams: true }));
  },

  async flattenBackground(
    bytes: Uint8Array,
    pageIndex: number | 'all',
    hexColor: string,
    job?: JobHandle
  ): Promise<{ bytes: Uint8Array; changed: boolean }> {
    // This operation rewrites content streams, so encrypted input must follow
    // the same refuse-closed rule as every other writer.
    const doc = await load(bytes);
    const pages = doc.getPages();

    // Parse hexColor (e.g., "#ffffff")
    const r = parseInt(hexColor.slice(1, 3), 16) / 255;
    const g = parseInt(hexColor.slice(3, 5), 16) / 255;
    const b = parseInt(hexColor.slice(5, 7), 16) / 255;

    const indices = pageIndex === 'all' ? pages.map((_, i) => i) : [pageIndex as number];
    let i = 0;
    let changed = false;
    for (const idx of indices) {
      if (job)
        await checkpoint(
          job,
          i / indices.length,
          `Flattening background (${i + 1} of ${indices.length})`
        );
      i++;
      const page = pages[idx];
      const cropBox = page.getCropBox();
      const { x: cropX, y: cropY, width, height } = cropBox;
      const pageArea = width * height;
      const thresholdArea = pageArea * 0.95;

      const leaf = page.node;
      const contents = leaf.Contents();
      if (!contents) continue;

      const streams: PDFStream[] = [];
      if (contents instanceof PDFArray) {
        for (let idx = 0; idx < contents.size(); idx++) {
          const s = doc.context.lookup(contents.get(idx));
          if (s instanceof PDFStream) streams.push(s);
        }
      } else if (contents instanceof PDFStream) {
        streams.push(contents);
      }

      if (streams.length === 0) continue;

      const allTokens: import('../pdf/interpreter').Token[] = [];
      for (const stream of streams) {
        const rawBytes = decodePDFRawStream(stream as unknown as PDFRawStream).decode();
        allTokens.push(...tokenizeContentStream(rawBytes));
      }

      const statements = parseContentStream(allTokens);

      const { GraphicsState, multiplyMatrix, transformPoint } = await import('../pdf/interpreter');

      const state = new GraphicsState();

      let backgroundRemoved = false;
      const filtered: import('../pdf/interpreter').Statement[] = [];

      // Determine what a Path Fill looks like. A path is constructed with m, l, c, v, y, re, h.
      // Then filled with f, F, f*, B, B*, b, b*.
      // For simplicity, if we encounter a path drawing op and its bounding box is huge, we drop it.
      // We will track the current path bounds.
      let pathMinX = Infinity,
        pathMinY = Infinity,
        pathMaxX = -Infinity,
        pathMaxY = -Infinity;
      const addPathPoint = (x: number, y: number) => {
        const pt = transformPoint(state.ctm, x, y);
        pathMinX = Math.min(pathMinX, pt.x);
        pathMinY = Math.min(pathMinY, pt.y);
        pathMaxX = Math.max(pathMaxX, pt.x);
        pathMaxY = Math.max(pathMaxY, pt.y);
      };

      const stateStack: import('../pdf/interpreter').Matrix[] = [];

      for (const stmt of statements) {
        const op = String.fromCharCode(...stmt.operator.bytes);

        // Track graphics state CTM
        if (op === 'q') {
          stateStack.push([...state.ctm]);
        } else if (op === 'Q') {
          const popped = stateStack.pop();
          if (popped) {
            state.ctm = popped;
          }
        } else if (op === 'cm' && stmt.operands.length === 6) {
          const m = stmt.operands.map(t =>
            parseFloat(String.fromCharCode(...t.bytes))
          ) as import('../pdf/interpreter').Matrix;
          state.ctm = multiplyMatrix(m, state.ctm);
        }

        // Track path
        if (op === 'm' || op === 'l') {
          if (stmt.operands.length >= 2) {
            addPathPoint(
              parseFloat(String.fromCharCode(...stmt.operands[0].bytes)),
              parseFloat(String.fromCharCode(...stmt.operands[1].bytes))
            );
          }
        } else if (op === 're' && stmt.operands.length === 4) {
          const rx = parseFloat(String.fromCharCode(...stmt.operands[0].bytes));
          const ry = parseFloat(String.fromCharCode(...stmt.operands[1].bytes));
          const rw = parseFloat(String.fromCharCode(...stmt.operands[2].bytes));
          const rh = parseFloat(String.fromCharCode(...stmt.operands[3].bytes));
          addPathPoint(rx, ry);
          addPathPoint(rx + rw, ry);
          addPathPoint(rx, ry + rh);
          addPathPoint(rx + rw, ry + rh);
        }
        // ignoring c, v, y for exactness since rect is most common for background

        if (!backgroundRemoved) {
          if (
            op === 'f' ||
            op === 'F' ||
            op === 'f*' ||
            op === 'B' ||
            op === 'B*' ||
            op === 'b' ||
            op === 'b*'
          ) {
            const area = (pathMaxX - pathMinX) * (pathMaxY - pathMinY);
            if (area >= thresholdArea && pathMaxX > pathMinX && pathMaxY > pathMinY) {
              backgroundRemoved = true;
              pathMinX = Infinity;
              pathMinY = Infinity;
              pathMaxX = -Infinity;
              pathMaxY = -Infinity;
              continue; // Drop this statement
            }
          }
        }

        // Reset path on n (end path) or after drawing
        if (
          op === 'n' ||
          op === 'f' ||
          op === 'F' ||
          op === 'f*' ||
          op === 'B' ||
          op === 'B*' ||
          op === 'b' ||
          op === 'b*' ||
          op === 'S' ||
          op === 's'
        ) {
          pathMinX = Infinity;
          pathMinY = Infinity;
          pathMaxX = -Infinity;
          pathMaxY = -Infinity;
        }

        filtered.push(stmt);
      }

      // An image that covers the page is normally the scan itself. Removing it
      // produces a blank page, and deleting its resource can also mutate an
      // inherited /Resources dictionary shared by sibling pages. OPS-13 is a
      // vector-background operation: only a large painted path is eligible.
      if (!backgroundRemoved) continue;

      const injectedStream = `
q
${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg
${cropX} ${cropY} ${width} ${height} re
f
Q
`;
      const injectedBytes = new TextEncoder().encode(injectedStream);
      const filteredBytes = serializeStatements(filtered);

      const combined = new Uint8Array(injectedBytes.length + filteredBytes.length);
      combined.set(injectedBytes, 0);
      combined.set(filteredBytes, injectedBytes.length);

      const newStream = doc.context.flateStream(combined);
      const newStreamRef = doc.context.register(newStream);
      leaf.set(PDFName.of('Contents'), newStreamRef);
      changed = true;
    }

    // Avoid a needless round-trip (and a misleading "cleaned" outcome) when
    // detection found no vector background. Unlike compression, flattening is a
    // content operation: pdf-lib may retain orphaned streams, so output size is
    // not evidence that no change occurred.
    if (!changed) return { bytes, changed: false };
    const output = await pseudoLinearize(doc).save({ useObjectStreams: true });
    return { bytes: output, changed: true };
  },
  async flattenDocument(bytes, job) {
    // Same order of refusals as `fillFormFields`: XFA on the raw bytes first,
    // because a hybrid form answers `false` to every parsed check.
    await checkpoint(job, 0, 'Reading the document');
    if (hasXfaMarker(bytes)) throw unsupported(XFA_MESSAGE);

    const doc = await load(bytes);
    const form = doc.getForm();
    if (form.hasXFA()) throw unsupported(XFA_MESSAGE);

    const fields = form.getFields().length;
    if (fields > 0) {
      await checkpoint(job, 0.25, `Drawing ${fields} form field${fields === 1 ? '' : 's'}`);
      // Same reason as the fill path: a form Stapler built has no /DR, so the
      // appearance pass below cannot resolve the /Helvetica its fields name.
      ensureAcroFormDefaults(doc);
      try {
        try {
          form.updateFieldAppearances();
        } catch {
          // ignore appearance generation fallback errors
        }
        form.flatten();
      } catch (err) {
        // Half a flatten is a mangled document: some fields drawn and removed,
        // the rest still interactive. Refuse, exactly as the fill path does.
        throw corrupt(
          'The form could not be drawn into the page (its default appearance is ' +
            `unusable): ${err instanceof Error ? err.message : String(err)}. Nothing was saved.`
        );
      }
      // pdf-lib leaves an /AcroForm with an empty /Fields behind. Removing the
      // entry means a viewer sees a document with no form at all, which is what
      // "finalized" means.
      doc.catalog.delete(PDFName.of('AcroForm'));
    }

    await checkpoint(job, 0.5, 'Drawing annotations');
    const { baked, dropped } = flattenAnnotations(doc);
    await checkpoint(job, 0.8, 'Writing file');
    return {
      bytes: transfer(await pseudoLinearize(doc).save({ useObjectStreams: true })),
      fields,
      annotationsBaked: baked,
      annotationsDropped: dropped
    };
  },

  async compose(
    pages,
    sources,
    stamps,
    watermark,
    headerFooter,
    normalize,
    nup,
    annotations,
    job,
    extras
  ) {
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
      'Composing page',
      0,
      pages.length,
      extras
    );
    await checkpoint(job, 0.95, 'Writing file');
    return transfer(await pseudoLinearize(outDoc).save({ useObjectStreams: true }));
  },

  async readOutline(bytes) {
    const doc = await load(bytes);
    const outlines = doc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
    if (!outlines) return [];
    return readOutlineNodes(
      outlines,
      pageRefIndex(doc),
      new Set<PDFDict>(),
      namedDestinations(doc)
    );
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
    job,
    extras
  ) {
    if (pages.length === 0) throw internal('Nothing to export: the page list is empty');

    // A whole-document outline cannot be written into a slice — its page indexes
    // address the input, not this file's pages — so only the Bates stamp (which is
    // deliberately continuous across the set) crosses into each slice. Source
    // outlines still carry through per slice via `copyOutlines`, unchanged.
    const sliceExtras: ComposeExtras = {
      bates: extras?.bates,
      formFieldsToCreate: extras?.formFieldsToCreate
    };

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
        pages.length,
        sliceExtras
      );
      return {
        bytes: transfer(await pseudoLinearize(outDoc).save({ useObjectStreams: true })),
        isZip: false,
        fileCount: 1
      };
    }

    const files: Record<string, Uint8Array> = {};
    const pad = Math.max(2, String(slices.length).length);
    const usedNames = new Set<string>();
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
        pages.length,
        sliceExtras
      );
      currentOffset += slices[i].length;
      files[
        uniqueName(
          usedNames,
          extras?.fileNames?.[i],
          `${baseName}-${String(i + 1).padStart(pad, '0')}`
        )
      ] = await pseudoLinearize(outDoc).save({ useObjectStreams: true });
    }

    await checkpoint(job, 0.95, 'Compressing archive');
    const zipped = zipSync(files);
    return { bytes: transfer(zipped), isZip: true, fileCount: slices.length };
  },

  async rebuildCompressed(bytes, rasterPages, replacedImages, job) {
    const source = await load(bytes);

    // Image replacement happens on the source document first: once the page's
    // /XObject entry points at the new stream, the old image is unreachable and
    // copyPages will not carry it into the output. Mutating and re-save in
    // place would keep both copies, which is how "compression" grew files.
    const pages = source.getPages();

    // One replacement stream per *original* image, keyed by its object number.
    // A logo on ten pages is one object in the input, and embedding it once per
    // page would write ten copies of the same JPEG — a shared image has to stay
    // shared or the "compressed" file grows a tenfold image table.
    const embedded = new Map<number, PDFRef>();

    // CMP-06 — the per-image breakdown, measured here because this is the only
    // place both numbers exist: the original stream's stored byte length and the
    // replacement's. Nothing downstream can reconstruct them, which is why the
    // JSON sidecar used to be permanently empty.
    const imageStats: ImageResultStat[] = [];
    const note = (stat: ImageResultStat) => {
      imageStats.push(stat);
    };
    /** Sizes of each object's one encode, so a second page can report them too. */
    const measured = new Map<number, { originalBytes: number; compressedBytes: number }>();

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
        const imageId = matches.length > 0 ? nameKey(matches[0].key) : `object-${objectNumber}`;
        if (matches.length === 0) {
          note({
            pageIndex,
            imageId,
            objectNumber,
            status: 'skipped',
            skipReason:
              'This image is not reachable from the page in the document being rebuilt, so nothing was replaced.'
          });
          continue;
        }
        const oldRef = matches[0].ref;

        const reused = embedded.get(oldRef.objectNumber);
        if (reused) {
          for (const { dict, key } of matches) dict.set(key, reused);
          // The same shared object, displayed on a second page: one embedded
          // stream, but this page is genuinely showing the re-encoded image, so
          // it is reported with the sizes measured the first time round.
          const sizes = measured.get(oldRef.objectNumber);
          note({
            pageIndex,
            imageId,
            objectNumber,
            originalBytes: sizes?.originalBytes,
            compressedBytes: sizes?.compressedBytes,
            status: 're-encoded'
          });
          continue;
        }

        const oldStream = source.context.lookupMaybe(oldRef, PDFStream);
        if (!oldStream) {
          note({
            pageIndex,
            imageId,
            objectNumber,
            status: 'skipped',
            skipReason: 'The original image stream could not be read, so it was left untouched.'
          });
          continue;
        }

        // The stored (already-filtered) length is what the image costs in the
        // file, which is the only number worth comparing a replacement against.
        const originalBytes = storedStreamBytes(oldStream);
        const compressedBytes = encoded.jpeg.byteLength;

        // CMP-04, per image: "compression" that makes an image bigger is not
        // compression. The whole-file gate at the end of this function would
        // catch a net growth, but not an image that grew inside a run that shrank
        // overall — the file gets smaller and one image silently gets worse. A
        // replacement is only taken when it is actually smaller.
        if (originalBytes > 0 && compressedBytes >= originalBytes) {
          note({
            pageIndex,
            imageId,
            objectNumber,
            originalBytes,
            compressedBytes,
            status: 'skipped',
            skipReason:
              `Re-encoding produced ${compressedBytes} bytes against the original ${originalBytes}, ` +
              'so the original stream was kept.'
          });
          continue;
        }

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
        if (!carriable(smaskRef) || !carriable(maskRef)) {
          note({
            pageIndex,
            imageId,
            objectNumber,
            originalBytes,
            status: 'skipped',
            skipReason:
              'Its transparency (a colour-key /Mask or a soft mask that cannot be carried onto a JPEG) ' +
              'would not survive re-encoding, so the original was kept.'
          });
          continue;
        }

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
        if (smaskStreamNow?.dict.get(PDFName.of('Matte')) !== undefined) {
          note({
            pageIndex,
            imageId,
            objectNumber,
            originalBytes,
            status: 'skipped',
            skipReason:
              'Its soft mask is pre-blended against a /Matte colour, which a re-encode would invalidate.'
          });
          continue;
        }
        if (oldStream.dict.lookup(PDFName.of('ImageMask')) === PDFBool.True) {
          note({
            pageIndex,
            imageId,
            objectNumber,
            originalBytes,
            status: 'skipped',
            skipReason: 'It is a 1-bit stencil mask, which a JPEG cannot represent.'
          });
          continue;
        }

        const image = await source.embedJpg(encoded.jpeg);
        // `embedJpg` only reserves a reference; the stream itself is written on
        // save. Forcing it now is what makes the object exist to hang the mask
        // off — without this the lookup below returns undefined and the mask is
        // quietly dropped.
        await image.embed();
        const newStream = source.context.lookup(image.ref);
        if (!(newStream instanceof PDFStream)) {
          note({
            pageIndex,
            imageId,
            objectNumber,
            originalBytes,
            status: 'skipped',
            skipReason: 'The re-encoded image could not be embedded, so the original was kept.'
          });
          continue;
        }

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
        measured.set(oldRef.objectNumber, { originalBytes, compressedBytes });
        note({
          pageIndex,
          imageId,
          objectNumber,
          originalBytes,
          compressedBytes,
          status: 're-encoded'
        });
        for (const { dict, key } of matches) dict.set(key, image.ref);
      }
    }

    const out = await PDFDocument.create();
    preserveDocumentCatalog(source, out);
    const total = source.getPageCount();

    const hasRaster =
      Object.keys(rasterPages).length > 0 && Object.values(rasterPages).some(Boolean);
    const hasReencoded = embedded.size > 0;
    // No raster page and no image actually swapped means no compression work
    // happened at all. Rebuilding anyway would still change the byte length —
    // pdf-lib re-serialises, drops unreferenced objects and rewrites the xref —
    // and the panel would report that difference as "saved", crediting
    // compression for savings no image re-encode produced. `keptOriginal` is the
    // honest answer: the original bytes go back untouched.
    if (!hasRaster && !hasReencoded) {
      return {
        bytes: transfer(new Uint8Array(bytes)),
        keptOriginal: true,
        rasterizedPages: [],
        imageStats
      };
    }

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
    const rebuilt = await pseudoLinearize(out).save({ useObjectStreams: true });

    // CMP-04: a "compressed" file that is not smaller is not saved. Returning the
    // original bytes is the only honest outcome.
    if (rebuilt.byteLength >= bytes.byteLength) {
      return {
        bytes: transfer(new Uint8Array(bytes)),
        keptOriginal: true,
        rasterizedPages: [],
        imageStats
      };
    }
    return { bytes: transfer(rebuilt), keptOriginal: false, rasterizedPages: [], imageStats };
  },

  async applyAltText(bytes, altTexts, job) {
    const doc = await load(bytes);

    if (job) await checkpoint(job, 0.5, 'Tagging images and building structure tree');
    await applyAltTextToDoc(doc, altTexts);

    if (job) await checkpoint(job, 0.9, 'Saving accessible document');
    // We cannot use object streams because it breaks accessibility testing tools
    // that don't fully support PDF 1.5 object streams (like Acrobat Reader sometimes when debugging).
    // Plus, it ensures our `/K` arrays in StructTreeRoot are easily readable.
    return transfer(await pseudoLinearize(doc).save({ useObjectStreams: true }));
  },

  async markdownToPdf(
    markdown: string
  ): Promise<{ bytes: Uint8Array; hadUnsupportedCharacters: boolean }> {
    const bytes = await markdownToPdfBytes(markdown);
    return Comlink.transfer({ bytes, hadUnsupportedCharacters: hadUnsupportedCharacter() }, [
      bytes.buffer
    ]);
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
    return transfer(await pseudoLinearize(doc).save({ useObjectStreams: true }));
  },

  /**
   * CNV-06 — pull every embedded image out as its own file.
   *
   * Enumeration is CMP-03's `collectImageRefs` walker, unchanged: page
   * resources plus nested Form XObjects, matched by object number. What differs
   * is the destination — `extractImageFile` hands over the image object's own
   * encoded bytes instead of re-encoding them.
   *
   * One file per distinct image *object*, named for the page and position it
   * first appears at. A logo drawn on 300 pages is one stream in the file and
   * one file here (the later pages report it as a `duplicate` pointing at that
   * name), which is both the "encode once, not once per page" rule and the only
   * sane output for a document that reuses artwork.
   */
  async extractImages(bytes, pageIndices, job) {
    // Not `allowEncrypted`: an encrypted document's streams are ciphertext, so
    // "extracting" them would write files full of noise. `load` refuses with the
    // explanation instead.
    const doc = await load(bytes);
    const pages = doc.getPages();
    const wanted =
      pageIndices && pageIndices.length > 0
        ? pageIndices.filter(i => i >= 0 && i < pages.length)
        : pages.map((_, i) => i);

    const files: Record<string, Uint8Array> = {};
    const entries: ExtractedImageEntry[] = [];
    /** Object number → what happened the first time this image object was seen. */
    const done = new Map<
      number,
      { fileName: string; byteLength: number } | { refusedBecause: string }
    >();
    const pad = Math.max(3, String(pages.length).length);

    for (let i = 0; i < wanted.length; i++) {
      const pageIndex = wanted[i];
      await checkpoint(
        job,
        i / wanted.length,
        `Extracting images from page ${pageIndex + 1} of ${pages.length}`
      );

      const resources = pages[pageIndex].node.Resources();
      const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      if (!xobjects) continue;
      const refs = collectImageRefs(xobjects, doc.context, new Set(), resources);

      let position = 0;
      const seenOnPage = new Set<number>();
      for (const found of refs) {
        // The same object reachable twice on one page (two resource names for one
        // image) is one image on the page, not two.
        if (seenOnPage.has(found.ref.objectNumber)) continue;
        seenOnPage.add(found.ref.objectNumber);
        position += 1;

        const stream = doc.context.lookup(found.ref);
        if (!(stream instanceof PDFStream)) continue;
        const name = found.key.asString().replace(/^\//, '');
        const width = numberOf(stream.dict, 'Width', 0);
        const height = numberOf(stream.dict, 'Height', 0);
        const base = {
          pageIndex,
          position,
          name,
          objectNumber: found.ref.objectNumber,
          width,
          height
        };

        const already = done.get(found.ref.objectNumber);
        if (already) {
          entries.push(
            'fileName' in already
              ? {
                  ...base,
                  fileName: already.fileName,
                  byteLength: already.byteLength,
                  status: 'duplicate',
                  note: `Same image object as ${already.fileName}, already extracted.`
                }
              : {
                  ...base,
                  byteLength: 0,
                  status: 'skipped',
                  note: `Left in the document: it has ${already.refusedBecause}.`
                }
          );
          continue;
        }

        const outcome = extractImageFile(stream, found.resources, doc.context);
        if (!outcome.ok) {
          done.set(found.ref.objectNumber, { refusedBecause: outcome.reason });
          entries.push({
            ...base,
            byteLength: 0,
            status: 'skipped',
            note: `Left in the document: it has ${outcome.reason}.`
          });
          continue;
        }

        const stem = `page-${String(pageIndex + 1).padStart(pad, '0')}-image-${String(position).padStart(2, '0')}`;
        const fileName = `${stem}.${outcome.file.ext}`;
        files[fileName] = outcome.file.bytes;
        done.set(found.ref.objectNumber, { fileName, byteLength: outcome.file.bytes.length });

        // Transparency is a separate object in PDF, and the base image's native
        // bytes cannot carry it (a JPEG has no alpha channel at all). Rather than
        // re-encode the pair into something that can — which would be exactly the
        // generational loss this ticket forbids — the mask is written beside it.
        let maskFileName: string | undefined;
        let maskNote: string | undefined;
        const smask = stream.dict.lookupMaybe(PDFName.of('SMask'), PDFStream);
        const hardMask = stream.dict.lookup(PDFName.of('Mask'));
        const maskStream = smask ?? (hardMask instanceof PDFStream ? hardMask : undefined);
        if (maskStream) {
          const maskOutcome = extractImageFile(maskStream, found.resources, doc.context);
          if (maskOutcome.ok) {
            maskFileName = `${stem}-mask.${maskOutcome.file.ext}`;
            files[maskFileName] = maskOutcome.file.bytes;
            maskNote = `Transparency is a separate PDF object; it is beside this file as ${maskFileName}.`;
          } else {
            maskNote = `This image has transparency that could not be extracted: it has ${maskOutcome.reason}.`;
          }
        } else if (hardMask !== undefined) {
          maskNote =
            'This image has colour-key transparency, which is defined by sample values rather than by a mask image.';
        }

        entries.push({
          ...base,
          fileName,
          maskFileName,
          byteLength: outcome.file.bytes.length,
          status: 'extracted',
          note: maskNote
        });
      }
    }

    await checkpoint(job, 0.95, 'Building the archive');
    // Store, not deflate: JPEG, JPEG 2000, and PNG are already compressed, so
    // deflating them again costs seconds and saves nothing (CNV-02 does the same).
    return { bytes: transfer(zipSync(files, { level: 0 })), entries };
  },

  async findImagesForAltText(bytes, job) {
    const doc = await load(bytes);
    const pages = doc.getPages();
    const images: ImageAltInfo[] = [];
    const done = new Set<number>();

    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
      await checkpoint(job, pageIndex / pages.length, `Scanning page ${pageIndex + 1} for images`);

      const resources = pages[pageIndex].node.Resources();
      const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      if (!xobjects) continue;
      const refs = collectImageRefs(xobjects, doc.context, new Set(), resources);

      for (const found of refs) {
        if (done.has(found.ref.objectNumber)) continue;

        const stream = doc.context.lookup(found.ref);
        if (!(stream instanceof PDFStream)) continue;

        const outcome = extractImageFile(stream, found.resources, doc.context);
        if (!outcome.ok) {
          done.add(found.ref.objectNumber);
          continue;
        }

        const width = numberOf(stream.dict, 'Width', 0);
        const height = numberOf(stream.dict, 'Height', 0);
        const name = found.key.asString().replace(/^\//, '');

        images.push({
          pageIndex,
          objectNumber: found.ref.objectNumber,
          name,
          width,
          height,
          ext: outcome.file.ext,
          bytes: transfer(outcome.file.bytes)
        });
        done.add(found.ref.objectNumber);
      }
    }
    return images;
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

  async protectDocument(bytes, settings, job) {
    // Encryption re-writes every string and stream in the document, which on a
    // large file is seconds of work that used to report nothing and could not
    // be cancelled at all.
    //
    // The AES pass itself lives in `core/pdf/encrypt.ts`, which now checkpoints
    // inside its own per-object loop (see ENCRYPT_CHECKPOINT_MS): cancellation
    // is honoured during the encryption, not only either side of it. Its 0..1
    // progress is mapped into the 0.1–0.95 slice of this operation's bar.
    await checkpoint(job, 0, 'Reading the document');
    await checkpoint(job, 0.1, 'Encrypting');
    const out = await encryptPdf(bytes, settings, subJob(job, 0.1, 0.95));
    await checkpoint(job, 1, 'Encrypted');
    return out;
  },

  async scrubMetadata(bytes, settings, job) {
    await checkpoint(job, 0, 'Reading the document');
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

    const scrubPages = doc.getPages();
    for (let i = 0; i < scrubPages.length; i++) {
      await checkpoint(
        job,
        0.1 + (i / Math.max(1, scrubPages.length)) * 0.3,
        `Scrubbing page ${i + 1} of ${scrubPages.length}`
      );
      const page = scrubPages[i];
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
    const rebuildPages = doc.getPages();
    for (let i = 0; i < rebuildPages.length; i++) {
      await checkpoint(
        job,
        0.4 + (i / Math.max(1, rebuildPages.length)) * 0.5,
        `Rebuilding page ${i + 1} of ${rebuildPages.length}`
      );
      const leaf = copier.copy(rebuildPages[i].node);
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
    await checkpoint(job, 0.95, 'Writing file');
    return transfer(await pseudoLinearize(out).save({ useObjectStreams: true }));
  },

  async planImageRedactions(bytes, regions) {
    const source = await load(bytes);
    const pages = source.getPages();
    const regionsByPage = groupRegionsByPage(regions);
    const requests: ImageRedactionRequest[] = [];

    for (const [pageIndex, pageRegions] of regionsByPage) {
      const page = pages[pageIndex];
      if (!page) continue;
      const rects = redactionRectsForPage(page, pageRegions);
      const { partialImages } = await filterPageForRedaction(page, source.context, rects);
      if (partialImages.size === 0) continue;
      const xObjects = pageXObjectDictOf(page, source.context);
      for (const [name, unitRects] of partialImages) {
        const entry = xObjects?.get(PDFName.of(name));
        if (!(entry instanceof PDFRef)) {
          // A direct (non-indirect) image XObject cannot be addressed by object
          // number, which is the only identifier pdf.js and pdf-lib share. Rather
          // than guess, say so: the caller refuses the redaction.
          throw unsupported(
            `An image on page ${pageIndex + 1} is partly covered by a redaction mark but is ` +
              'stored in a form Stapler cannot address for pixel-level removal. Nothing was ' +
              'changed — your original document is untouched.'
          );
        }
        requests.push({ pageIndex, name, objectNumber: entry.objectNumber, rects: unitRects });
      }
    }

    return requests;
  },

  async planPageImages(bytes, pageIndices) {
    const source = await load(bytes);
    const pages = source.getPages();
    const wanted =
      pageIndices && pageIndices.length > 0
        ? pageIndices.filter(index => index >= 0 && index < pages.length)
        : pages.map((_, index) => index);

    const images: PageImageRef[] = [];
    const unaddressablePages = new Set<number>();

    for (const pageIndex of wanted) {
      const page = pages[pageIndex];
      if (!page) continue;
      const xObjects = pageXObjectDictOf(page, source.context);
      if (!xObjects) continue;
      for (const [key, value] of xObjects.entries()) {
        // `/Subtype /Image` is the only thing that can hold a face; a `/Form`
        // XObject is a nested content stream, and its own images are reached
        // through the page that draws it in the normal way.
        const stream = value instanceof PDFRef ? source.context.lookup(value) : value;
        if (!(stream instanceof PDFStream)) continue;
        if (stream.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
        if (!(value instanceof PDFRef)) {
          unaddressablePages.add(pageIndex);
          continue;
        }
        images.push({
          pageIndex,
          name: key.asString().replace(/^\//, ''),
          objectNumber: value.objectNumber
        });
      }
    }

    return { images, unaddressablePages: [...unaddressablePages] };
  },

  async replacePageImages(bytes, replacements, job) {
    const doc = await load(bytes);
    const pages = doc.getPages();
    const pageIndices = Object.keys(replacements)
      .map(Number)
      .filter(index => Number.isInteger(index) && index >= 0 && index < pages.length)
      .sort((a, b) => a - b);
    if (pageIndices.length === 0) return transfer(bytes);

    // Each distinct replacement is embedded once and its ref reused, so an
    // image drawn on twenty pages produces one new stream rather than twenty
    // copies of the same blurred raster. Keyed on the byte buffer itself: the
    // caller already de-duplicated by object number, and identity is exactly
    // the question being asked.
    const embedded = new Map<Uint8Array, PDFRef>();
    const retired = new Set<PDFRef>();

    for (let i = 0; i < pageIndices.length; i++) {
      const pageIndex = pageIndices[i];
      await checkpoint(job, i / pageIndices.length, `Updating page ${pageIndex + 1}`);
      const page = pages[pageIndex];
      const xObjects = localizePageResources(page, doc.context);
      // Reachable only if the caller's plan disagrees with what this page
      // actually has — `planPageImages` uses the same resource lookup, so a
      // page it found images on always has one here too. Continuing quietly
      // would let the caller believe this page's image was replaced (it
      // counts toward `pagesTouched`) when nothing was written at all.
      if (!xObjects) {
        throw internal(
          `Page ${pageIndex + 1} has an image replacement queued, but no image resources to apply it to.`
        );
      }

      for (const [name, replacement] of Object.entries(replacements[pageIndex])) {
        const pdfName = PDFName.of(name);
        const previous = xObjects.get(pdfName);
        let ref = embedded.get(replacement.bytes);
        if (!ref) {
          const image =
            replacement.format === 'png'
              ? await doc.embedPng(replacement.bytes)
              : await doc.embedJpg(replacement.bytes);
          // `embedPng`/`embedJpg` only reserve a reference; the stream is
          // written on save. Forcing it now is what makes the object exist to
          // point at.
          await image.embed();
          ref = image.ref;
          embedded.set(replacement.bytes, ref);
        }
        xObjects.set(pdfName, ref);
        if (previous instanceof PDFRef) retired.add(previous);
      }
    }

    // Purged after every page has been rewritten, not during: an image shared
    // between two pages is still named by the second one while the first is
    // being processed, and purging then would leave a dangling reference.
    for (const ref of retired) purgeXObjectIfUnreferenced(doc, ref);

    await checkpoint(job, 0.95, 'Writing file');
    return transfer(await doc.save({ useObjectStreams: true }));
  },

  async applyRedactions(bytes, regions, imageReplacements, job) {
    const source = await load(bytes);
    const sourcePages = source.getPages();
    const regionsByPage = groupRegionsByPage(regions);

    const out = await PDFDocument.create();
    preserveDocumentCatalog(source, out, undefined, REDACTION_CATALOG_KEYS);
    const total = sourcePages.length;

    for (let i = 0; i < total; i++) {
      await checkpoint(job, i / total, `Redacting page ${i + 1} of ${total}`);

      const [copied] = await out.copyPages(source, [i]);
      out.addPage(copied);

      const pageRegions = regionsByPage.get(i);
      if (!pageRegions) continue;

      const rects = redactionRectsForPage(copied, pageRegions);

      // 1. Operator-level content removal.
      const { content, strippedXObjectNames, partialImages } = await filterPageForRedaction(
        copied,
        out.context,
        rects
      );
      if (content) {
        const newStream = out.context.flateStream(content);
        copied.node.set(PDFName.of('Contents'), out.context.register(newStream));
      }

      const xObjects = localizePageResources(copied, out.context);

      // 2. Image XObjects whose `Do` was removed outright: unhook the name, then
      // drop the stream itself. pdf-lib serialises every object in its context
      // whether or not anything references it, so unhooking alone leaves the
      // image bytes recoverable with `pdfimages`.
      if (strippedXObjectNames.length > 0 && xObjects) {
        for (const name of strippedXObjectNames) {
          const pdfName = PDFName.of(name);
          const entry = xObjects.get(pdfName);
          xObjects.delete(pdfName);
          if (entry instanceof PDFRef) purgeXObjectIfUnreferenced(out, entry);
        }
      }

      // 3. Image XObjects a mark only *partly* covers. The `Do` has to stay (the
      // uncovered part of the image is content the user kept), so the only real
      // removal is in the pixels — supplied by the caller, which decodes the
      // image with pdf.js and paints the covered area opaque black. Without one
      // the operation is refused: painting a black rectangle over an intact
      // full-resolution image is an overlay, not a redaction, and reporting it
      // as verified would be the worst outcome available.
      for (const name of partialImages.keys()) {
        const entry = xObjects?.get(PDFName.of(name));
        const replacement = entry instanceof PDFRef ? imageReplacements?.[i]?.[name] : undefined;
        if (!replacement) {
          throw unsupported(
            `An image on page ${i + 1} is only partly covered by a redaction mark, and its ` +
              'pixels could not be decoded and blacked out (JBIG2 and JPEG 2000 images cannot ' +
              'be decoded here). Drawing a black box over it would leave the original image ' +
              'inside the file. Nothing was changed — your original document is untouched. ' +
              'Cover the whole image with the mark, or rasterise the page first.'
          );
        }
        const image =
          replacement.format === 'png'
            ? await out.embedPng(replacement.bytes)
            : await out.embedJpg(replacement.bytes);
        // `embedPng`/`embedJpg` only reserve a reference; the stream is written
        // on save. Forcing it now is what makes the object exist to point at.
        await image.embed();
        xObjects!.set(PDFName.of(name), image.ref);
        if (entry instanceof PDFRef) purgeXObjectIfUnreferenced(out, entry);
      }

      // 4. Annotations overlapping a mark. Their /Contents, field values and
      // appearance streams are text a viewer never shows on the page but every
      // extraction tool reads, so they are removed from /Annots *and* deleted.
      stripOverlappingAnnotations(out, copied, rects);

      // 5. The opaque mark itself, drawn on top of what is left. A shaped mark
      // (RED-07) is filled as its own path: drawing its bounding rectangle
      // instead would black out the corners the shape deliberately left alone,
      // which is content the user chose to keep — and the pixel verifier, which
      // now samples inside the shape, would still pass it, so the difference
      // would be silent.
      for (const rect of rects) {
        if (rect.polygon) {
          copied.drawSvgPath(polygonSvgPath(rect.polygon), {
            x: 0,
            y: 0,
            color: DOC_REDACT,
            borderWidth: 0
          });
          continue;
        }
        copied.drawRectangle({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          color: DOC_REDACT,
          borderWidth: 0
        });
      }
    }

    reattachAcroForm(out, [source]);
    // The last line of defence, and the one that does not depend on every
    // removal path above having remembered to clean up after itself: anything no
    // longer reachable from the catalog is deleted outright, so pdf-lib cannot
    // serialise an orphaned annotation, form field, or appearance stream whose
    // text was supposed to be gone.
    sweepUnreachableObjects(out);
    await checkpoint(job, 0.95, 'Writing file');
    return transfer(await pseudoLinearize(out).save({ useObjectStreams: true }));
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
  },

  async addOcrTextLayer(bytes, layers, job) {
    await checkpoint(job, 0.85, 'Writing the text layer');
    const doc = await load(bytes);

    const report = await addOcrTextLayerToDocument(doc, layers);
    if (report.wordsAdded === 0) {
      // Nothing recognised anywhere. Handing back the input untouched is both
      // cheaper and safer than saving a re-serialised copy that differs from the
      // original for no user-visible reason.
      return { bytes, ...report };
    }

    await checkpoint(job, 0.95, 'Saving');
    return {
      bytes: transfer(await pseudoLinearize(doc).save({ useObjectStreams: true })),
      ...report
    };
  },

  // DOC-09 — contact sheet
  async contactSheetExport(jpegPages, cols, job) {
    await checkpoint(job, 0, 'Building contact sheet');

    // A4 portrait in points (72 pt/in)
    const PAGE_W = 595.28;
    const PAGE_H = 841.89;
    const MARGIN = 20;
    const GAP = 8;

    const maxRowsPerPage = 5;
    const itemsPerPage = cols * maxRowsPerPage;
    const totalSheets = Math.max(1, Math.ceil(jpegPages.length / itemsPerPage));

    const out = await PDFDocument.create();

    for (let p = 0; p < totalSheets; p++) {
      const sheetPage = out.addPage([PAGE_W, PAGE_H]);
      const pageItems = jpegPages.slice(p * itemsPerPage, (p + 1) * itemsPerPage);
      const cellW = (PAGE_W - MARGIN * 2 - GAP * (cols - 1)) / cols;
      const cellH = (PAGE_H - MARGIN * 2 - GAP * (maxRowsPerPage - 1)) / maxRowsPerPage;

      for (let i = 0; i < pageItems.length; i++) {
        const globalIdx = p * itemsPerPage + i;
        await checkpoint(job, globalIdx / jpegPages.length, `Embedding thumbnail ${globalIdx + 1}`);
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = MARGIN + col * (cellW + GAP);
        const y = PAGE_H - MARGIN - (row + 1) * cellH - row * GAP;

        const img = await out.embedJpg(pageItems[i]);
        const { width: iw, height: ih } = img;
        const scale = Math.min(cellW / iw, cellH / ih);
        const dw = iw * scale;
        const dh = ih * scale;
        const dx = x + (cellW - dw) / 2;
        const dy = y + (cellH - dh) / 2;

        sheetPage.drawImage(img, { x: dx, y: dy, width: dw, height: dh });
      }
    }

    await checkpoint(job, 0.95, 'Saving');
    return transfer(await pseudoLinearize(out).save({ useObjectStreams: true }));
  }
};

/* ------------------------------------------------------------------ *
 * Redaction internals (RED-02, RED-03)
 * ------------------------------------------------------------------ */

/**
 * A content stream's operators, whatever filter chain it was stored under.
 *
 * The old test — "is `/Filter` the name `FlateDecode`, or an array whose *first*
 * entry is" — got two common cases wrong and got them wrong silently. A chain
 * like `[/ASCII85Decode /FlateDecode]` failed the check, so the still-ASCII85'd
 * (and still deflated) bytes were tokenised as if they were operators, producing
 * a page of garbage tokens that was then re-serialised over the real content. An
 * `/LZWDecode` stream did the same. Both destroyed the page and reported
 * success.
 *
 * pdf-lib's own `decodePDFRawStream` walks the whole chain and refuses what it
 * cannot decode, which is exactly the behaviour needed: decode it properly, or
 * say so and let the caller return the original bytes.
 */
async function decodeContentStreamBytes(
  stream: PDFStream,
  context: PDFContext
): Promise<Uint8Array> {
  const filters = filterNamesOf(stream.dict.get(PDFName.of('Filter')), context);
  const raw = stream.getContents();
  if (filters.length === 0) return raw;

  if (stream instanceof PDFRawStream) {
    try {
      return decodePDFRawStream(stream).decode();
    } catch (err) {
      throw unsupported(
        `A page's content stream uses a filter chain Stapler cannot decode (${filters.join(
          ' → '
        )}): ${err instanceof Error ? err.message : String(err)}. Nothing was changed — your ` +
          'original document is untouched. Re-save the file from a PDF viewer and try again.'
      );
    }
  }

  // A stream this process built itself, rather than one read from the file.
  if (filters.length === 1 && filters[0] === 'FlateDecode') return decodeStream(raw);
  throw unsupported(
    `A page's content stream uses a filter chain Stapler cannot decode (${filters.join(' → ')}). ` +
      'Nothing was changed — your original document is untouched.'
  );
}

/**
 * A closed polygon in PDF user space as an SVG path for `drawSvgPath`.
 *
 * pdf-lib emits `translate(x, y)` then `scale(1, -1)` before the path, so path
 * coordinates are read with y running *down* from the anchor — hence the negated
 * y against an anchor of (0, 0), which leaves the path in page space. Fixed
 * notation, never exponential: pdf-lib's path parser would read `1e-7` as a
 * number followed by a command letter.
 */
function polygonSvgPath(points: { x: number; y: number }[]): string {
  const at = (p: { x: number; y: number }) => `${p.x.toFixed(4)},${(-p.y).toFixed(4)}`;
  return `M ${at(points[0])} ${points
    .slice(1)
    .map(p => `L ${at(p)}`)
    .join(' ')} Z`;
}

/**
 * The redaction regions for one page, in that page's unrotated content space.
 *
 * pdf.js applies `/Rotate` when building the viewport, so the normalised
 * coordinates the UI produced are in the *rotated* frame. The inverse rotation
 * maps them back to the space `filterContentStream` and `drawRectangle` work in.
 *
 * A shaped mark (RED-07) carries its polygon through the same mapping, so the box
 * and the shape can never end up in different frames.
 */
function redactionRectsForPage(page: PDFPage, regions: RedactionRegion[]): RedactionArea[] {
  const cropBox = page.getCropBox();
  const rotateDeg = normalizeRotation(page.getRotation().angle);

  /**
   * One normalised mark corner → PDF user space, by the same four cases as the
   * box below. A rect is `{rx, ry, rw, rh}` with `rh = 0` at a single point, so
   * this is that arithmetic with the extents dropped — which is why a polygon
   * built from a rect's own four corners maps to exactly the rect's own box (the
   * property `redact-polygon.test.ts` pins down for all four rotations).
   */
  const pointToPage = (x: number, y: number) => {
    let nx: number, ny: number;
    if (rotateDeg === 0) {
      nx = x;
      ny = y;
    } else if (rotateDeg === 90) {
      nx = y;
      ny = 1 - x;
    } else if (rotateDeg === 180) {
      nx = 1 - x;
      ny = 1 - y;
    } else {
      nx = 1 - y;
      ny = x;
    }
    return {
      x: cropBox.x + nx * cropBox.width,
      y: cropBox.y + cropBox.height * (1 - ny)
    };
  };

  return regions.map(r => {
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
    // Normalised fractions (top-left origin) → PDF user space (bottom-left origin).
    const box: RedactionArea = {
      x: cropBox.x + rx * cropBox.width,
      y: cropBox.y + cropBox.height * (1 - ry - rh),
      width: rw * cropBox.width,
      height: rh * cropBox.height
    };
    // A shape needs at least a triangle to enclose anything; anything less falls
    // back to its bounding box rather than silently redacting nothing.
    if (r.points && r.points.length >= 3) {
      box.polygon = r.points.map(p => pointToPage(p.x, p.y));
    }
    return box;
  });
}

function groupRegionsByPage(regions: RedactionRegion[]): Map<number, RedactionRegion[]> {
  const byPage = new Map<number, RedactionRegion[]>();
  for (const region of regions) {
    const list = byPage.get(region.pageIndex);
    if (list) list.push(region);
    else byPage.set(region.pageIndex, [region]);
  }
  return byPage;
}

/** The page's `/Resources/XObject` dictionary, through however many refs. */
function pageXObjectDictOf(page: PDFPage, context: PDFContext): PDFDict | undefined {
  // `page.node.Resources()` (not a raw `.get('Resources')`) walks up to the
  // nearest `/Pages` ancestor that declares one, per spec — a page is free to
  // have no `/Resources` of its own and inherit the tree's. A direct get
  // here made every caller of this helper (image-redaction planning as well
  // as RED-08's face-blur planning) silently see "no images" on such a page
  // — indistinguishable from a page that genuinely has none, so a face or a
  // redaction target on it was never even offered, with no error to say why.
  const resources = page.node.Resources();
  const xObjectRaw = resources?.get(PDFName.of('XObject'));
  return xObjectRaw instanceof PDFDict
    ? xObjectRaw
    : xObjectRaw instanceof PDFRef
      ? (context.lookup(xObjectRaw) as PDFDict | undefined)
      : undefined;
}

/**
 * Materialises a page-local `/Resources` dictionary so mutating `/XObject`
 * cannot accidentally mutate a shared inherited dictionary from another page.
 */
function localizePageResources(page: PDFPage, context: PDFContext): PDFDict | undefined {
  const resources = page.node.Resources();
  if (!resources) return undefined;

  const localResources = context.obj({}) as PDFDict;
  for (const [key, value] of resources.entries()) {
    localResources.set(key, value);
  }

  const xObjects = pageXObjectDictOf(page, context);
  if (xObjects) {
    const localXObjects = context.obj({}) as PDFDict;
    for (const [key, value] of xObjects.entries()) {
      localXObjects.set(key, value);
    }
    localResources.set(PDFName.of('XObject'), localXObjects);
  }

  page.node.set(PDFName.of('Resources'), localResources);
  const localized = localResources.lookupMaybe(PDFName.of('XObject'), PDFDict);
  return localized ?? undefined;
}

/** The page's `/Resources/Font` dictionary, if it has one. */
function pageFontDictOf(page: PDFPage, context: PDFContext): PDFDict | undefined {
  const resourcesRaw = page.node.get(PDFName.of('Resources'));
  const resources =
    resourcesRaw instanceof PDFDict
      ? resourcesRaw
      : resourcesRaw instanceof PDFRef
        ? (context.lookup(resourcesRaw) as PDFDict | undefined)
        : undefined;
  const fontRaw = resources?.get(PDFName.of('Font'));
  return fontRaw instanceof PDFDict
    ? fontRaw
    : fontRaw instanceof PDFRef
      ? (context.lookup(fontRaw) as PDFDict | undefined)
      : undefined;
}

function asDict(value: unknown, context: PDFContext): PDFDict | undefined {
  const resolved = value instanceof PDFRef ? context.lookup(value) : value;
  return resolved instanceof PDFDict ? resolved : undefined;
}

/**
 * DOC-12 — a `/Type0` (composite) font's own dict never carries a
 * `/FontDescriptor` itself; both the embedding question and the display name
 * live one level down, in `/DescendantFonts[0]`. Everything else (Type1,
 * TrueType) carries both directly.
 */
function descriptorHostOf(fontDict: PDFDict, context: PDFContext): PDFDict {
  if (fontDict.get(PDFName.of('Subtype')) === PDFName.of('Type0')) {
    const descendants = asArray(fontDict.get(PDFName.of('DescendantFonts')), context);
    const descendant = descendants ? asDict(descendants.get(0), context) : undefined;
    if (descendant) return descendant;
  }
  return fontDict;
}

function isFontEmbedded(fontDict: PDFDict, context: PDFContext): boolean {
  const descriptor = asDict(
    descriptorHostOf(fontDict, context).get(PDFName.of('FontDescriptor')),
    context
  );
  if (!descriptor) return false;
  return (
    descriptor.get(PDFName.of('FontFile')) !== undefined ||
    descriptor.get(PDFName.of('FontFile2')) !== undefined ||
    descriptor.get(PDFName.of('FontFile3')) !== undefined
  );
}

/** `/BaseFont`, with a subset tag (`ABCDEF+`) stripped so `Arial` reads as `Arial`. */
function baseFontNameOf(fontDict: PDFDict): string {
  const raw = fontDict.get(PDFName.of('BaseFont'));
  const name = raw instanceof PDFName ? raw.asString().replace(/^\//, '') : 'Unknown';
  return name.replace(/^[A-Z]{6}\+/, '');
}

/**
 * The only substitution DOC-12 will ever offer: an exact name match to
 * regular-weight Arial/Helvetica, re-embedded with the *real*, vendored
 * Liberation Sans Regular font program (metric-compatible with Arial — the
 * same substitute pdf.js's own renderer already uses when a PDF references
 * Arial without embedding it, per `pdfjs-setup.ts`).
 *
 * Deliberately narrow, for two reasons stated rather than glossed over:
 *
 *  1. pdf-lib's own 14 "standard" fonts (`StandardFonts.Helvetica` etc.) are
 *     *not* a real substitution — the PDF spec assumes viewers already have
 *     them, so pdf-lib writes no `/FontFile` for them at all. Answering this
 *     ticket's AC ("finding the font's `/FontFile*` present") needs a real,
 *     bundled font program, and Liberation Sans is the only one already
 *     vendored in this codebase in a format (`.ttf`) fontkit can embed — the
 *     Foxit serif/fixed fallbacks alongside it are legacy Type 1 (`.pfb`).
 *  2. Only the regular weight is vendored here, so only names that mean
 *     "plain Arial/Helvetica" are matched. Reporting a bold or italic font as
 *     safely substitutable by a *regular*-weight program would change how the
 *     text actually looks — exactly the silent corruption this codebase's
 *     "never silently corrupt a document" rule exists to rule out — so a
 *     bold/italic reference reports no match rather than a wrong one.
 */
const SUBSTITUTABLE_FONT_NAMES = new Set(['Arial', 'ArialMT', 'Helvetica']);
const SUBSTITUTE_FONT_LABEL = 'Liberation Sans Regular (Arial-compatible)';

function standardFontFor(baseFont: string): string | null {
  return SUBSTITUTABLE_FONT_NAMES.has(baseFont) ? SUBSTITUTE_FONT_LABEL : null;
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function asArray(value: unknown, context: PDFContext): PDFArray | undefined {
  const resolved = value instanceof PDFRef ? context.lookup(value) : value;
  return resolved instanceof PDFArray ? resolved : undefined;
}

function numberAt(array: PDFArray, index: number, context: PDFContext): number | undefined {
  const raw = array.get(index);
  const resolved = raw instanceof PDFRef ? context.lookup(raw) : raw;
  return resolved instanceof PDFNumber ? resolved.asNumber() : undefined;
}

/**
 * `/BaseFont` name → the AFM metric set that describes it.
 *
 * The standard 14 are the one family of fonts a PDF is allowed to reference
 * without shipping any metrics at all: no `/Widths`, often no
 * `/FontDescriptor`, because every conforming viewer is required to already
 * know them. pdf-lib's own `StandardFonts` writes exactly that shape, as do
 * plenty of real producers. The redaction filter used to meet such a font with
 * nothing but a flat 0.6 em-per-glyph guess, which for mixed prose overshoots
 * the real advance by about a fifth — so the estimated run sat to the *right* of
 * the run a viewer draws, and a mark over one field in it matched the wrong
 * glyphs.
 *
 * These are the real metrics instead, out of the same tables pdf.js measures
 * with, so the estimate stops being an estimate. The Arial and Courier New
 * aliases are here because they are metric-compatible with the Helvetica and
 * Courier entries they map to — the same equivalence DOC-12's font substitution
 * already relies on — and are what Windows producers emit for them.
 */
const STANDARD_FONT_METRICS: Readonly<Record<string, IFontNames>> = {
  Helvetica: FontNames.Helvetica,
  'Helvetica-Bold': FontNames.HelveticaBold,
  'Helvetica-Oblique': FontNames.HelveticaOblique,
  'Helvetica-BoldOblique': FontNames.HelveticaBoldOblique,
  Arial: FontNames.Helvetica,
  ArialMT: FontNames.Helvetica,
  'Arial-Bold': FontNames.HelveticaBold,
  'Arial-BoldMT': FontNames.HelveticaBold,
  'Arial-Italic': FontNames.HelveticaOblique,
  'Arial-ItalicMT': FontNames.HelveticaOblique,
  'Arial-BoldItalicMT': FontNames.HelveticaBoldOblique,
  Courier: FontNames.Courier,
  'Courier-Bold': FontNames.CourierBold,
  'Courier-Oblique': FontNames.CourierOblique,
  'Courier-BoldOblique': FontNames.CourierBoldOblique,
  CourierNew: FontNames.Courier,
  CourierNewPSMT: FontNames.Courier,
  'Times-Roman': FontNames.TimesRoman,
  'Times-Bold': FontNames.TimesRomanBold,
  'Times-Italic': FontNames.TimesRomanItalic,
  'Times-BoldItalic': FontNames.TimesRomanBoldItalic,
  TimesNewRoman: FontNames.TimesRoman,
  TimesNewRomanPSMT: FontNames.TimesRoman,
  Symbol: FontNames.Symbol,
  ZapfDingbats: FontNames.ZapfDingbats
};

interface StandardMetricTable {
  /** Character code → width in 1/1000 em, for codes this table can be sure of. */
  widths: Map<number, number>;
  /** The widest glyph in the whole font, in 1/1000 em. */
  maxGlyphWidth: number;
}

/** Built tables, keyed by metric set plus base encoding. `null` caches a miss. */
const standardMetricCache = new Map<string, StandardMetricTable | null>();

/**
 * The code → width table for one standard-14 metric set under one base
 * encoding, or `null` when the metrics cannot be read.
 *
 * Codes 32–126 are populated whatever the encoding, because every Latin text
 * encoding a PDF can name (Standard, WinAnsi, MacRoman, PDFDoc) agrees on the
 * glyph for each of them — except codes 39 and 96, where Standard has
 * `quoteright`/`quoteleft` and WinAnsi has `quotesingle`/`grave`, at different
 * widths. Those two are populated only when `/WinAnsiEncoding` is named
 * explicitly, and otherwise left out: a code absent from the table is treated
 * as inexact by the filter, which costs that run its glyph-level split but
 * cannot mis-measure it. Above 126 the encodings genuinely disagree, so those
 * codes need the same explicit naming.
 */
function standardMetricTable(metricName: IFontNames, baseEncoding: string | undefined) {
  const key = `${metricName}|${baseEncoding ?? ''}`;
  const cached = standardMetricCache.get(key);
  if (cached !== undefined) return cached;

  let table: StandardMetricTable | null = null;
  try {
    const font = StandardFontMetrics.load(metricName);
    const symbolic =
      metricName === FontNames.Symbol
        ? Encodings.Symbol
        : metricName === FontNames.ZapfDingbats
          ? Encodings.ZapfDingbats
          : undefined;
    const encoding = symbolic ?? Encodings.WinAnsi;

    const names = new Map<number, string>();
    for (const codePoint of encoding.supportedCodePoints) {
      const encoded = encoding.encodeUnicodeCodePoint(codePoint);
      if (!names.has(encoded.code)) names.set(encoded.code, encoded.name);
    }

    const widthOfGlyph = (glyph: string) => {
      const width = font.getWidthOfGlyph(glyph);
      return typeof width === 'number' && Number.isFinite(width) ? width : undefined;
    };

    // A symbolic font has exactly one encoding, so every code in it is certain.
    const winAnsi = baseEncoding === 'WinAnsiEncoding';
    const widths = new Map<number, number>();
    let maxGlyphWidth = 0;
    for (const [code, glyph] of names) {
      const width = widthOfGlyph(glyph);
      if (width === undefined) continue;
      if (width > maxGlyphWidth) maxGlyphWidth = width;
      const certain =
        symbolic || winAnsi || (code >= 32 && code <= 126 && code !== 39 && code !== 96);
      if (certain) widths.set(code, width);
    }
    if (widths.size > 0 && maxGlyphWidth > 0) table = { widths, maxGlyphWidth };
  } catch {
    // A metric set that will not load is a miss, not a failure: the caller falls
    // back to the guessed width and its conservative coverage bound.
    table = null;
  }

  standardMetricCache.set(key, table);
  return table;
}

/**
 * The `/Encoding` a simple font names, as `BaseEncoding` plus `/Differences`.
 * `/Encoding` may be a name or a dictionary (PDF 32000 9.6.6).
 */
function simpleFontEncoding(dict: PDFDict, context: PDFContext) {
  const raw = dict.get(PDFName.of('Encoding'));
  const resolved = raw instanceof PDFRef ? context.lookup(raw) : raw;
  if (resolved instanceof PDFName) {
    return { baseEncoding: resolved.asString().replace(/^\//, ''), differences: undefined };
  }
  if (resolved instanceof PDFDict) {
    const base = resolved.get(PDFName.of('BaseEncoding'));
    return {
      baseEncoding: base instanceof PDFName ? base.asString().replace(/^\//, '') : undefined,
      differences: asArray(resolved.get(PDFName.of('Differences')), context)
    };
  }
  return { baseEncoding: undefined, differences: undefined };
}

/**
 * Widths for a simple font that ships none of its own, from the standard-14
 * metrics its `/BaseFont` names — or `undefined` when it names something else.
 */
function standardFontWidths(
  dict: PDFDict,
  context: PDFContext
): { widths: Map<number, number>; maxGlyphWidth: number } | undefined {
  const metricName = STANDARD_FONT_METRICS[baseFontNameOf(dict)];
  if (!metricName) return undefined;

  const { baseEncoding, differences } = simpleFontEncoding(dict, context);
  const table = standardMetricTable(metricName, baseEncoding);
  if (!table) return undefined;

  const widths = new Map(table.widths);

  // `/Differences` remaps codes to named glyphs. Applying it is not optional:
  // without it a remapped code would be measured as whatever glyph the base
  // encoding puts there, which is a wrong width rather than a missing one. A
  // name this font has no metric for is *deleted*, so the filter treats that
  // code as inexact instead of trusting a stale entry.
  if (differences) {
    let font: ReturnType<typeof StandardFontMetrics.load> | undefined;
    try {
      font = StandardFontMetrics.load(metricName);
    } catch {
      return undefined;
    }
    let code = 0;
    for (let i = 0; i < differences.size(); i++) {
      const raw = differences.get(i);
      const item = raw instanceof PDFRef ? context.lookup(raw) : raw;
      if (item instanceof PDFNumber) {
        code = item.asNumber();
        continue;
      }
      if (!(item instanceof PDFName)) continue;
      const width = font.getWidthOfGlyph(item.asString().replace(/^\//, ''));
      if (typeof width === 'number' && Number.isFinite(width)) widths.set(code, width);
      else widths.delete(code);
      code++;
    }
  }

  return widths.size > 0 ? { widths, maxGlyphWidth: table.maxGlyphWidth } : undefined;
}

/**
 * An upper bound on any glyph's advance in this font, in 1/1000 em, or
 * `undefined` when the font declares nothing to bound it with.
 *
 * Fed to `FontInfo.maxGlyphWidth`, which uses it *only* to widen the redaction
 * filter's hit-testing box for a code whose width had to be guessed — never to
 * position anything. The widest declared width bounds the font on its own; the
 * `/FontBBox` span covers a font that declares no per-code widths at all, which
 * is exactly the case that used to be measured at a flat 0.6 em and therefore
 * measured *narrower* than the glyphs a viewer draws.
 */
function maxGlyphWidthOf(
  widths: Map<number, number> | undefined,
  declaredDefault: number | undefined,
  descriptor: PDFDict | undefined,
  context: PDFContext
): number | undefined {
  let max = 0;
  if (widths) for (const width of widths.values()) if (width > max) max = width;
  if (declaredDefault !== undefined && declaredDefault > max) max = declaredDefault;

  const bbox = descriptor ? asArray(descriptor.get(PDFName.of('FontBBox')), context) : undefined;
  if (bbox && bbox.size() === 4) {
    const llx = numberAt(bbox, 0, context);
    const urx = numberAt(bbox, 2, context);
    // Measured from the origin, or from a negative left side bearing when the
    // font has one, so the span is never shorter than the ink it describes.
    if (llx !== undefined && urx !== undefined) {
      const span = urx - Math.min(0, llx);
      if (Number.isFinite(span) && span > max) max = span;
    }
  }

  if (max <= 0) return undefined;
  // A bogus /FontBBox must not turn one glyph's coverage box into a page-wide
  // one, which would silently redact the whole line around the mark.
  return Math.min(max, 4000);
}

/**
 * Real glyph widths for one font resource, so the redaction filter measures a
 * text run instead of guessing 0.6em per byte.
 *
 * Simple fonts index `/Widths` from `/FirstChar`. Composite (`/Type0`) fonts put
 * their widths in the descendant's `/W`, a run-length form keyed by CID, with
 * `/DW` (default 1000) for everything absent. `/Type0` also means two-byte
 * codes for every CMap Stapler will meet here (Identity-H and the predefined
 * CJK CMaps are all two-byte), which is the half of this that mattered most:
 * counting a CJK run's bytes counted every glyph twice.
 */
function fontInfoFor(name: string, fonts: PDFDict | undefined, context: PDFContext) {
  const dict = fonts ? asDict(fonts.get(PDFName.of(name)), context) : undefined;
  if (!dict) return undefined;

  const subtype = dict.get(PDFName.of('Subtype'));
  if (subtype === PDFName.of('Type0')) {
    const descendants = asArray(dict.get(PDFName.of('DescendantFonts')), context);
    const descendant = descendants ? asDict(descendants.get(0), context) : undefined;
    const dwRaw = descendant?.get(PDFName.of('DW'));
    const dw = dwRaw instanceof PDFNumber ? dwRaw.asNumber() : 1000;
    const widths = new Map<number, number>();
    const w = descendant ? asArray(descendant.get(PDFName.of('W')), context) : undefined;
    if (w) {
      let i = 0;
      while (i < w.size()) {
        const first = numberAt(w, i, context);
        if (first === undefined) break;
        const second = w.get(i + 1);
        const secondResolved = second instanceof PDFRef ? context.lookup(second) : second;
        if (secondResolved instanceof PDFArray) {
          for (let k = 0; k < secondResolved.size(); k++) {
            const width = numberAt(secondResolved, k, context);
            if (width !== undefined) widths.set(first + k, width);
          }
          i += 2;
        } else {
          const last = numberAt(w, i + 1, context);
          const width = numberAt(w, i + 2, context);
          if (last === undefined || width === undefined) break;
          // A malformed range could otherwise ask for millions of entries.
          const span = Math.min(last - first, 65535);
          for (let c = 0; c <= span; c++) widths.set(first + c, width);
          i += 3;
        }
      }
    }
    const cidDescriptor = descendant
      ? asDict(descendant.get(PDFName.of('FontDescriptor')), context)
      : undefined;
    return {
      twoByte: true,
      widths,
      defaultWidth: dw,
      maxGlyphWidth: maxGlyphWidthOf(widths, dw, cidDescriptor, context)
    };
  }

  const descriptor = asDict(dict.get(PDFName.of('FontDescriptor')), context);
  const missingRaw = descriptor?.get(PDFName.of('MissingWidth'));
  const missingWidth = missingRaw instanceof PDFNumber ? missingRaw.asNumber() : undefined;

  const firstCharRaw = dict.get(PDFName.of('FirstChar'));
  const firstChar = firstCharRaw instanceof PDFNumber ? firstCharRaw.asNumber() : undefined;
  const widthsArray = asArray(dict.get(PDFName.of('Widths')), context);
  if (firstChar === undefined || !widthsArray) {
    // No per-code widths at all — a bare `/BaseFont /Helvetica` reference, whose
    // real metrics live in the viewer's own standard-14 tables. Read them from
    // the same AFM data pdf.js measures with, so the filter agrees with the
    // extractor that verifies it rather than guessing 0.6 em per glyph.
    const standard = standardFontWidths(dict, context);
    if (standard) {
      return {
        twoByte: false,
        widths: standard.widths,
        maxGlyphWidth: Math.max(
          standard.maxGlyphWidth,
          maxGlyphWidthOf(undefined, missingWidth, descriptor, context) ?? 0
        )
      };
    }

    // Not one of the standard 14 either. The descriptor is still worth reading:
    // `/MissingWidth` is what the spec says to advance by here, and `/FontBBox`
    // bounds the glyphs the viewer will draw. Both beat the flat 0.6 em this
    // returned nothing for before, which could measure such a run *shorter* than
    // it draws and let a mark over its tail miss the last glyphs entirely.
    //
    // A `/MissingWidth` of zero is not used for positioning: it is the spec
    // default, so a descriptor that simply omits the key is indistinguishable
    // from one declaring it, and taking it literally would collapse every run in
    // the font to zero width and drag every later run's box to the wrong place.
    return {
      twoByte: false,
      defaultWidth: missingWidth !== undefined && missingWidth > 0 ? missingWidth : undefined,
      maxGlyphWidth: maxGlyphWidthOf(undefined, missingWidth, descriptor, context)
    };
  }

  const widths = new Map<number, number>();
  for (let k = 0; k < widthsArray.size(); k++) {
    const width = numberAt(widthsArray, k, context);
    if (width !== undefined) widths.set(firstChar + k, width);
  }
  return {
    twoByte: false,
    widths,
    defaultWidth: missingWidth,
    maxGlyphWidth: maxGlyphWidthOf(widths, missingWidth, descriptor, context)
  };
}

interface PageRedactionFilter {
  /** The rebuilt content stream, or null when the page had no content streams. */
  content: Uint8Array | null;
  strippedXObjectNames: string[];
  /** Name → the union of every unit-space rect that covers part of that image. */
  partialImages: Map<string, RedactionArea[]>;
}

/**
 * Runs the operator-level filter over every chunk of one page's `/Contents`.
 *
 * Shared by `planImageRedactions` (which only wants the image overlaps) and
 * `applyRedactions` (which wants the rebuilt stream too), so the two can never
 * disagree about what a redaction rectangle touches.
 */
async function filterPageForRedaction(
  page: PDFPage,
  context: PDFContext,
  rects: RedactionArea[]
): Promise<PageRedactionFilter> {
  const rawContents = page.node.Contents();
  const streamRefs: unknown[] = [];
  if (rawContents) {
    if (rawContents instanceof PDFArray) {
      for (let k = 0; k < rawContents.size(); k++) streamRefs.push(rawContents.get(k));
    } else {
      streamRefs.push(rawContents);
    }
  }

  const strippedXObjectNames: string[] = [];
  const partialImages = new Map<string, RedactionArea[]>();
  if (streamRefs.length === 0) return { content: null, strippedXObjectNames, partialImages };

  const xObjects = pageXObjectDictOf(page, context);

  // A Form XObject's true extent is its own /BBox (through its own /Matrix) —
  // nothing like an image's implicit unit square. Without this, every Form
  // invocation was measured as a bogus tiny box and could never be detected as
  // overlapping a redaction region, however large it actually painted.
  const resolveXObject = (name: string) => {
    const entry = xObjects?.get(PDFName.of(name));
    const resolved = entry instanceof PDFRef ? context.lookup(entry) : entry;
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

  // Text widths come from the page's own font resources, not a 0.6em guess.
  const fonts = pageFontDictOf(page, context);
  const fontCache = new Map<string, ReturnType<typeof fontInfoFor>>();
  const resolveFont = (name: string) => {
    if (!fontCache.has(name)) fontCache.set(name, fontInfoFor(name, fonts, context));
    return fontCache.get(name);
  };

  const filteredChunks: Uint8Array[] = [];
  let carryState: GraphicsState | undefined;

  for (const ref of streamRefs) {
    const resolved = ref instanceof PDFStream ? ref : context.lookup(ref as never);
    if (!(resolved instanceof PDFStream)) {
      // A missing object is what a dangling /Contents entry resolves to, and
      // every viewer ignores it — there is nothing to drop. Anything else that
      // is present but is not a stream is a shape this filter cannot read, and
      // skipping it would silently delete that slice of the page.
      if (resolved === undefined || resolved === null) continue;
      throw unsupported(
        "A page's /Contents array holds an entry that is not a content stream, so the page " +
          'cannot be filtered without losing part of it. Nothing was changed — your original ' +
          'document is untouched.'
      );
    }

    const decoded = await decodeContentStreamBytes(resolved, context);
    const statements = parseContentStream(tokenizeContentStream(decoded));
    const result = filterContentStream(statements, rects, carryState, resolveXObject, resolveFont);
    carryState = result.finalState;
    strippedXObjectNames.push(...result.strippedXObjectNames);
    for (const partial of result.partialImageCoverage) {
      const existing = partialImages.get(partial.name);
      if (existing) existing.push(...partial.rects);
      else partialImages.set(partial.name, [...partial.rects]);
    }
    filteredChunks.push(serializeStatements(result.filtered));
  }

  let totalLen = 0;
  for (const c of filteredChunks) totalLen += c.length + 1;
  const merged = new Uint8Array(totalLen);
  let pos = 0;
  for (const c of filteredChunks) {
    merged.set(c, pos);
    pos += c.length;
    merged[pos++] = 0x0a;
  }

  return { content: merged.slice(0, pos), strippedXObjectNames, partialImages };
}

/**
 * Drops an indirect object from the context when nothing on any page still
 * points at it.
 *
 * pdf-lib's `save()` serialises every object registered in the context whether
 * or not it is reachable, so unhooking a reference is only half of a removal:
 * the bytes stay in the file and come back out of `pdfimages`, `qpdf`, or a text
 * dump. Shared objects (still named by another page) are deliberately left
 * alone — the remaining references keep them alive correctly.
 */
function purgeXObjectIfUnreferenced(doc: PDFDocument, ref: PDFRef): void {
  for (const page of doc.getPages()) {
    const xObjects = pageXObjectDictOf(page, doc.context);
    if (xObjects && xObjectDictReferences(xObjects, doc.context, ref, new Set())) return;
  }
  // `indirectObjects` is private on PDFContext, but the underlying Map is the
  // only way to surgically remove one object without rebuilding the context.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (doc.context as any).indirectObjects.delete(ref);
}

/**
 * True if `ref` is one of this dict's own entries, or is reachable through a
 * Form XObject entry's own nested `/Resources /XObject` dict. A page's
 * `/XObject` dict lists reusable content it *paints* — a stamp, a watermark,
 * a repeated letterhead — as a Form XObject, and that form's own resources
 * are where the real reference to a shared image can live. Without recursing
 * into it, an image still painted (indirectly, via the form) on some other
 * page looked unreferenced from every page's top-level dict and was deleted
 * — leaving that form pointing at a purged object the next time it was drawn.
 */
function xObjectDictReferences(
  xObjects: PDFDict,
  context: PDFContext,
  ref: PDFRef,
  visitedForms: Set<PDFDict>
): boolean {
  if (visitedForms.has(xObjects)) return false;
  visitedForms.add(xObjects);
  for (const key of xObjects.keys()) {
    const entry = xObjects.get(key);
    if (entry === ref) return true;
    const resolved = entry instanceof PDFRef ? context.lookup(entry) : entry;
    if (!(resolved instanceof PDFStream)) continue;
    if (resolved.dict.get(PDFName.of('Subtype')) !== PDFName.of('Form')) continue;
    const resourcesRaw = resolved.dict.get(PDFName.of('Resources'));
    const resources = resourcesRaw instanceof PDFRef ? context.lookup(resourcesRaw) : resourcesRaw;
    if (!(resources instanceof PDFDict)) continue;
    const nestedRaw = resources.get(PDFName.of('XObject'));
    const nested = nestedRaw instanceof PDFRef ? context.lookup(nestedRaw) : nestedRaw;
    if (nested instanceof PDFDict && xObjectDictReferences(nested, context, ref, visitedForms))
      return true;
  }
  return false;
}

/**
 * Removes every annotation whose `/Rect` overlaps a redaction mark — from the
 * page's `/Annots` array *and* from the document.
 *
 * Unhooking alone was the bug: pdf-lib serialises every object registered in its
 * context regardless of whether anything still points at it, so a sticky note's
 * `/Contents` or a form field's `/V` — the redacted string, in text, verbatim —
 * stayed in the output bytes while the verifier, which reads the page tree, saw
 * a clean document and reported `verified: true`.
 *
 * A widget's value is cleared on its parent field chain as well. The parent may
 * be shared with widgets on other pages, and clearing it there too is
 * deliberate: a redacted value is secret everywhere, and over-removal is the
 * only safe direction to be wrong in.
 */
function stripOverlappingAnnotations(
  doc: PDFDocument,
  page: PDFPage,
  rects: RedactionArea[]
): void {
  const annotsRaw = page.node.get(PDFName.of('Annots'));
  const annots =
    annotsRaw instanceof PDFArray
      ? annotsRaw
      : annotsRaw instanceof PDFRef
        ? (doc.context.lookup(annotsRaw) as PDFArray | undefined)
        : undefined;
  if (!annots) return;

  const kept: unknown[] = [];
  let removedAny = false;

  for (let a = 0; a < annots.size(); a++) {
    const annotRef = annots.get(a);
    const annotDict =
      annotRef instanceof PDFDict
        ? annotRef
        : annotRef instanceof PDFRef
          ? (doc.context.lookup(annotRef) as PDFDict | undefined)
          : undefined;
    if (!annotDict) {
      kept.push(annotRef);
      continue;
    }

    const rectArr = annotDict.get(PDFName.of('Rect'));
    if (!(rectArr instanceof PDFArray) || rectArr.size() < 4) {
      kept.push(annotRef);
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

    // A shaped mark only takes the annotations it actually encloses — the same
    // rule the content filter applies to a text run (RED-07).
    if (!rects.some(r => areaTouches(r, annotBox))) {
      kept.push(annotRef);
      continue;
    }

    removedAny = true;
    // The value lives on the widget, on its field ancestors, or on both. Clear
    // it everywhere along the chain before the annotation itself goes, so a
    // field shared with a surviving widget cannot carry the string out.
    let node: PDFDict | undefined = annotDict;
    const seen = new Set<PDFDict>();
    while (node && !seen.has(node)) {
      seen.add(node);
      node.delete(PDFName.of('V'));
      node.delete(PDFName.of('DV'));
      node.delete(PDFName.of('Contents'));
      node.delete(PDFName.of('RC'));
      const parent: unknown = node.get(PDFName.of('Parent'));
      const parentDict =
        parent instanceof PDFDict
          ? parent
          : parent instanceof PDFRef
            ? (doc.context.lookup(parent) as PDFDict | undefined)
            : undefined;
      node = parentDict;
    }
    // Appearance streams are separate objects holding the drawn text; the
    // sweep below collects them once nothing points at them any more.
    annotDict.delete(PDFName.of('AP'));
    if (annotRef instanceof PDFRef) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (doc.context as any).indirectObjects.delete(annotRef);
    }
  }

  if (!removedAny) return;

  const newAnnots = PDFArray.withContext(doc.context);
  for (const ref of kept) newAnnots.push(ref as PDFRef);
  page.node.set(PDFName.of('Annots'), newAnnots);
}

/**
 * Deletes every indirect object no longer reachable from the trailer.
 *
 * pdf-lib's `save()` writes the whole object table, not the live reference
 * graph, so "removed" content survives in the bytes of any document this worker
 * mutates rather than rebuilds. On the redaction path that is not untidiness,
 * it is a failed redaction: the string is still in the file. Reachability is
 * walked from the catalog and the trailer's own entries, so nothing a viewer
 * could ever reach is collected.
 */
function sweepUnreachableObjects(doc: PDFDocument): number {
  const context = doc.context;
  const reachable = new Set<string>();
  const queue: unknown[] = [doc.catalog];

  const trailer = context.trailerInfo as unknown as Record<string, unknown>;
  for (const key of ['Root', 'Info', 'Encrypt', 'ID']) {
    if (trailer[key] !== undefined) queue.push(trailer[key]);
  }

  while (queue.length > 0) {
    const item = queue.pop();
    if (item instanceof PDFRef) {
      const key = item.toString();
      if (reachable.has(key)) continue;
      reachable.add(key);
      const target = context.lookup(item);
      if (target !== undefined) queue.push(target);
      continue;
    }
    if (item instanceof PDFStream) {
      queue.push(item.dict);
      continue;
    }
    if (item instanceof PDFDict) {
      for (const [, value] of item.entries()) queue.push(value);
      continue;
    }
    if (item instanceof PDFArray) {
      for (let i = 0; i < item.size(); i++) queue.push(item.get(i));
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const objects = (context as any).indirectObjects as Map<PDFRef, unknown>;
  let removed = 0;
  for (const ref of [...objects.keys()]) {
    if (reachable.has(ref.toString())) continue;
    objects.delete(ref);
    removed += 1;
  }
  return removed;
}

function isJavaScriptAction(dict: PDFDict): boolean {
  const type = dict.get(PDFName.of('Type'));
  const action = dict.get(PDFName.of('S'));
  const isAction = type === undefined || type === PDFName.of('Action');
  return isAction && action === PDFName.of('JavaScript');
}

if (
  typeof self !== 'undefined' &&
  typeof (self as unknown as { addEventListener?: unknown }).addEventListener === 'function'
) {
  Comlink.expose(api);
}
export const processWorkerImpl = api;

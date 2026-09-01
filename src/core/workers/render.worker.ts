/**
 * The pdf.js worker: everything that *reads* a PDF.
 *
 * Consolidated from three workers (`render`, `redact`, `verify`) that each bundled
 * their own copy of pdf.js — 1.7MB of duplicated code and three independent
 * document caches. PLAN §2.1 specifies one reader and one writer.
 *
 * Documents live behind an opaque handle so callers never re-parse bytes they have
 * already loaded, and every multi-page loop is a cancellation point.
 */
import * as Comlink from 'comlink';
import { openDocument, pdfjsLib } from './pdfjs-setup';
import { checkpoint, type JobHandle } from './protocol';
import { corrupt, encrypted, internal } from '../errors';
import { DOC_PAGE_WHITE, DOC_REDACT_RGB } from '../doc-colors';
import { blankCoverageLimit, inkCoverage, layoutText, toRgba, type TextRun } from '../text-layout';
import type { RedactionRegion } from './process.worker';
import { locatePatterns, type PatternCategory } from '../patterns';
import {
  measureRectsBlacked,
  paintRectsBlack,
  type BlackoutResidue,
  type UnitRect
} from '../pdf/image-redaction';
import { findAcrossRuns } from '../pdf/text-search';
import { pageBlocks, type DocxBlock } from '../convert/blocks';
import { formattedRuns } from '../convert/pdf-runs';
import { pixelateRects, type BlurStrength } from '../faceblur/blur';
import {
  detectFaces,
  loadFaceModel,
  type DetectedRegion,
  type FaceModelWeights
} from '../faceblur/detect';
import { cropUnitRect, intersectionOverUnion, matchTemplate } from '../faceblur/logoMatch';
import { decodeBarcodesFromImage, type DecodedBarcode } from '../barcode';
import { fillPolygonMask, polygonOverlapsBox, shrinkMask } from '../geometry';

export interface DocumentInfo {
  handle: string;
  pageCount: number;
  isXfa: boolean;
  /** Two documents with the same fingerprint are the same file to pdf.js. */
  fingerprint: string;
  /** Page sizes in CSS pixels at scale 1, i.e. points with /Rotate applied. */
  pageSizes: { width: number; height: number }[];
}

export interface TextRegion {
  pageIndex: number;
  /** Normalised to the page box, origin top-left, ready for the DOM. */
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
}

/**
 * RED-05 — one proposed redaction, not yet a mark.
 *
 * `regions` is a list because a match can straddle two text runs; accepting the
 * suggestion pushes all of them into the same `pendingRedactions` array the
 * drawing tool and the text search already write to, so nothing downstream knows
 * a mark was proposed rather than drawn.
 */
export interface PatternSuggestion {
  id: string;
  category: PatternCategory;
  pageIndex: number;
  text: string;
  regions: TextRegion[];
}

export interface PageTextPresence {
  pageIndex: number;
  /** Non-whitespace characters pdf.js can extract. */
  charCount: number;
  /** Glyph-drawing runs — distinguishes "no text" from "one stray label". */
  runCount: number;
}

export interface ExtractedImage {
  /**
   * PDF object number of the image XObject this JPEG replaces.
   *
   * Deliberately *not* the resource name: pdf.js identifies images in an operator
   * list by its own generated id (`img_p0_1`), which has no relationship to the
   * `/XObject` key in the page's resources, and the same image reached from two
   * pages gets two different ids. The object number is the one identifier both
   * halves of the pipeline agree on.
   */
  objectNumber: number;
  jpeg: Uint8Array;
  /** Pixel size of the JPEG, which is the downscaled size, not the source size. */
  width: number;
  height: number;
  /** Source pixel size, so the caller can report what was actually resampled. */
  sourceWidth: number;
  sourceHeight: number;
  /**
   * True when pdf.js applied an /SMask or stencil /Mask to this image. The JPEG
   * carries the *base colour* only; the mask has to be re-attached to the
   * replacement stream or the image renders opaque.
   */
  hadTransparency: boolean;
  /** Downscaled grayscale mask (SMask) pixels, uncompressed. */
  maskBytes?: Uint8Array;
}

export interface RegionRaster {
  png: Uint8Array;
  width: number;
  height: number;
}

/**
 * RED-03 — is anything still *there*, whatever colour the mark was filled with?
 *
 * Distance from the redaction fill (below) can only answer "is this the colour we
 * painted". It is blind in both directions: a fill drawn in any other colour
 * reads as 100% residue on a perfectly good redaction, and — the reason this
 * exists — content that survives in a region whose fill never covered it is only
 * caught when it happens to be far from *that one colour*.
 *
 * So the region is also graded against itself: the colour covering most of it is
 * measured from its own pixels, and anything that departs from that colour, or
 * sits on a hard edge, is content. A solid fill has no interior edges at any DPI;
 * a glyph, a rule, a logo or a photograph is almost entirely edges.
 */
export interface RegionContentSignal {
  /** Pixels examined — the same set the fill grading below sampled. */
  sampled: number;
  /**
   * Sampled pixels that differ from the region's own dominant colour, plus every
   * pixel nothing was painted into at all (whatever is under it shows through).
   */
  offDominant: number;
  /** `offDominant / sampled`, 0 when nothing could be sampled. */
  offDominantFraction: number;
  /** Sampled pixels sitting on a high-contrast edge — a stroke, rule, or outline. */
  edges: number;
  /** `edges / sampled`, 0 when nothing could be sampled. */
  edgeFraction: number;
}

/**
 * RED-03 — what a rendered redaction region actually contains, in pixels.
 *
 * The text-based half of verification can only prove there is no *extractable
 * text* left inside a region. It says nothing about a vector shape, an inline
 * image, or an image whose pixels were only partly overwritten, so this is the
 * second, independent half: the region is rendered exactly as a viewer would
 * draw it and compared against the opaque redaction fill.
 */
export interface RegionPixelResidue {
  /** Pixels examined, i.e. the region minus the anti-aliasing inset. */
  sampled: number;
  /** Sampled pixels further from the fill colour than `channelTolerance`. */
  offFill: number;
  /** `offFill / sampled`, 0 when nothing could be sampled. */
  fraction: number;
  /** Largest per-channel distance from the fill seen on any sampled pixel. */
  maxDeviation: number;
  /** Fill-colour-agnostic reading of the same pixels. See {@link RegionContentSignal}. */
  content: RegionContentSignal;
}

/**
 * RED-03 — one image XObject still drawn under a mark in the *output*, graded on
 * whether the pixels the mark covers were really destroyed.
 *
 * See {@link BlackoutResidue}: this is the only half of the gate that can see
 * *underneath* the cover rectangle, and the only one that works at all on a
 * redaction over a photograph or a scan, where there is no text layer to
 * re-extract.
 */
export interface RedactedImageInspection {
  pageIndex: number;
  objectNumber: number;
  /** Absent when the image could not be read — `reason` then says why. */
  residue?: BlackoutResidue;
  /** Set when the image could not be decoded, so the caller can fail closed. */
  reason?: string;
}

export interface RenderJob {
  loadDocument(bytes: Uint8Array, password?: string): Promise<DocumentInfo>;
  closeDocument(handle: string): Promise<void>;
  renderPage(handle: string, pageIndex: number, scale: number): Promise<ImageBitmap>;
  pageToImageBytes(
    handle: string,
    pageIndex: number,
    format: 'png' | 'jpeg',
    dpi: number,
    quality?: number
  ): Promise<Uint8Array>;
  /**
   * SCN-04 — renders one page and scans the bitmap for any barcode/QR code.
   * Reuses the exact rendering path {@link RenderJob.renderPage} does (same
   * viewport/render call), rather than a second one, so this is the same
   * pixels a person looking at the page preview would see.
   */
  decodePageBarcodes(handle: string, pageIndex: number, dpi: number): Promise<DecodedBarcode[]>;
  renderRegionPng(
    handle: string,
    pageIndex: number,
    region: { x: number; y: number; width: number; height: number },
    dpi: number
  ): Promise<RegionRaster>;
  extractText(handle: string, pageIndex: number, mode: 'text' | 'markdown'): Promise<string>;
  /**
   * CNV-08 — one page's text as the DOCX block model: paragraphs, headings by
   * font size, simple tables, and bold/italic per run. Shares CNV-04's line
   * grouping and CNV-05's heading promotion (`layoutLines`), so the Word export
   * and the text export never disagree about where a paragraph starts.
   */
  extractPageBlocks(handle: string, pageIndex: number): Promise<DocxBlock[]>;
  extractPageTextItems(
    handle: string,
    pageIndex: number
  ): Promise<{ text: string; x: number; y: number; width: number; height: number }[]>;
  textPresence(handle: string, job?: JobHandle): Promise<PageTextPresence[]>;
  findText(
    handle: string,
    query: string,
    matchCase: boolean,
    job?: JobHandle
  ): Promise<TextRegion[]>;
  /** RED-05 — proposes marks for emails, phones, SSNs, cards, and IP addresses. */
  findPatterns(handle: string, job?: JobHandle): Promise<PatternSuggestion[]>;
  /** Per-page text — the input to the redaction verifier. */
  documentText(handle: string, job?: JobHandle): Promise<string[]>;
  detectBlankPages(handle: string, threshold: number, job?: JobHandle): Promise<number[]>;
  detectSignatureLines(handle: string, job?: JobHandle): Promise<TextRegion[]>;
  /**
   * Re-encodes the page's image XObjects to JPEG (CMP-03). `wanted` names the
   * object numbers worth touching; anything else on the page is left alone.
   */
  extractPageImages(
    handle: string,
    pageIndex: number,
    quality: number,
    targetDpi: number,
    wanted?: number[]
  ): Promise<ExtractedImage[]>;
  /**
   * CMP-03, document-wide — re-encodes each distinct image XObject **once**, at
   * the largest size any page displays it at.
   *
   * `extractPageImages` works a page at a time, so a logo on ten pages was
   * decoded, downscaled and JPEG-encoded ten times and nine of those results were
   * thrown away (only the largest is embedded). The cost was proportional to page
   * count for no benefit. This decides the winning size for every image *before*
   * any pixel work, then does that work exactly once per object.
   */
  extractSharedImages(
    handle: string,
    requests: { pageIndex: number; objectNumbers: number[] }[],
    quality: number,
    targetDpi: number,
    job?: JobHandle
  ): Promise<ExtractedImage[]>;
  checkRegionText(
    handle: string,
    regions: RedactionRegion[],
    job?: JobHandle
  ): Promise<{ region: RedactionRegion; foundText: string }[]>;
  /**
   * RED-03's pixel half — renders each region and grades it, both against the
   * redaction fill and against itself (see {@link RegionContentSignal}). Kept in
   * the worker (rather than handing `renderRegionPng`'s PNG back and decoding it
   * on the main thread) because decoding and scanning a region per mark is
   * exactly the >50ms main-thread work the NFRs forbid.
   */
  checkRegionPixels(
    handle: string,
    regions: RedactionRegion[],
    job?: JobHandle
  ): Promise<{ region: RedactionRegion; residue: RegionPixelResidue }[]>;
  /**
   * RED-03 — reads the *embedded* pixels of every image a mark still covers in
   * the output and reports what is left there.
   *
   * `requests` is `planImageRedactions` run against the **output** bytes: the
   * same plan that told the redaction which image pixels to destroy, so this asks
   * the narrow question "did that actually happen", against the image stream
   * rather than the composited page. Rendering cannot answer it — the cover
   * rectangle is drawn over the image, so an untouched image and a destroyed one
   * look identical from above.
   */
  inspectRedactedImages(
    handle: string,
    requests: { pageIndex: number; objectNumber: number; rects: UnitRect[] }[],
    job?: JobHandle
  ): Promise<RedactedImageInspection[]>;
  /**
   * RED-02 — destroys the covered pixels of an image a redaction mark only
   * partly overlaps, and hands back the re-encoded image.
   *
   * The alternative the code used to take was to leave the image alone and let
   * the black rectangle drawn on the page hide it, which hides nothing: the
   * full-resolution original stays embedded and comes straight back out of any
   * image extractor. An image pdf.js cannot decode (JBIG2, JPEG 2000, a broken
   * stream) is reported as a failure rather than approximated, so the caller can
   * refuse the redaction instead of shipping a false one.
   */
  redactPageImages(
    handle: string,
    pageIndex: number,
    requests: { objectNumber: number; rects: UnitRect[] }[]
  ): Promise<RedactedImageResult[]>;
  /**
   * RED-08 — loads the face-detector weights into this worker, once.
   *
   * Separate from {@link RenderJob.blurPageImages} so 196 KB of weights crosses
   * the worker boundary a single time per session instead of once per page, and
   * so the caller can prove ordering: the weights only ever arrive here after
   * the consent dialog resolved. Idempotent.
   */
  loadFaceDetector(weights: FaceModelWeights): Promise<void>;
  /**
   * RED-08 — the pixels of one image, cropped to a unit-space rect.
   *
   * This is how "the logo the user marked" becomes a template: the mark is
   * mapped onto the image it covers, and the pixels underneath come back here
   * to be correlated against every other image in the document.
   */
  extractImageRegion(
    handle: string,
    pageIndex: number,
    objectNumber: number,
    rect: UnitRect
  ): Promise<{ rgba: Uint8ClampedArray; width: number; height: number } | null>;
  /**
   * RED-08 — detects faces and/or a marked logo in the named images on one
   * page, mosaics what it finds, and hands back the re-encoded images.
   *
   * An image pdf.js cannot decode (JBIG2, JPEG 2000, a broken stream) is
   * reported as a `reason` rather than silently reported as "no faces here" —
   * the two are indistinguishable from the outside, and only one of them is
   * safe to believe.
   */
  blurPageImages(
    handle: string,
    pageIndex: number,
    requests: BlurImageRequest[],
    settings: BlurSettings,
    job?: JobHandle
  ): Promise<BlurredImageResult[]>;
}

/** One image on a page to look at, plus any region already known to need blurring. */
export interface BlurImageRequest {
  objectNumber: number;
  /**
   * Regions in this image's unit space that are blurred regardless of what the
   * detector finds — the logo the user marked, in the image it was marked on.
   */
  forcedRects?: UnitRect[];
}

export interface BlurSettings {
  detectFaces: boolean;
  minScore?: number;
  strength?: BlurStrength;
  /** The marked logo's pixels, correlated against every requested image. */
  logoTemplate?: { rgba: Uint8ClampedArray; width: number; height: number };
  logoMinScore?: number;
}

export interface BlurredImageResult {
  objectNumber: number;
  /** Absent when nothing was found, or when `reason` says why nothing could be. */
  image?: { bytes: Uint8Array; format: 'png' | 'jpeg'; width: number; height: number };
  /** What was blurred, in the image's unit space. Empty when nothing matched. */
  regions: DetectedRegion[];
  reason?: string;
}

export interface RedactedImageResult {
  objectNumber: number;
  /** Absent when `reason` is set — the image could not be decoded. */
  image?: { bytes: Uint8Array; format: 'png' | 'jpeg'; width: number; height: number };
  reason?: string;
}

interface DocEntry {
  doc: pdfjsLib.PDFDocumentProxy;
  task: pdfjsLib.PDFDocumentLoadingTask;
}

/**
 * The subset of pdf.js's annotation shape this module reads. `getAnnotations()`
 * returns a loosely-typed grab-bag whose exact fields vary by annotation type
 * (`contents` for markup annotations, `fieldValue`/`buttonValue` for form
 * widgets) — pdf.js does not export a discriminated union for it.
 */
interface PdfJsAnnotation {
  contents?: string;
  fieldValue?: string;
  buttonValue?: string;
  rect?: [number, number, number, number];
}

const docs = new Map<string, DocEntry>();

function entry(handle: string): DocEntry {
  const found = docs.get(handle);
  if (!found) throw internal(`Render handle is not open`, { handle });
  return found;
}

function isTextRun(item: unknown): item is TextRun {
  return typeof item === 'object' && item !== null && 'str' in item && 'transform' in item;
}

async function textRuns(page: pdfjsLib.PDFPageProxy): Promise<TextRun[]> {
  const content = await page.getTextContent();
  // getTextContent returns marked-content markers interleaved with glyph runs.
  return (content.items as unknown[]).filter(isTextRun);
}

function offscreen(width: number, height: number) {
  const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw internal('OffscreenCanvas 2D context unavailable');
  return { canvas, ctx };
}

/**
 * pdf.js v6 wants an explicit `canvas` property; passing `null` alongside
 * `canvasContext` is the documented way to render into an OffscreenCanvas.
 */
function renderParams(ctx: OffscreenCanvasRenderingContext2D, viewport: pdfjsLib.PageViewport) {
  return {
    canvas: null,
    canvasContext: ctx as unknown as CanvasRenderingContext2D,
    viewport,
    background: DOC_PAGE_WHITE,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE
  };
}

/* ------------------------------------------------------------------ *
 * SGN-02 — signature-line detection, the vector half.
 *
 * A real "sign here" line is almost never text. It is a stroked path, or a filled
 * rectangle 0.8pt tall, with a small "Signature" or "Date" caption printed beneath
 * it. Matching text runs alone therefore missed the normal case entirely and only
 * caught the typewriter-era `_______` convention.
 *
 * These three functions are pure and exported so they can be tested against a real
 * pdf.js operator list without a browser.
 * ------------------------------------------------------------------ */

/** The op codes this scan needs, structurally compatible with pdf.js's `OPS`. */
export interface PathOpCodes {
  save: number;
  restore: number;
  transform: number;
  setLineWidth: number;
  constructPath: number;
  stroke: number;
  closeStroke: number;
  fill: number;
  eoFill: number;
  fillStroke: number;
  eoFillStroke: number;
  closeFillStroke: number;
  closeEOFillStroke: number;
}

/** A long, thin, horizontal painted path, in PDF user space (y up). */
export interface PageRule {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Thicker than this and it is a box, a table cell or a bar chart, not a rule. */
const MAX_RULE_THICKNESS = 3;
/** Shorter than this (~0.8in) and nobody is signing on it. */
const MIN_RULE_LENGTH = 60;
/** A rule is much wider than it is tall; this rejects short dashes and ticks. */
const MIN_RULE_ASPECT = 8;

/** Captions that mean "a person writes here". */
const SIGNATURE_LABEL = /signature|sign here|signed by|printed name|_{5,}/i;
/** Captions that only count when a rule is drawn next to them. */
const RULE_LABEL = /signature|sign here|signed by|printed name|\bdate\b/i;

type PathMatrix = [number, number, number, number, number, number];

/** `m` applied first, then `ctm` — pdf.js's own `Util.transform` composition. */
function composeMatrix(ctm: PathMatrix, m: PathMatrix): PathMatrix {
  return [
    ctm[0] * m[0] + ctm[2] * m[1],
    ctm[1] * m[0] + ctm[3] * m[1],
    ctm[0] * m[2] + ctm[2] * m[3],
    ctm[1] * m[2] + ctm[3] * m[3],
    ctm[0] * m[4] + ctm[2] * m[5] + ctm[4],
    ctm[1] * m[4] + ctm[3] * m[5] + ctm[5]
  ];
}

function applyMatrix(m: PathMatrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * Finds every long, thin horizontal rule in a pdf.js operator list.
 *
 * pdf.js hands each painted path as `constructPath [paintOp, [pathData], minMax]`,
 * where `minMax` is the path's bounding box in the *current* user space. That box
 * plus the CTM plus the line width is everything needed here — the individual path
 * segments are not, which is what keeps this cheap enough to run per page.
 */
export function horizontalRulesFromOps(
  fnArray: number[],
  argsArray: unknown[],
  ops: PathOpCodes
): PageRule[] {
  const strokePaints = new Set([
    ops.stroke,
    ops.closeStroke,
    ops.fillStroke,
    ops.eoFillStroke,
    ops.closeFillStroke,
    ops.closeEOFillStroke
  ]);

  const rules: PageRule[] = [];
  let ctm: PathMatrix = [1, 0, 0, 1, 0, 0];
  let lineWidth = 1;
  const stack: { ctm: PathMatrix; lineWidth: number }[] = [];

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];

    if (fn === ops.save) {
      stack.push({ ctm, lineWidth });
      continue;
    }
    if (fn === ops.restore) {
      const previous = stack.pop();
      if (previous) {
        ctm = previous.ctm;
        lineWidth = previous.lineWidth;
      }
      continue;
    }
    if (fn === ops.transform && Array.isArray(args)) {
      ctm = composeMatrix(ctm, args.slice(0, 6) as PathMatrix);
      continue;
    }
    if (fn === ops.setLineWidth && Array.isArray(args) && typeof args[0] === 'number') {
      lineWidth = args[0];
      continue;
    }
    if (fn !== ops.constructPath || !Array.isArray(args)) continue;

    const paintOp = args[0] as number;
    const minMax = args[2] as ArrayLike<number> | undefined;
    if (!minMax || minMax.length < 4) continue;

    const [minX, minY, maxX, maxY] = [minMax[0], minMax[1], minMax[2], minMax[3]];
    // The box may be rotated or skewed by the CTM, so take the axis-aligned bounds
    // of all four transformed corners rather than transforming two of them.
    const corners: [number, number][] = [
      applyMatrix(ctm, minX, minY),
      applyMatrix(ctm, maxX, minY),
      applyMatrix(ctm, maxX, maxY),
      applyMatrix(ctm, minX, maxY)
    ];
    const xs = corners.map(c => c[0]);
    const ys = corners.map(c => c[1]);
    let x = Math.min(...xs);
    let y = Math.min(...ys);
    let width = Math.max(...xs) - x;
    let height = Math.max(...ys) - y;

    // A zero-height stroked line is still `lineWidth` thick on the page, centred
    // on the path — so the painted extent is the box grown by half on each side.
    if (strokePaints.has(paintOp)) {
      const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) || 1;
      const painted = (lineWidth || 1) * scale;
      x -= painted / 2;
      y -= painted / 2;
      width += painted;
      height += painted;
    }

    if (
      height <= MAX_RULE_THICKNESS &&
      width >= MIN_RULE_LENGTH &&
      width >= height * MIN_RULE_ASPECT
    ) {
      rules.push({ x, y, width, height });
    }
  }

  return rules;
}

/** Minimal view of a pdf.js viewport, so the pairing below stays testable. */
export interface RuleViewport {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): number[];
}

/** Minimal view of a pdf.js text run. */
export interface RuleTextRun {
  str: string;
  width: number;
  height: number;
  transform: number[];
}

function textRunViewportBox(
  run: { str: string; width: number; height: number; transform: number[] },
  viewport: RuleViewport,
  from = 0,
  to = run.str.length
): { x: number; y: number; width: number; height: number } {
  const perChar = run.width / Math.max(1, run.str.length);
  const height = run.height || run.transform[3] || 12;
  const x0 = run.transform[4] + from * perChar;
  const x1 = run.transform[4] + to * perChar;
  const y0 = run.transform[5];
  const y1 = run.transform[5] + height;
  const corners = [
    viewport.convertToViewportPoint(x0, y0),
    viewport.convertToViewportPoint(x1, y0),
    viewport.convertToViewportPoint(x1, y1),
    viewport.convertToViewportPoint(x0, y1)
  ];
  const xs = corners.map(([x]) => x / viewport.width);
  const ys = corners.map(([, y]) => y / viewport.height);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top)
  };
}

/**
 * Pairs each drawn rule with a nearby caption and turns the survivors into
 * signature-field suggestions sitting *on* the rule.
 *
 * The caption requirement is what stops every table border and page header rule in
 * the document from being offered as a place to sign.
 */
export function signatureRulesToRegions(
  rules: PageRule[],
  runs: RuleTextRun[],
  viewport: RuleViewport,
  pageIndex: number
): TextRegion[] {
  const regions: TextRegion[] = [];

  const labels = runs
    .filter(run => run.str.trim() && RULE_LABEL.test(run.str))
    .map(run => {
      const box = textRunViewportBox(run, viewport, 0, run.str.length);
      const [, vy] = viewport.convertToViewportPoint(run.transform[4], run.transform[5]);
      return {
        text: run.str.trim(),
        x: box.x * viewport.width,
        baselineY: vy,
        width: box.width * viewport.width,
        height: box.height * viewport.height
      };
    });

  for (const rule of rules) {
    const [x1, y1] = viewport.convertToViewportPoint(rule.x, rule.y);
    const [x2, y2] = viewport.convertToViewportPoint(rule.x + rule.width, rule.y + rule.height);
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    const top = Math.min(y1, y2);
    const bottom = Math.max(y1, y2);
    if (right - left < MIN_RULE_LENGTH) continue; // rotated into a vertical rule

    const label = labels.find(candidate => {
      // The caption sits just under the rule (the common case) or just above it,
      // within about two of its own line heights.
      const near = candidate.height * 3 + 6;
      const verticallyClose =
        candidate.baselineY >= top - near && candidate.baselineY <= bottom + near;
      if (!verticallyClose) return false;
      // …and horizontally in the same column: overlapping the rule, or starting
      // within ~1.5in to the left of it ("Signature: ______").
      const labelRight = candidate.x + Math.max(candidate.width, 8);
      return labelRight >= left - 110 && candidate.x <= right + 110;
    });
    if (!label) continue;

    const boxHeight = Math.max(label.height * 2.5, 24);
    regions.push({
      pageIndex,
      x: left / viewport.width,
      // The signature goes above the rule, resting on it.
      y: Math.max(0, (top - boxHeight) / viewport.height),
      width: Math.min(1, (right - left) / viewport.width),
      height: boxHeight / viewport.height,
      text: label.text
    });
  }

  return regions;
}

/** True when two suggestions cover materially the same spot. */
export function overlapsRegion(a: TextRegion, b: TextRegion): boolean {
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (overlapX <= 0 || overlapY <= 0) return false;
  const intersection = overlapX * overlapY;
  const smaller = Math.min(a.width * a.height, b.width * b.height);
  return smaller > 0 && intersection / smaller > 0.5;
}

/* ------------------------------------------------------------------ *
 * RED-03 — the pixel half of the verification gate.
 * ------------------------------------------------------------------ */

/**
 * Renders one normalised region of a page, exactly as a viewer would draw it.
 *
 * Shared by `renderRegionPng` (which hands the pixels to the UI) and
 * `checkRegionPixels` (which grades them). Rendering the *full* page viewport and
 * translating it so the region lands on the canvas origin — rather than rendering
 * a cropped viewport — is what keeps content that straddles the region boundary in
 * frame, which is precisely the content a redaction is most likely to have missed.
 */
async function renderRegion(
  page: pdfjsLib.PDFPageProxy,
  region: { x: number; y: number; width: number; height: number },
  dpi: number
) {
  const full = page.getViewport({ scale: dpi / 72 });
  const px = {
    x: region.x * full.width,
    y: region.y * full.height,
    width: Math.max(1, region.width * full.width),
    height: Math.max(1, region.height * full.height)
  };
  const { canvas, ctx } = offscreen(px.width, px.height);
  // Shift the page so the requested region lands on the canvas origin.
  await page.render({
    ...renderParams(ctx, full),
    transform: [1, 0, 0, 1, -px.x, -px.y]
  }).promise;
  return { canvas, ctx, px };
}

/** Verification renders at screen resolution; more pixels prove nothing extra. */
const VERIFY_DPI = 96;

/**
 * A full-page mark on a poster-sized page would otherwise allocate a canvas of
 * hundreds of megabytes. Residue is a *fraction*, so downsampling a huge region
 * costs no sensitivity worth having: surviving content large enough to matter
 * still lands on many pixels.
 */
const VERIFY_MAX_SIDE = 1200;

/** Below this the region is a sliver, and the AA inset would consume all of it. */
const VERIFY_MIN_DPI = 18;

/** Chosen so the region raster stays within `VERIFY_MAX_SIDE` on its long side. */
function regionVerifyDpi(
  region: { width: number; height: number },
  page: pdfjsLib.PDFPageProxy
): number {
  const base = page.getViewport({ scale: 1 });
  const longest = Math.max(
    1,
    Math.max(region.width * base.width, region.height * base.height) * (VERIFY_DPI / 72)
  );
  if (longest <= VERIFY_MAX_SIDE) return VERIFY_DPI;
  return Math.max(VERIFY_MIN_DPI, (VERIFY_DPI * VERIFY_MAX_SIDE) / longest);
}

/**
 * Per-channel slack allowed against the redaction fill, out of 255.
 *
 * The fill is opaque and flat, so in principle every pixel should be exactly
 * `DOC_REDACT_RGB`. In practice the region is rendered through pdf.js's
 * rasteriser at a DPI unrelated to the one the mark was drawn at, and a
 * previously-JPEG-compressed page carries ringing, so an exact match would fail
 * on correct output. 24/255 is far below the distance to any content a human
 * could read off the region — mid-grey is 118 away, white 245.
 */
const FILL_CHANNEL_TOLERANCE = 24;

/**
 * Fraction of the shorter side ignored at each edge.
 *
 * The mark's own boundary is anti-aliased, and neighbouring content that
 * legitimately sits *outside* the mark bleeds a pixel or two inside at render
 * resolution. This is the same conservatism `checkRegionText` applies by scoring
 * a glyph against the region with an approximated per-character box: both halves
 * of the gate judge the interior of the mark and forgive its edge.
 */
const AA_INSET_FRACTION = 0.08;

/**
 * Side of the colour cube bucket the dominant colour is found in, out of 255.
 *
 * Coarse on purpose. The dominant colour has to survive the same rasteriser
 * noise and JPEG ringing `FILL_CHANNEL_TOLERANCE` forgives, so a flat fill whose
 * pixels jitter across a bucket boundary must still land in one bucket often
 * enough to win it; the winner's own pixels are then averaged, so the coarseness
 * costs no accuracy in the value itself.
 */
const DOMINANT_BUCKET = 32;

/**
 * Per-channel slack allowed against the region's *own* dominant colour, out of 255.
 *
 * Deliberately looser than `FILL_CHANNEL_TOLERANCE`: this reading exists to catch
 * content, not to re-litigate the fill colour, and a false failure here would
 * block a save on a correct redaction. Content a reader could recover is
 * hundreds of levels away, not fifty.
 */
const UNIFORM_CHANNEL_TOLERANCE = 48;

/**
 * Per-channel step between neighbouring pixels that counts as an edge, out of 255.
 *
 * A solid fill has no interior edges at any resolution — the only hard boundary
 * in a correctly redacted region is the mark's own outline, which the inset below
 * has already trimmed away. Glyph strokes, rules, and logo outlines are almost
 * entirely edge, which is what makes this readable even where the surviving
 * content happens to sit close to the fill colour.
 */
const EDGE_CONTRAST_TOLERANCE = 64;

/** Pixels trimmed from each edge before sampling. 0 when the region is tiny. */
function regionInset(width: number, height: number): number {
  const shortest = Math.min(width, height);
  if (shortest <= 4) return 0;
  return Math.min(
    Math.floor((shortest - 2) / 2),
    Math.max(1, Math.round(shortest * AA_INSET_FRACTION))
  );
}

/**
 * Measures a rendered region twice over: how far it is from the opaque redaction
 * fill, and — independently of what colour that fill is — whether it holds
 * anything at all (see {@link RegionContentSignal}).
 *
 * Pure and exported so the grading can be tested against real pixel buffers
 * without a browser. Returns counts rather than a verdict: the threshold is the
 * caller's policy decision (`operations.ts`), not this function's.
 */
export function regionPixelResidue(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  polygon?: { x: number; y: number }[]
): RegionPixelResidue {
  const [fr, fg, fb] = DOC_REDACT_RGB;
  const fill = [Math.round(fr * 255), Math.round(fg * 255), Math.round(fb * 255)];
  const inset = regionInset(width, height);

  let sampled = 0;
  let offFill = 0;
  let maxDeviation = 0;

  /**
   * RED-07 — a shaped mark is only obliged to fill the shape, so grading its
   * whole bounding box would fail every correct polygon redaction: the corners
   * the shape left alone hold the content the user *kept*. The shape is
   * rasterised into this region's own pixel grid and eroded by the same inset the
   * rectangle path trims from its edges, so the mark's own anti-aliased outline
   * is forgiven exactly as a rectangle's is. A mask of all ones eroded by `inset`
   * is precisely the rectangle loop below, which is why that path is untouched.
   */
  const shape =
    polygon && polygon.length >= 3
      ? shrinkMask(
          fillPolygonMask(
            polygon.map(p => ({ x: p.x * width, y: p.y * height })),
            width,
            height
          ),
          width,
          height,
          inset
        )
      : undefined;

  /** Is this pixel one of the ones this mark is judged on? */
  const inside = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    if (shape) return shape[y * width + x] === 1;
    return x >= inset && y >= inset && x < width - inset && y < height - inset;
  };

  /** Every sampled pixel, once, in row order. */
  const forEachSampled = (visit: (x: number, y: number, at: number) => void) => {
    if (shape) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (shape[y * width + x] === 1) visit(x, y, (y * width + x) * 4);
        }
      }
    } else {
      for (let y = inset; y < height - inset; y++) {
        for (let x = inset; x < width - inset; x++) {
          visit(x, y, (y * width + x) * 4);
        }
      }
    }
  };

  /** True where nothing was painted, so whatever is underneath shows through. */
  const unpainted = (at: number) => data[at + 3] < 255 - FILL_CHANNEL_TOLERANCE;

  // Pass 1 — distance from the fill, and a coarse colour histogram of everything
  // that *was* painted, whose modal bucket becomes the dominant colour.
  const buckets = Math.ceil(256 / DOMINANT_BUCKET);
  const bins = buckets * buckets * buckets;
  const binCount = new Uint32Array(bins);
  const binSum = new Float64Array(bins * 3);

  forEachSampled((_x, _y, at) => {
    const deviation = unpainted(at)
      ? 255
      : Math.max(
          Math.abs(data[at] - fill[0]),
          Math.abs(data[at + 1] - fill[1]),
          Math.abs(data[at + 2] - fill[2])
        );
    sampled++;
    if (deviation > FILL_CHANNEL_TOLERANCE) offFill++;
    if (deviation > maxDeviation) maxDeviation = deviation;

    if (unpainted(at)) return;
    const bin =
      (Math.floor(data[at] / DOMINANT_BUCKET) * buckets +
        Math.floor(data[at + 1] / DOMINANT_BUCKET)) *
        buckets +
      Math.floor(data[at + 2] / DOMINANT_BUCKET);
    binCount[bin]++;
    binSum[bin * 3] += data[at];
    binSum[bin * 3 + 1] += data[at + 1];
    binSum[bin * 3 + 2] += data[at + 2];
  });

  let best = -1;
  for (let bin = 0; bin < bins; bin++) {
    if (best === -1 || binCount[bin] > binCount[best]) best = bin;
  }
  // No painted pixel at all: nothing can be "the colour covering most of it", and
  // every sampled pixel is content by definition.
  const dominant =
    best >= 0 && binCount[best] > 0
      ? [
          binSum[best * 3] / binCount[best],
          binSum[best * 3 + 1] / binCount[best],
          binSum[best * 3 + 2] / binCount[best]
        ]
      : null;

  // Pass 2 — departure from that colour, and hard edges between neighbours. Both
  // are read from the same sampled set, so a shaped mark judges its shape only.
  let offDominant = 0;
  let edges = 0;

  const step = (at: number, otherAt: number) =>
    Math.max(
      Math.abs(data[at] - data[otherAt]),
      Math.abs(data[at + 1] - data[otherAt + 1]),
      Math.abs(data[at + 2] - data[otherAt + 2])
    );

  forEachSampled((x, y, at) => {
    if (!dominant || unpainted(at)) {
      offDominant++;
    } else {
      const away = Math.max(
        Math.abs(data[at] - dominant[0]),
        Math.abs(data[at + 1] - dominant[1]),
        Math.abs(data[at + 2] - dominant[2])
      );
      if (away > UNIFORM_CHANNEL_TOLERANCE) offDominant++;
    }

    // Right and down only: every sampled neighbour pair is then visited once, and
    // both pixels of a genuine edge still get counted (one from each side).
    const right = inside(x + 1, y) ? (y * width + x + 1) * 4 : -1;
    const down = inside(x, y + 1) ? ((y + 1) * width + x) * 4 : -1;
    if (
      (right >= 0 && step(at, right) > EDGE_CONTRAST_TOLERANCE) ||
      (down >= 0 && step(at, down) > EDGE_CONTRAST_TOLERANCE)
    ) {
      edges++;
    }
  });

  return {
    sampled,
    offFill,
    fraction: sampled > 0 ? offFill / sampled : 0,
    maxDeviation,
    content: {
      sampled,
      offDominant,
      offDominantFraction: sampled > 0 ? offDominant / sampled : 0,
      edges,
      edgeFraction: sampled > 0 ? edges / sampled : 0
    }
  };
}

/**
 * A mark's polygon expressed as fractions of its own bounding box — the space
 * `regionPixelResidue` grades in, because that is the window `renderRegion`
 * rasterised. Returns undefined for a plain rectangle mark and for a degenerate
 * box, where the whole render window is the mark.
 */
function regionLocalPolygon(region: RedactionRegion): { x: number; y: number }[] | undefined {
  if (!region.points || region.points.length < 3) return undefined;
  if (!(region.width > 0) || !(region.height > 0)) return undefined;
  return region.points.map(p => ({
    x: (p.x - region.x) / region.width,
    y: (p.y - region.y) / region.height
  }));
}

const api: RenderJob = {
  async loadDocument(bytes, password) {
    // DOC-02: "never load two full copies of the bytes". `bytes` arrives by
    // structured clone across the Comlink boundary — no call site wraps this
    // argument in `Comlink.transfer` — so this array is already private to this
    // worker, and nothing in this realm reads it after this line. Copying it
    // again meant a 100MB import held 200MB in the render worker before pdf.js
    // had started, and the copy protected nobody: the caller on the other side
    // of the boundary owns a different buffer entirely.
    //
    // pdf.js takes ownership of (and may detach) what it is given, which is
    // exactly right for a buffer with no other reader.
    const task = openDocument({ data: bytes, password });
    let doc: pdfjsLib.PDFDocumentProxy;
    try {
      doc = await task.promise;
    } catch (err) {
      // Detect-and-explain, never half-process (PLAN §5.2).
      if (err instanceof pdfjsLib.PasswordException) {
        throw encrypted('The document requires a password to open.');
      }
      if (err instanceof pdfjsLib.InvalidPDFException) {
        throw corrupt('The file is not a readable PDF — its structure is invalid or truncated.');
      }
      throw err;
    }

    const handle = crypto.randomUUID();
    docs.set(handle, { doc, task });

    try {
      const pageSizes: DocumentInfo['pageSizes'] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const { width, height } = page.getViewport({ scale: 1 });
        pageSizes.push({ width, height });
        page.cleanup();
      }

      return {
        handle,
        pageCount: doc.numPages,
        isXfa: Boolean(doc.isPureXfa),
        fingerprint: doc.fingerprints[0] ?? handle,
        pageSizes
      };
    } catch (err) {
      docs.delete(handle);
      await doc.cleanup().catch(() => {});
      await task.destroy().catch(() => {});
      throw err;
    }
  },

  async closeDocument(handle) {
    const found = docs.get(handle);
    if (!found) return;
    docs.delete(handle);
    await found.doc.cleanup();
    await found.task.destroy();
  },

  async renderPage(handle, pageIndex, scale) {
    const page = await entry(handle).doc.getPage(pageIndex + 1);
    try {
      const viewport = page.getViewport({ scale });
      const { canvas, ctx } = offscreen(viewport.width, viewport.height);
      await page.render(renderParams(ctx, viewport)).promise;
      const bitmap = canvas.transferToImageBitmap();
      return Comlink.transfer(bitmap, [bitmap]);
    } finally {
      page.cleanup();
    }
  },

  async pageToImageBytes(handle, pageIndex, format, dpi, quality) {
    const page = await entry(handle).doc.getPage(pageIndex + 1);
    try {
      const viewport = page.getViewport({ scale: dpi / 72 });
      const { canvas, ctx } = offscreen(viewport.width, viewport.height);
      await page.render(renderParams(ctx, viewport)).promise;
      const blob = await canvas.convertToBlob({
        type: `image/${format}`,
        quality: format === 'jpeg' ? (quality ?? 0.92) : undefined
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return Comlink.transfer(bytes, [bytes.buffer]);
    } finally {
      page.cleanup();
    }
  },

  async decodePageBarcodes(handle, pageIndex, dpi) {
    const page = await entry(handle).doc.getPage(pageIndex + 1);
    try {
      const viewport = page.getViewport({ scale: dpi / 72 });
      const { canvas, ctx } = offscreen(viewport.width, viewport.height);
      await page.render(renderParams(ctx, viewport)).promise;
      const { data, width, height } = ctx.getImageData(0, 0, viewport.width, viewport.height);
      canvas.width = 0;
      canvas.height = 0;
      return decodeBarcodesFromImage({ data, width, height });
    } finally {
      page.cleanup();
    }
  },

  async renderRegionPng(handle, pageIndex, region, dpi) {
    const page = await entry(handle).doc.getPage(pageIndex + 1);
    try {
      const { canvas } = await renderRegion(page, region, dpi);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const png = new Uint8Array(await blob.arrayBuffer());
      const size = { width: canvas.width, height: canvas.height };
      canvas.width = 0;
      canvas.height = 0;
      return Comlink.transfer({ png, ...size }, [png.buffer]);
    } finally {
      page.cleanup();
    }
  },

  async checkRegionPixels(handle, regions, job) {
    const { doc } = entry(handle);
    const out: { region: RedactionRegion; residue: RegionPixelResidue }[] = [];

    for (let i = 0; i < regions.length; i++) {
      await checkpoint(job, i / Math.max(1, regions.length), `Checking region ${i + 1}`);
      const region = regions[i];
      const page = await doc.getPage(region.pageIndex + 1);
      try {
        const { canvas, ctx } = await renderRegion(page, region, regionVerifyDpi(region, page));
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        out.push({
          region,
          residue: regionPixelResidue(data, canvas.width, canvas.height, regionLocalPolygon(region))
        });
        canvas.width = 0;
        canvas.height = 0;
      } finally {
        page.cleanup();
      }
    }
    return out;
  },

  async inspectRedactedImages(handle, requests, job) {
    if (requests.length === 0) return [];
    const { doc } = entry(handle);

    const byPage = new Map<number, typeof requests>();
    for (const request of requests) {
      const list = byPage.get(request.pageIndex);
      if (list) list.push(request);
      else byPage.set(request.pageIndex, [request]);
    }

    const out: RedactedImageInspection[] = [];
    let done = 0;
    for (const [pageIndex, pageRequests] of byPage) {
      await checkpoint(
        job,
        done / byPage.size,
        `Inspecting images on page ${pageIndex + 1} of ${doc.numPages}`
      );
      done++;
      const page = await doc.getPage(pageIndex + 1);
      try {
        const wanted = new Map(pageRequests.map(r => [r.objectNumber, r.rects]));
        const seen = new Set<number>();
        for (const placement of imagePlacements(await page.getOperatorList())) {
          if (seen.size === wanted.size) break;
          const decoded = await decodeImage(page, placement.objId);
          if (!decoded) continue;
          const rects = wanted.get(decoded.objectNumber);
          if (!rects || seen.has(decoded.objectNumber)) continue;
          seen.add(decoded.objectNumber);
          out.push({
            pageIndex,
            objectNumber: decoded.objectNumber,
            residue: measureRectsBlacked(decoded, rects)
          });
        }
        // An image the mark still covers that could not be read is the one case
        // where "we could not look" and "the secret is still in there" are
        // indistinguishable, so it is reported rather than omitted: the caller
        // fails the region closed.
        for (const request of pageRequests) {
          if (seen.has(request.objectNumber)) continue;
          out.push({
            pageIndex,
            objectNumber: request.objectNumber,
            reason:
              'pdf.js could not decode this image (JBIG2 and JPEG 2000 images have no decoder ' +
              'here), so whether its covered pixels were destroyed cannot be checked.'
          });
        }
      } finally {
        page.cleanup();
      }
    }
    return out;
  },

  async extractText(handle, pageIndex, mode) {
    const page = await entry(handle).doc.getPage(pageIndex + 1);
    try {
      return layoutText(await textRuns(page), mode);
    } finally {
      page.cleanup();
    }
  },

  async extractPageBlocks(handle, pageIndex) {
    const page = await entry(handle).doc.getPage(pageIndex + 1);
    try {
      const runs = await formattedRuns(page);
      // The unrotated media height, because `formattedRuns` hands back pdf.js's
      // own y-up baselines rather than viewport coordinates.
      const { height } = page.getViewport({ scale: 1, rotation: 0 });
      return pageBlocks(runs, height);
    } finally {
      page.cleanup();
    }
  },

  async extractPageTextItems(handle, pageIndex) {
    const page = await entry(handle).doc.getPage(pageIndex + 1);
    try {
      const viewport = page.getViewport({ scale: 1.0 });
      const runs = await textRuns(page);
      return runs.map(run => {
        const height = Math.abs(run.transform[3]) || run.height || 10;
        return {
          text: run.str,
          x: run.transform[4],
          y: Math.max(0, viewport.height - run.transform[5]),
          width: run.width,
          height
        };
      });
    } finally {
      page.cleanup();
    }
  },

  async textPresence(handle, job) {
    const { doc } = entry(handle);
    const out: PageTextPresence[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      await checkpoint(job, (i - 1) / doc.numPages, `Analysing page ${i} of ${doc.numPages}`);
      const page = await doc.getPage(i);
      try {
        const runs = await textRuns(page);
        out.push({
          pageIndex: i - 1,
          charCount: runs.reduce((n, run) => n + run.str.trim().length, 0),
          runCount: runs.length
        });
      } catch {
        // An unparseable text layer counts as no text; the classifier decides
        // what that means rather than this loop failing the whole analysis.
        out.push({ pageIndex: i - 1, charCount: 0, runCount: 0 });
      } finally {
        page.cleanup();
      }
    }
    return out;
  },

  async documentText(handle, job) {
    const { doc } = entry(handle);
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      await checkpoint(job, (i - 1) / doc.numPages, `Reading page ${i} of ${doc.numPages}`);
      const page = await doc.getPage(i);
      try {
        const textFromRuns = (await textRuns(page)).map(run => run.str).join('');
        const annots = (await page.getAnnotations()) as PdfJsAnnotation[];
        const textFromAnnots = annots
          .flatMap(a => [a.contents, a.fieldValue, a.buttonValue])
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .join('\n');
        pages.push(textFromRuns + '\n' + textFromAnnots);
      } finally {
        page.cleanup();
      }
    }
    return pages;
  },

  async findText(handle, query, matchCase, job) {
    const needle = matchCase ? query : query.toLowerCase();
    if (!needle) return [];
    const { doc } = entry(handle);
    const regions: TextRegion[] = [];

    for (let i = 1; i <= doc.numPages; i++) {
      await checkpoint(job, (i - 1) / doc.numPages, `Searching page ${i} of ${doc.numPages}`);
      const page = await doc.getPage(i);
      try {
        const viewport = page.getViewport({ scale: 1 });

        // Matched across the whole page's text, not run by run: pdf.js splits a
        // run at every kern pair and style change, so an occurrence the user
        // can plainly see is regularly spread over two or three runs and used
        // to be invisible to this search.
        const runs = await textRuns(page);
        for (const match of findAcrossRuns(runs, query, matchCase)) {
          // pdf.js does not expose per-glyph advance widths, so we divide the
          // total run width evenly across characters (monospace approximation).
          // For search this is intentionally over-inclusive — a slightly wider
          // hit box is safe. For verification at the exact redaction boundary a
          // character on the edge may be mis-classified, but the geometric check
          // in checkRegionText uses the same approximation so both sides are
          // consistently conservative.
          for (const slice of match.slices) {
            const run = runs[slice.runIndex];
            const box = textRunViewportBox(run, viewport, slice.start, slice.end);
            regions.push({
              pageIndex: i - 1,
              ...box,
              // The *whole* match, on every slice: verification uses this to
              // check the string is gone from the document, and half a string
              // would let a partial removal pass.
              text: match.text
            });
          }
        }

        const annots = (await page.getAnnotations()) as PdfJsAnnotation[];
        for (const annot of annots) {
          const contents = [annot.contents, annot.fieldValue, annot.buttonValue]
            .filter((s): s is string => typeof s === 'string')
            .join(' ');
          if (!contents.trim()) continue;

          const haystack = matchCase ? contents : contents.toLowerCase();
          let from = 0;
          for (;;) {
            const at = haystack.indexOf(needle, from);
            if (at === -1) break;
            from = at + needle.length;

            if (annot.rect) {
              const [llx, lly, urx, ury] = annot.rect;
              const [x1, y1] = viewport.convertToViewportPoint(llx, lly);
              const [x2, y2] = viewport.convertToViewportPoint(urx, ury);
              const x = Math.min(x1, x2) / viewport.width;
              const y = Math.min(y1, y2) / viewport.height;
              const width = Math.abs(x2 - x1) / viewport.width;
              const height = Math.abs(y2 - y1) / viewport.height;
              regions.push({
                pageIndex: i - 1,
                x,
                y,
                width,
                height,
                text: contents.slice(at, at + needle.length)
              });
            }
          }
        }
      } finally {
        page.cleanup();
      }
    }
    return regions;
  },

  async findPatterns(handle, job) {
    const { doc } = entry(handle);
    const suggestions: PatternSuggestion[] = [];

    for (let i = 1; i <= doc.numPages; i++) {
      await checkpoint(job, (i - 1) / doc.numPages, `Scanning page ${i} of ${doc.numPages}`);
      const page = await doc.getPage(i);
      try {
        const viewport = page.getViewport({ scale: 1 });
        for (const found of locatePatterns(await textRuns(page), viewport)) {
          suggestions.push({
            id: `${i - 1}:${suggestions.length}:${found.category}`,
            category: found.category,
            pageIndex: i - 1,
            text: found.text,
            regions: found.boxes.map(box => ({ pageIndex: i - 1, ...box }))
          });
        }
      } finally {
        page.cleanup();
      }
    }
    return suggestions;
  },

  async detectSignatureLines(handle, job) {
    const { doc } = entry(handle);
    const found: TextRegion[] = [];

    for (let i = 1; i <= doc.numPages; i++) {
      await checkpoint(job, (i - 1) / doc.numPages, `Scanning page ${i} of ${doc.numPages}`);
      const page = await doc.getPage(i);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const runs = await textRuns(page);

        for (const run of runs) {
          if (!run.str.trim() || !SIGNATURE_LABEL.test(run.str)) continue;
          const height = run.height || run.transform[3] || 12;
          // Suggest a box sitting just above the label's baseline.
          const boxHeight = height * 2.5;
          const box = textRunViewportBox(run, viewport);
          const [, baselineYPx] = viewport.convertToViewportPoint(
            run.transform[4],
            run.transform[5]
          );
          const baselineY = baselineYPx / viewport.height;
          found.push({
            pageIndex: i - 1,
            x: box.x,
            y: Math.max(0, baselineY - boxHeight / viewport.height),
            width: Math.min(1, Math.max(box.width, (height * 8) / viewport.width)),
            height: boxHeight / viewport.height,
            text: run.str.trim()
          });
        }

        // The other half — and in real documents the usual half: a rule drawn as
        // vector path content with "Signature" or "Date" printed under it. Text
        // matching alone cannot see it, because there is no text there to match.
        const opList = await page.getOperatorList();
        const rules = horizontalRulesFromOps(
          Array.from(opList.fnArray),
          opList.argsArray,
          pdfjsLib.OPS as unknown as PathOpCodes
        );
        for (const region of signatureRulesToRegions(rules, runs, viewport, i - 1)) {
          if (found.some(existing => overlapsRegion(existing, region))) continue;
          found.push(region);
        }
      } finally {
        page.cleanup();
      }
    }
    return found;
  },

  async detectBlankPages(handle, threshold, job) {
    const { doc } = entry(handle);
    const blank: number[] = [];
    // A tenth-scale render is enough to measure ink coverage and keeps a
    // 300-page scan inside the memory budget.
    const scale = 0.1;
    const limit = blankCoverageLimit(threshold);

    for (let i = 1; i <= doc.numPages; i++) {
      await checkpoint(job, (i - 1) / doc.numPages, `Checking page ${i} of ${doc.numPages}`);
      const page = await doc.getPage(i);
      try {
        const viewport = page.getViewport({ scale });
        const { canvas, ctx } = offscreen(viewport.width, viewport.height);
        await page.render(renderParams(ctx, viewport)).promise;
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        if (inkCoverage(data) <= limit) blank.push(i - 1);
      } finally {
        page.cleanup();
      }
    }
    return blank;
  },

  async extractPageImages(handle, pageIndex, quality, targetDpi, wanted) {
    const page = await entry(handle).doc.getPage(pageIndex + 1);
    try {
      const ops = await page.getOperatorList();
      const out: ExtractedImage[] = [];

      for (const placement of imagePlacements(ops)) {
        const decoded = await decodeImage(page, placement.objId);
        // A null decode is pdf.js telling us it could not read the image
        // (JBIG2/JPX without a decoder, a broken stream). Leaving the original
        // in place is the only safe answer — PLAN §5.2.
        if (!decoded) continue;
        if (wanted && !wanted.includes(decoded.objectNumber)) continue;

        const target = targetSize(placement, decoded, targetDpi);
        const jpeg = await encodeJpeg(decoded, target, quality);
        // A mask is resampled to `target` whenever one exists, not only when the
        // *colour* image's own dimensions changed. The colour image and its
        // `/SMask` are independent XObjects — a small image can carry a
        // disproportionately large soft mask (or vice versa) — and it is the
        // caller (`rebuildCompressed`) that ultimately decides whether the
        // original mask stream's own resolution actually warrants replacing it.
        const maskBytes = decoded.mask
          ? await encodeMask(decoded.mask, decoded.width, decoded.height, target)
          : undefined;

        out.push({
          objectNumber: decoded.objectNumber,
          jpeg,
          width: target.width,
          height: target.height,
          sourceWidth: decoded.width,
          sourceHeight: decoded.height,
          hadTransparency: decoded.hadTransparency,
          maskBytes
        });
      }

      return Comlink.transfer(
        out,
        out.map(o => o.jpeg.buffer)
      );
    } finally {
      page.cleanup();
    }
  },

  async extractSharedImages(handle, requests, quality, targetDpi, job) {
    const { doc } = entry(handle);
    if (requests.length === 0) return [];

    /**
     * The winning placement per image, and the result already produced for it.
     * `encodedFor` records *which* target a result came from, so a later, larger
     * placement can be recognised as needing a fresh encode and anything already
     * at its final size is never encoded twice.
     */
    const winners = new Map<number, ImageEncodeTarget>();
    const results = new Map<number, ExtractedImage>();
    const encodedFor = new Map<number, ImageEncodeTarget>();

    /**
     * Pages whose decoded images are still needed, oldest first.
     *
     * A page cannot be released until every image it currently wins has been
     * encoded: `page.cleanup()` empties that page's decoded-object store, and
     * pdf.js will not resend an image it has already delivered, so asking for one
     * afterwards waits for an object that never arrives. (Images promoted to the
     * document-wide `commonObjs` do survive, but which images those are is
     * pdf.js's decision, not something this code may assume.)
     */
    const held = new Map<number, pdfjsLib.PDFPageProxy>();

    const encode = async (target: ImageEncodeTarget) => {
      const page = held.get(target.pageIndex);
      if (!page) return;
      const decoded = await decodeImage(page, target.placement.objId);
      // A null decode is pdf.js telling us it could not read the image
      // (JBIG2/JPX without a decoder, a broken stream). Leaving the original in
      // place is the only safe answer — PLAN §5.2.
      if (!decoded) {
        encodedFor.set(target.objectNumber, target);
        return;
      }

      const size = targetSize(target.placement, decoded, targetDpi);
      const jpeg = await encodeJpeg(decoded, size, quality);
      // A mask is resampled to `size` whenever one exists, not only when the
      // *colour* image's own dimensions changed — see `extractPageImages`.
      const maskBytes = decoded.mask
        ? await encodeMask(decoded.mask, decoded.width, decoded.height, size)
        : undefined;

      results.set(decoded.objectNumber, {
        objectNumber: decoded.objectNumber,
        jpeg,
        width: size.width,
        height: size.height,
        sourceWidth: decoded.width,
        sourceHeight: decoded.height,
        hadTransparency: decoded.hadTransparency,
        maskBytes
      });
      encodedFor.set(target.objectNumber, target);
    };

    /** Releases every held page that no unencoded winner still depends on. */
    const releaseSettled = () => {
      const needed = new Set<number>();
      for (const [objectNumber, target] of winners) {
        if (encodedFor.get(objectNumber) !== target) needed.add(target.pageIndex);
      }
      for (const [pageIndex, page] of held) {
        if (needed.has(pageIndex)) continue;
        page.cleanup();
        held.delete(pageIndex);
      }
    };

    try {
      for (let i = 0; i < requests.length; i++) {
        const { pageIndex, objectNumbers } = requests[i];
        await checkpoint(job, i / requests.length, `Re-encoding images on page ${pageIndex + 1}`);
        const wanted = new Set(objectNumbers);
        if (wanted.size === 0) continue;

        const page = await doc.getPage(pageIndex + 1);
        held.set(pageIndex, page);

        // Nothing is decoded to pixels here: the operator list gives the
        // placement, and the decoded object is read only for its `ref`, which is
        // the object number the pdf-lib half of the pipeline addresses.
        for (const placement of imagePlacements(await page.getOperatorList())) {
          const resolved = await awaitImageObject(page, placement.objId);
          const objectNumber = refObjectNumber((resolved?.data as { ref?: unknown })?.ref);
          if (objectNumber < 0 || !wanted.has(objectNumber)) continue;
          const previous = winners.get(objectNumber);
          if (!previous || largerPlacement(placement, previous.placement)) {
            winners.set(objectNumber, { objectNumber, pageIndex, placement });
          }
        }

        releaseSettled();

        // Memory valve. Holding a page keeps its decoded images alive, so a long
        // document with a different large image on every page would otherwise
        // grow without bound. Past the cap the oldest page's images are encoded
        // at the best size seen *so far* and the page is let go; if a later page
        // turns out to display one of them larger, that one image is encoded a
        // second time. Correctness never depends on the cap — only the promise of
        // exactly one encode does, and only under memory pressure.
        while (held.size > MAX_HELD_PAGES) {
          const oldest = held.keys().next().value;
          if (oldest === undefined) break;
          for (const [objectNumber, target] of winners) {
            if (target.pageIndex === oldest && encodedFor.get(objectNumber) !== target) {
              await encode(target);
            }
          }
          const page = held.get(oldest);
          page?.cleanup();
          held.delete(oldest);
        }
      }

      for (const [objectNumber, target] of winners) {
        if (encodedFor.get(objectNumber) !== target) await encode(target);
      }
    } finally {
      for (const page of held.values()) page.cleanup();
      held.clear();
    }

    const out = [...results.values()];
    return Comlink.transfer(
      out,
      out.map(o => o.jpeg.buffer)
    );
  },

  async redactPageImages(handle, pageIndex, requests) {
    if (requests.length === 0) return [];
    const page = await entry(handle).doc.getPage(pageIndex + 1);
    try {
      const wanted = new Map(requests.map(r => [r.objectNumber, r.rects]));
      const results: RedactedImageResult[] = [];
      const seen = new Set<number>();

      for (const placement of imagePlacements(await page.getOperatorList())) {
        if (seen.size === wanted.size) break;
        const decoded = await decodeImage(page, placement.objId);
        // A null decode is pdf.js saying it could not read the image — JBIG2 and
        // JPEG 2000 have no decoder here. There is no safe half-measure: the
        // caller is told, and refuses the redaction.
        if (!decoded) continue;
        const rects = wanted.get(decoded.objectNumber);
        if (!rects || seen.has(decoded.objectNumber)) continue;
        seen.add(decoded.objectNumber);

        // `decodeImage` moves any /SMask or stencil into `decoded.mask` and
        // makes the colour buffer opaque. Both have to be blacked out: colour
        // alone would leave the secret visible wherever the mask makes the pixel
        // transparent, and the mask is re-attached below as PNG alpha.
        paintRectsBlack(decoded, rects);

        const bytes = await encodeRedacted(decoded);
        results.push({
          objectNumber: decoded.objectNumber,
          image: {
            bytes,
            format: decoded.mask ? 'png' : 'jpeg',
            width: decoded.width,
            height: decoded.height
          }
        });
      }

      for (const request of requests) {
        if (seen.has(request.objectNumber)) continue;
        results.push({
          objectNumber: request.objectNumber,
          reason:
            'pdf.js could not decode this image (JBIG2 and JPEG 2000 images have no decoder ' +
            'here), so its pixels cannot be blacked out.'
        });
      }

      return Comlink.transfer(
        results,
        results.flatMap(r => (r.image ? [r.image.bytes.buffer] : []))
      );
    } finally {
      page.cleanup();
    }
  },

  async loadFaceDetector(weights) {
    await loadFaceModel(weights);
  },

  async extractImageRegion(handle, pageIndex, objectNumber, rect) {
    const page = await entry(handle).doc.getPage(pageIndex + 1);
    try {
      for (const placement of imagePlacements(await page.getOperatorList())) {
        const decoded = await decodeImage(page, placement.objId);
        if (!decoded || decoded.objectNumber !== objectNumber) continue;
        const crop = cropUnitRect(decoded, rect);
        if (!crop) return null;
        return Comlink.transfer(crop, [crop.rgba.buffer]);
      }
      return null;
    } finally {
      page.cleanup();
    }
  },

  async blurPageImages(handle, pageIndex, requests, settings, job) {
    if (requests.length === 0) return [];
    const page = await entry(handle).doc.getPage(pageIndex + 1);
    try {
      const wanted = new Map(requests.map(request => [request.objectNumber, request]));
      const results: BlurredImageResult[] = [];
      const seen = new Set<number>();
      let done = 0;

      for (const placement of imagePlacements(await page.getOperatorList())) {
        if (seen.size === wanted.size) break;
        const decoded = await decodeImage(page, placement.objId);
        // A null decode is pdf.js saying it could not read the image. There is
        // no safe half-measure — the caller is told which image, and says so.
        if (!decoded) continue;
        const request = wanted.get(decoded.objectNumber);
        if (!request || seen.has(decoded.objectNumber)) continue;
        seen.add(decoded.objectNumber);

        await checkpoint(job, done / wanted.size, `Looking for faces on page ${pageIndex + 1}`);
        done += 1;

        const regions: DetectedRegion[] = [];
        if (settings.detectFaces) {
          regions.push(...(await detectFaces(decoded, { minScore: settings.minScore })));
        }
        if (settings.logoTemplate) {
          for (const match of matchTemplate(decoded, settings.logoTemplate, {
            minScore: settings.logoMinScore
          })) {
            regions.push({ ...match, kind: 'logo' });
          }
        }
        for (const rect of request.forcedRects ?? []) {
          // The marked instance is exactly what `logoTemplate` was cropped
          // from, so `matchTemplate` above almost always finds it again at
          // this same spot on this same image — without this check that one
          // real instance was reported (and counted) twice.
          if (
            regions.some(
              region => region.kind === 'logo' && intersectionOverUnion(region, rect) > 0.3
            )
          ) {
            continue;
          }
          regions.push({ ...rect, kind: 'logo', score: 1 });
        }

        if (regions.length === 0) {
          results.push({ objectNumber: decoded.objectNumber, regions: [] });
          continue;
        }

        // `decodeImage` moves any /SMask or stencil into `decoded.mask` and
        // makes the colour buffer opaque; `pixelateRects` mosaics both, so the
        // alpha silhouette of a head does not survive the blur.
        pixelateRects(decoded, regions, { strength: settings.strength });

        const bytes = await encodeRedacted(decoded);
        results.push({
          objectNumber: decoded.objectNumber,
          regions,
          image: {
            bytes,
            format: decoded.mask ? 'png' : 'jpeg',
            width: decoded.width,
            height: decoded.height
          }
        });
      }

      for (const request of requests) {
        if (seen.has(request.objectNumber)) continue;
        // Two different things land here and cannot be told apart from this
        // side: an image pdf.js genuinely tried to decode and failed on
        // (JBIG2/JPEG 2000 have no decoder here), and a resource dict entry
        // the page's content stream never actually paints (the plan lists
        // every `/Subtype /Image` entry, painted or not) — that second case
        // was never even attempted, so blaming a specific codec for it would
        // be a guess stated as fact. The reason stays honest about what is
        // actually known instead.
        results.push({
          objectNumber: request.objectNumber,
          regions: [],
          reason: 'This image could not be decoded, so it could not be checked for faces.'
        });
      }

      return Comlink.transfer(
        results,
        results.flatMap(result => (result.image ? [result.image.bytes.buffer] : []))
      );
    } finally {
      page.cleanup();
    }
  },

  async checkRegionText(handle, regions, job) {
    const { doc } = entry(handle);
    const results: { region: RedactionRegion; foundText: string }[] = [];

    for (let i = 0; i < regions.length; i++) {
      await checkpoint(
        job,
        i / Math.max(1, regions.length),
        `Checking region ${i + 1} of ${regions.length}`
      );
      const region = regions[i];
      const page = await doc.getPage(region.pageIndex + 1);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const runs = await textRuns(page);
        let foundText = '';

        // RED-07 — a shaped mark is checked against the shape, not its bounding
        // box. Testing the box would fail a correct polygon redaction on the text
        // it deliberately left in the box's corners, and blocking the save on
        // content the user asked to keep is as wrong as passing content it asked
        // to remove. The overlap rule is the same one `filterContentStream`
        // removed by, so verification can never demand more than removal did.
        const shape = region.points && region.points.length >= 3 ? region.points : undefined;

        for (const run of runs) {
          if (!run.str.trim()) continue;

          for (let i = 0; i < run.str.length; i++) {
            const charBox = textRunViewportBox(run, viewport, i, i + 1);
            const charX = charBox.x;
            const charY = charBox.y;
            const charW = charBox.width;
            const charH = charBox.height;

            const intersects = !(
              charX >= region.x + region.width ||
              charX + charW <= region.x ||
              charY >= region.y + region.height ||
              charY + charH <= region.y
            );

            if (intersects && (!shape || polygonOverlapsBox(shape, charBox))) {
              foundText += run.str[i];
            }
          }
        }
        results.push({ region, foundText });
      } finally {
        page.cleanup();
      }
    }
    return results;
  }
};

/* ------------------------------------------------------------------ *
 * Surgical image re-encode (CMP-03)
 * ------------------------------------------------------------------ */

/** `[a, b, c, d, e, f]`, the PDF transformation matrix. */
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m` applied first, then `ctm` — pdf.js's `Util.transform(ctm, m)`. */
function concat(ctm: Matrix, m: Matrix): Matrix {
  return [
    ctm[0] * m[0] + ctm[2] * m[1],
    ctm[1] * m[0] + ctm[3] * m[1],
    ctm[0] * m[2] + ctm[2] * m[3],
    ctm[1] * m[2] + ctm[3] * m[3],
    ctm[0] * m[4] + ctm[2] * m[5] + ctm[4],
    ctm[1] * m[4] + ctm[3] * m[5] + ctm[5]
  ];
}

interface ImagePlacement {
  /** pdf.js's own object id for the image, e.g. `img_p0_1`. */
  objId: string;
  /** Largest width this image is drawn at anywhere on the page, in points. */
  widthPt: number;
  heightPt: number;
  /** False when an operator we do not model could have changed the matrix. */
  measured: boolean;
}

function isMatrix(value: unknown): value is Matrix {
  return Array.isArray(value) && value.length === 6 && value.every(n => typeof n === 'number');
}

/**
 * How many pages `extractSharedImages` may keep decoded at once. Each held page
 * is one page's worth of decoded images; eight is a few tens of MB on ordinary
 * content and keeps the encode-once guarantee for any realistic shared logo,
 * which is what this exists for.
 */
const MAX_HELD_PAGES = 8;

/** Which page's placement of a shared image decides the size it is encoded at. */
interface ImageEncodeTarget {
  objectNumber: number;
  pageIndex: number;
  placement: ImagePlacement;
}

/**
 * True when `candidate` needs at least as many pixels as `incumbent` — the rule
 * that picks the one size a shared image is encoded at.
 *
 * An *unmeasured* placement wins outright: `targetSize` refuses to downscale one
 * (it cannot know how large the image is really drawn), so it needs the source
 * resolution, which is the largest anything can ask for. Between two measured
 * placements, displayed area decides. Exported for testing: getting this backwards
 * means every other page inherits a too-small encode and shows a blurry image,
 * which is exactly the bug that made the per-page encode look necessary.
 */
export function largerPlacement(candidate: ImagePlacement, incumbent: ImagePlacement): boolean {
  if (!candidate.measured) return true;
  if (!incumbent.measured) return false;
  return candidate.widthPt * candidate.heightPt > incumbent.widthPt * incumbent.heightPt;
}

/**
 * Walks the operator list, tracking the CTM, and reports how large each image is
 * actually drawn — the input to "downscale to displayed size".
 *
 * Getting the matrix wrong can only pick the wrong *resolution*; the image is
 * still drawn into the same unit square, so geometry cannot break. Even so the
 * tracker refuses to guess: transparency groups and annotations re-base the
 * canvas transform in ways that are not visible from the operator list, so any
 * image drawn inside one is marked unmeasured and re-encoded at source size.
 */
function imagePlacements(ops: { fnArray: number[]; argsArray: unknown[] }): ImagePlacement[] {
  const OPS = pdfjsLib.OPS;
  const found = new Map<string, ImagePlacement>();
  const stack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;

  const record = (objId: unknown, scaleX: number, scaleY: number) => {
    if (typeof objId !== 'string') return;
    const widthPt = Math.abs(scaleX) * Math.hypot(ctm[0], ctm[1]);
    const heightPt = Math.abs(scaleY) * Math.hypot(ctm[2], ctm[3]);
    const previous = found.get(objId);
    if (!previous) {
      found.set(objId, { objId, widthPt, heightPt, measured: true });
      return;
    }
    // An image drawn twice has to survive at the size of its largest use.
    previous.widthPt = Math.max(previous.widthPt, widthPt);
    previous.heightPt = Math.max(previous.heightPt, heightPt);
  };

  for (let i = 0; i < ops.fnArray.length; i++) {
    const args = ops.argsArray[i];
    switch (ops.fnArray[i]) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? IDENTITY;
        break;
      case OPS.transform:
        if (isMatrix(args)) ctm = concat(ctm, args);
        break;
      case OPS.paintFormXObjectBegin: {
        stack.push(ctm);
        const matrix = Array.isArray(args) ? args[0] : null;
        if (isMatrix(matrix)) ctm = concat(ctm, matrix);
        break;
      }
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? IDENTITY;
        break;
      case OPS.paintImageXObject:
        if (Array.isArray(args)) record(args[0], 1, 1);
        break;
      case OPS.paintImageXObjectRepeat:
        // pdf.js collapses three or more identical draws into one op carrying
        // the per-instance scale.
        if (Array.isArray(args)) record(args[0], Number(args[1]) || 1, Number(args[2]) || 1);
        break;
      default:
        break;
    }
  }

  return [...found.values()];
}

interface DecodedImage {
  objectNumber: number;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  hadTransparency: boolean;
  mask?: Uint8Array;
}

/**
 * pdf.js writes `Ref.toString()` into the decoded image, e.g. `"7R"` or `"7R2"`.
 * That object number is the only identifier shared with the pdf-lib half of the
 * pipeline, which addresses the same image as `/XObject` entry N.
 */
function refObjectNumber(ref: unknown): number {
  if (typeof ref === 'string') {
    const match = /^(\d+)R/.exec(ref);
    return match ? Number(match[1]) : -1;
  }
  if (ref && typeof ref === 'object' && typeof (ref as { num?: unknown }).num === 'number') {
    return (ref as { num: number }).num;
  }
  return -1;
}

/**
 * How long to wait for pdf.js to hand over a decoded image before giving up.
 *
 * `getOperatorList()` resolves as soon as the *operators* are known: the
 * evaluator kicks off `PDFImage.buildImage()` and deliberately does not await it,
 * so the pixels arrive tens of milliseconds later, and for a large image much
 * later than that. The previous implementation asked `store.has(name)` the
 * instant the operator list came back, always got `false`, and skipped the image
 * — which is why the surgical path silently re-encoded nothing at all.
 */
const IMAGE_DECODE_TIMEOUT_MS = 60_000;

/**
 * Waits for one decoded image.
 *
 * Which store it lands in is not knowable in advance: an image used on a single
 * page goes to `page.objs`, and one pdf.js has seen on two pages is promoted to
 * the document-wide `commonObjs`. Both are asked, and whichever answers first
 * wins.
 */
function awaitImageObject(
  page: pdfjsLib.PDFPageProxy,
  objId: string
): Promise<{ data: unknown; shared: boolean } | null> {
  // pdf.js does not export the `PDFObjects` type, so the store is taken
  // structurally — the callback form of `get` is all this needs.
  const from = (
    store: { get(id: string, callback: (data: unknown) => void): unknown },
    shared: boolean
  ) =>
    new Promise<{ data: unknown; shared: boolean }>(resolve => {
      store.get(objId, (data: unknown) => resolve({ data, shared }));
    });
  return Promise.race([
    from(page.objs, false),
    from(page.commonObjs, true),
    new Promise<null>(resolve => setTimeout(() => resolve(null), IMAGE_DECODE_TIMEOUT_MS))
  ]);
}

interface DrawableFrame {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

/**
 * pdf.js hands back one of two drawable objects, and which one depends on the
 * filter: a Flate image arrives as an `ImageBitmap`, while a DCTDecode one is
 * decoded through WebCodecs and arrives as a `VideoFrame`. The old code only
 * recognised `ImageBitmap`, so *JPEG* images — by far the most common thing in
 * a PDF worth compressing — were silently skipped.
 */
function drawableFrom(...candidates: unknown[]): DrawableFrame | null {
  for (const candidate of candidates) {
    if (candidate instanceof ImageBitmap) {
      return {
        source: candidate,
        width: candidate.width,
        height: candidate.height,
        close: () => candidate.close()
      };
    }
    if (typeof VideoFrame !== 'undefined' && candidate instanceof VideoFrame) {
      return {
        source: candidate,
        width: candidate.displayWidth,
        height: candidate.displayHeight,
        close: () => candidate.close()
      };
    }
  }
  return null;
}

/**
 * Normalises whatever pdf.js decoded into straight RGBA.
 *
 * Two shapes come back. With OffscreenCanvas available the worker returns an
 * `ImageBitmap`, whose backing store is alpha-premultiplied; `getImageData`
 * undoes that, so colour is recovered to within a level or two wherever alpha is
 * non-zero, and is lost only where alpha is zero — pixels that contribute
 * nothing to the rendered result. Otherwise raw pixels arrive with a `kind`
 * discriminant. Anything else is refused rather than guessed at.
 *
 * The colour space has already been resolved by this point: pdf.js converts
 * DeviceCMYK, Indexed, ICCBased and friends to RGB while decoding, which is why
 * those images can be re-encoded at all.
 */
async function decodeImage(
  page: pdfjsLib.PDFPageProxy,
  objId: string
): Promise<DecodedImage | null> {
  const resolved = await awaitImageObject(page, objId);
  if (!resolved || !resolved.data || typeof resolved.data !== 'object') return null;

  const img = resolved.data as {
    bitmap?: unknown;
    data?: Uint8Array | Uint8ClampedArray;
    width?: number;
    height?: number;
    kind?: number;
    ref?: unknown;
  };
  const objectNumber = refObjectNumber(img.ref);
  // Without an object number there is no way to say which XObject this replaces.
  if (objectNumber < 0) return null;

  let rgba: Uint8ClampedArray | null = null;
  let width = 0;
  let height = 0;

  const frame = drawableFrom(img.bitmap, resolved.data);
  if (frame) {
    // pdf.js reports the logical size; a VideoFrame's own coded size can be
    // padded out to whole macroblocks, so the payload's dimensions win.
    width = img.width ?? frame.width;
    height = img.height ?? frame.height;
    const { canvas, ctx } = offscreen(width, height);
    ctx.drawImage(frame.source, 0, 0, width, height);
    rgba = ctx.getImageData(0, 0, width, height).data;
    // A frame in commonObjs belongs to the document, and other pages still need
    // it; only a page-local one is ours to release early.
    if (!resolved.shared) frame.close();
    canvas.width = 0;
    canvas.height = 0;
  } else if (img.data && img.width && img.height && img.kind !== undefined) {
    width = img.width;
    height = img.height;
    rgba = toRgba(img.data, width, height, img.kind);
  }

  if (!rgba || width <= 0 || height <= 0) return null;

  const mask = extractMask(rgba, width, height);
  return { objectNumber, rgba, width, height, hadTransparency: mask !== undefined, mask };
}

/**
 * Makes the buffer opaque, and reports whether it was not.
 *
 * JPEG has no alpha, so a canvas holding transparency is composited onto black
 * on the way out — which is exactly the "black box" this ticket exists to
 * prevent, and it is worse than it looks: a half-transparent pixel would be
 * darkened once here and again when the re-attached soft mask is applied.
 *
 * So the alpha is dropped deliberately rather than by accident. The colour is
 * kept as-is (it is the *un*-premultiplied base colour), and pixels that have no
 * colour of their own — fully transparent ones — are filled from the nearest
 * pixel that does. That fill is invisible in any correct renderer, because the
 * original soft mask is re-attached to the replacement stream and hides those
 * pixels again; its job is to stop JPEG's 8×8 blocks from smearing black across
 * the edge of the mask into pixels that *are* visible.
 */
function extractMask(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): Uint8Array | undefined {
  const total = width * height;
  let transparent = 0;
  let translucent = false;
  for (let p = 0; p < total; p++) {
    const alpha = rgba[p * 4 + 3];
    if (alpha === 0) transparent += 1;
    else if (alpha !== 255) translucent = true;
  }
  if (transparent === 0 && !translucent) return undefined;

  const mask = new Uint8Array(total);
  for (let p = 0; p < total; p++) {
    mask[p] = rgba[p * 4 + 3];
  }

  // Colourless pixels borrow from their nearest coloured neighbour; with none to
  // borrow from there is nothing to do but make the buffer opaque.
  if (transparent > 0 && transparent < total) bleedColour(rgba, width, height);
  for (let p = 0; p < total; p++) rgba[p * 4 + 3] = 255;
  return mask;
}

/**
 * Breadth-first fill of fully transparent pixels from their nearest opaque
 * neighbour. Every pixel is queued at most once, so this is linear in the image.
 */
function bleedColour(rgba: Uint8ClampedArray, width: number, height: number): void {
  const total = width * height;
  const queue = new Int32Array(total);
  const filled = new Uint8Array(total);
  let head = 0;
  let tail = 0;

  for (let p = 0; p < total; p++) {
    if (rgba[p * 4 + 3] !== 0) {
      filled[p] = 1;
      queue[tail++] = p;
    }
  }

  while (head < tail) {
    const from = queue[head++];
    const x = from % width;
    const y = (from - x) / width;
    for (let n = 0; n < 4; n++) {
      const nx = x + (n === 0 ? -1 : n === 1 ? 1 : 0);
      const ny = y + (n === 2 ? -1 : n === 3 ? 1 : 0);
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const to = ny * width + nx;
      if (filled[to]) continue;
      filled[to] = 1;
      rgba[to * 4] = rgba[from * 4];
      rgba[to * 4 + 1] = rgba[from * 4 + 1];
      rgba[to * 4 + 2] = rgba[from * 4 + 2];
      queue[tail++] = to;
    }
  }
}

/**
 * Re-encodes a redacted image at its source resolution.
 *
 * PNG when the image carried transparency, so the mask travels back as alpha and
 * pdf-lib rebuilds the `/SMask` itself; JPEG otherwise, which is what the rest of
 * the pipeline embeds and keeps a scanned page from ballooning. Neither is
 * resampled: redaction must not quietly change the rest of the page's quality.
 */
async function encodeRedacted(decoded: DecodedImage): Promise<Uint8Array> {
  const { width, height } = decoded;
  const rgba = new Uint8ClampedArray(decoded.rgba);
  if (decoded.mask) {
    for (let p = 0; p < width * height; p++) rgba[p * 4 + 3] = decoded.mask[p];
  }

  const bitmap = await createImageBitmap(new ImageData(rgba, width, height));
  try {
    const { canvas, ctx } = offscreen(width, height);
    ctx.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob(
      decoded.mask ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.92 }
    );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    canvas.width = 0;
    canvas.height = 0;
    return bytes;
  } finally {
    bitmap.close();
  }
}

interface TargetSize {
  width: number;
  height: number;
}

/** Below this ratio the resample costs quality for no meaningful saving. */
const MIN_RESAMPLE_RATIO = 1.15;

/**
 * Pixel size to re-encode at: the displayed size at the target resolution,
 * never larger than the source and never below one pixel.
 */
function targetSize(
  placement: ImagePlacement,
  decoded: DecodedImage,
  targetDpi: number
): TargetSize {
  const source = { width: decoded.width, height: decoded.height };
  if (!placement.measured || targetDpi <= 0) return source;
  if (placement.widthPt <= 0 || placement.heightPt <= 0) return source;

  const wanted = {
    width: Math.round((placement.widthPt / 72) * targetDpi),
    height: Math.round((placement.heightPt / 72) * targetDpi)
  };
  const ratio = Math.min(source.width / wanted.width, source.height / wanted.height);
  if (!Number.isFinite(ratio) || ratio < MIN_RESAMPLE_RATIO) return source;

  return {
    width: Math.max(1, Math.min(source.width, wanted.width)),
    height: Math.max(1, Math.min(source.height, wanted.height))
  };
}

async function encodeJpeg(
  decoded: DecodedImage,
  target: TargetSize,
  quality: number
): Promise<Uint8Array> {
  const source = new ImageData(decoded.rgba, decoded.width, decoded.height);
  const bitmap = await createImageBitmap(source);
  try {
    const { canvas, ctx } = offscreen(target.width, target.height);
    ctx.drawImage(bitmap, 0, 0, target.width, target.height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    canvas.width = 0;
    canvas.height = 0;
    return bytes;
  } finally {
    bitmap.close();
  }
}

async function encodeMask(
  mask: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  target: TargetSize
): Promise<Uint8Array> {
  if (sourceWidth === target.width && sourceHeight === target.height) {
    return mask;
  }

  const rgba = new Uint8ClampedArray(sourceWidth * sourceHeight * 4);
  for (let p = 0; p < mask.length; p++) {
    rgba[p * 4] = mask[p];
    rgba[p * 4 + 1] = mask[p];
    rgba[p * 4 + 2] = mask[p];
    rgba[p * 4 + 3] = 255;
  }

  const source = new ImageData(rgba, sourceWidth, sourceHeight);
  const bitmap = await createImageBitmap(source);
  try {
    const { canvas, ctx } = offscreen(target.width, target.height);
    ctx.drawImage(bitmap, 0, 0, target.width, target.height);
    const { data } = ctx.getImageData(0, 0, target.width, target.height);

    const outMask = new Uint8Array(target.width * target.height);
    for (let p = 0; p < outMask.length; p++) {
      outMask[p] = data[p * 4]; // Copy back the R channel
    }

    canvas.width = 0;
    canvas.height = 0;
    return outMask;
  } finally {
    bitmap.close();
  }
}

Comlink.expose(api);

/**
 * The same object `Comlink.expose` publishes, exported so tests can drive the
 * real implementation against real bytes instead of a mock. Mirrors
 * `processWorkerImpl` in `process.worker.ts`.
 */
export const renderWorkerImpl = api;

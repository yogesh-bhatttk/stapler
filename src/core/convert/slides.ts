/**
 * CNV-12 — a PDF's pages → a slide plan.
 *
 * This is the widest fidelity gap of the six conversion tickets, and the ticket
 * says so outright: what comes out is *positioned text boxes and pictures
 * approximating each page's layout*, not an outline a presenter would have built.
 * Every number in this file is a measurement of the source page; nothing here is
 * an attempt to infer intent. There are no bullets, no title placeholders, no
 * speaker notes and no reflow, because a PDF states none of those and inventing
 * them is exactly the sort of plausible-looking wrongness this codebase refuses.
 *
 * What is borrowed rather than rewritten:
 *
 *  • **Line grouping** is `text-layout.ts`'s `layoutLines` — the same grouping
 *    CNV-04's text export, CNV-08's DOCX export and CNV-10's XLSX export read.
 *    What this file does *not* borrow is CNV-08's paragraph merging: a slide wants
 *    one box where the page had one line, and merging wrapped lines into a
 *    reflowable paragraph would move text away from where the page drew it. So
 *    the grouping is shared and the block model is not.
 *  • **Image bytes** are CNV-06's `extractImages`, byte-for-byte, the same source
 *    CNV-08 embeds from.
 *  • **Image positions** are `pdf/image-placements.ts`, which walks the page's
 *    content stream with RED-02's interpreter. CNV-08 states it cannot place an
 *    image because a resource dictionary has no geometry; that is true of the
 *    dictionary, and this ticket asks the content stream instead.
 *
 * Coordinates. Everything a caller hands in is in the page's own **unrotated raw**
 * user space, y up from the bottom-left, because that is what pdf.js's text
 * transforms and pdf-lib's content streams both use. Everything this module hands
 * out is in **points from the slide's top-left, y down**, which is (divided by 72)
 * exactly what PowerPoint wants. The rotation, the y flip, the **box-origin
 * shift** and the fit-to-slide scale all happen here, once, so the writer does no
 * geometry at all.
 *
 * That box-origin shift is not a detail. Raw user space is *not* anchored at the
 * page's visible corner: a `/MediaBox` may start anywhere, and a `/CropBox`
 * usually does — Stapler's own Crop tool writes one (`composeDocument`). pdf.js
 * reports a text run's transform and pdf-lib's content stream states an image's
 * `cm` in raw user space, while the page a reader sees starts at the *displayed
 * box's* own origin. So every raw coordinate has that origin subtracted before
 * `(0, 0)` is treated as the slide's top-left. Without it a page cropped to
 * `[100 100 612 792]` puts every line and every picture 100 pt right and 100 pt
 * up from where the page draws it, which for a page-top title means off the slide
 * entirely. The governing box is the one pdf.js's own viewport uses, and the
 * origin travels with the width and height it belongs to — see {@link PageBox}.
 */

import { normalizeRotation } from '../rotation';
import { layoutLines, type TextRun } from '../text-layout';

/** A run of text with the two attributes a PowerPoint run can carry from a PDF. */
export interface SlideRun {
  text: string;
  bold: boolean;
  italic: boolean;
}

/** A pdf.js text run plus what its font descriptor said. Same shape CNV-08 uses. */
export interface FormattedTextRun extends TextRun {
  bold?: boolean;
  italic?: boolean;
}

/**
 * One line of a page's text, in the page's own unrotated **raw** user space.
 *
 * `x`/`baseline` are the line's baseline *origin* exactly as pdf.js reported it —
 * raw, so the displayed box's origin has still to be subtracted (see the module
 * comment). `baseline` is the PDF baseline (y up), not a box edge: the box is
 * derived from it in {@link planSlides} so the ascent assumption lives in one
 * place.
 */
export interface PageTextLine {
  runs: SlideRun[];
  x: number;
  baseline: number;
  /** Advance along the line's own text direction, in points. */
  width: number;
  /** The largest glyph size on the line, in points. */
  size: number;
  /**
   * The baseline's direction, in degrees **counter-clockwise** from the page's
   * +x axis. `0` for ordinary horizontal text, which is nearly every line of
   * nearly every page; non-zero for a diagonal watermark or a sideways column
   * header. See {@link textBaselineAngle} for what is and is not treated as
   * rotated.
   */
  angle: number;
  /**
   * How many characters {@link MAX_BOX_CHARS} actually cut from this line. The
   * exact count, so a line that happens to be exactly the cap's length is not
   * reported as shortened when nothing was removed from it.
   */
  truncated: number;
}

/**
 * The page box a reader actually sees, in raw PDF user space.
 *
 * `width`/`height` are what the slide is sized from; `x`/`y` are the origin every
 * raw coordinate on the page is measured *from*, and the reason the two travel
 * together in one object rather than as two loose numbers. This is pdf.js's own
 * view box — `/CropBox` intersected with `/MediaBox`, falling back to the
 * `/MediaBox` — which is the box its viewport is built from and therefore the box
 * its text transforms have to be interpreted against. It is the same
 * crop-first-then-media selection the rest of the app already makes for
 * edge-anchored furniture (`process.worker.ts` lays a Bates number out against
 * `getCropBox()`, after one landed outside the crop the same export applied).
 */
export interface PageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the render worker extracts per page, before any slide geometry exists. */
export interface PageSlideData {
  pageIndex: number;
  /** The unrotated displayed page box, origin included. */
  box: PageBox;
  /** The page's `/Rotate`, normalised. */
  rotation: SlideRotation;
  lines: PageTextLine[];
  /** How many lines the per-page cap left out. */
  droppedLines: number;
  /** How many lines were placed at a real angle rather than horizontally. */
  rotatedLines: number;
  /**
   * How many runs have a non-horizontal baseline that is *mirrored* rather than
   * rotated, so they are left horizontal. Reported, never silently flattened.
   */
  mirroredLines: number;
}

export type SlideRotation = 0 | 90 | 180 | 270;

/** The image formats a PowerPoint picture part can hold from CNV-06's output. */
export type SlideImageFormat = 'png' | 'jpg';

/** A positioned text box, in points from the slide's top-left, y down. */
export interface SlideTextBox {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Points, already scaled if the page had to be fitted to the slide. */
  fontSize: number;
  runs: SlideRun[];
  /**
   * Degrees clockwise about the box's own centre, in `[0, 360)`.
   *
   * Not one of the four `/Rotate` values: it is the page's `/Rotate` *plus* the
   * line's own baseline angle, so a diagonal watermark on an upright page and an
   * upright line on a sideways page both land at the angle the page draws them
   * at. `placeByCentre` is what makes an arbitrary angle land correctly —
   * PowerPoint rotates a shape about its centre, so the centre is the point that
   * is mapped.
   */
  rotate: number;
}

/** A positioned picture, in points from the slide's top-left, y down. */
export interface SlideImage {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees clockwise about the picture's own centre, in `[0, 360)`. */
  rotate: number;
  /** CNV-06 ZIP entry name; the writer reads the bytes out of the archive. */
  fileName: string;
  format: SlideImageFormat;
  altText: string;
}

export interface PlannedSlide {
  pageIndex: number;
  /** Boxes and pictures, in the order they are added — pictures first. */
  images: SlideImage[];
  boxes: SlideTextBox[];
}

/** One row of the preview the user must see before the save button unlocks. */
export interface PptxPreviewItem {
  pageIndex: number;
  /** 1-based slide number, which is what the panel and PowerPoint both show. */
  slideNumber: number;
  textBoxCount: number;
  imageCount: number;
  /**
   * The slide's leading text, elided. A slide whose text landed on the wrong
   * page — the failure a mandatory preview exists to catch — is visible here
   * without rendering anything.
   */
  text: string;
}

/** The whole plan, before any `.pptx` bytes exist. */
export interface SlidePlan {
  /** Slide size in points. One size for the whole deck — PowerPoint has no other. */
  slideWidth: number;
  slideHeight: number;
  slides: PlannedSlide[];
  outline: PptxPreviewItem[];
  /** Everything recognised and deliberately not placed, each with its reason. */
  notes: string[];
}

/* ------------------------------------------------------------------ *
 * Caps and constants, each with a reason
 * ------------------------------------------------------------------ */

/**
 * How many text boxes one slide may carry.
 *
 * Each line of the page becomes its own shape. A dense two-column page runs to
 * ~120 lines; a page of a printed table of contents can run to 200. Past 400 the
 * file has stopped being something PowerPoint can edit — every shape is a
 * separate object in the outliner — so the overflow is reported instead of
 * written.
 */
export const MAX_BOXES_PER_SLIDE = 400;

/**
 * How many characters one text box may carry.
 *
 * A "line" is whatever shares a baseline, and a producer that emits an entire
 * page on one baseline exists. The cap keeps a single shape from holding a page
 * of prose; what it cuts is counted and reported.
 */
export const MAX_BOX_CHARS = 1000;

/**
 * PowerPoint's own slide-dimension limits, in points (1–56 inches).
 *
 * A page outside them is scaled to fit rather than refused: an A0 poster is a
 * legitimate PDF page, and 56 inches is PowerPoint's ceiling, not this
 * converter's opinion.
 */
export const MIN_SLIDE_POINTS = 72;
export const MAX_SLIDE_POINTS = 56 * 72;

/**
 * Where a single-line box's top edge sits relative to its baseline, as a
 * multiple of the type size, and how tall the box is made.
 *
 * PowerPoint draws a `wrap: false`, zero-margin, top-anchored box's first line
 * from the box's top edge, so the ascent is what actually decides where the
 * glyphs land; the height only decides the shape's outline for someone editing
 * it. 0.80/1.20 em are the ordinary metrics of a Latin text face — chosen, not
 * derived, and the reason the tool's copy says positioning is approximate.
 */
const ASCENT_EM = 0.8;
const LINE_HEIGHT_EM = 1.2;

/** How much of a slide's text the preview shows before eliding it. */
const PREVIEW_TEXT_LIMIT = 160;

function elide(text: string): string {
  return text.length <= PREVIEW_TEXT_LIMIT
    ? text
    : `${text.slice(0, PREVIEW_TEXT_LIMIT - 1).trimEnd()}…`;
}

/**
 * `/Rotate` as one of the four values PDF allows.
 *
 * `rotation.ts`'s `normalizeRotation` is the snapping rule the whole app already
 * uses (thumbnails, N-up, redaction mapping); this only adds the guard for a
 * missing or non-finite `/Rotate`, which `page.rotate` can be for a malformed
 * file and which would otherwise reach the geometry as `NaN`.
 */
export function slideRotation(rotate: number | null | undefined): SlideRotation {
  return Number.isFinite(rotate ?? NaN) ? normalizeRotation(rotate as number) : 0;
}

/**
 * Why a document that would produce a deck with nothing on any slide is refused.
 *
 * The scanned-PDF case reaches this whenever images are switched off, and a
 * document with neither a text layer nor an embedded image reaches it either
 * way. Writing a deck of blank slides is the silent failure; naming both the
 * option and OCR is the useful answer.
 */
export const EMPTY_DECK_MESSAGE =
  'Nothing could be placed on any slide: this PDF has no selectable text and no embedded image ' +
  'that PowerPoint can hold. If it is a scan, run the OCR tool on it first and convert the ' +
  'result; if you switched text or images off, turn them back on.';

/**
 * What this converter does not do, stated before it runs.
 *
 * A `core/` constant the panel renders, on CNV-11's precedent, so the tool's
 * copy and this module cannot state different limitations. Deliberately longer
 * and blunter than its four siblings' lists: this is the widest fidelity gap of
 * the six conversion tools, and the ticket says the beta copy has to say so
 * plainly. Every entry is a real property of the output, not a hedge.
 */
export const PPTX_LIMITATIONS: readonly string[] = [
  'Each line of text becomes its own text box, placed where the page drew it. There are no ' +
    'paragraphs, no bullets, no outline and no title placeholders — a PDF states none of those, ' +
    'so none is invented. This is not a deck you would build slides from; it is the page, ' +
    'approximated.',
  'Text does not reflow. Edit a box and it will not re-wrap with the rest of the slide, because ' +
    'nothing on the slide is connected to anything else on it.',
  'Fonts are not carried across. Every box uses the deck’s own theme font at the size the PDF ' +
    'used, so line widths differ from the original and a long line can overrun its box.',
  'All text is black. A PDF’s text colour is not read, so white-on-dark or coloured type arrives ' +
    'as black type.',
  'Tables, columns, rules, borders, backgrounds and every other vector drawing on the page are ' +
    'not reproduced. Only text and embedded raster images are placed.',
  'An OCR’d scan’s invisible text layer becomes *visible* black text over the page image, ' +
    'because PowerPoint has no invisible text. Switch “Place page text” off for a scan, or ' +
    'switch “Place embedded images” off to keep the text alone.',
  'One slide size for the whole deck — PowerPoint allows no other. It is the first page’s size; ' +
    'pages of any other size are scaled to fit it and centred, keeping their own proportions.',
  'JBIG2 and JPEG 2000 images cannot be embedded in a slide. Each one is named in the preview ' +
    'and left in the PDF rather than re-encoded.',
  'Image transparency is not carried across: a masked image appears fully opaque.',
  'Positioning is approximate, and the approximation is in the *vertical* placement of a line. ' +
    'Where a line starts and how wide it is are measured from the page; how far above its ' +
    'baseline the box has to start is not — a PDF states no ascent, so ordinary Latin text ' +
    'metrics are assumed (0.80 em ascent, 1.20 em line height). A line of Latin text lands ' +
    'within about a point of where the page drew it; a face with unusual metrics, or a script ' +
    'whose glyphs rise higher than Latin ones (CJK, Devanagari), can sit further off. Nothing ' +
    'is shifted by the page’s crop — a cropped or offset page is placed against the box the ' +
    'reader sees, not against raw PDF coordinates. `W n` clip paths are not applied, so an ' +
    'image the page clips with one is placed at its unclipped size.',
  'Text drawn at an angle — a diagonal watermark, a sideways column header — is placed at that ' +
    'angle and at its real type size, but not reproduced exactly: each run of a rotated line ' +
    'becomes its own text box rather than being joined into one, and a slanted or mirrored ' +
    'transform is placed upright inside the same frame. Every page carrying angled text says so ' +
    'in the preview.',
  'Links, annotations, form fields, bookmarks and page labels are not carried into the deck.'
];

/* ------------------------------------------------------------------ *
 * Text extraction (the pure half of the render worker's page pass)
 * ------------------------------------------------------------------ */

/**
 * Below this many degrees off the +x axis a baseline counts as horizontal.
 *
 * A producer emits 11.999998pt type and matrices that round; half a degree is far
 * inside any of that and far outside anything a document means as "at an angle".
 */
const HORIZONTAL_ANGLE_EPSILON = 0.5;

/** The default type size for a line whose transform states none. */
const FALLBACK_TYPE_SIZE = 12;

/**
 * Which way a text run's baseline actually runs, from its own transform.
 *
 * pdf.js hands back `[a, b, c, d, tx, ty]`; `(a, b)` is the baseline's direction
 * and `(c, d)` the glyph's up-vector. Everything downstream of here used to read
 * only `d`, which is what silently flattened rotated text: for a run turned a
 * quarter turn the transform is `[0, s, -s, 0, …]`, so `d` is **zero** — the
 * baseline angle was lost *and* the type size fell back to a default, coming out
 * horizontal at the wrong size with nothing said about it.
 *
 * `mirrored` is the case that must not be turned into a rotation. A negative
 * determinant is a reflection, and rotating a box by `atan2(b, a)` would flip the
 * glyphs the other way as well — so a mirrored run stays on the horizontal path
 * (which is what it has always done) and is *counted*, so the conversion can say
 * it did not reproduce it. An ordinary 180° rotation has a positive determinant
 * and is handled as the rotation it is.
 */
export function textBaselineAngle(transform: readonly number[]): {
  angle: number;
  mirrored: boolean;
} {
  const [a, b, c, d] = transform;
  if (![a, b, c, d].every(value => Number.isFinite(value))) return { angle: 0, mirrored: false };
  const degrees = (Math.atan2(b, a) * 180) / Math.PI;
  if (Math.abs(degrees) < HORIZONTAL_ANGLE_EPSILON) return { angle: 0, mirrored: false };
  if (!(a * d - b * c > 0)) return { angle: 0, mirrored: true };
  return { angle: degrees, mirrored: false };
}

/**
 * A run's type size, in points, whichever way it is turned.
 *
 * The length of the transformed up-vector, which is `|d|` for horizontal text —
 * so this agrees with `layoutLines`'s own `maxSize` on every ordinary page — and
 * still the real size for a run at an angle, where `|d|` alone is not.
 */
export function textTypeSize(transform: readonly number[]): number {
  const size = Math.hypot(transform[2], transform[3]);
  return Number.isFinite(size) ? size : 0;
}

/**
 * Turns one page's runs into positioned lines.
 *
 * Deliberately *not* `pageBlocks`: that merges wrapped lines into a paragraph so
 * Word can reflow them, which is the right answer for a document and the wrong
 * one for a slide — a merged paragraph has no single position. Line grouping is
 * still `layoutLines`, so a line here is the same line the text export writes.
 *
 * Table detection is not run either. A grid on the page is already a grid of
 * positioned boxes on the slide; turning it into a PowerPoint table would move
 * every cell to that table's own layout, which is the opposite of what this tool
 * promises.
 *
 * **Angled runs are separated out before `layoutLines` ever sees them.** That
 * function groups runs into lines by comparing `transform[5]`, i.e. by shared
 * *height on the page* — which is exactly right for horizontal text and
 * meaningless for a sideways column header, whose glyphs share an `x` instead. It
 * is also shared with CNV-04, CNV-05, CNV-08 and CNV-10, so teaching it about
 * rotation here would change four other exports. So the horizontal runs go
 * through it unchanged, and each angled run becomes its own line: pdf.js emits one
 * item per show operation, so a rotated string is normally one item and therefore
 * one box, and the failure this avoids — merging two unrelated angled runs that
 * happen to share a `y` into one line — is worse than the one it accepts, which
 * is a rotated line split across two show operations arriving as two correctly
 * placed boxes. Limitation 11 states it.
 */
export function pageTextLines(
  runs: FormattedTextRun[],
  pageIndex: number,
  box: PageBox,
  rotation: SlideRotation
): PageSlideData {
  const horizontal: FormattedTextRun[] = [];
  const angled: { run: FormattedTextRun; angle: number }[] = [];
  let mirroredLines = 0;
  for (const run of runs) {
    const { angle, mirrored } = textBaselineAngle(run.transform);
    if (mirrored) mirroredLines += 1;
    if (angle === 0) horizontal.push(run);
    else angled.push({ run, angle });
  }

  const { lines } = layoutLines(horizontal);
  const out: PageTextLine[] = [];
  let droppedLines = 0;

  for (const line of lines) {
    if (out.length >= MAX_BOXES_PER_SLIDE) {
      droppedLines += 1;
      continue;
    }
    const built = lineToRuns(line.runs);
    if (built.runs.length === 0) continue;
    const first = line.runs[0];
    const last = line.runs[line.runs.length - 1];
    const right = last.transform[4] + last.width;
    const size = line.maxSize > 0 ? line.maxSize : FALLBACK_TYPE_SIZE;
    out.push({
      runs: built.runs,
      x: first.transform[4],
      baseline: line.baseline,
      // A run's reported `width` is the advance pdf.js measured, so the line's
      // extent is measured rather than estimated from a character count.
      width: Math.max(right - first.transform[4], size * 0.5),
      size,
      angle: 0,
      truncated: built.truncated
    });
  }

  // Angled runs last, so the preview's leading text and the shape order of an
  // ordinary page are exactly what they were before this path existed.
  let rotatedLines = 0;
  for (const { run, angle } of angled) {
    if (out.length >= MAX_BOXES_PER_SLIDE) {
      droppedLines += 1;
      continue;
    }
    const built = lineToRuns([run]);
    if (built.runs.length === 0) continue;
    // The real size, from the transform's up-vector rather than from `d` alone.
    const size = textTypeSize(run.transform) || FALLBACK_TYPE_SIZE;
    rotatedLines += 1;
    out.push({
      runs: built.runs,
      x: run.transform[4],
      baseline: run.transform[5],
      // pdf.js reports `width` as the advance along the run's *own* direction,
      // so it needs no rotating — verified against a 90° and a 45° run.
      width: Math.max(run.width, size * 0.5),
      size,
      angle,
      truncated: built.truncated
    });
  }

  return { pageIndex, box, rotation, lines: out, droppedLines, rotatedLines, mirroredLines };
}

/**
 * One line's runs, merged where adjacent runs share formatting and with the
 * space a producer implied by position reinstated.
 *
 * The rule is `blocks.ts`'s `lineRuns`, and it is applied here rather than
 * imported because that function returns `DocxRun`s and lives in the module that
 * owns the DOCX block model; sharing the *rule* by copying six lines is cheaper
 * than making CNV-08's model a dependency of a tool that does not use it. The
 * behaviour is pinned by a test that asserts both produce the same joined text.
 */
function lineToRuns(runs: readonly FormattedTextRun[]): { runs: SlideRun[]; truncated: number } {
  const out: SlideRun[] = [];
  let previous: FormattedTextRun | null = null;

  for (const run of runs) {
    if (run.str.length === 0) continue;
    const bold = run.bold === true;
    const italic = run.italic === true;
    let separator = '';
    if (previous) {
      const gap = run.transform[4] - (previous.transform[4] + previous.width);
      if (gap > Math.abs(run.transform[3]) * 0.25) separator = ' ';
    }
    const last = out[out.length - 1];
    if (last && last.bold === bold && last.italic === italic) {
      last.text += separator + run.str;
    } else {
      out.push({ text: separator + run.str, bold, italic });
    }
    previous = run;
  }

  const collapsed = out
    .map(run => ({ ...run, text: run.text.replace(/\s+/g, ' ') }))
    .filter(run => run.text.length > 0);
  if (collapsed.length > 0) {
    collapsed[0].text = collapsed[0].text.replace(/^\s+/, '');
    const tail = collapsed[collapsed.length - 1];
    tail.text = tail.text.replace(/\s+$/, '');
  }

  const kept = collapsed.filter(run => run.text.length > 0);
  let budget = MAX_BOX_CHARS;
  let truncated = 0;
  const capped: SlideRun[] = [];
  for (const run of kept) {
    if (budget <= 0) {
      truncated += run.text.length;
      continue;
    }
    if (run.text.length > budget) {
      truncated += run.text.length - budget;
      capped.push({ ...run, text: run.text.slice(0, budget) });
      budget = 0;
      continue;
    }
    capped.push(run);
    budget -= run.text.length;
  }
  return { runs: capped, truncated };
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/** A page's displayed size in points, after `/Rotate`. */
export function displayedSize(page: { box: PageBox; rotation: SlideRotation }): {
  width: number;
  height: number;
} {
  const sideways = page.rotation === 90 || page.rotation === 270;
  return {
    width: sideways ? page.box.height : page.box.width,
    height: sideways ? page.box.width : page.box.height
  };
}

/** Degrees folded into `[0, 360)`, at a resolution well past PowerPoint's own. */
function normalizeDegrees(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  const wrapped = ((degrees % 360) + 360) % 360;
  return Math.round(wrapped * 1000) / 1000;
}

/**
 * A point in unrotated top-left-origin page space, mapped into the *displayed*
 * top-left-origin frame.
 *
 * Derived rather than copied from pdf.js's viewport matrix so it can be checked
 * against corners by hand: `/Rotate 90` displays the page turned a quarter turn
 * clockwise, so the unrotated top-left corner ends up at the displayed top-right.
 */
export function rotatePoint(
  u: number,
  v: number,
  rotation: SlideRotation,
  boxWidth: number,
  boxHeight: number
): { u: number; v: number } {
  switch (rotation) {
    case 90:
      return { u: boxHeight - v, v: u };
    case 180:
      return { u: boxWidth - u, v: boxHeight - v };
    case 270:
      return { u: v, v: boxWidth - u };
    default:
      return { u, v };
  }
}

/**
 * How one page is placed on the deck's single slide size.
 *
 * PowerPoint has exactly one slide size per presentation, so a document with
 * mixed page sizes cannot have per-slide geometry — this is the hard limit that
 * makes "a same-size slide" only true of the size the deck was built at. Pages of
 * a different displayed size are scaled uniformly and centred, which keeps each
 * page's own aspect ratio rather than stretching it, and the difference is
 * reported per page.
 */
export interface PageFit {
  scale: number;
  offsetX: number;
  offsetY: number;
  /** True when this page is not the size the slide was built at. */
  rescaled: boolean;
}

export function fitPageToSlide(
  page: { box: PageBox; rotation: SlideRotation },
  slideWidth: number,
  slideHeight: number
): PageFit {
  const { width, height } = displayedSize(page);
  if (!(width > 0) || !(height > 0)) {
    return { scale: 1, offsetX: 0, offsetY: 0, rescaled: false };
  }
  const scale = Math.min(slideWidth / width, slideHeight / height);
  const rescaled = Math.abs(scale - 1) > 1e-6;
  return {
    scale,
    offsetX: (slideWidth - width * scale) / 2,
    offsetY: (slideHeight - height * scale) / 2,
    rescaled
  };
}

/**
 * A box given by its centre in the displayed frame, plus its own unrotated size,
 * placed through a `PageFit`.
 *
 * The centre is what is mapped, not the corner, because PowerPoint rotates a
 * shape about its own centre. Handing it the unrotated width and height with
 * `rot` set therefore lands the shape exactly where the rotated page draws it —
 * mapping a corner instead would put a rotated box a half-diagonal away.
 */
function placeByCentre(
  centreU: number,
  centreV: number,
  width: number,
  height: number,
  fit: PageFit
): { x: number; y: number; width: number; height: number } {
  const w = width * fit.scale;
  const h = height * fit.scale;
  return {
    x: fit.offsetX + centreU * fit.scale - w / 2,
    y: fit.offsetY + centreV * fit.scale - h / 2,
    width: w,
    height: h
  };
}

/* ------------------------------------------------------------------ *
 * The plan
 * ------------------------------------------------------------------ */

/** One image `Do`, as `pdf/image-placements.ts` reports it. */
export interface ImagePlacementInput {
  pageIndex: number;
  objectNumber: number;
  name: string;
  /**
   * Unrotated **raw** page user space, y up from the bottom-left — the space the
   * content stream's own `cm` operands are in, with no box origin removed. The
   * walk is deliberately left in raw space rather than seeded with a translated
   * initial CTM: the displayed box's origin then has exactly one source (the
   * render worker's own view box, which is also where the width and height come
   * from) and is subtracted in exactly one place, {@link planSlides} below.
   */
  x: number;
  y: number;
  width: number;
  height: number;
  axisAligned: boolean;
}

/** The subset of CNV-06's per-image report this planner reads. */
export interface ExtractedImageInput {
  pageIndex: number;
  objectNumber: number;
  name: string;
  fileName?: string;
  maskFileName?: string;
  status: 'extracted' | 'duplicate' | 'skipped';
  note?: string;
}

export interface SlidePlanOptions {
  includeText: boolean;
  includeImages: boolean;
  /** Placements per page, or null when images were switched off. */
  placements: readonly ImagePlacementInput[] | null;
  /** CNV-06's report, or null when images were switched off. */
  entries: readonly ExtractedImageInput[] | null;
  /** ZIP entry names CNV-06 actually wrote, so a missing file is caught here. */
  archivedFiles: ReadonlySet<string>;
  /** How many placements the per-page cap dropped, by page index. */
  droppedPlacements?: Readonly<Record<number, number>>;
}

/** The two extensions PowerPoint can embed from CNV-06's output. */
function slideImageFormat(fileName: string): SlideImageFormat | null {
  if (/\.png$/i.test(fileName)) return 'png';
  if (/\.jpe?g$/i.test(fileName)) return 'jpg';
  return null;
}

/**
 * Decides the deck: its one slide size, one slide per page, and what goes where.
 *
 * Slide size is the **first** page's displayed size. Not the most common one: the
 * first page is the one a user looking at the deck's dimensions will compare
 * against, and "most common" would silently letterbox page 1 of a document whose
 * cover is a different size from its body.
 */
export function planSlides(pages: readonly PageSlideData[], options: SlidePlanOptions): SlidePlan {
  const notes: string[] = [];

  const first = pages[0];
  const base = first ? displayedSize(first) : { width: 612, height: 792 };
  const slideWidth = Math.min(MAX_SLIDE_POINTS, Math.max(MIN_SLIDE_POINTS, base.width));
  const slideHeight = Math.min(MAX_SLIDE_POINTS, Math.max(MIN_SLIDE_POINTS, base.height));
  if (
    first &&
    (Math.abs(slideWidth - base.width) > 0.5 || Math.abs(slideHeight - base.height) > 0.5)
  ) {
    notes.push(
      `The first page is ${Math.round(base.width)} × ${Math.round(base.height)} pt, which is ` +
        `outside PowerPoint's slide-size limits, so the deck is ` +
        `${Math.round(slideWidth)} × ${Math.round(slideHeight)} pt and every page is scaled to ` +
        'fit it.'
    );
  }

  // Group the image inputs by page once, rather than filtering per page.
  const placementsByPage = new Map<number, ImagePlacementInput[]>();
  for (const placement of options.placements ?? []) {
    const list = placementsByPage.get(placement.pageIndex);
    if (list) list.push(placement);
    else placementsByPage.set(placement.pageIndex, [placement]);
  }
  /** `pageIndex:objectNumber` → CNV-06's entry for that image on that page. */
  const entryByKey = new Map<string, ExtractedImageInput>();
  /** Names of images CNV-06 reported for a page, so an unmatched name is visible. */
  const entriesByPage = new Map<number, ExtractedImageInput[]>();
  for (const entry of options.entries ?? []) {
    entryByKey.set(`${entry.pageIndex}:${entry.objectNumber}`, entry);
    const list = entriesByPage.get(entry.pageIndex);
    if (list) list.push(entry);
    else entriesByPage.set(entry.pageIndex, [entry]);
  }

  const slides: PlannedSlide[] = [];
  const outline: PptxPreviewItem[] = [];
  let rescaledPages = 0;
  let truncatedBoxes = 0;
  let droppedLines = 0;
  let unplaceable = 0;
  let neverDrawn = 0;
  const reportedObjects = new Set<string>();

  for (const page of pages) {
    const human = page.pageIndex + 1;
    const fit = fitPageToSlide(page, slideWidth, slideHeight);
    if (fit.rescaled) rescaledPages += 1;

    const images: SlideImage[] = [];
    const boxes: SlideTextBox[] = [];

    /* --- pictures first, so text lands on top of them ------------------- */
    if (options.includeImages) {
      for (const placement of placementsByPage.get(page.pageIndex) ?? []) {
        const key = `${page.pageIndex}:${placement.objectNumber}`;
        const entry = entryByKey.get(key);
        const reason = imageRefusal(entry, placement, options.archivedFiles);
        if (reason) {
          // Reported once per image object per page, however many times the page
          // draws it: three refusal lines for one logo drawn three times is
          // noise, not disclosure.
          if (!reportedObjects.has(key)) {
            reportedObjects.add(key);
            notes.push(`Page ${human}: ${reason}`);
            unplaceable += 1;
          }
          continue;
        }
        // `imageRefusal` returning null is what proves these are set.
        const fileName = entry?.fileName as string;
        const format = slideImageFormat(fileName) as SlideImageFormat;

        // The placement is y-up from the *raw* origin, so the displayed box's
        // own origin comes off first — a page cropped to [100 100 …] draws its
        // pictures at raw coordinates 100 pt away from where the reader sees
        // them. Then the y flip, then `/Rotate`, on the box's centre.
        const centre = rotatePoint(
          placement.x - page.box.x + placement.width / 2,
          page.box.height - (placement.y - page.box.y + placement.height / 2),
          page.rotation,
          page.box.width,
          page.box.height
        );
        images.push({
          ...placeByCentre(centre.u, centre.v, placement.width, placement.height, fit),
          rotate: page.rotation,
          fileName,
          format,
          altText: `Image from page ${human}`
        });

        if (!placement.axisAligned && !reportedObjects.has(`${key}:skew`)) {
          reportedObjects.add(`${key}:skew`);
          notes.push(
            `Page ${human}: an image is drawn rotated or skewed on the page. PowerPoint places ` +
              'it upright inside the same rectangle, so its orientation is not reproduced.'
          );
        }
        if (entry?.maskFileName && !reportedObjects.has(`${key}:mask`)) {
          reportedObjects.add(`${key}:mask`);
          notes.push(
            `Page ${human}: an image's transparency mask was not carried into PowerPoint, so it ` +
              'appears fully opaque.'
          );
        }
      }

      // An image CNV-06 found in the page's resources that the content stream
      // never paints is not an error — it is an unused resource — but one it
      // *does* paint and this walk missed would be a silent loss, so the two
      // lists are compared rather than assumed to agree.
      //
      // Counted, not one note per page: an unused resource dictionary entry
      // inherited by all 300 pages of a document would otherwise produce 300
      // identical lines, which buries the notes that matter.
      const painted = new Set(
        (placementsByPage.get(page.pageIndex) ?? []).map(p => p.objectNumber)
      );
      for (const entry of entriesByPage.get(page.pageIndex) ?? []) {
        if (painted.has(entry.objectNumber)) continue;
        if (entry.status === 'skipped') continue;
        neverDrawn += 1;
      }

      const dropped = options.droppedPlacements?.[page.pageIndex] ?? 0;
      if (dropped > 0) {
        notes.push(
          `Page ${human}: ${dropped} further image placement(s) were left out — the page draws ` +
            'more pictures than one slide can hold.'
        );
      }
    }

    /* --- then the text boxes -------------------------------------------- */
    if (options.includeText) {
      droppedLines += page.droppedLines;
      // The exact count `lineToRuns` measured, not a length check against the
      // cap: a line that happens to be exactly MAX_BOX_CHARS long had nothing
      // removed from it and must not be reported as shortened.
      truncatedBoxes += page.lines.filter(line => line.truncated > 0).length;

      if (page.rotatedLines > 0) {
        notes.push(
          `Page ${human}: ${page.rotatedLines} line(s) of text are drawn at an angle. Each is ` +
            'placed at that angle and at its real type size, but a rotated line is not joined ' +
            'into one box and a slant is not reproduced.'
        );
      }
      if (page.mirroredLines > 0) {
        notes.push(
          `Page ${human}: ${page.mirroredLines} run(s) of text are drawn mirrored. PowerPoint ` +
            'places them upright inside the same frame, so their orientation is not reproduced.'
        );
      }

      for (const line of page.lines) {
        const height = line.size * LINE_HEIGHT_EM;
        // Baseline origin, in the displayed box's own frame, still y-up.
        const originU = line.x - page.box.x;
        const originV = line.baseline - page.box.y;
        // The box's centre relative to that origin: half the line's advance
        // along the baseline, plus the distance from the baseline up to the
        // box's middle. The top edge is ASCENT_EM above the baseline and the box
        // is LINE_HEIGHT_EM tall, so its centre is (0.80 − 0.60) em above it.
        // For an unrotated line this is exactly the old `mediaHeight −
        // (baseline + size × ASCENT_EM)` top edge plus half the height.
        const theta = (line.angle * Math.PI) / 180;
        const along = line.width / 2;
        const above = line.size * (ASCENT_EM - LINE_HEIGHT_EM / 2);
        const centreU = originU + Math.cos(theta) * along - Math.sin(theta) * above;
        const centreV = originV + Math.sin(theta) * along + Math.cos(theta) * above;
        const centre = rotatePoint(
          centreU,
          page.box.height - centreV,
          page.rotation,
          page.box.width,
          page.box.height
        );
        boxes.push({
          ...placeByCentre(centre.u, centre.v, line.width, height, fit),
          fontSize: line.size * fit.scale,
          runs: line.runs,
          // The page's own quarter turns are clockwise in the displayed frame;
          // the line's baseline angle is counter-clockwise in PDF space, so it
          // subtracts. A 90°-CCW run on an upright page is a 270° shape.
          rotate: normalizeDegrees(page.rotation - line.angle)
        });
      }
    }

    slides.push({ pageIndex: page.pageIndex, images, boxes });
    outline.push({
      pageIndex: page.pageIndex,
      slideNumber: slides.length,
      textBoxCount: boxes.length,
      imageCount: images.length,
      text: elide(
        boxes
          .slice(0, 4)
          .map(box => box.runs.map(run => run.text).join(''))
          .join(' ')
          .trim()
      )
    });
  }

  if (rescaledPages > 0) {
    notes.push(
      `${rescaledPages} page(s) are not the same size as the first page. PowerPoint allows one ` +
        'slide size per deck, so those pages are scaled to fit it and centred, keeping their ' +
        'own proportions.'
    );
  }
  if (droppedLines > 0) {
    notes.push(
      `${droppedLines} line(s) of text were left out: some page has more lines than the ` +
        `${MAX_BOXES_PER_SLIDE}-text-box limit one slide carries.`
    );
  }
  if (truncatedBoxes > 0) {
    notes.push(
      `${truncatedBoxes} text box(es) were shortened to ${MAX_BOX_CHARS} characters. A whole ` +
        'page drawn on one text baseline cannot be one editable line.'
    );
  }
  if (unplaceable > 0) {
    notes.push(
      `${unplaceable} image(s) could not be placed; each is listed above with its reason. They ` +
        'are still in the PDF.'
    );
  }
  if (neverDrawn > 0) {
    notes.push(
      `${neverDrawn} image(s) are in a page's resources but are never drawn by that page, so ` +
        'they were left out. Nothing visible on any page is missing.'
    );
  }

  return { slideWidth, slideHeight, slides, outline, notes };
}

/**
 * Why this placement cannot become a picture, or `null` when it can.
 *
 * Every branch is a real case CNV-06 produces, and the reason is CNV-06's own
 * wherever it gave one — a JBIG2 image the extractor refused must not be
 * reported here as merely "missing".
 */
function imageRefusal(
  entry: ExtractedImageInput | undefined,
  placement: ImagePlacementInput,
  archivedFiles: ReadonlySet<string>
): string | null {
  if (placement.objectNumber < 0) {
    return (
      `the image named /${placement.name} is stored directly in the page rather than as a ` +
      'numbered object, so its bytes could not be matched to the drawing. It was left out.'
    );
  }
  if (!entry) {
    return (
      `the image named /${placement.name} is drawn by the page but was not found in its ` +
      'resources, so it was left out.'
    );
  }
  if (entry.status === 'skipped' || !entry.fileName) {
    return entry.note ?? 'an image could not be read and was left out.';
  }
  if (!slideImageFormat(entry.fileName)) {
    const ext = entry.fileName.replace(/^.*\./, '');
    return (
      `an image in ${ext} format cannot be embedded in a PowerPoint slide. It was left out; ` +
      'the PDF still has it.'
    );
  }
  if (!archivedFiles.has(entry.fileName)) {
    return 'an image could not be read out of its archive and was left out.';
  }
  return null;
}

/** True when the plan would produce a deck with nothing on any slide. */
export function isEmptyPlan(plan: SlidePlan): boolean {
  return plan.slides.every(slide => slide.boxes.length === 0 && slide.images.length === 0);
}

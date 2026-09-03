/**
 * CNV-13 — a `.pptx` → the generalized PDF block model, one canvas per slide.
 *
 * The last of the six conversion tools, and the only one whose source document
 * states *where* its content goes. A `.docx` and an `.xlsx` describe a sequence
 * — paragraphs, then more paragraphs; rows, then more rows — so CNV-09 and
 * CNV-11 hand the layout engine a flow and let it paginate. A deck describes an
 * arrangement: two shapes sit side by side, a caption sits under a picture, and
 * the reading order the XML happens to use is not the order a reader sees. Flow
 * that down an A4 page and what comes out is a different document, not a
 * lower-fidelity copy of this one.
 *
 * So this module produces `canvas` blocks — the block kind CNV-13 added to
 * `html-to-pdf-blocks.ts` for exactly this: one page of producer-positioned
 * content, drawn on a page of its own. "One PDF page per slide" is then a
 * property of the model rather than a hope about how much text fits.
 *
 * **No geometry happens here beyond one unit conversion.** OOXML measures in
 * EMU from the slide's top-left with y increasing downward; this module divides
 * by {@link EMU_PER_POINT} and hands the engine points in the same top-left
 * frame. The y flip, the fit-to-page scale and the centring all happen once, in
 * `pdf-block-layout.ts`'s `drawCanvas`. That split is deliberate: CNV-12's audit
 * found a real displacement bug in the *opposite* direction's geometry, and the
 * lesson taken from it was that page-frame arithmetic belongs in one function
 * that one test can pin against the produced file.
 *
 * **Reading is `pptx-reader.ts`'s job**, not this file's. That reader was
 * written for CNV-12 and shipped unused so this ticket could consume it; what
 * this ticket added to it is listed in its own module comment (group
 * transforms, tables, run properties, media bytes), all of which are facts
 * about the file format rather than about this conversion.
 *
 * **What is not carried across** is {@link PPT_LIMITATIONS}, which the panel
 * renders verbatim *before* the conversion runs. The ticket names three of them
 * outright — transitions, animations and speaker notes — and requires that they
 * be stated rather than silently dropped.
 *
 * ## What the second review pass changed here
 *
 * An audit found three ways this file's own disclosures were weaker than the
 * panel copy above claimed, all of the "left out with nothing said" class:
 *
 *  • A **chart or SmartArt** contributed nothing and produced no note, while the
 *    panel said such frames "contribute their text only". The reader now reads
 *    their text out of their own parts and every frame gets {@link
 *    graphicFrameNote}, per slide; the panel copy states what is really true.
 *  • `SlideSummary.empty` was **computed and read by nothing** except the
 *    all-or-nothing refusal, so a deck with three blank slides among four
 *    previewed as if every page had content. It is now named per slide
 *    ({@link BLANK_SLIDE_LABEL}) and by number ({@link blankSlidesNote}).
 *  • The all-blank refusal **discarded an accurate diagnosis it had already
 *    made** — a missing media part, an EMF, a chart with no readable text — and
 *    blamed layout inheritance instead. See {@link blankDeckMessage}.
 */

import { unsupported } from '../errors';
import { checkpoint, subJob, type JobHandle } from '../workers/protocol';
import {
  readPptx,
  type PptxDeck,
  type PptxGraphicKind,
  type PptxParagraph,
  type PptxShape,
  type PptxSlide
} from './pptx-reader';
import type { CanvasItem, LayoutBlock, PdfImageFormat, StyledRun } from './html-to-pdf-blocks';

/** English Metric Units per PostScript point. 914400 per inch, 72 points per inch. */
export const EMU_PER_POINT = 12700;

/** EMU → points. The only unit conversion in this file. */
export function toPoints(emu: number): number {
  return Number.isFinite(emu) ? emu / EMU_PER_POINT : 0;
}

/* ------------------------------------------------------------------ *
 * Defaults and caps, each with a reason
 * ------------------------------------------------------------------ */

/**
 * The size a run is drawn at when it states none.
 *
 * A `<a:rPr sz>` is optional, and a run without one inherits from the list style
 * of the placeholder it sits in — which lives in the slide *layout* and the
 * *master*, neither of which this reader resolves. 18pt is PowerPoint's own
 * default body size, so it is the least wrong constant available; what it is
 * not is the real size of a 44pt title, and every run it is applied to is
 * counted and reported rather than quietly rendered small.
 */
export const DEFAULT_FONT_POINTS = 18;

/** Table cell text, which PowerPoint defaults smaller than body text. */
export const DEFAULT_TABLE_FONT_POINTS = 12;

/**
 * The slide size assumed when the deck states none, in points.
 *
 * `<p:sldSz>` is required by the format, so a deck without one is damaged or
 * hand-assembled — but its *shapes* still carry real EMU coordinates, and
 * throwing the deck away over a missing pair of attributes would lose content
 * that is perfectly readable. 10 × 7.5 inches is PowerPoint's own pre-2013
 * default, so it is the least invented constant available. It is reported.
 */
export const DEFAULT_SLIDE_POINTS = { width: 720, height: 540 } as const;

/**
 * How many slides this converter will draw.
 *
 * One slide is one PDF page, so this is also a page cap. A deck past this size
 * is a generated artefact rather than a presentation, and laying out thousands
 * of positioned pages exhausts memory long before it finishes. What is left out
 * is counted and named, never silently truncated.
 */
export const MAX_SLIDES = 500;

/**
 * How many positioned items one slide may carry.
 *
 * The same cap and the same reason as CNV-12's `MAX_BOXES_PER_SLIDE` in the
 * opposite direction: past a few hundred shapes the page has stopped being a
 * slide, and each one is a separate draw. Overflow is reported per slide.
 */
export const MAX_ITEMS_PER_SLIDE = 400;

/** Indent applied per `<a:pPr lvl>`, in points — PowerPoint's own 0.25 inch. */
const INDENT_PER_LEVEL = 18;

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

export const PPTX_EMPTY_DECK_MESSAGE =
  'Nothing in this presentation could be drawn onto a page: every slide came back with no text, ' +
  'no picture and no table. That usually means its text lives in placeholders inherited from a ' +
  'slide layout or master, which this converter does not read. Nothing was written, and your ' +
  '.pptx is untouched.';

/**
 * The same refusal, when the converter already knows a *better* reason.
 *
 * {@link PPTX_EMPTY_DECK_MESSAGE} names the most common cause — text that lives
 * only in a layout — as a guess, which is right for a deck of inherited
 * placeholders and **wrong** for a deck whose one picture is missing from the
 * package or is an EMF this build cannot decode. Both of those were already
 * diagnosed and written into a note by the time the refusal fired, and the
 * generic message threw that diagnosis away: the user was told to look at their
 * slide master because of an image problem this code had already identified.
 * So the specific reasons win, and the layout guess is what is left when there
 * are none.
 */
export function blankDeckMessage(reasons: readonly string[]): string {
  if (reasons.length === 0) return PPTX_EMPTY_DECK_MESSAGE;
  return (
    'Nothing in this presentation could be drawn onto a page, and the reason is not that its ' +
    `text lives in a slide layout: ${reasons.join(' ')} Nothing was written, and your .pptx is ` +
    'untouched.'
  );
}

/**
 * Every limitation, in one place, rendered by the panel before the conversion
 * runs.
 *
 * It is a `core/` constant for the same reason CNV-11's and CNV-12's are: the
 * panel and the converter cannot then state different ones. The first entry is
 * the ticket's own requirement — transitions, animations and speaker notes are
 * out of scope, and out of scope has to be *said*, not left to be discovered.
 */
export const PPT_LIMITATIONS: readonly string[] = [
  'Transitions, animations and speaker notes are not reproduced. They are out of scope for ' +
    'this converter, not dropped by accident — a PDF page has no notion of any of them.',
  'Slide layouts and masters are not read. Text typed into a placeholder is converted; a title ' +
    'or footer that only the layout supplies is not, and a slide made entirely of those comes ' +
    'out blank. A placeholder that also takes its *box* from the layout is drawn from its ' +
    'corner across the rest of the slide, so its text is all present but wraps differently.',
  'Fonts are substituted. Everything is drawn in Helvetica at the size the deck stated, so line ' +
    'widths differ from PowerPoint’s and a line can overrun the box it was measured for.',
  'A run that states no size is drawn at ' +
    `${DEFAULT_FONT_POINTS}pt, PowerPoint’s default body size. The real size would come from ` +
    'the layout’s list style, which is not read.',
  'All text is black. Run colours, highlights and theme colours are not read, so white text on ' +
    'a dark shape arrives as black text.',
  'Shape fills, outlines, shadows and slide backgrounds are not drawn — only text, pictures and ' +
    'table grids. A coloured banner behind a title is absent.',
  'Rotated and flipped shapes are drawn upright and unflipped, at their stated position and ' +
    'size. A flipped *group* also mirrors where its children sit, and that part is honoured — ' +
    'they are drawn at their mirrored positions. A rotated group is not: its children are drawn ' +
    'where the group’s unrotated rectangle puts them, which can be well away from where ' +
    'PowerPoint shows them. Every one of these is counted and reported with the conversion.',
  'Charts and SmartArt are not drawn. The text in their own parts — a chart’s title, series ' +
    'names and category labels; a diagram’s node text — is read and drawn as plain text where ' +
    'the frame sits, with no axes, bars, connectors or layout. An embedded object (a spreadsheet, ' +
    'an equation) contributes nothing at all. Each frame is named, per slide, in the ' +
    'conversion’s own report.',
  'Numbered bullets lose their numbers (PowerPoint stores the numbering scheme, not the ' +
    'numbers). Literal bullet characters are kept.',
  'Video, audio, hyperlinks, comments and slide numbers that come from a placeholder are not ' +
    'carried across.'
];

/* ------------------------------------------------------------------ *
 * Notes
 * ------------------------------------------------------------------ */

export function slideCapNote(total: number): string {
  return (
    `This presentation has ${total} slides and the first ${MAX_SLIDES} were converted. Slides ` +
    `${MAX_SLIDES + 1}–${total} are not in the PDF.`
  );
}

export function slideSizeNote(): string {
  return (
    'This presentation does not state a slide size, so the pages are ' +
    `${DEFAULT_SLIDE_POINTS.width / 72} × ${DEFAULT_SLIDE_POINTS.height / 72} inches — ` +
    'PowerPoint’s own default. Everything on each slide is drawn at the position the file ' +
    'states for it, so a shape outside that rectangle will be off the page.'
  );
}

export function itemCapNote(slideNumber: number, dropped: number): string {
  return (
    `Slide ${slideNumber} has more than ${MAX_ITEMS_PER_SLIDE} shapes; ${dropped} of them ` +
    `${dropped === 1 ? 'is' : 'are'} not in the PDF.`
  );
}

export function defaultSizeNote(count: number): string {
  return (
    `${count} text run${count === 1 ? '' : 's'} state no font size, so ${count === 1 ? 'it was' : 'they were'} ` +
    `drawn at ${DEFAULT_FONT_POINTS}pt. The real size lives in a slide layout, which is not read.`
  );
}

export function unpositionedNote(count: number): string {
  return (
    `${count} shape${count === 1 ? '' : 's'} state no size of ${count === 1 ? 'its' : 'their'} ` +
    'own — their box comes from the slide layout, which is not read — so they were drawn from ' +
    'their stated corner across the rest of the slide. Their text is all present; its wrapping ' +
    'and its position are approximate.'
  );
}

export function rotatedNote(count: number): string {
  return (
    `${count} shape${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} rotated or flipped in ` +
    'the deck and were drawn upright at the same position and size.'
  );
}

/**
 * Shapes inside a *rotated group*, whose positions are wrong rather than
 * approximate.
 *
 * A group's rotation turns its children about the group's own centre, and this
 * converter draws them where the unrotated rectangle puts them — so unlike a
 * shape's own rotation, which only costs the shape's orientation, this costs
 * its *place on the page*. That is worth its own sentence rather than being
 * folded into {@link rotatedNote}'s "at the same position and size", which
 * would be false for these.
 */
export function rotatedGroupNote(count: number): string {
  return (
    `${count} shape${count === 1 ? '' : 's'} sit${count === 1 ? 's' : ''} inside a rotated group. ` +
    'The group’s rotation was not applied, so ' +
    `${count === 1 ? 'it is' : 'they are'} drawn where the group’s unrotated rectangle puts ` +
    `${count === 1 ? 'it' : 'them'} — which can be well away from where PowerPoint shows ` +
    `${count === 1 ? 'it' : 'them'}.`
  );
}

/** What to call a graphic frame in a note the user reads. */
const GRAPHIC_NAMES: Record<PptxGraphicKind, string> = {
  chart: 'a chart',
  diagram: 'a SmartArt diagram',
  ole: 'an embedded object',
  unknown: 'an embedded graphic'
};

/** One chart, diagram or embedded object, and what became of its content. */
export interface GraphicFrameReport {
  slideNumber: number;
  kind: PptxGraphicKind;
  /** How many strings were read out of the frame's own part and drawn. */
  extracted: number;
  /** How many the reader's cap left out. */
  dropped: number;
}

/**
 * A note per graphic frame, naming the slide it was on.
 *
 * Per frame rather than aggregated, because "a chart was left out" is only
 * actionable if the user knows which page to look at. This is the note CNV-13
 * shipped without: a chart contributed nothing and `notes` stayed empty, so the
 * preview said the slide's content was fully captured when none of it was.
 */
export function graphicFrameNote(report: GraphicFrameReport): string {
  const name = GRAPHIC_NAMES[report.kind];
  const head = `Slide ${report.slideNumber} holds ${name}, which is not drawn`;
  if (report.extracted === 0) {
    return (
      `${head}: no shape, axis or connector of it is in the PDF, and no text could be read out ` +
      'of its own part either, so nothing on the page stands for it.'
    );
  }
  const dropped =
    report.dropped > 0
      ? ` ${report.dropped} further label${report.dropped === 1 ? '' : 's'} ` +
        `${report.dropped === 1 ? 'was' : 'were'} left out.`
      : '';
  return (
    `${head}. Its text (${report.extracted} label${report.extracted === 1 ? '' : 's'}: title, ` +
    'series and category names) was drawn as plain text where the frame sits, with no axes, ' +
    `bars or connectors.${dropped}`
  );
}

/** A table drawn as an empty grid, which is a page that looks like a mistake. */
export function emptyTableNote(slideNumber: number): string {
  return (
    `Slide ${slideNumber} holds a table whose cells are all empty. The grid was drawn, but it ` +
    'carries no text — PowerPoint may be filling it from a layout, which this converter does ' +
    'not read.'
  );
}

/**
 * What the panel puts on a blank slide's own preview row.
 *
 * A `core/` constant for the same reason {@link PPT_LIMITATIONS} is: the panel
 * and the converter cannot then describe the same page differently.
 */
export const BLANK_SLIDE_LABEL =
  'appears blank — nothing could be drawn for it (its content may be inherited from a slide ' +
  'layout, which this converter does not read)';

/**
 * The slides that will be blank pages, named.
 *
 * The all-blank case is refused outright, but a deck where *some* slides inherit
 * everything from a layout is more common in an authored deck than one where
 * every slide does — and it was previously invisible: `SlideSummary.empty` was
 * computed and then read by nothing, so the mandatory preview showed a row with
 * a page number and no hint that the page would come out empty. This note and
 * {@link BLANK_SLIDE_LABEL} are the two halves of fixing that: the count in the
 * "left out" list, and the marker on the row itself.
 */
export function blankSlidesNote(slideNumbers: readonly number[]): string {
  const list = slideNumbers.join(', ').replace(/, (\d+)$/, ' and $1');
  const one = slideNumbers.length === 1;
  return (
    `Slide${one ? '' : 's'} ${list} ${one ? 'will be a blank page' : 'will be blank pages'}: ` +
    `nothing on ${one ? 'it' : 'them'} could be drawn. A slide whose text lives only in a ` +
    'placeholder inherited from a slide layout or master comes out empty, because layouts and ' +
    'masters are not read.'
  );
}

export function unsupportedImageNote(formats: readonly string[]): string {
  return (
    `${formats.length} picture${formats.length === 1 ? '' : 's'} ` +
    `(${[...new Set(formats)].join(', ')}) ${formats.length === 1 ? 'was' : 'were'} left out: a ` +
    'PDF can embed PNG and JPEG directly, and re-encoding anything else would mean decoding a ' +
    'format this build carries no decoder for.'
  );
}

export function missingImageNote(count: number): string {
  return (
    `${count} picture${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} referenced by a ` +
    'slide but not present in the package, so nothing was drawn for ' +
    `${count === 1 ? 'it' : 'them'}.`
  );
}

export function autoNumberedNote(count: number): string {
  return (
    `${count} numbered bullet${count === 1 ? '' : 's'} lost ` +
    `${count === 1 ? 'its number' : 'their numbers'}: PowerPoint stores the numbering scheme ` +
    'rather than the numbers, and computing them would mean guessing where each list restarts.'
  );
}

/* ------------------------------------------------------------------ *
 * What the panel shows per slide
 * ------------------------------------------------------------------ */

export interface SlideSummary {
  /** 1-based, in the deck's own `<p:sldIdLst>` order. */
  number: number;
  textBoxes: number;
  images: number;
  tables: number;
  /**
   * True when this slide's page will carry nothing a reader can read.
   *
   * "Nothing drawn" *and* the one case where something is drawn but says
   * nothing: a table whose every cell is empty. Rendered on the slide's own row
   * in the preview ({@link BLANK_SLIDE_LABEL}) and listed by number in the
   * notes ({@link blankSlidesNote}) — a page that will come out blank has to be
   * visible in the preview that gates the save, not only in the all-or-nothing
   * refusal.
   */
  empty: boolean;
}

export interface PptxBlocksResult {
  blocks: LayoutBlock[];
  notes: string[];
  slides: SlideSummary[];
  /** The deck's slide size in points, so the caller can size the PDF page. */
  slideWidth: number;
  slideHeight: number;
  /** `dc:title` from the deck's core properties, when it set one. */
  title?: string;
}

/* ------------------------------------------------------------------ *
 * Paragraphs → runs
 * ------------------------------------------------------------------ */

/** The two raster formats pdf-lib can embed, by media part extension. */
export function imageFormatOf(part: string): PdfImageFormat | null {
  if (/\.png$/i.test(part)) return 'png';
  if (/\.jpe?g$/i.test(part)) return 'jpg';
  return null;
}

/** What to call a media part this converter cannot embed, for the note. */
function describeFormat(part: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(part);
  return match ? match[1].toUpperCase() : 'unknown format';
}

/** A counter bag threaded through the walk, so every note can state a number. */
interface Tally {
  defaultSized: number;
  rotated: number;
  /** Shapes whose *position* is wrong because an enclosing group is rotated. */
  rotatedGroup: number;
  autoNumbered: number;
  unpositioned: number;
  unsupportedImages: string[];
  missingImages: number;
  /** One entry per chart, diagram or embedded object, in slide order. */
  graphics: GraphicFrameReport[];
  /** Slide numbers holding a table with nothing in any cell. */
  emptyTables: number[];
}

/**
 * One paragraph → styled runs, with its bullet character prefixed.
 *
 * The bullet is prefixed as *text* rather than drawn as a marker because a
 * canvas text item is one box: PowerPoint's own hanging indent would need the
 * marker outside the box, and a marker drawn outside a box that may itself be
 * mis-sized is worse than one inside it. `•` is representable in WinAnsi, so
 * nothing is substituted for the common case.
 */
function paragraphRuns(paragraph: PptxParagraph, tally: Tally): StyledRun[] {
  const runs: StyledRun[] = [];
  const text = paragraph.runs.map(run => run.text).join('');
  if (text.trim().length === 0) return runs;

  if (paragraph.bullet) {
    runs.push({ text: `${paragraph.bullet} `, bold: false, italic: false });
  } else if (paragraph.autoNumbered) {
    tally.autoNumbered += 1;
  }
  for (const run of paragraph.runs) {
    if (run.sizePt === undefined && run.text.trim().length > 0) tally.defaultSized += 1;
    runs.push({ text: run.text, bold: run.bold, italic: run.italic });
  }
  return runs;
}

/** The size to draw a shape's text at: the largest size any of its runs states. */
function shapeFontPoints(paragraphs: readonly PptxParagraph[], fallback: number): number {
  let largest = 0;
  for (const paragraph of paragraphs) {
    for (const run of paragraph.runs) {
      if (run.sizePt !== undefined && run.sizePt > largest) largest = run.sizePt;
    }
  }
  return largest > 0 ? largest : fallback;
}

/**
 * Paragraphs → one text item's runs, joined by hard breaks.
 *
 * `\n` is what the layout engine's own wrapper treats as a forced break, so a
 * shape's paragraphs stay separate lines inside one box instead of becoming one
 * run-on paragraph — which is what a slide's bullet list would otherwise turn
 * into.
 */
function bodyRuns(paragraphs: readonly PptxParagraph[], tally: Tally): StyledRun[] {
  const out: StyledRun[] = [];
  for (const paragraph of paragraphs) {
    const runs = paragraphRuns(paragraph, tally);
    if (runs.length === 0) continue;
    if (out.length > 0) out.push({ text: '\n', bold: false, italic: false });
    out.push(...runs);
  }
  return out;
}

/** The deepest indent level any of a shape's paragraphs asks for, in points. */
function indentPoints(paragraphs: readonly PptxParagraph[]): number {
  let level = 0;
  for (const paragraph of paragraphs) {
    if (paragraph.runs.length > 0) level = Math.max(level, paragraph.level);
  }
  return Math.min(level, 8) * INDENT_PER_LEVEL;
}

/**
 * The alignment to draw a shape's text with: the first paragraph's.
 *
 * A shape whose paragraphs disagree gets the first one's, because a canvas text
 * item is one box with one alignment. Splitting it into a box per paragraph
 * would need per-paragraph geometry the file does not state.
 */
function alignmentOf(paragraphs: readonly PptxParagraph[]): 'left' | 'center' | 'right' {
  const first = paragraphs.find(paragraph => paragraph.runs.length > 0);
  if (!first) return 'left';
  // `justify` has no counterpart in the engine's greedy wrap, and stretching a
  // line to both margins is a layout decision rather than a fidelity one.
  return first.align === 'center' || first.align === 'right' ? first.align : 'left';
}

/* ------------------------------------------------------------------ *
 * Shapes → canvas items
 * ------------------------------------------------------------------ */

/** The slide's own extent in points, so an unstated shape size has a bound. */
interface SlideBox {
  width: number;
  height: number;
}

/**
 * The width to draw a shape's text in, when the shape does not state one.
 *
 * A placeholder that inherits its geometry from the slide layout carries **no**
 * `<a:xfrm>` at all, which is ordinary in a deck a person authored and is the
 * single most likely shape to hold the slide's title. Reading that as a box of
 * zero width would wrap its text to one character per line — a page that is
 * technically not missing any text and is unreadable, which is the worst of both
 * outcomes. So an unstated extent becomes "the rest of the slide from here", and
 * every shape it happens to is counted and reported.
 */
function extentFallback(stated: number, from: number, limit: number): number {
  return stated > 0 ? stated : Math.max(1, limit - from);
}

function textItem(shape: PptxShape, slide: SlideBox, tally: Tally): CanvasItem | null {
  const paragraphs = shape.paragraphs ?? [];
  const runs = bodyRuns(paragraphs, tally);
  if (runs.length === 0) return null;

  const indent = indentPoints(paragraphs);
  const x = toPoints(shape.x);
  const y = toPoints(shape.y);
  if (!(toPoints(shape.cx) > 0) || !(toPoints(shape.cy) > 0)) tally.unpositioned += 1;
  return {
    kind: 'text',
    x: x + indent,
    y,
    width: Math.max(1, extentFallback(toPoints(shape.cx), x, slide.width) - indent),
    height: extentFallback(toPoints(shape.cy), y, slide.height),
    runs,
    fontSize: shapeFontPoints(paragraphs, DEFAULT_FONT_POINTS),
    align: alignmentOf(paragraphs)
  };
}

function tableItem(shape: PptxShape, slide: SlideBox, tally: Tally): CanvasItem | null {
  const table = shape.table;
  if (!table || table.rows.length === 0) return null;
  const rows = table.rows.map(row =>
    row.map(cell => (cell.merged ? [] : bodyRuns(cell.paragraphs, tally)))
  );
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (columnCount === 0) return null;

  const x = toPoints(shape.x);
  const y = toPoints(shape.y);
  if (!(toPoints(shape.cx) > 0)) tally.unpositioned += 1;
  return {
    kind: 'table',
    x,
    y,
    width: extentFallback(toPoints(shape.cx), x, slide.width),
    height: extentFallback(toPoints(shape.cy), y, slide.height),
    // Relative weights; the layout engine normalises them to the frame's width,
    // so a grid whose stored widths do not add up to the frame still fills it.
    columnWidths: table.columnWidths.map(width => toPoints(width)),
    rowHeights: table.rowHeights.map(height => toPoints(height)),
    // Short rows are padded so the grid is rectangular — the engine steps x by
    // one width per column, and a ragged row would draw its cells in the wrong
    // ones.
    rows: rows.map(row => Array.from({ length: columnCount }, (_, index) => row[index] ?? [])),
    fontSize: DEFAULT_TABLE_FONT_POINTS
  };
}

function pictureItem(shape: PptxShape, slide: PptxSlide, tally: Tally): CanvasItem | null {
  const media = slide.media.find(entry => entry.relationshipId === shape.relationshipId);
  if (!media || !media.bytes || media.bytes.length === 0) {
    tally.missingImages += 1;
    return null;
  }
  const format = imageFormatOf(media.part);
  if (!format) {
    tally.unsupportedImages.push(describeFormat(media.part));
    return null;
  }
  return {
    kind: 'image',
    x: toPoints(shape.x),
    y: toPoints(shape.y),
    width: toPoints(shape.cx),
    height: toPoints(shape.cy),
    data: media.bytes,
    format,
    // The package part name: the same string for every slide that references
    // the same picture, which is what lets the layout engine embed a logo used
    // on forty slides exactly once.
    id: media.part,
    altText: `Picture from slide ${slide.slideNumber}`
  };
}

/** One slide's shapes → the canvas items that will be drawn, in painting order. */
function slideItems(
  slide: PptxSlide,
  box: SlideBox,
  tally: Tally
): {
  items: CanvasItem[];
  dropped: number;
  counts: Omit<SlideSummary, 'number' | 'empty'>;
  /** True when at least one item carries something a reader can read. */
  content: boolean;
} {
  const items: CanvasItem[] = [];
  const counts = { textBoxes: 0, images: 0, tables: 0 };
  let dropped = 0;
  let content = false;

  for (const shape of slide.shapes) {
    if (items.length >= MAX_ITEMS_PER_SLIDE) {
      dropped += 1;
      continue;
    }
    if (shape.rot !== 0 || shape.flipH || shape.flipV) tally.rotated += 1;
    // Counted separately from the line above, which it usually also trips: a
    // rotated group costs its children their *position*, not just their
    // orientation, so `rotatedNote`'s "at the same position and size" is not
    // true for them and they need their own sentence.
    if (shape.groupRotated) tally.rotatedGroup += 1;
    // Every chart, diagram and embedded object is recorded whether or not any
    // text came out of its part, because the note is the only thing standing
    // for the drawing that is not reproduced.
    if (shape.kind === 'graphic') {
      const extracted = (shape.paragraphs ?? []).filter(
        paragraph => paragraph.runs.length > 0
      ).length;
      tally.graphics.push({
        slideNumber: slide.slideNumber,
        kind: shape.graphicKind ?? 'unknown',
        extracted,
        dropped: shape.graphicTextDropped ?? 0
      });
    }

    const item =
      shape.kind === 'picture'
        ? pictureItem(shape, slide, tally)
        : shape.kind === 'table'
          ? tableItem(shape, box, tally)
          : textItem(shape, box, tally);
    if (!item) continue;

    items.push(item);
    if (item.kind === 'image') counts.images += 1;
    else if (item.kind === 'table') counts.tables += 1;
    else counts.textBoxes += 1;

    // A table of entirely empty cells is *drawn* — the grid is real — but it
    // says nothing, so it must not make a slide look non-blank to the preview.
    // Everything else that produced an item produced either text or a picture.
    if (item.kind === 'table') {
      if (item.rows.some(row => row.some(cell => cell.length > 0))) content = true;
      else tally.emptyTables.push(slide.slideNumber);
    } else {
      content = true;
    }
  }

  return { items, dropped, counts, content };
}

/* ------------------------------------------------------------------ *
 * The deck
 * ------------------------------------------------------------------ */

/** How much of a slide's text the preview row shows before eliding it. */
const PREVIEW_TEXT_LIMIT = 200;

/**
 * Turns an already-read deck into blocks.
 *
 * Separate from {@link readPptxAsBlocks} so the mapping can be unit-tested
 * against a deck built in memory, without a ZIP.
 */
export function deckToBlocks(deck: PptxDeck): PptxBlocksResult {
  const notes: string[] = [];
  const blocks: LayoutBlock[] = [];
  const summaries: SlideSummary[] = [];
  const tally: Tally = {
    defaultSized: 0,
    rotated: 0,
    rotatedGroup: 0,
    autoNumbered: 0,
    unpositioned: 0,
    unsupportedImages: [],
    missingImages: 0,
    graphics: [],
    emptyTables: []
  };

  const slides = deck.slides.slice(0, MAX_SLIDES);
  if (deck.slides.length > slides.length) notes.push(slideCapNote(deck.slides.length));

  // A deck with no `<p:sldSz>` still has shapes with real coordinates, so it
  // gets a default canvas rather than a page with nothing on it.
  const stated = { width: toPoints(deck.slideWidth), height: toPoints(deck.slideHeight) };
  const sized = stated.width > 0 && stated.height > 0;
  if (!sized) notes.push(slideSizeNote());
  const slideWidth = sized ? stated.width : DEFAULT_SLIDE_POINTS.width;
  const slideHeight = sized ? stated.height : DEFAULT_SLIDE_POINTS.height;

  for (const slide of slides) {
    const { items, dropped, counts, content } = slideItems(
      slide,
      { width: slideWidth, height: slideHeight },
      tally
    );
    if (dropped > 0) notes.push(itemCapNote(slide.slideNumber, dropped));

    blocks.push({
      kind: 'canvas',
      width: slideWidth,
      height: slideHeight,
      items,
      label: `Slide ${slide.slideNumber}`,
      text:
        slide.text.length > PREVIEW_TEXT_LIMIT
          ? `${slide.text.slice(0, PREVIEW_TEXT_LIMIT - 1).trimEnd()}…`
          : slide.text
    });
    summaries.push({
      number: slide.slideNumber,
      ...counts,
      empty: !content
    });
  }

  const blank = summaries.filter(summary => summary.empty).map(summary => summary.number);
  if (blank.length > 0) notes.push(blankSlidesNote(blank));
  if (tally.defaultSized > 0) notes.push(defaultSizeNote(tally.defaultSized));
  if (tally.rotated > 0) notes.push(rotatedNote(tally.rotated));
  if (tally.rotatedGroup > 0) notes.push(rotatedGroupNote(tally.rotatedGroup));
  if (tally.autoNumbered > 0) notes.push(autoNumberedNote(tally.autoNumbered));
  if (tally.unpositioned > 0) notes.push(unpositionedNote(tally.unpositioned));
  if (tally.unsupportedImages.length > 0) {
    notes.push(unsupportedImageNote(tally.unsupportedImages));
  }
  if (tally.missingImages > 0) notes.push(missingImageNote(tally.missingImages));
  for (const graphic of tally.graphics) notes.push(graphicFrameNote(graphic));
  for (const slideNumber of tally.emptyTables) notes.push(emptyTableNote(slideNumber));

  // A deck that would produce nothing but blank pages is refused rather than
  // written, the same policy CNV-10 applies to a scan and CNV-12 to an empty
  // plan: a file of blank pages is one the user then has to diagnose.
  //
  // *Which* cause is named matters as much as the refusal. The generic message
  // blames layout inheritance, which is the right guess only when there is no
  // better one — and by this point the walk above may already have diagnosed the
  // real problem exactly (a picture missing from the package, an EMF this build
  // cannot decode, a chart whose part holds no text). Those reasons are already
  // written; handing back the guess instead would be telling the user to look at
  // their slide master because of an image failure this code had identified.
  if (summaries.every(summary => summary.empty)) {
    const diagnosed = [
      ...(tally.missingImages > 0 ? [missingImageNote(tally.missingImages)] : []),
      ...(tally.unsupportedImages.length > 0
        ? [unsupportedImageNote(tally.unsupportedImages)]
        : []),
      ...tally.graphics.map(graphicFrameNote),
      ...tally.emptyTables.map(emptyTableNote)
    ];
    throw unsupported(blankDeckMessage(diagnosed));
  }

  return {
    blocks,
    notes,
    slides: summaries,
    slideWidth,
    slideHeight,
    ...(deck.title !== undefined ? { title: deck.title } : {})
  };
}

/**
 * Reads a `.pptx` and returns the block model for it.
 *
 * Every refusal is the reader's own — an empty file, an OLE2 container (a
 * legacy `.ppt` or a password-protected `.pptx`), a ZIP that is not a
 * presentation package, a package that lists a slide it does not contain — and
 * each one throws before any block exists, so a refused file is never
 * half-converted. One refusal is this file's own: a deck that would produce
 * nothing but blank pages, thrown with the most specific reason available
 * ({@link blankDeckMessage}) rather than with a guess about slide layouts.
 */
export async function readPptxAsBlocks(
  bytes: Uint8Array,
  job?: JobHandle
): Promise<PptxBlocksResult> {
  await checkpoint(job, 0, 'Reading the presentation');
  // The parse is where a large deck spends its time, so the job goes *into* the
  // reader's own per-slide loop; 0–0.85 of this phase is that loop, and the
  // mapping below is the rest.
  const deck = await readPptx(bytes, { includeMediaBytes: true, job: subJob(job, 0, 0.85) });
  await checkpoint(job, 0.85, `Laying out ${deck.slides.length} slide(s)`);
  const result = deckToBlocks(deck);
  await checkpoint(job, 1, 'Reading the presentation');
  return result;
}

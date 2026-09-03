/**
 * CNV-12 — a `.pptx` read back out of its own OOXML package.
 *
 * The ticket's acceptance criterion is stated as a *round trip*: each slide's
 * extracted text, read back from the produced file, must match the source page's
 * text. That is only evidence if the reader is independent of the writer, so
 * nothing here goes through `pptxgenjs`. A `.pptx` is a ZIP of XML, `fflate` is
 * already a runtime dependency, and this module walks the package the way a
 * viewer does — which is what makes the round trip a check rather than the writer
 * agreeing with itself.
 *
 * It is deliberately a *reader*, not a converter. CNV-13 (PowerPoint → PDF) is
 * the ticket that turns this into pages; the shape here is chosen so that ticket
 * can consume it unchanged (per-slide runs, per-slide media parts, per-shape
 * geometry), but no part of CNV-13's conversion, UI or worker method is built.
 *
 * ## Why the parsing is regex over the XML, and where that is safe
 *
 * There is no XML parser in this bundle that is not part of a much larger
 * library, and pulling one in for a read this narrow is the trade CNV-13's own
 * ticket explicitly rules out ("a zip-of-XML walker over the existing `fflate`
 * dependency — no new library for this narrow read need"). The parts read here
 * are machine-written OOXML with a fixed element vocabulary; the risk of a regex
 * walker is a *missed* element, never a wrong one, and a missed element makes the
 * round-trip assertion fail loudly rather than pass falsely. The two constructs
 * that could make it a *wrong* one — a comment and a CDATA section, either of
 * which may contain something shaped like a tag — are skipped by the scan
 * outright ({@link childElements}), which is what makes that claim true rather
 * than merely likely. Text content is
 * entity-decoded properly, because that is the one place a naive read would
 * silently corrupt a comparison (`&amp;` vs `&`).
 *
 * ## Refusals
 *
 * CNV-11 found that `xlsx` does not throw on twelve bytes of binary garbage — it
 * sniffs them as delimited text and returns a workbook of control characters. A
 * hand-rolled reader has the mirror-image hazard: it can find nothing in a valid
 * file and report an empty deck. So every failure below is an explicit refusal
 * with its own message, and "0 slides" is never returned as a success.
 *
 * ## What it does not read yet, stated rather than left to be discovered
 *
 * Not read (and not needed by CNV-12's round trip): slide layouts and masters,
 * so text that lives only in a placeholder inherited from a layout is not
 * reported; speaker notes; and per-run colour or font. A chart's or SmartArt's
 * *drawing* is not read either — its **text** is, out of its own part (see
 * {@link graphicPartText}), and the frame is always reported as a `graphic`
 * shape so a consumer can say a chart was there.
 *
 * ## What CNV-13 added, and why it belongs here rather than in that ticket
 *
 * CNV-12 shipped this file with three gaps written down as obligations on its
 * successor. All three are closed here, because each is a fact about the *file
 * format* rather than about either conversion:
 *
 *  • **Group shapes.** `<p:grpSp>` nests `<p:sp>`/`<p:pic>` children in the
 *    group's own child coordinate space (`<a:chOff>`/`<a:chExt>`), which the
 *    group's `<a:off>`/`<a:ext>` then map onto the slide. Reporting a child's
 *    raw geometry — which is what this file used to do — is *wrong*, not
 *    approximate, and PowerPoint groups shapes routinely. {@link shapesOf} now
 *    composes the transform down the tree, nested groups included.
 *  • **Tables.** `<a:tbl>` lives inside a `<p:graphicFrame>`, which the old
 *    element scan did not look at at all: its cell text reached `runs` and
 *    `text` (they scan for `<a:t>` anywhere) but no *shape* carried it, so a
 *    positioned layout would have drawn nothing while the slide's own `text`
 *    claimed the words were there. That is a silent loss, so the grid — column
 *    widths, row heights, per-cell paragraphs — is read.
 *  • **Run and paragraph properties.** `sz`, `b`, `i`, `<a:pPr algn>`, the
 *    indent level and a literal bullet character. A converter that has to draw
 *    this text needs a size; guessing one is how a deck comes out at the wrong
 *    scale.
 *
 * ## What CNV-13's second review pass added
 *
 * An audit of CNV-13 found two silent losses in the above, both of the same
 * class the whole conversion series polices — content that goes missing with
 * nothing reported:
 *
 *  • **A group's own `rot`/`flipH`/`flipV` were not read at all.** A group's
 *    flip mirrors the *child coordinate space*, so every child of a flipped
 *    group was placed at its unmirrored position — the same class of error as
 *    ignoring `<a:chOff>` — and none of it reached the consumer's tally, so a
 *    deck of flipped groups reported nothing left out. The flip is now applied
 *    (a sign on the axis scale, {@link composeGroup}) and the rotation, which is
 *    *not* applied, is reported per shape ({@link PptxShape.groupRotated}).
 *  • **A chart's and SmartArt's text lives in a part of its own**, which this
 *    file never opened, so a slide whose content was a chart contributed
 *    nothing and reported nothing. {@link graphicPartText} reads it.
 *
 * Nesting is why the scan is no longer one non-greedy regex per element name:
 * `<p:grpSp>` can contain a `<p:grpSp>`, and `[\s\S]*?` up to the first
 * `</p:grpSp>` closes the outer group at the inner group's end tag. See
 * {@link childElements}, which counts depth.
 */

import { corrupt, unsupported } from '../errors';
import { checkpoint, type JobHandle } from '../workers/protocol';

/** One run of text, with the three properties a `<a:rPr>` states outright. */
export interface PptxTextRun {
  text: string;
  bold: boolean;
  italic: boolean;
  /**
   * Point size, when the run states one (`sz` is in hundredths of a point).
   * Absent when it does not: the real size then comes from the placeholder's
   * list style in the layout or master, which this reader does not resolve, so
   * the consumer picks a default rather than being handed a fabricated number.
   */
  sizePt?: number;
}

export type PptxAlign = 'left' | 'center' | 'right' | 'justify';

/** One `<a:p>`: its runs plus the paragraph properties that affect placement. */
export interface PptxParagraph {
  runs: PptxTextRun[];
  /** `<a:pPr algn>`; `left` when unstated, which is OOXML's own default. */
  align: PptxAlign;
  /** `<a:pPr lvl>` — 0 for a top-level paragraph. */
  level: number;
  /** The literal `<a:buChar char>`, when the paragraph carries one. */
  bullet?: string;
  /** True for `<a:buAutoNum>`: a *numbered* bullet whose number is not stored. */
  autoNumbered: boolean;
}

/** One `<a:tc>`. Merge continuation cells are reported, not silently dropped. */
export interface PptxTableCell {
  paragraphs: PptxParagraph[];
  /** True for a cell covered by a horizontal or vertical merge. */
  merged: boolean;
}

/** One `<a:tbl>`: the grid PowerPoint stored, in EMU. */
export interface PptxTable {
  /** `<a:gridCol w>` per column, in EMU. */
  columnWidths: number[];
  /** `<a:tr h>` per row, in EMU. A row states a *minimum* height. */
  rowHeights: number[];
  rows: PptxTableCell[][];
}

/**
 * What a `<p:graphicFrame>` that is not a table holds.
 *
 * `unknown` is a frame whose `<a:graphicData uri>` is none of the three this
 * reader recognises — reported rather than dropped, because the consumer's whole
 * job for these is to say that something was there.
 */
export type PptxGraphicKind = 'chart' | 'diagram' | 'ole' | 'unknown';

/** One shape on a slide, with the geometry PowerPoint actually stored. */
export interface PptxShape {
  kind: 'text' | 'picture' | 'table' | 'graphic';
  /**
   * English Metric Units (914400 per inch), from `<a:off>`/`<a:ext>`, already
   * mapped out of any enclosing `<p:grpSp>`'s child coordinate space — so these
   * are slide coordinates whether or not the shape sits in a group.
   */
  x: number;
  y: number;
  cx: number;
  cy: number;
  /**
   * Rotation in 60000ths of a degree: the shape's own `<a:xfrm rot>` **plus**
   * every enclosing group's, because a shape inside a group rotated 45° appears
   * rotated on the slide whatever its own transform says. 0 when the shape and
   * its groups all state none.
   *
   * The sum is an orientation *report*, not a composed transform: a mirrored
   * group reverses the sense of a rotation inside it, which this does not model.
   * It exists so a consumer that cannot draw rotation can count and disclose it,
   * and it is never used to place anything.
   */
  rot: number;
  /** A text shape's own text, runs joined. */
  text?: string;
  /** A text shape's or picture's paragraphs, with their run properties. */
  paragraphs?: PptxParagraph[];
  /**
   * A picture's `<a:blip r:embed>` relationship id, or — for a `graphic` shape —
   * the frame's own reference to the part that holds its content (`<c:chart
   * r:id>` for a chart, `<dgm:relIds r:dm>` for SmartArt).
   */
  relationshipId?: string;
  /** A table shape's grid. */
  table?: PptxTable;
  /** A `graphic` shape's kind, from its `<a:graphicData uri>`. */
  graphicKind?: PptxGraphicKind;
  /**
   * How many strings from a `graphic` shape's own part were **not** kept,
   * because {@link MAX_GRAPHIC_TEXT_RUNS} capped them. Absent when none were.
   */
  graphicTextDropped?: number;
  /** True when the shape was found inside a `<p:grpSp>`. */
  grouped?: boolean;
  /**
   * `<a:xfrm flipH>` / `flipV`, XOR'd with every enclosing group's — a shape
   * flipped inside a group that is itself flipped is not mirrored on the slide.
   * Reported so a consumer can disclose them.
   *
   * A group's flip also mirrors the *positions* of its children, and that half
   * **is** applied: see {@link composeGroup}.
   */
  flipH?: boolean;
  flipV?: boolean;
  /**
   * True when an enclosing group states a rotation. The group's rotation is
   * *not* applied to this shape's position — doing so would need the group's
   * centre and a rotated draw — so a consumer must disclose that this shape sits
   * where the group's unrotated rectangle puts it.
   */
  groupRotated?: boolean;
}

export interface PptxSlideMedia {
  relationshipId: string;
  /** Package part name, e.g. `ppt/media/image-1-1.png`. */
  part: string;
  byteLength: number;
  /** The part's own bytes, only when the caller asked for them. */
  bytes?: Uint8Array;
}

export interface PptxSlide {
  /** 1-based position in `<p:sldIdLst>` order, which is the deck's own order. */
  slideNumber: number;
  /** Package part name, e.g. `ppt/slides/slide1.xml`. */
  part: string;
  /** Every `<a:t>` on the slide, in document order. */
  runs: string[];
  /** Runs joined per `<a:p>`, blank paragraphs dropped. */
  paragraphs: string[];
  /** Every run joined with single spaces. The comparison surface. */
  text: string;
  shapes: PptxShape[];
  media: PptxSlideMedia[];
}

export interface PptxDeck {
  /** `<p:sldSz>` in EMU. */
  slideWidth: number;
  slideHeight: number;
  /** `dc:title` from `docProps/core.xml`, when the deck set one. */
  title?: string;
  /** Slides in presentation order, never empty (an empty deck is refused). */
  slides: PptxSlide[];
}

export const NOT_A_ZIP_MESSAGE =
  'This file is not a PowerPoint presentation — a `.pptx` is a ZIP package, and this file does ' +
  'not start like one. Nothing was read.';

export const OLE2_MESSAGE =
  'This looks like a legacy `.ppt` file, or a password-protected `.pptx` (both are stored in an ' +
  'OLE container rather than a ZIP). Open it in PowerPoint and save it as an unprotected ' +
  '`.pptx`, then try again.';

export const NOT_A_PRESENTATION_MESSAGE =
  'This ZIP is not a PowerPoint package: it has no `ppt/presentation.xml`. Nothing was read.';

export const NO_SLIDES_MESSAGE = 'This presentation lists no slides, so there is nothing to read.';

export const EMPTY_FILE_MESSAGE = 'The file is empty, so there is nothing to read.';

/** `PK\x03\x04`, and the two variants an empty or spanned archive starts with. */
function isZip(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  const third = bytes[2];
  const fourth = bytes[3];
  return (
    (third === 0x03 && fourth === 0x04) ||
    (third === 0x05 && fourth === 0x06) ||
    (third === 0x07 && fourth === 0x08)
  );
}

/** The OLE2/CFB signature. A legacy `.ppt` and an encrypted `.pptx` both start with it. */
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
function isOle2(bytes: Uint8Array): boolean {
  if (bytes.length < OLE2.length) return false;
  return OLE2.every((byte, i) => bytes[i] === byte);
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
};

/** XML text content → the characters it stands for. */
export function decodeXmlText(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return match ? decodeXmlText(match[1]) : undefined;
}

function numericAttribute(tag: string, name: string): number {
  const raw = attribute(tag, name);
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) ? value : 0;
}

/**
 * One element's character data → the string it stands for.
 *
 * A CDATA section is literal text: `&amp;` inside one is an ampersand followed
 * by "amp;", not an ampersand, and the `<![CDATA[` markers themselves are not
 * text at all. So the two kinds of segment are decoded differently — entity
 * decoding outside, verbatim inside — rather than running one pass over both,
 * which would either leave the markers in the drawn text or decode entities
 * that were written to be literal.
 */
function textContent(raw: string): string {
  if (!raw.includes('<![CDATA[')) return decodeXmlText(raw);
  const pattern = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let out = '';
  let index = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    out += decodeXmlText(raw.slice(index, match.index)) + match[1];
    index = pattern.lastIndex;
  }
  return out + decodeXmlText(raw.slice(index));
}

/** Every `<a:t>` in `xml`, decoded, in document order. */
function textRuns(xml: string): string[] {
  return [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(match =>
    textContent(match[1])
  );
}

/** Runs grouped by the `<a:p>` they sit in. Empty paragraphs are dropped. */
function paragraphs(xml: string): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g)) {
    const joined = textRuns(match[1]).join('');
    if (joined.trim().length > 0) out.push(joined);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * A depth-counting element scanner
 * ------------------------------------------------------------------ */

interface XmlElement {
  name: string;
  /** The whole opening tag, so attributes can be read off it. */
  open: string;
  /** Everything between the tags; empty for a self-closed element. */
  body: string;
}

/**
 * Matches one tag. Quoted attribute values may contain `>`, which a bare
 * `<[^>]*>` would end the tag on.
 *
 * Built per call rather than shared: a `g`-flagged regex carries `lastIndex`,
 * and this scanner is called recursively.
 */
function tagPattern(): RegExp {
  return /<(\/?)([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
}

/**
 * The `[start, end)` spans of every comment and CDATA section in `xml`.
 *
 * Both are opaque to the element scan: what is written inside them is character
 * data, not markup, so a `</a:t>` in a CDATA section closes nothing and a
 * commented-out `<p:sp>` opens nothing. Computed only when the part actually
 * contains one, because the common case is neither.
 */
function opaqueRanges(xml: string): Array<[number, number]> {
  if (!xml.includes('<!')) return [];
  const ranges: Array<[number, number]> = [];
  for (const match of xml.matchAll(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g)) {
    if (match.index === undefined) continue;
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function isInside(ranges: ReadonlyArray<[number, number]>, index: number): boolean {
  for (const [start, end] of ranges) {
    if (index >= start && index < end) return true;
    if (index < start) return false; // ranges are in document order
  }
  return false;
}

/**
 * The outermost occurrences in `xml` of elements named in `names`, in document
 * order, each with a balanced body.
 *
 * "Outermost" is what makes one pass enough: an element of a listed name found
 * *inside* another listed element is part of that element's body and is not
 * reported again, so scanning a slide's shape tree for `p:sp`/`p:pic`/`p:grpSp`
 * yields the tree's own children and leaves a group's members to the recursive
 * call that knows the group's transform.
 *
 * Elements not in `names` are ignored entirely, so `firstChild(body, 'a:xfrm')`
 * finds a transform however deeply `<p:spPr>` buries it.
 *
 * Depth counting is the whole point. `<p:grpSp>` may contain another
 * `<p:grpSp>`, and the non-greedy `<p:grpSp>([\s\S]*?)<\/p:grpSp>` this file
 * used to rely on would close the outer group at the *inner* group's end tag —
 * truncating the outer group's remaining shapes and giving the inner group's
 * trailing siblings the wrong parent transform. The same hazard exists for
 * `<a:tbl>` inside a `<p:graphicFrame>` inside a group.
 *
 * Only elements sharing a name with the one currently open are counted, so an
 * unrelated nested element cannot unbalance the scan.
 *
 * A comment and a CDATA section may both legally contain something that looks
 * like a tag — `<!-- </p:sp> -->`, `<![CDATA[</a:t>]]>` — and either would
 * unbalance the scan, so both are located up front and any "tag" found inside
 * one is ignored. Their *bodies* are still returned as part of the element they
 * sit in, because a body is a slice of the original XML: a run's text inside a
 * CDATA section is kept, it simply cannot close an element any more.
 */
export function childElements(xml: string, names: ReadonlySet<string>): XmlElement[] {
  const out: XmlElement[] = [];
  let open: { name: string; tag: string; start: number } | null = null;
  let depth = 0;
  const opaque = opaqueRanges(xml);

  const tag = tagPattern();
  let match: RegExpExecArray | null;
  while ((match = tag.exec(xml)) !== null) {
    if (isInside(opaque, match.index)) continue;
    const closing = match[1] === '/';
    const name = match[2];
    const selfClosed = match[4] === '/';

    if (open === null) {
      if (closing || !names.has(name)) continue;
      if (selfClosed) {
        out.push({ name, open: match[0], body: '' });
        continue;
      }
      open = { name, tag: match[0], start: tag.lastIndex };
      depth = 1;
      continue;
    }

    if (name !== open.name || selfClosed) continue;
    if (!closing) {
      depth += 1;
      continue;
    }
    depth -= 1;
    if (depth > 0) continue;
    out.push({ name: open.name, open: open.tag, body: xml.slice(open.start, match.index) });
    open = null;
  }
  // An unclosed element is a damaged part. Reporting what was opened, with the
  // rest of the XML as its body, keeps its text rather than dropping it — the
  // slide-level `text` scan would have found it anyway, so dropping it here
  // would make the shapes and the text disagree.
  if (open !== null) {
    out.push({ name: open.name, open: open.tag, body: xml.slice(open.start) });
  }
  return out;
}

/** The first outermost occurrence of `name`, or undefined. */
function firstChild(xml: string, name: string): XmlElement | undefined {
  return childElements(xml, new Set([name]))[0];
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/** A shape's own `<a:xfrm>`, in whatever coordinate space it was written in. */
interface RawTransform {
  x: number;
  y: number;
  cx: number;
  cy: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

const NO_TRANSFORM: RawTransform = {
  x: 0,
  y: 0,
  cx: 0,
  cy: 0,
  rot: 0,
  flipH: false,
  flipV: false
};

function flag(tag: string, name: string): boolean {
  const raw = attribute(tag, name);
  return raw === '1' || raw === 'true';
}

/**
 * `<a:xfrm>` (or a graphic frame's `<p:xfrm>`) geometry, or zeros when the shape
 * declares none.
 *
 * A graphic frame — which is what holds a table — writes its transform in the
 * `p:` namespace with `a:`-namespaced children. Looking only for `<a:xfrm>` is
 * why every table on every slide used to be at (0, 0) with no size.
 */
function transformOf(xml: string): RawTransform {
  const xfrm = firstChild(xml, 'a:xfrm') ?? firstChild(xml, 'p:xfrm');
  if (!xfrm) return NO_TRANSFORM;
  const off = firstChild(xfrm.body, 'a:off');
  const ext = firstChild(xfrm.body, 'a:ext');
  return {
    x: off ? numericAttribute(off.open, 'x') : 0,
    y: off ? numericAttribute(off.open, 'y') : 0,
    cx: ext ? numericAttribute(ext.open, 'cx') : 0,
    cy: ext ? numericAttribute(ext.open, 'cy') : 0,
    rot: numericAttribute(xfrm.open, 'rot'),
    flipH: flag(xfrm.open, 'flipH'),
    flipV: flag(xfrm.open, 'flipV')
  };
}

/**
 * How a group's child coordinate space maps onto the slide.
 *
 * OOXML gives a group both an outer rectangle (`<a:off>`/`<a:ext>`, on the
 * slide) and a child rectangle (`<a:chOff>`/`<a:chExt>`, the space its children
 * are written in). A child at `cx` lands at `off.x + (cx - chOff.x) * ext.cx /
 * chExt.cx`. Identity when there is no group.
 *
 * A group's own `rot`/`flipH`/`flipV` are part of that mapping too, and they are
 * *not* the same kind of fact as a shape's own:
 *
 *  • A **shape's** flip mirrors its own content inside its own box, so it
 *    changes nothing about where the box is.
 *  • A **group's** flip mirrors the child coordinate space itself, so every
 *    child moves — a child against the group's left edge ends up against its
 *    right edge. Reporting the unmirrored position is *wrong*, not approximate,
 *    which is the same reason the child-space mapping is composed at all. A
 *    mirror is a sign change on one axis, so it is carried in `scaleX`/`scaleY`
 *    and {@link place} normalises the negative-width interval that produces.
 *  • A group's **rotation** would need the group's centre and a rotated draw,
 *    which no consumer of this reader does. It is reported (`rot`,
 *    `groupRotated`) and not applied, so the disclosure is a count rather than
 *    a silent displacement.
 */
interface GroupTransform {
  offsetX: number;
  offsetY: number;
  /** Negative when an enclosing group mirrors this axis. */
  scaleX: number;
  scaleY: number;
  /** The group chain's own rotation, in 60000ths of a degree. */
  rot: number;
  /** The group chain's net mirroring, XOR'd down the tree. */
  flipH: boolean;
  flipV: boolean;
}

const IDENTITY: GroupTransform = {
  offsetX: 0,
  offsetY: 0,
  scaleX: 1,
  scaleY: 1,
  rot: 0,
  flipH: false,
  flipV: false
};

function composeGroup(outer: GroupTransform, groupBody: string): GroupTransform {
  const xfrm = firstChild(groupBody, 'a:xfrm');
  if (!xfrm) return outer;
  const rot = numericAttribute(xfrm.open, 'rot');
  const flipH = flag(xfrm.open, 'flipH');
  const flipV = flag(xfrm.open, 'flipV');
  const orientation = {
    rot: outer.rot + rot,
    flipH: outer.flipH !== flipH,
    flipV: outer.flipV !== flipV
  };

  const off = firstChild(xfrm.body, 'a:off');
  const ext = firstChild(xfrm.body, 'a:ext');
  const chOff = firstChild(xfrm.body, 'a:chOff');
  const chExt = firstChild(xfrm.body, 'a:chExt');
  // A group stating an orientation but no child mapping still rotates or
  // mirrors its children, so the orientation is kept even when the rest of the
  // transform is unusable.
  if (!off || !ext || !chOff || !chExt) return { ...outer, ...orientation };

  const childWidth = numericAttribute(chExt.open, 'cx');
  const childHeight = numericAttribute(chExt.open, 'cy');
  // A zero child extent would divide by zero and put every child at ±Infinity.
  // A group written that way states no mapping, so the identity is the only
  // reading that leaves its children where they were written.
  const magnitudeX = childWidth > 0 ? numericAttribute(ext.open, 'cx') / childWidth : 1;
  const magnitudeY = childHeight > 0 ? numericAttribute(ext.open, 'cy') / childHeight : 1;
  const scaleX = flipH ? -magnitudeX : magnitudeX;
  const scaleY = flipV ? -magnitudeY : magnitudeY;
  // Mirroring about the group's own rectangle: the child space maps onto
  // `off + ext` counting backwards, so the constant term picks up the group's
  // extent. Without the flip this reduces to `off - chOff * scale`, which is
  // what it has always been.
  const localX =
    numericAttribute(off.open, 'x') +
    (flipH ? numericAttribute(ext.open, 'cx') : 0) -
    numericAttribute(chOff.open, 'x') * scaleX;
  const localY =
    numericAttribute(off.open, 'y') +
    (flipV ? numericAttribute(ext.open, 'cy') : 0) -
    numericAttribute(chOff.open, 'y') * scaleY;
  return {
    offsetX: outer.offsetX + localX * outer.scaleX,
    offsetY: outer.offsetY + localY * outer.scaleY,
    scaleX: outer.scaleX * scaleX,
    scaleY: outer.scaleY * scaleY,
    ...orientation
  };
}

function place(raw: RawTransform, group: GroupTransform): Omit<PptxShape, 'kind'> {
  const x = group.offsetX + raw.x * group.scaleX;
  const y = group.offsetY + raw.y * group.scaleY;
  const width = raw.cx * group.scaleX;
  const height = raw.cy * group.scaleY;
  const flipH = raw.flipH !== group.flipH;
  const flipV = raw.flipV !== group.flipV;
  return {
    // A mirrored group maps a child's left edge onto its right one, so the
    // interval the child spans comes back negative. The shape's own `x` is its
    // *left* edge and its `cx` is a width, never a direction, so the interval is
    // normalised here rather than left for every consumer to discover.
    x: width < 0 ? x + width : x,
    y: height < 0 ? y + height : y,
    cx: Math.abs(width),
    cy: Math.abs(height),
    rot: raw.rot + group.rot,
    ...(flipH ? { flipH: true } : {}),
    ...(flipV ? { flipV: true } : {}),
    ...(group.rot !== 0 ? { groupRotated: true } : {})
  };
}

/* ------------------------------------------------------------------ *
 * Text bodies
 * ------------------------------------------------------------------ */

const ALIGNMENTS: Record<string, PptxAlign> = {
  l: 'left',
  ctr: 'center',
  r: 'right',
  just: 'justify',
  justLow: 'justify',
  dist: 'justify',
  thaiDist: 'justify'
};

/** One `<a:r>` or `<a:fld>` — both carry an `<a:rPr>` and an `<a:t>`. */
function runOf(body: string): PptxTextRun | null {
  const text = textRuns(body).join('');
  if (text.length === 0) return null;
  const rPr = firstChild(body, 'a:rPr') ?? firstChild(body, 'a:defRPr');
  // `sz` is hundredths of a point. A non-positive or absent one means the size
  // is inherited from a list style this reader does not resolve, so no size is
  // reported rather than a plausible-looking zero.
  const size = rPr ? numericAttribute(rPr.open, 'sz') / 100 : 0;
  return {
    text,
    bold: rPr ? flag(rPr.open, 'b') : false,
    italic: rPr ? flag(rPr.open, 'i') : false,
    ...(size > 0 ? { sizePt: size } : {})
  };
}

/** The paragraphs of one `<p:txBody>` (or `<a:txBody>` in a table cell). */
export function parseParagraphs(txBody: string): PptxParagraph[] {
  const out: PptxParagraph[] = [];
  for (const paragraph of childElements(txBody, new Set(['a:p']))) {
    const pPr = firstChild(paragraph.body, 'a:pPr');
    const runs: PptxTextRun[] = [];
    for (const child of childElements(paragraph.body, new Set(['a:r', 'a:fld', 'a:br']))) {
      if (child.name === 'a:br') {
        // A soft line break inside the paragraph. `\n` is what the layout
        // engine's own wrapper treats as a hard break, so it is the right
        // carrier here too.
        runs.push({ text: '\n', bold: false, italic: false });
        continue;
      }
      const run = runOf(child.body);
      if (run) runs.push(run);
    }
    const buChar = pPr ? firstChild(pPr.body, 'a:buChar') : undefined;
    const buNone = pPr ? firstChild(pPr.body, 'a:buNone') : undefined;
    const buAutoNum = pPr ? firstChild(pPr.body, 'a:buAutoNum') : undefined;
    const bullet = !buNone && buChar ? attribute(buChar.open, 'char') : undefined;
    out.push({
      runs,
      align: (pPr ? ALIGNMENTS[attribute(pPr.open, 'algn') ?? ''] : undefined) ?? 'left',
      level: pPr ? Math.max(0, numericAttribute(pPr.open, 'lvl')) : 0,
      ...(bullet ? { bullet } : {}),
      autoNumbered: !buNone && buAutoNum !== undefined
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Tables
 * ------------------------------------------------------------------ */

function parseTable(tbl: string): PptxTable {
  const grid = firstChild(tbl, 'a:tblGrid');
  const columnWidths = grid
    ? childElements(grid.body, new Set(['a:gridCol'])).map(col => numericAttribute(col.open, 'w'))
    : [];

  const rowHeights: number[] = [];
  const rows: PptxTableCell[][] = [];
  for (const tr of childElements(tbl, new Set(['a:tr']))) {
    rowHeights.push(numericAttribute(tr.open, 'h'));
    rows.push(
      childElements(tr.body, new Set(['a:tc'])).map(tc => ({
        paragraphs: parseParagraphs(firstChild(tc.body, 'a:txBody')?.body ?? ''),
        // A merge continuation cell carries no text of its own; it is reported
        // so a consumer can draw the grid without claiming an empty cell.
        merged: flag(tc.open, 'hMerge') || flag(tc.open, 'vMerge')
      }))
    );
  }
  return { columnWidths, rowHeights, rows };
}

/* ------------------------------------------------------------------ *
 * Charts, SmartArt and embedded objects
 * ------------------------------------------------------------------ */

/**
 * How many strings are kept from one chart or SmartArt part.
 *
 * A chart's cached category labels are one string per data point, and a
 * generated chart can hold thousands — drawing all of them as plain text where
 * the chart sat would bury the slide. What is left out is *counted*
 * ({@link PptxShape.graphicTextDropped}) so the consumer can say so, which is
 * the difference between a cap and a silent truncation.
 */
export const MAX_GRAPHIC_TEXT_RUNS = 60;

/** `<a:graphicData uri>` → what the frame holds. */
function graphicKindOf(uri: string): PptxGraphicKind {
  if (/chart/i.test(uri)) return 'chart';
  if (/diagram|smartArt/i.test(uri)) return 'diagram';
  if (/\bole\b|oleObject|activeX/i.test(uri)) return 'ole';
  return 'unknown';
}

/**
 * The text a chart or SmartArt part states, in document order, deduplicated.
 *
 * **This is the part CNV-13 originally missed.** A `<p:graphicFrame>` holding a
 * chart contains a *reference* (`<c:chart r:id>`) and no text at all: the title,
 * the series names and the category labels live in `ppt/charts/chart1.xml`, and
 * SmartArt's node text lives in `ppt/diagrams/data1.xml`. Reading only the
 * frame's own body therefore found nothing and contributed nothing, which is a
 * silent loss of every word on a slide whose content is a chart.
 *
 * Two places hold that text and both are read: rich text (`<a:t>` — a chart
 * title, an axis title, every SmartArt node) and the *string* caches
 * (`<c:strCache>`'s `<c:v>` — series names and category labels). Numeric caches
 * are deliberately not read: a column's height is not text, and listing the
 * numbers would read as a data table this converter did not draw.
 *
 * Deduplicated because every series repeats the same category labels in its own
 * cache, so a three-series chart would otherwise state each label three times.
 */
export function graphicPartText(xml: string): { runs: string[]; dropped: number } {
  const seen = new Set<string>();
  const all: string[] = [];
  const push = (decoded: string) => {
    const value = decoded.replace(/\s+/g, ' ').trim();
    if (value.length === 0 || seen.has(value)) return;
    seen.add(value);
    all.push(value);
  };
  for (const run of textRuns(xml)) push(run);
  for (const cache of xml.matchAll(/<c:strCache>([\s\S]*?)<\/c:strCache>/g)) {
    for (const value of cache[1].matchAll(/<c:v(?:\s[^>]*)?>([\s\S]*?)<\/c:v>/g)) {
      push(decodeXmlText(value[1]));
    }
  }
  return {
    runs: all.slice(0, MAX_GRAPHIC_TEXT_RUNS),
    dropped: Math.max(0, all.length - MAX_GRAPHIC_TEXT_RUNS)
  };
}

/** One extracted string → the paragraph shape a consumer draws it from. */
function graphicParagraph(text: string): PptxParagraph {
  return {
    runs: [{ text, bold: false, italic: false }],
    align: 'left',
    level: 0,
    autoNumbered: false
  };
}

/* ------------------------------------------------------------------ *
 * The shape tree
 * ------------------------------------------------------------------ */

const SHAPE_ELEMENTS = new Set(['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp']);

/**
 * Text shapes, pictures and tables on one slide, in the order the slide paints
 * them — group members included, at the slide coordinates the group puts them.
 *
 * Painting order is what decides whether text sits over or under a picture, so
 * one ordered pass handles every element name rather than one pass per name.
 */
function shapesOf(slideXml: string): PptxShape[] {
  // A comment can legally hold anything, including something that looks like an
  // element, and an unbalanced one inside it would desynchronise the scan.
  const xml = slideXml.includes('<!--') ? slideXml.replace(/<!--[\s\S]*?-->/g, '') : slideXml;
  // The shape tree, when the part has one. Scoping to it keeps `<p:bg>` and the
  // slide's own `<p:nvGrpSpPr>` out, and costs nothing when it is absent.
  const tree = firstChild(xml, 'p:spTree');
  const out: PptxShape[] = [];

  const walk = (body: string, group: GroupTransform, grouped: boolean) => {
    for (const element of childElements(body, SHAPE_ELEMENTS)) {
      if (element.name === 'p:grpSp') {
        const groupProperties = firstChild(element.body, 'p:grpSpPr');
        walk(element.body, composeGroup(group, groupProperties?.body ?? ''), true);
        continue;
      }

      const geometry = place(transformOf(element.body), group);
      const flags = grouped ? { grouped: true as const } : {};

      if (element.name === 'p:pic') {
        const blip = /<a:blip\b[^>]*\/?>/.exec(element.body);
        out.push({
          kind: 'picture',
          ...geometry,
          ...flags,
          ...(blip ? { relationshipId: attribute(blip[0], 'r:embed') ?? '' } : {})
        });
        continue;
      }

      if (element.name === 'p:graphicFrame') {
        const tbl = firstChild(element.body, 'a:tbl');
        if (tbl) {
          out.push({ kind: 'table', ...geometry, ...flags, table: parseTable(tbl.body) });
          continue;
        }
        // A chart, a diagram or an embedded object. A shape is emitted **even
        // when the frame's own body holds no text at all**, which is the normal
        // case: a chart frame is a reference and its words live in
        // `ppt/charts/chart1.xml`. Dropping it here (what this used to do) meant
        // a slide whose content was a chart contributed nothing *and* was
        // reported as carrying nothing. {@link readPptx} fills the text in from
        // the referenced part; the consumer counts and discloses the frame
        // either way.
        const data = firstChild(element.body, 'a:graphicData');
        const inlineText = textRuns(element.body).join('');
        const relationshipId = data
          ? /\br:(?:id|dm)\s*=\s*"([^"]*)"/.exec(data.body)?.[1]
          : undefined;
        out.push({
          kind: 'graphic',
          ...geometry,
          ...flags,
          graphicKind: graphicKindOf(data ? (attribute(data.open, 'uri') ?? '') : ''),
          ...(relationshipId ? { relationshipId } : {}),
          ...(inlineText.trim().length > 0
            ? { text: inlineText, paragraphs: parseParagraphs(element.body) }
            : {})
        });
        continue;
      }

      const txBody = firstChild(element.body, 'p:txBody');
      out.push({
        kind: 'text',
        ...geometry,
        ...flags,
        text: textRuns(element.body).join(''),
        paragraphs: parseParagraphs(txBody?.body ?? '')
      });
    }
  };

  walk(tree?.body ?? xml, IDENTITY, false);
  return out;
}

/** `Id` → `Target`, from one `_rels` part. */
function relationships(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = attribute(match[0], 'Id');
    const target = attribute(match[0], 'Target');
    if (id && target) out.set(id, target);
  }
  return out;
}

/**
 * Resolves a relationship `Target` against the part it was declared in.
 *
 * `ppt/slides/_rels/slide1.xml.rels` declaring `../media/image1.png` means
 * `ppt/media/image1.png`. Doing this by string surgery rather than with `URL`
 * keeps it working for the `/ppt/...` absolute form some producers emit.
 */
export function resolvePart(fromPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const segments = fromPart.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}

/**
 * Reads a `.pptx` package.
 *
 * Slide order comes from `<p:sldIdLst>` resolved through
 * `ppt/_rels/presentation.xml.rels`, **not** from sorting part names: `slide10`
 * sorts before `slide2`, so a filename sort silently reorders any deck with ten
 * or more slides — and a per-slide text assertion would then be comparing the
 * wrong page.
 */
export interface PptxReadOptions {
  /**
   * CNV-13 — also hand back each media part's own bytes.
   *
   * Off by default, and deliberately: CNV-12's round trip only needs to know
   * *which* parts a slide references, and holding a deck's worth of image bytes
   * in memory to answer that would be a cost for nothing. The converter that
   * has to embed them asks for them.
   */
  includeMediaBytes?: boolean;
  /**
   * CNV-13 — progress and cancellation for the per-slide loop.
   *
   * Parsing is where a large deck spends its time, so the checkpoint is inside
   * that loop rather than around the whole read: a 500-slide deck that could
   * only be cancelled after it finished would not be cancellable in any sense
   * the user would recognise. Optional, so CNV-12's own call is unchanged.
   */
  job?: JobHandle;
}

export async function readPptx(
  bytes: Uint8Array,
  options: PptxReadOptions = {}
): Promise<PptxDeck> {
  if (bytes.length === 0) throw corrupt(EMPTY_FILE_MESSAGE);
  if (isOle2(bytes)) throw unsupported(OLE2_MESSAGE);
  if (!isZip(bytes)) throw corrupt(NOT_A_ZIP_MESSAGE);

  const { unzipSync, strFromU8 } = await import('fflate');
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (err) {
    throw corrupt(
      `${NOT_A_ZIP_MESSAGE.replace('does not start like one', 'could not be opened')} (${
        err instanceof Error ? err.message : String(err)
      })`
    );
  }

  const presentationPart = 'ppt/presentation.xml';
  const presentation = files[presentationPart];
  if (!presentation) throw unsupported(NOT_A_PRESENTATION_MESSAGE);
  const presentationXml = strFromU8(presentation);

  const sldSz = /<p:sldSz\b[^>]*\/?>/.exec(presentationXml);
  const slideWidth = sldSz ? numericAttribute(sldSz[0], 'cx') : 0;
  const slideHeight = sldSz ? numericAttribute(sldSz[0], 'cy') : 0;

  const presentationRels = files['ppt/_rels/presentation.xml.rels'];
  const rels = presentationRels ? relationships(strFromU8(presentationRels)) : new Map();

  const slides: PptxSlide[] = [];
  const idList = /<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/.exec(presentationXml);
  const listed = [...(idList?.[1] ?? '').matchAll(/<p:sldId\b[^>]*\/?>/g)];
  for (const match of listed) {
    await checkpoint(
      options.job,
      slides.length / Math.max(1, listed.length),
      `Reading slide ${slides.length + 1} of ${listed.length}`
    );
    const relId = attribute(match[0], 'r:id');
    const target = relId ? rels.get(relId) : undefined;
    // A `<p:sldId>` whose relationship does not resolve is the same class of
    // damage as one whose part is missing (below), so it gets the same
    // treatment. Skipping it would quietly return a deck with fewer slides than
    // the file claims — and a per-slide assertion would then compare slide N
    // against page N+1 and fail somewhere far from the cause.
    if (!target) {
      throw corrupt(
        `This presentation lists a slide whose relationship (${relId ?? 'with no r:id'}) is not ` +
          'declared, so it is incomplete. Nothing was read.'
      );
    }
    const part = resolvePart(presentationPart, target);
    const slideBytes = files[part];
    // A `<p:sldId>` whose part is absent is a broken package, and calling it
    // "one fewer slide" would make the round-trip assertion pass on a file
    // PowerPoint would offer to repair.
    if (!slideBytes) {
      throw corrupt(
        `This presentation lists a slide (${part}) that is not in the package, so it is ` +
          'incomplete. Nothing was read.'
      );
    }
    const xml = strFromU8(slideBytes);

    const slideRelsPart = `${part.replace(/\/([^/]+)$/, '/_rels/$1')}.rels`;
    const slideRelsBytes = files[slideRelsPart];
    const slideRels = slideRelsBytes ? relationships(strFromU8(slideRelsBytes)) : new Map();
    const media: PptxSlideMedia[] = [];
    for (const [id, relTarget] of slideRels) {
      const mediaPart = resolvePart(part, relTarget);
      if (!/^ppt\/media\//.test(mediaPart)) continue;
      const content = files[mediaPart];
      media.push({
        relationshipId: id,
        part: mediaPart,
        byteLength: content?.length ?? 0,
        // The same `Uint8Array` instance for every slide that references the
        // part, because it is the one `unzipSync` produced — so a logo on forty
        // slides is one copy here, and the converter that embeds it can
        // deduplicate by part name rather than by comparing bytes.
        ...(options.includeMediaBytes && content ? { bytes: content } : {})
      });
    }

    const shapes = shapesOf(xml);
    // A chart's or a diagram's text is in a part of its own, so it is resolved
    // here — where the package is — rather than in the slide-XML walk. Without
    // this the frame is found and stays empty, which is how a whole slide's
    // worth of labels used to disappear with nothing said.
    const fromGraphicParts: string[] = [];
    for (const shape of shapes) {
      if (shape.kind !== 'graphic' || (shape.paragraphs?.length ?? 0) > 0) continue;
      const graphicTarget = shape.relationshipId ? slideRels.get(shape.relationshipId) : undefined;
      const graphicPart = graphicTarget ? resolvePart(part, graphicTarget) : undefined;
      const content = graphicPart ? files[graphicPart] : undefined;
      // A frame whose part is missing (or an OLE object, whose part is binary)
      // keeps its empty shape: the consumer's note is then the only trace of it,
      // which is the point.
      if (!content) continue;
      const extracted = graphicPartText(strFromU8(content));
      if (extracted.runs.length === 0) continue;
      shape.text = extracted.runs.join('\n');
      shape.paragraphs = extracted.runs.map(graphicParagraph);
      if (extracted.dropped > 0) shape.graphicTextDropped = extracted.dropped;
      fromGraphicParts.push(...extracted.runs);
    }

    // The slide's own comparison surface includes what those parts stated, for
    // the same reason a table cell's text does: a consumer draws it, so a round
    // trip that did not list it would be comparing against a shorter document
    // than the one produced.
    const runs = [...textRuns(xml), ...fromGraphicParts];
    slides.push({
      slideNumber: slides.length + 1,
      part,
      runs,
      paragraphs: [...paragraphs(xml), ...fromGraphicParts],
      text: runs.join(' ').replace(/\s+/g, ' ').trim(),
      shapes,
      media
    });
  }

  if (slides.length === 0) throw unsupported(NO_SLIDES_MESSAGE);

  const core = files['docProps/core.xml'];
  const title = core ? /<dc:title>([\s\S]*?)<\/dc:title>/.exec(strFromU8(core))?.[1] : undefined;

  return {
    slideWidth,
    slideHeight,
    ...(title !== undefined ? { title: decodeXmlText(title) } : {}),
    slides
  };
}

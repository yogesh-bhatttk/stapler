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
 * round-trip assertion fail loudly rather than pass falsely. Text content is
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
 * **Group shapes.** `<p:grpSp>` nests `<p:sp>`/`<p:pic>` children under the
 * group's own transform, and `shapesOf` below reports those children with their
 * *own* geometry, ignoring the group's — so a grouped shape's reported position
 * is wrong, not merely approximate. CNV-12's writer never emits a group, so
 * nothing this repo produces is affected, and every assertion in
 * `tests/unit/pdf-to-ppt.test.ts` reads a deck this codebase wrote. **CNV-13
 * must fix this before reading a deck a person authored**, because PowerPoint
 * groups shapes routinely. `runs`, `paragraphs` and `text` are unaffected: they
 * scan for `<a:t>` wherever it appears.
 *
 * Also not read (and not needed by CNV-12's round trip): slide layouts and
 * masters, so text that lives only in a placeholder inherited from a layout is
 * not reported; tables (`<a:tbl>` cell text *is* picked up by `<a:t>`, but not
 * its grid); charts; speaker notes; and per-run colour or font.
 */

import { corrupt, unsupported } from '../errors';

/** One shape on a slide, with the geometry PowerPoint actually stored. */
export interface PptxShape {
  kind: 'text' | 'picture';
  /** English Metric Units (914400 per inch), from `<a:off>`/`<a:ext>`. */
  x: number;
  y: number;
  cx: number;
  cy: number;
  /** `<a:xfrm rot>` in 60000ths of a degree. 0 when unrotated. */
  rot: number;
  /** A text shape's own text, runs joined. */
  text?: string;
  /** A picture's `<a:blip r:embed>` relationship id. */
  relationshipId?: string;
}

export interface PptxSlideMedia {
  relationshipId: string;
  /** Package part name, e.g. `ppt/media/image-1-1.png`. */
  part: string;
  byteLength: number;
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

/** Every `<a:t>` in `xml`, decoded, in document order. */
function textRuns(xml: string): string[] {
  return [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(match =>
    decodeXmlText(match[1])
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

/** `<a:xfrm>` geometry from a shape's XML, or zeros when it declares none. */
function transformOf(xml: string): { x: number; y: number; cx: number; cy: number; rot: number } {
  const xfrm = /<a:xfrm(\s[^>]*)?>([\s\S]*?)<\/a:xfrm>/.exec(xml);
  if (!xfrm) return { x: 0, y: 0, cx: 0, cy: 0, rot: 0 };
  const rot = xfrm[1] ? numericAttribute(xfrm[1], 'rot') : 0;
  const off = /<a:off\b[^>]*\/?>/.exec(xfrm[2]);
  const ext = /<a:ext\b[^>]*\/?>/.exec(xfrm[2]);
  return {
    x: off ? numericAttribute(off[0], 'x') : 0,
    y: off ? numericAttribute(off[0], 'y') : 0,
    cx: ext ? numericAttribute(ext[0], 'cx') : 0,
    cy: ext ? numericAttribute(ext[0], 'cy') : 0,
    rot
  };
}

/** Text shapes and pictures on one slide, in the order the slide paints them. */
function shapesOf(xml: string): PptxShape[] {
  const out: PptxShape[] = [];
  // One pass over both element names, so painting order is preserved — which is
  // what decides whether text sits over or under a picture.
  const pattern = /<p:(sp|pic)(?:\s[^>]*)?>([\s\S]*?)<\/p:\1>/g;
  for (const match of xml.matchAll(pattern)) {
    const body = match[2];
    const geometry = transformOf(body);
    if (match[1] === 'pic') {
      const blip = /<a:blip\b[^>]*\/?>/.exec(body);
      out.push({
        kind: 'picture',
        ...geometry,
        ...(blip ? { relationshipId: attribute(blip[0], 'r:embed') ?? '' } : {})
      });
      continue;
    }
    const text = textRuns(body).join('');
    out.push({ kind: 'text', ...geometry, text });
  }
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
export async function readPptx(bytes: Uint8Array): Promise<PptxDeck> {
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
  for (const match of (idList?.[1] ?? '').matchAll(/<p:sldId\b[^>]*\/?>/g)) {
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
      media.push({
        relationshipId: id,
        part: mediaPart,
        byteLength: files[mediaPart]?.length ?? 0
      });
    }

    const runs = textRuns(xml);
    slides.push({
      slideNumber: slides.length + 1,
      part,
      runs,
      paragraphs: paragraphs(xml),
      text: runs.join(' ').replace(/\s+/g, ' ').trim(),
      shapes: shapesOf(xml),
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

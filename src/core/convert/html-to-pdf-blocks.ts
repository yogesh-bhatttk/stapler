/**
 * CNV-09 — the generalized *block model for PDF output*, and the HTML → blocks pass.
 *
 * This is the mirror image of `blocks.ts`. That file answers "what structure does
 * this PDF page's geometry imply?"; this one answers "what structure does this
 * already-structured document declare?" — and the answer is far more reliable,
 * because a `.docx` really does contain headings, lists and tables rather than
 * positioned glyphs that resemble them.
 *
 * Two deliberate constraints shape this file:
 *
 *  • **No DOM.** Heavy work runs in a worker (CLAUDE.md), and a dedicated worker
 *    has no `DOMParser` — it is a `Window` API. So the parser below is a small
 *    tokenizer scoped to the HTML `mammoth` actually emits, which is
 *    machine-generated and narrow: `p`, `h1`–`h6`, `strong`/`em`, `ul`/`ol`/`li`,
 *    `table`/`tr`/`td`/`th`, `a`, `br`, and `img` with a `data:` URI. Anything it
 *    does not recognise is *recursed into* rather than dropped, so an unhandled
 *    wrapper element can never cost the user their text.
 *  • **No pdf-lib.** The layout engine that consumes this model lives in
 *    `pdf-block-layout.ts` and runs in the `process` worker, where pdf-lib
 *    already is. Keeping the model and the parser free of it is what lets the
 *    `convert` worker (which owns `mammoth`) produce blocks without a second
 *    copy of pdf-lib entering the build — the same library-split rule
 *    `workers/index.ts` states.
 *
 * The block model is deliberately a *superset* of `blocks.ts`'s `DocxBlock`
 * rather than a parallel invention: `StyledRun` extends CNV-08's `DocxRun`, so a
 * model produced for the Word writer flows into this layout engine unchanged
 * apart from tables (which carry runs here, not plain strings). CNV-11 and CNV-13
 * are planned against this same model, which is why nothing below mentions Word.
 */

// Type-only: `blocks.ts` pulls in `text-layout` and OCR-03's table clustering at
// runtime, and neither is wanted in the process worker just to name a run type.
import type { DocxRun } from './blocks';

/**
 * A run of text with the attributes this engine can actually draw.
 *
 * Extends CNV-08's `DocxRun` (`{ text, bold, italic }`) rather than redeclaring
 * it, so `DocxRun[]` is assignable here and the two directions cannot drift.
 * `href` is the one addition: a Word hyperlink whose URL was thrown away would be
 * a silent loss of content the source document had.
 */
export interface StyledRun extends DocxRun {
  /** Target of the hyperlink this run sits inside, if any. */
  href?: string;
}

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** The raster formats pdf-lib can embed. Anything else is refused and reported. */
export type PdfImageFormat = 'png' | 'jpg';

export type LayoutBlock =
  | { kind: 'heading'; level: HeadingLevel; runs: StyledRun[] }
  | { kind: 'paragraph'; runs: StyledRun[] }
  | {
      kind: 'list-item';
      ordered: boolean;
      /** Rendered bullet or number, e.g. `•` or `3.` — decided at parse time. */
      marker: string;
      /** 0 for a top-level list, 1 for a list nested inside it, and so on. */
      depth: number;
      runs: StyledRun[];
    }
  /**
   * Cells carry runs, not strings. CNV-08's `DocxBlock` models a table as
   * `string[][]` and states the resulting loss of bold/italic inside a cell as a
   * limitation; there is no reason to inherit that here, because the source
   * document says outright which cell text is bold.
   */
  | {
      kind: 'table';
      rows: StyledRun[][][];
      /**
       * CNV-11 — relative column widths, one per column, in any consistent unit.
       *
       * Absent (the CNV-08/CNV-09 case) the layout engine divides the content
       * width equally, which is what HTML gives it: `mammoth` reports no column
       * geometry, so an equal split is the only honest reading of a `.docx`
       * table. A spreadsheet *does* state its column widths, and a grid drawn
       * with them is far closer to what the user is converting — so the engine
       * normalises these to the content width when they are present. Relative,
       * not absolute, because the page size (and therefore the content width) is
       * the layout engine's business, not the producer's.
       */
      columnWidths?: number[];
    }
  | {
      kind: 'image';
      data: Uint8Array;
      format: PdfImageFormat;
      altText: string;
    }
  /**
   * CNV-13 — a whole page of *positioned* content, drawn on a page of its own.
   *
   * Every other block in this model flows: the engine stacks it under the last
   * one and breaks a page when it runs out of room. A slide does not flow. Its
   * shapes have coordinates, two of them can sit side by side, and the thing a
   * reader recognises as "the slide" is the arrangement rather than the reading
   * order — so flowing a deck's text down an A4 page would be a different
   * document, not a lower-fidelity version of the same one. This block is
   * therefore not "a slide": it is the general case of *one page laid out by the
   * producer*, and nothing in it names PowerPoint.
   *
   * One canvas is one page. The engine starts a fresh page for it and leaves it
   * full afterwards, which is what makes "one PDF page per slide" a structural
   * property of the model rather than a coincidence of how much text fits.
   */
  | {
      kind: 'canvas';
      /**
       * The canvas's own coordinate space, in points, **origin at the top-left
       * with y increasing downward** — which is what every producer of
       * positioned content (OOXML, HTML, a screen) uses, and the opposite of
       * PDF user space. The single y flip lives in the layout engine, so no
       * producer does page geometry (see `pdf-block-layout.ts`'s `drawCanvas`).
       */
      width: number;
      height: number;
      /**
       * Painted in order: item 0 is at the bottom. The producer states the
       * z-order because only it knows one.
       */
      items: CanvasItem[];
      /** What the preview calls this page, e.g. `Slide 3`. */
      label: string;
      /** The canvas's leading text, for the preview row. */
      text: string;
    };

/** Where one item sits on a canvas, in the canvas's own top-left-origin space. */
export interface CanvasBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A positioned run of text.
 *
 * `fontSize` is in the canvas's own points; the engine scales it by exactly the
 * factor it scales the geometry by, so a canvas fitted to a different page size
 * stays a uniform reduction of itself rather than a re-layout.
 */
export interface CanvasTextItem extends CanvasBox {
  kind: 'text';
  runs: StyledRun[];
  fontSize: number;
  align: 'left' | 'center' | 'right';
}

export interface CanvasImageItem extends CanvasBox {
  kind: 'image';
  data: Uint8Array;
  format: PdfImageFormat;
  altText: string;
  /**
   * A stable name for the *source* of these bytes, when the producer has one.
   *
   * Two canvases showing the same picture hand over the same id, and the engine
   * embeds it once — the encode-once rule this codebase applies to a shared
   * image everywhere else (CNV-06, CMP-03, `pptx-writer.ts`'s media dedup). An
   * id is an identity claim, so it must never be reused for different bytes.
   */
  id?: string;
}

/** A positioned grid. Column widths and row heights are in canvas points. */
export interface CanvasTableItem extends CanvasBox {
  kind: 'table';
  columnWidths: number[];
  rowHeights: number[];
  rows: StyledRun[][][];
  fontSize: number;
}

export type CanvasItem = CanvasTextItem | CanvasImageItem | CanvasTableItem;

/** What the parser produced, plus everything it could not carry across. */
export interface ParsedHtmlBlocks {
  blocks: LayoutBlock[];
  /**
   * Content that was recognised and deliberately not converted, each with the
   * reason. Surfaced in the UI — a silently dropped image is exactly the failure
   * mode this product's error philosophy exists to prevent.
   */
  notes: string[];
}

/* ------------------------------------------------------------------ *
 * A very small HTML tokenizer
 * ------------------------------------------------------------------ */

interface ElementNode {
  type: 'element';
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
}

interface TextNode {
  type: 'text';
  text: string;
}

type HtmlNode = ElementNode | TextNode;

/** Elements that never have a closing tag. */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr'
]);

/**
 * Elements an *identical* sibling implicitly closes. `mammoth` always closes its
 * tags, so this only ever matters for hand-written or third-party HTML reaching
 * the same engine later (CNV-11/CNV-13) — but an unclosed `<li>` nesting every
 * subsequent item inside the first would be a silently mangled document, which is
 * worth four lines to prevent.
 */
const SELF_CLOSING_SIBLINGS = new Set(['li', 'p', 'td', 'th', 'tr', 'dt', 'dd', 'option']);

/**
 * Matches one tag. Attribute values are allowed to contain `>` as long as they
 * are quoted, which a naive `<[^>]*>` would break on.
 */
const TAG_PATTERN =
  /<(\/?)\s*([a-zA-Z][\w:-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)\s*>/g;

const ATTR_PATTERN = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  // `mammoth` emits none of these, but a style map or a future producer can.
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”'
};

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      // Surrogates and out-of-range values would throw; leaving the entity as
      // written is more honest than emitting a replacement character.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!source.trim()) return attrs;
  ATTR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_PATTERN.exec(source)) !== null) {
    const name = match[1].toLowerCase();
    if (!name) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/** Parses the HTML into a node tree. Never throws: malformed markup degrades. */
export function parseHtml(html: string): HtmlNode[] {
  // Comments and doctypes/CDATA carry nothing this engine draws, and leaving
  // them in would let a `<` inside one open a bogus element.
  const source = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<![\s\S]*?>/g, '');

  const root: ElementNode = { type: 'element', tag: '#root', attrs: {}, children: [] };
  const stack: ElementNode[] = [root];
  const top = () => stack[stack.length - 1];

  const pushText = (raw: string) => {
    if (raw.length === 0) return;
    top().children.push({ type: 'text', text: decodeEntities(raw) });
  };

  TAG_PATTERN.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = TAG_PATTERN.exec(source)) !== null) {
    pushText(source.slice(cursor, match.index));
    cursor = TAG_PATTERN.lastIndex;

    const closing = match[1] === '/';
    const tag = match[2].toLowerCase();
    const selfClosed = match[4] === '/';

    if (closing) {
      // Pop to the *innermost* matching open element. Searching from the top
      // matters: `<li>a<ul><li>b</li></ul></li>` has two open `li`s, and closing
      // the outer one first would strand every following item outside its list.
      // An unmatched close tag is ignored rather than unwinding the whole stack.
      let at = -1;
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          at = i;
          break;
        }
      }
      if (at > 0) stack.length = at;
      continue;
    }

    if (top().tag === tag && SELF_CLOSING_SIBLINGS.has(tag)) stack.pop();

    const element: ElementNode = {
      type: 'element',
      tag,
      attrs: parseAttrs(match[3]),
      children: []
    };
    top().children.push(element);
    if (!selfClosed && !VOID_TAGS.has(tag)) stack.push(element);
  }

  pushText(source.slice(cursor));
  return root.children;
}

/* ------------------------------------------------------------------ *
 * Node tree → blocks
 * ------------------------------------------------------------------ */

const HEADINGS: Record<string, HeadingLevel> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
const BOLD_TAGS = new Set(['strong', 'b']);
const ITALIC_TAGS = new Set(['em', 'i', 'cite', 'var', 'dfn']);
/** Elements whose own box we ignore, walking straight into their children. */
const TRANSPARENT_BLOCKS = new Set([
  'body',
  'html',
  'div',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'aside',
  'nav',
  'figure',
  'figcaption',
  'blockquote',
  'form',
  'fieldset'
]);

/**
 * Word's own nesting sequence is `•`, `o`, `▪`. The third is dropped here in
 * favour of a hyphen because `▪` (and `◦`) are outside WinAnsi, so the standard
 * fonts this engine draws with cannot represent them: `markdown-to-pdf.ts`'s
 * sanitiser would replace each with `?` *and* raise the "some characters could
 * not be represented" warning — on a document whose own text was fine. A marker
 * the renderer can actually draw beats a faithful one it has to substitute.
 */
const BULLETS = ['•', 'o', '-'];

interface RunStyle {
  bold: boolean;
  italic: boolean;
  href?: string;
}

interface InlineResult {
  runs: StyledRun[];
  /** Images found inside inline content — `mammoth` wraps every one in a `<p>`. */
  images: LayoutBlock[];
}

/**
 * How many indent levels this engine draws. Word itself offers nine list levels,
 * so a document *can* nest deeper than this — see {@link DEEP_LIST_NOTE} for what
 * happens then, which is emphatically not "the text is dropped".
 */
export const MAX_LIST_DEPTH = 8;

/**
 * What a list deeper than {@link MAX_LIST_DEPTH} costs the user: its indentation,
 * never its text.
 *
 * Pushed into `notes` the same way an image this engine cannot embed is — the
 * established pattern in this file for "recognised, carried across imperfectly,
 * and said so". Silently returning early instead (which is what this used to do)
 * deleted every item below level 8 with nothing anywhere to say so.
 */
export const DEEP_LIST_NOTE =
  `A list nested more than ${MAX_LIST_DEPTH} levels deep was flattened: items below level ` +
  `${MAX_LIST_DEPTH} are drawn at level ${MAX_LIST_DEPTH}. All of their text is in the PDF — ` +
  'only the extra indentation is not.';

/**
 * Collapses whitespace, merges adjacent runs that share a style, and trims the
 * outer edges — the same normalisation `blocks.ts`'s `lineRuns` applies, minus
 * the geometry, since HTML states word boundaries outright.
 *
 * `\n` (from `<br />`) is preserved: the layout engine treats it as a hard break
 * inside the paragraph rather than as whitespace to be collapsed away.
 */
export function normalizeRuns(runs: readonly StyledRun[]): StyledRun[] {
  const out: StyledRun[] = [];
  for (const run of runs) {
    const text = run.text.replace(/[^\S\n]+/g, ' ');
    if (text.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.bold === run.bold && last.italic === run.italic && last.href === run.href) {
      last.text += text;
    } else {
      out.push({
        text,
        bold: run.bold,
        italic: run.italic,
        ...(run.href ? { href: run.href } : {})
      });
    }
  }
  if (out.length > 0) {
    out[0].text = out[0].text.replace(/^[^\S\n]+/, '');
    out[out.length - 1].text = out[out.length - 1].text.replace(/[^\S\n]+$/, '');
  }
  return out.filter(run => run.text.length > 0);
}

/** True when the runs hold nothing a reader would see. */
function isBlank(runs: readonly StyledRun[]): boolean {
  return runs.every(run => run.text.trim().length === 0);
}

const DATA_URI = /^data:([^;,]+)(;[^,]*)?,(.*)$/s;

/** `data:image/png;base64,…` → bytes, or null when it is not one we can embed. */
function decodeDataUri(src: string): { data: Uint8Array; mime: string } | null {
  const match = DATA_URI.exec(src);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const isBase64 = (match[2] ?? '').toLowerCase().includes('base64');
  if (!isBase64) return null;
  try {
    // `atob` exists in workers and in Node ≥16; the alternative would be pulling
    // a base64 decoder in for a job the platform already does.
    const binary = atob(match[3].replace(/\s+/g, ''));
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
    return { data, mime };
  } catch {
    return null;
  }
}

function imageFormat(mime: string): PdfImageFormat | null {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  return null;
}

function describeImageRefusal(src: string, mime: string | null): string {
  if (mime === null) {
    return (
      'An image was left out: it is not stored inside the document as data ' +
      `(${src.slice(0, 40)}…), and this converter never fetches anything.`
    );
  }
  const kind = mime.replace(/^image\//, '').toUpperCase();
  return (
    `An image in ${kind} format was left out: a PDF can embed PNG and JPEG directly, and ` +
    're-encoding anything else would mean decoding a format this build carries no decoder for.'
  );
}

/**
 * Walks inline content, collecting runs and any images encountered.
 *
 * Images come back separately because `mammoth` writes every one as
 * `<p><img … /></p>` — an image is a block in the output even though it is an
 * inline element in the source.
 */
function inlineContent(nodes: readonly HtmlNode[], style: RunStyle, notes: string[]): InlineResult {
  const runs: StyledRun[] = [];
  const images: LayoutBlock[] = [];

  const visit = (list: readonly HtmlNode[], current: RunStyle) => {
    for (const node of list) {
      if (node.type === 'text') {
        runs.push({
          text: node.text,
          bold: current.bold,
          italic: current.italic,
          ...(current.href ? { href: current.href } : {})
        });
        continue;
      }

      if (node.tag === 'br') {
        runs.push({ text: '\n', bold: current.bold, italic: current.italic });
        continue;
      }

      if (node.tag === 'img') {
        const src = node.attrs.src ?? '';
        const decoded = decodeDataUri(src);
        const format = decoded ? imageFormat(decoded.mime) : null;
        if (decoded && format) {
          images.push({
            kind: 'image',
            data: decoded.data,
            format,
            altText: node.attrs.alt ?? 'Image from the Word document'
          });
        } else {
          notes.push(describeImageRefusal(src, decoded?.mime ?? null));
        }
        continue;
      }

      // Unknown inline elements (span, u, sup, sub, small, …) contribute their
      // children and nothing else. Underline and super/subscript are not drawn:
      // pdf-lib's `drawText` has no underline, and faking one with a rule would
      // be a guess at a baseline offset. Stated in the panel copy, not silent.
      const next: RunStyle = {
        bold: current.bold || BOLD_TAGS.has(node.tag),
        italic: current.italic || ITALIC_TAGS.has(node.tag),
        href: node.tag === 'a' && node.attrs.href ? node.attrs.href : current.href
      };
      visit(node.children, next);
    }
  };

  visit(nodes, style);
  return { runs: normalizeRuns(runs), images };
}

/** The `tr` elements of a table, whether or not it uses `thead`/`tbody`. */
function tableRows(node: ElementNode): ElementNode[] {
  const rows: ElementNode[] = [];
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    if (child.tag === 'tr') rows.push(child);
    else if (child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot') {
      for (const inner of child.children) {
        if (inner.type === 'element' && inner.tag === 'tr') rows.push(inner);
      }
    }
  }
  return rows;
}

/**
 * One cell's runs. `mammoth` wraps cell content in `<p>`, and a cell may hold
 * several — they are joined with a space rather than becoming separate blocks,
 * because a table cell in this engine is one wrapped text box.
 */
function cellRuns(cell: ElementNode, notes: string[]): StyledRun[] {
  const collected: StyledRun[] = [];
  const paragraphs = cell.children.filter(
    (node): node is ElementNode => node.type === 'element' && node.tag === 'p'
  );

  if (paragraphs.length === 0) {
    const { runs, images } = inlineContent(cell.children, { bold: false, italic: false }, notes);
    if (images.length > 0) {
      notes.push('An image inside a table cell was left out: cells hold text only.');
    }
    return runs;
  }

  for (const paragraph of paragraphs) {
    const { runs, images } = inlineContent(
      paragraph.children,
      { bold: false, italic: false },
      notes
    );
    if (images.length > 0) {
      notes.push('An image inside a table cell was left out: cells hold text only.');
    }
    if (runs.length === 0) continue;
    if (collected.length > 0) collected.push({ text: ' ', bold: false, italic: false });
    collected.push(...runs);
  }
  return normalizeRuns(collected);
}

/** Emits the blocks for one `<ul>`/`<ol>`, recursing into nested lists. */
function listBlocks(node: ElementNode, depth: number, notes: string[]): LayoutBlock[] {
  const blocks: LayoutBlock[] = [];
  const ordered = node.tag === 'ol';
  const start = Number.parseInt(node.attrs.start ?? '', 10);
  let index = Number.isFinite(start) ? start : 1;

  for (const child of node.children) {
    if (child.type !== 'element' || child.tag !== 'li') continue;

    // A nested list is a sibling of the item's own text in mammoth's output, so
    // it is pulled out before the item's inline content is read.
    const nested = child.children.filter(
      (n): n is ElementNode => n.type === 'element' && (n.tag === 'ul' || n.tag === 'ol')
    );
    const own = child.children.filter(n => !nested.includes(n as ElementNode));

    const { runs, images } = inlineContent(own, { bold: false, italic: false }, notes);
    const marker = ordered ? `${index}.` : BULLETS[Math.min(depth, BULLETS.length - 1)];
    if (!isBlank(runs)) {
      blocks.push({ kind: 'list-item', ordered, marker, depth, runs });
      index += 1;
    }
    blocks.push(...images);

    // A list deeper than the indent limit is *flattened*, not skipped: its items
    // are emitted at the deepest level this engine draws. Returning early here
    // (the original shape of this line) dropped their text with no block and no
    // note — the one failure mode this file's contract rules out outright, and a
    // reachable one, since Word offers nine list levels to this engine's eight.
    const innerDepth = Math.min(depth + 1, MAX_LIST_DEPTH - 1);
    if (nested.length > 0 && innerDepth === depth && !notes.includes(DEEP_LIST_NOTE)) {
      notes.push(DEEP_LIST_NOTE);
    }
    for (const inner of nested) blocks.push(...listBlocks(inner, innerDepth, notes));
  }
  return blocks;
}

/**
 * Turns `mammoth`'s HTML into the layout block model.
 *
 * Structure is read from the markup, never guessed: a heading is a heading
 * because the source said `<h2>`, not because its type size cleared a ratio.
 * That is the whole reason this direction is more faithful than CNV-08's.
 */
export function parseHtmlBlocks(html: string): ParsedHtmlBlocks {
  const notes: string[] = [];
  const blocks: LayoutBlock[] = [];

  const walk = (nodes: readonly HtmlNode[]) => {
    for (const node of nodes) {
      if (node.type === 'text') {
        // Loose text between blocks — whitespace in practice, but if a producer
        // ever emits real text here it becomes a paragraph rather than vanishing.
        if (node.text.trim().length === 0) continue;
        blocks.push({
          kind: 'paragraph',
          runs: normalizeRuns([{ text: node.text, bold: false, italic: false }])
        });
        continue;
      }

      const heading = HEADINGS[node.tag];
      if (heading !== undefined) {
        const { runs, images } = inlineContent(
          node.children,
          { bold: false, italic: false },
          notes
        );
        if (!isBlank(runs)) blocks.push({ kind: 'heading', level: heading, runs });
        blocks.push(...images);
        continue;
      }

      if (node.tag === 'p') {
        const { runs, images } = inlineContent(
          node.children,
          { bold: false, italic: false },
          notes
        );
        // An empty `<p>` is Word's spacer paragraph. Dropping it costs a blank
        // line of rhythm; keeping it would fill the preview with empty rows.
        if (!isBlank(runs)) blocks.push({ kind: 'paragraph', runs });
        blocks.push(...images);
        continue;
      }

      if (node.tag === 'ul' || node.tag === 'ol') {
        blocks.push(...listBlocks(node, 0, notes));
        continue;
      }

      if (node.tag === 'table') {
        const rows = tableRows(node).map(row =>
          row.children
            .filter(
              (cell): cell is ElementNode =>
                cell.type === 'element' && (cell.tag === 'td' || cell.tag === 'th')
            )
            .map(cell => cellRuns(cell, notes))
        );
        const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
        if (rows.length > 0 && columnCount > 0) {
          // Short rows are padded so the grid is rectangular — the layout engine
          // divides the column width by a single count, and a ragged row would
          // otherwise draw its cells at the wrong x.
          blocks.push({
            kind: 'table',
            rows: rows.map(row =>
              Array.from({ length: columnCount }, (_, index) => row[index] ?? [])
            )
          });
        }
        continue;
      }

      if (node.tag === 'img') {
        const { images } = inlineContent([node], { bold: false, italic: false }, notes);
        blocks.push(...images);
        continue;
      }

      if (node.tag === 'br' || node.tag === 'hr') continue;

      if (TRANSPARENT_BLOCKS.has(node.tag)) {
        walk(node.children);
        continue;
      }

      // Anything unrecognised: walk into it as block content. Its text reaches
      // the PDF as paragraphs rather than being dropped for want of a rule.
      walk(node.children);
    }
  };

  walk(parseHtml(html));
  return { blocks, notes };
}

/* ------------------------------------------------------------------ *
 * The mandatory preview (PLAN §5.5)
 * ------------------------------------------------------------------ */

/**
 * One row of the preview the user must see before the save button unlocks.
 *
 * Like CNV-08's `DocxPreviewItem`, this is a *description* of the output rather
 * than the model itself — carrying every image's bytes into the UI would copy
 * megabytes for something that renders as one line of text. It is built by the
 * layout engine from the very blocks the PDF was drawn from, so the preview and
 * the file cannot describe different documents.
 */
export interface PdfPreviewItem {
  /** 0-based page of the *produced PDF* the block was drawn on. */
  pageIndex: number;
  kind: LayoutBlock['kind'];
  /** Heading level, for a heading. */
  level?: HeadingLevel;
  /** The block's text, or a size summary for a table or an image. */
  text: string;
}

/** How much of a paragraph the preview shows before eliding it. */
const PREVIEW_TEXT_LIMIT = 160;

export function elide(text: string): string {
  return text.length <= PREVIEW_TEXT_LIMIT
    ? text
    : `${text.slice(0, PREVIEW_TEXT_LIMIT - 1).trimEnd()}…`;
}

/** Flattens a block's runs back to plain text, for the preview and for tests. */
export function runsToText(runs: readonly StyledRun[]): string {
  return runs
    .map(run => run.text)
    .join('')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * CNV-13 — PowerPoint (PPTX) → PDF, graded against real output bytes.
 *
 * The acceptance criterion names its own verification method: a multi-slide
 * fixture (text, at least one image, one slide with a table) must produce "a PDF
 * with one page per slide, all slide text present, verified against the source
 * deck's own text content". So the round trip below runs the production pipeline
 * end to end, reads the *source deck's* text back out with `pptx-reader.ts`, and
 * reads the *produced PDF's* text back out with `extractDocumentText` — the same
 * `layoutText` path the Extract tool ships (CNV-04). Neither side is a copy of
 * the model the PDF was drawn from, so nothing here grades intent.
 *
 * Same worker arrangement as `excel-to-pdf.test.ts`, and for the same reason:
 * `vi.mock('comlink')` makes the worker modules importable in Node (each calls
 * `Comlink.expose` at import time), and `vi.mock('../../src/core/workers')`
 * leases the **real** worker implementations in place of real `Worker`s. The
 * function under test is therefore `operations.convertPptxToPdf` itself — its
 * own sequencing, its own progress bands, its own refusal behaviour — not a
 * re-implementation of it.
 *
 * **The geometry assertions are the point of this file.** OOXML measures from a
 * slide's top-left with y increasing downward; a PDF page measures from its
 * bottom-left with y increasing upward. A converter that forgets the flip
 * produces a file where every assertion made against its own model still passes
 * and every page is upside down. So the fixture puts a title at the deck's top
 * edge and a footer at its bottom edge, and the assertions below read where they
 * landed *out of the produced PDF* with pdf.js — CNV-12's own `extractPageSlide`,
 * which reports a line's baseline in the page's user space.
 *
 * What this file cannot prove is stated in the ticket's Status line: nothing here
 * opens Acrobat, Preview, PowerPoint or Chrome's viewer.
 */
import { describe, expect, it, vi } from 'vitest';
import { strToU8, unzlibSync, zipSync } from 'fflate';
import { PDFArray, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { PPT_TO_PDF, pptToPdfPptx } from '../e2e/fixtures';
import {
  BLANK_SLIDE_LABEL,
  DEFAULT_FONT_POINTS,
  DEFAULT_SLIDE_POINTS,
  EMU_PER_POINT,
  MAX_ITEMS_PER_SLIDE,
  MAX_SLIDES,
  PPTX_EMPTY_DECK_MESSAGE,
  PPT_LIMITATIONS,
  autoNumberedNote,
  blankSlidesNote,
  deckToBlocks,
  defaultSizeNote,
  emptyTableNote,
  graphicFrameNote,
  imageFormatOf,
  itemCapNote,
  missingImageNote,
  rotatedGroupNote,
  rotatedNote,
  slideCapNote,
  slideSizeNote,
  toPoints,
  unpositionedNote,
  unsupportedImageNote
} from '../../src/core/convert/pptx-slides';
import {
  EMPTY_FILE_MESSAGE,
  MAX_GRAPHIC_TEXT_RUNS,
  NOT_A_PRESENTATION_MESSAGE,
  NOT_A_ZIP_MESSAGE,
  NO_SLIDES_MESSAGE,
  OLE2_MESSAGE,
  childElements,
  graphicPartText,
  readPptx,
  type PptxDeck
} from '../../src/core/convert/pptx-reader';
import { clampPageBox } from '../../src/core/convert/pdf-block-layout';
import { StaplerError } from '../../src/core/errors';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));
vi.mock('../../src/core/workers/pdfjs-setup', async () => {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return {
    pdfjsLib,
    openDocument: ({ data, password }: { data: Uint8Array; password?: string }) =>
      pdfjsLib.getDocument({ data, password, disableFontFace: true })
  };
});

/** How many times the layout engine was reached. A refusal must leave this at 0. */
let layoutCalls = 0;

vi.mock('../../src/core/workers', async () => {
  const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
  const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
  const { convertWorkerImpl } = await import('../../src/core/workers/convert.worker');
  type Bytes = Uint8Array;

  // `.slice()` stands in for the structured clone the real Comlink boundary
  // performs — pdf.js takes ownership of (and detaches) what `loadDocument` is
  // given, which would otherwise poison a second read of the same array.
  const renderApi = {
    loadDocument: (bytes: Bytes, password?: string) =>
      renderWorkerImpl.loadDocument(bytes.slice(), password),
    extractText: (handle: string, pageIndex: number, mode: 'text' | 'markdown') =>
      renderWorkerImpl.extractText(handle, pageIndex, mode),
    extractPageSlide: (handle: string, pageIndex: number) =>
      renderWorkerImpl.extractPageSlide(handle, pageIndex),
    closeDocument: (handle: string) => renderWorkerImpl.closeDocument(handle)
  };
  const processApi = {
    layoutBlocksToPdf: (...args: Parameters<typeof processWorkerImpl.layoutBlocksToPdf>) => {
      layoutCalls++;
      return processWorkerImpl.layoutBlocksToPdf(...args);
    }
  };
  const convertApi = {
    pptxToBlocks: (bytes: Bytes, job?: Parameters<typeof convertWorkerImpl.pptxToBlocks>[1]) =>
      convertWorkerImpl.pptxToBlocks(bytes.slice(), job)
  };
  const leaseOn =
    <T>(target: T) =>
    (fn: (api: T) => Promise<unknown>) =>
      fn(target);
  return {
    renderWorker: {
      lease: leaseOn(renderApi),
      pin: () => ({ lease: leaseOn(renderApi), release: () => {} })
    },
    processWorker: { lease: leaseOn(processApi) },
    cvWorker: { lease: leaseOn({}) },
    ocrWorker: { lease: leaseOn({}) },
    convertWorker: { lease: leaseOn(convertApi) }
  };
});

const { convertPptxToPdf, extractDocumentText } = await import('../../src/core/operations');
const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');

type Converted = Awaited<ReturnType<typeof convertPptxToPdf>> & { progress: number[] };

/** The production entry point, nothing else. */
async function convert(
  bytes: Uint8Array,
  options: Partial<Parameters<typeof convertPptxToPdf>[1]> = {},
  jobOptions: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}
): Promise<Converted> {
  const progress: number[] = [];
  const result = await convertPptxToPdf(
    bytes,
    { pageSize: 'slide', ...options },
    {
      ...(jobOptions.signal ? { signal: jobOptions.signal } : {}),
      onProgress: fraction => {
        progress.push(fraction ?? 0);
        jobOptions.onProgress?.(fraction ?? 0);
      }
    }
  );
  return { ...result, progress };
}

/**
 * Page-by-page text of a produced PDF, read back through CNV-04's own
 * extraction — the same path the Extract tool ships, one page at a time so the
 * per-page assertions are about the page and not about a joined blob.
 */
async function pagesOf(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes.slice());
  const pages: string[] = [];
  for (let i = 0; i < doc.getPageCount(); i++) {
    pages.push(await extractDocumentText(bytes.slice(), [i], 'text'));
  }
  return pages;
}

/** One page's content stream, inflated, as text. */
function contentOf(doc: PDFDocument, pageIndex: number): string {
  const contents = doc.getPage(pageIndex).node.Contents();
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map(ref => doc.context.lookup(ref))
      : [contents];
  let body = '';
  for (const stream of streams) {
    if (!(stream instanceof PDFRawStream)) continue;
    const filter = stream.dict.get(PDFName.of('Filter'))?.toString() ?? '';
    const raw = stream.getContents();
    body += new TextDecoder('latin1').decode(
      filter.includes('FlateDecode') ? unzlibSync(raw) : raw
    );
  }
  return body;
}

/** One page's positioned lines, straight out of pdf.js. */
async function linesOf(bytes: Uint8Array, pageIndex: number) {
  const { handle } = await renderWorkerImpl.loadDocument(bytes.slice());
  try {
    return await renderWorkerImpl.extractPageSlide(handle, pageIndex);
  } finally {
    await renderWorkerImpl.closeDocument(handle);
  }
}

/** How many image XObjects the produced file actually holds. */
function imageObjectCount(doc: PDFDocument): number {
  let count = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    if (object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) count += 1;
  }
  return count;
}

/* ------------------------------------------------------------------ *
 * Hand-built packages, for the cases no writer produces
 * ------------------------------------------------------------------ */

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** A one-slide package whose slide XML is supplied verbatim. */
function packageWith(
  slideXml: string,
  extras: Record<string, string> = {},
  size = { cx: 9144000, cy: 6858000 }
): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'ppt/presentation.xml': strToU8(
      `<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>` +
        `<p:sldSz cx="${size.cx}" cy="${size.cy}"/></p:presentation>`
    ),
    'ppt/_rels/presentation.xml.rels': strToU8(
      '<Relationships><Relationship Id="rId1" Type="slide" Target="slides/slide1.xml"/>' +
        '</Relationships>'
    ),
    'ppt/slides/slide1.xml': strToU8(
      `<p:sld ${NS}><p:cSld><p:spTree>${slideXml}</p:spTree></p:cSld></p:sld>`
    )
  };
  for (const [name, content] of Object.entries(extras)) files[name] = strToU8(content);
  return zipSync(files);
}

function textShape(text: string, x: number, y: number, extra = '', rPr = '<a:rPr lang="en"/>') {
  return (
    `<p:sp><p:spPr><a:xfrm ${extra}><a:off x="${x}" y="${y}"/><a:ext cx="2000000" cy="500000"/>` +
    `</a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r>${rPr}<a:t>${text}</a:t></a:r></a:p>` +
    '</p:txBody></p:sp>'
  );
}

/** A deck object, for the pure mapping tests, without going near a ZIP. */
function deckOf(shapes: PptxDeck['slides'][number]['shapes'], text = 'Slide text'): PptxDeck {
  return {
    slideWidth: 9144000,
    slideHeight: 6858000,
    slides: [
      {
        slideNumber: 1,
        part: 'ppt/slides/slide1.xml',
        runs: [text],
        paragraphs: [text],
        text,
        shapes,
        media: []
      }
    ]
  };
}

/* ================================================================== *
 * AC 1 — one page per slide, all slide text present
 * ================================================================== */

describe('CNV-13 — the round trip, against the produced PDF', () => {
  it('produces one page per slide, at the deck’s own slide size', async () => {
    const deckBytes = await pptToPdfPptx();
    const result = await convert(deckBytes.slice());

    expect(result.slideCount).toBe(4);
    expect(result.pageCount).toBe(4);

    // Re-parsed, not trusted: the page count and the page boxes come from the
    // bytes that would be written to disk.
    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getPageCount()).toBe(4);
    for (let i = 0; i < 4; i++) {
      const { width, height } = doc.getPage(i).getSize();
      expect(width).toBeCloseTo(PPT_TO_PDF.slide.widthPt, 1);
      expect(height).toBeCloseTo(PPT_TO_PDF.slide.heightPt, 1);
    }
  }, 60_000);

  it('puts every slide’s own text on the matching page, and no other page', async () => {
    const deckBytes = await pptToPdfPptx();
    // The source side of the comparison is read independently of the conversion,
    // out of the same file, by the reader CNV-12 shipped.
    const deck = await readPptx(deckBytes.slice());
    const result = await convert(deckBytes.slice());
    const pages = await pagesOf(result.bytes);

    expect(pages).toHaveLength(deck.slides.length);
    for (const slide of deck.slides) {
      const page = pages[slide.slideNumber - 1];
      for (const run of slide.runs) {
        const wanted = run.trim();
        if (wanted.length === 0) continue;
        // Whitespace is the only thing allowed to differ: a wrapped line in the
        // PDF carries a newline where the deck had a space.
        expect(page.replace(/\s+/g, ' ')).toContain(wanted.replace(/\s+/g, ' '));
      }
    }

    // …and slide 3's table text is on page 3 only, which is what makes "one page
    // per slide" a claim about placement rather than about a page count.
    expect(pages[2]).toContain('Committed');
    expect(pages[0]).not.toContain('Committed');
    expect(pages[3]).not.toContain('Committed');
  }, 60_000);

  it('keeps every cell of the table on slide three, in reading order', async () => {
    const result = await convert((await pptToPdfPptx()).slice());
    const page = (await pagesOf(result.bytes))[2].replace(/\s+/g, ' ');
    for (const row of PPT_TO_PDF.slide3.table) {
      for (const cell of row) expect(page).toContain(cell);
    }
    // Row order: the header's first cell precedes the last row's last cell.
    expect(page.indexOf('Region')).toBeLessThan(page.indexOf('At risk'));
    expect(result.slides[2].tables).toBe(1);
  }, 60_000);

  it('keeps the bulleted list’s marker as well as its text', async () => {
    const result = await convert((await pptToPdfPptx()).slice());
    const page = (await pagesOf(result.bytes))[0];
    for (const bullet of PPT_TO_PDF.slide1.bullets) {
      expect(page.replace(/\s+/g, ' ')).toContain(bullet);
    }
    // The deck's marker survives as a marker, though not as the same glyph:
    // `markdown-to-pdf.ts`'s shared WinAnsi sanitiser rewrites `•` to `-` for
    // every tool in this codebase (CNV-09's own list markers included), so the
    // substitution is the app's existing, deliberate one rather than a loss
    // introduced here. Each bulleted line starts with it.
    for (const bullet of PPT_TO_PDF.slide1.bullets) {
      expect(page.replace(/\s+/g, ' ')).toContain(`- ${bullet}`);
    }
    // …and nothing was replaced with `?`, which is what an unrepresentable
    // character would have produced.
    expect(result.hadUnsupportedCharacters).toBe(false);
    expect(page).not.toContain('?');
  }, 60_000);
});

/* ================================================================== *
 * The geometry: EMU → points, and the y flip
 * ================================================================== */

describe('CNV-13 — slide coordinates land where the deck put them', () => {
  it('draws the top-edge title near the top of the page and the footer near the bottom', async () => {
    const result = await convert((await pptToPdfPptx()).slice());
    const page = await linesOf(result.bytes, 0);
    expect(page.box.height).toBeCloseTo(PPT_TO_PDF.slide.heightPt, 1);

    const title = page.lines.find(line =>
      line.runs
        .map(run => run.text)
        .join('')
        .includes(PPT_TO_PDF.slide1.title)
    );
    const footer = page.lines.find(line =>
      line.runs
        .map(run => run.text)
        .join('')
        .includes(PPT_TO_PDF.slide1.footer)
    );
    expect(title).toBeDefined();
    expect(footer).toBeDefined();

    // The deck puts the title 0.4in from the *top*. A PDF baseline is measured
    // from the *bottom*, so it has to land high. Drop the flip and this number
    // is ~29 instead of ~468 — which is the one failure an internally
    // consistent model can never catch.
    const expectedTitleBaseline =
      PPT_TO_PDF.slide.heightPt -
      PPT_TO_PDF.slide1.titleAt.y * 72 -
      PPT_TO_PDF.slide1.titleAt.size * 1.35;
    expect(title!.baseline).toBeCloseTo(expectedTitleBaseline, 0);
    expect(title!.baseline).toBeGreaterThan(PPT_TO_PDF.slide.heightPt * 0.8);

    const expectedFooterBaseline =
      PPT_TO_PDF.slide.heightPt -
      PPT_TO_PDF.slide1.footerAt.y * 72 -
      PPT_TO_PDF.slide1.footerAt.size * 1.35;
    expect(footer!.baseline).toBeCloseTo(expectedFooterBaseline, 0);
    expect(footer!.baseline).toBeLessThan(PPT_TO_PDF.slide.heightPt * 0.15);

    // x is *not* flipped, and is not offset either: the title starts at the
    // deck's own 0.6in.
    expect(title!.x).toBeCloseTo(PPT_TO_PDF.slide1.titleAt.x * 72, 0);
    // The type size is the deck's own, not a default.
    expect(title!.size).toBeCloseTo(PPT_TO_PDF.slide1.titleAt.size, 0);
  }, 60_000);

  it('honours a paragraph’s centre alignment', async () => {
    const result = await convert((await pptToPdfPptx()).slice());
    const page = await linesOf(result.bytes, 0);
    const centred = page.lines.find(line =>
      line.runs
        .map(run => run.text)
        .join('')
        .includes(PPT_TO_PDF.slide1.centred)
    );
    expect(centred).toBeDefined();

    const box = PPT_TO_PDF.slide1.centredAt;
    const left = box.x * 72;
    const expected = left + (box.w * 72 - centred!.width) / 2;
    expect(centred!.x).toBeCloseTo(expected, 0);
    // …and that is genuinely different from where a left-aligned box would put
    // it, so the assertion above is not satisfied by doing nothing.
    expect(centred!.x).toBeGreaterThan(left + 40);
  }, 60_000);

  it('places the picture at the rectangle the slide states', async () => {
    const result = await convert((await pptToPdfPptx()).slice());
    const doc = await PDFDocument.load(result.bytes);
    // pdf-lib does not report a placement, so the content stream is read for the
    // `cm` matrix the image was drawn under: `w 0 0 h x y cm`.
    const content = contentOf(doc, 1);
    // pdf-lib writes the placement as a translate, an identity rotate, and a
    // scale — three `cm` operators, not one matrix.
    const placement =
      /1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm\s+1 0 0 1 0 0 cm\s+([\d.]+) 0 0 ([\d.]+) 0 0 cm/.exec(
        content
      );
    expect(placement).toBeTruthy();
    const [, x, yBottom, w, h] = placement!.map(Number);

    const image = PPT_TO_PDF.slide2.image;
    expect(w).toBeCloseTo(image.w * 72, 0);
    expect(h).toBeCloseTo(image.h * 72, 0);
    expect(x).toBeCloseTo(image.x * 72, 0);
    // Same flip as the text: the picture's *top* is 1.4in down the slide, so its
    // bottom edge is height − top − h up from the page's bottom.
    expect(yBottom).toBeCloseTo(PPT_TO_PDF.slide.heightPt - image.y * 72 - image.h * 72, 0);
  }, 60_000);

  it('converts EMU to points exactly, at the one place that does it', () => {
    expect(EMU_PER_POINT).toBe(12700);
    expect(toPoints(914400)).toBe(72); // one inch
    expect(toPoints(12191695)).toBeCloseTo(959.976, 3);
    expect(toPoints(0)).toBe(0);
    expect(toPoints(Number.NaN)).toBe(0);
    expect(toPoints(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

/* ================================================================== *
 * Images: embedded once, and refused clearly when they cannot be
 * ================================================================== */

describe('CNV-13 — pictures', () => {
  it('embeds an image shown on two slides exactly once', async () => {
    const deckBytes = await pptToPdfPptx();
    // The premise: the deck really does reference one media part from two
    // slides. Without this the test would pass on a deck that has one picture.
    const deck = await readPptx(deckBytes.slice());
    expect(deck.slides[1].media[0].part).toBe(deck.slides[3].media[0].part);

    const result = await convert(deckBytes.slice());
    expect(result.imageCount).toBe(2); // two placements…

    const doc = await PDFDocument.load(result.bytes);
    expect(imageObjectCount(doc)).toBe(1); // …one object.
  }, 60_000);

  it('names the format of a picture it cannot embed, and draws the rest', async () => {
    const deck = deckOf([
      { kind: 'picture', x: 0, y: 0, cx: 100000, cy: 100000, rot: 0, relationshipId: 'rId5' },
      { ...textShapeModel('Still here') }
    ]);
    deck.slides[0].media = [
      {
        relationshipId: 'rId5',
        part: 'ppt/media/diagram1.emf',
        byteLength: 4,
        bytes: new Uint8Array([1, 2, 3, 4])
      }
    ];
    const result = deckToBlocks(deck);
    expect(result.notes).toContain(unsupportedImageNote(['EMF']));
    expect(result.slides[0].images).toBe(0);
    expect(result.slides[0].textBoxes).toBe(1);
  });

  it('reports a picture whose part is missing from the package', () => {
    const deck = deckOf([
      { kind: 'picture', x: 0, y: 0, cx: 100000, cy: 100000, rot: 0, relationshipId: 'rIdGone' },
      { ...textShapeModel('Still here') }
    ]);
    const result = deckToBlocks(deck);
    expect(result.notes).toContain(missingImageNote(1));
  });

  it('recognises only the two formats a PDF can embed directly', () => {
    expect(imageFormatOf('ppt/media/image1.png')).toBe('png');
    expect(imageFormatOf('ppt/media/image1.PNG')).toBe('png');
    expect(imageFormatOf('ppt/media/image1.jpg')).toBe('jpg');
    expect(imageFormatOf('ppt/media/image1.jpeg')).toBe('jpg');
    expect(imageFormatOf('ppt/media/image1.gif')).toBeNull();
    expect(imageFormatOf('ppt/media/image1.emf')).toBeNull();
    expect(imageFormatOf('ppt/media/image1')).toBeNull();
  });
});

/** A text shape for the model-level tests. */
function textShapeModel(text: string): PptxDeck['slides'][number]['shapes'][number] {
  return {
    kind: 'text',
    x: 0,
    y: 0,
    cx: 2000000,
    cy: 500000,
    rot: 0,
    text,
    paragraphs: [
      {
        runs: [{ text, bold: false, italic: false, sizePt: 18 }],
        align: 'left',
        level: 0,
        autoNumbered: false
      }
    ]
  };
}

/* ================================================================== *
 * Page fitting
 * ================================================================== */

describe('CNV-13 — fitting a deck onto paper', () => {
  it('letterboxes a widescreen deck onto A4 rather than stretching it', async () => {
    const result = await convert((await pptToPdfPptx()).slice(), { pageSize: 'a4' });
    const doc = await PDFDocument.load(result.bytes);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo(595.28, 1);
    expect(height).toBeCloseTo(841.89, 1);

    const scale = width / PPT_TO_PDF.slide.widthPt;
    const bands = (height - PPT_TO_PDF.slide.heightPt * scale) / 2;

    const page = await linesOf(result.bytes, 0);
    const title = page.lines.find(line =>
      line.runs
        .map(run => run.text)
        .join('')
        .includes(PPT_TO_PDF.slide1.title)
    )!;
    // Uniform: the type shrank by exactly the factor the geometry did.
    expect(title.size).toBeCloseTo(PPT_TO_PDF.slide1.titleAt.size * scale, 1);
    expect(title.x).toBeCloseTo(PPT_TO_PDF.slide1.titleAt.x * 72 * scale, 0);
    // Centred: the slide sits between two equal bands, not against the top edge.
    expect(title.baseline).toBeCloseTo(
      height -
        bands -
        PPT_TO_PDF.slide1.titleAt.y * 72 * scale -
        PPT_TO_PDF.slide1.titleAt.size * scale * 1.35,
      0
    );
    expect(bands).toBeGreaterThan(100);
  }, 60_000);

  it('uses US Letter when asked, and the deck’s own size by default', async () => {
    const deckBytes = await pptToPdfPptx();
    const letter = await convert(deckBytes.slice(), { pageSize: 'letter' });
    const letterDoc = await PDFDocument.load(letter.bytes);
    expect(letterDoc.getPage(0).getSize().width).toBeCloseTo(612, 1);
    expect(letterDoc.getPage(0).getSize().height).toBeCloseTo(792, 1);

    const own = await convert(deckBytes.slice());
    const ownDoc = await PDFDocument.load(own.bytes);
    expect(ownDoc.getPage(0).getSize().width).toBeCloseTo(PPT_TO_PDF.slide.widthPt, 1);
  }, 90_000);

  it('clamps a page box the PDF format cannot express, and says so', () => {
    const notes: string[] = [];
    expect(clampPageBox({ width: 100, height: 200 }, [595.28, 841.89], notes)).toEqual([100, 200]);
    expect(notes).toEqual([]);

    expect(clampPageBox({ width: 1, height: 99999 }, [595.28, 841.89], notes)).toEqual([9, 14400]);
    expect(notes[0]).toContain('clamped');

    notes.length = 0;
    expect(clampPageBox({ width: 0, height: 0 }, [612, 792], notes)).toEqual([612, 792]);
    expect(notes[0]).toContain('did not state a usable page size');

    notes.length = 0;
    expect(clampPageBox({ width: Number.NaN, height: 100 }, [612, 792], notes)).toEqual([612, 792]);
    expect(notes).toHaveLength(1);
  });

  it('uses PowerPoint’s default slide size when the deck states none, and says so', async () => {
    const bytes = packageWith(textShape('No size stated', 0, 0), {}, { cx: 0, cy: 0 });
    const result = await convert(bytes);
    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getPage(0).getSize().width).toBeCloseTo(DEFAULT_SLIDE_POINTS.width, 1);
    expect(doc.getPage(0).getSize().height).toBeCloseTo(DEFAULT_SLIDE_POINTS.height, 1);
    expect(result.notes).toContain(slideSizeNote());
    // The text still arrives, which is the whole point of defaulting rather than
    // refusing a deck whose shapes have perfectly good coordinates.
    expect((await pagesOf(result.bytes))[0]).toContain('No size stated');
  }, 60_000);
});

/* ================================================================== *
 * Refusals — nothing is ever half-converted
 * ================================================================== */

describe('CNV-13 — refusals happen before any PDF exists', () => {
  const cases: [string, () => Uint8Array, string][] = [
    ['an empty file', () => new Uint8Array(), EMPTY_FILE_MESSAGE],
    [
      'a legacy .ppt or an encrypted .pptx (both OLE2)',
      () => new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]),
      OLE2_MESSAGE
    ],
    [
      'a file that is not a ZIP',
      () => strToU8('this is plainly not a presentation'),
      NOT_A_ZIP_MESSAGE
    ],
    [
      'a ZIP that is not a presentation package',
      () => zipSync({ 'readme.txt': strToU8('hello') }),
      NOT_A_PRESENTATION_MESSAGE
    ],
    [
      'a presentation that lists no slides',
      () =>
        zipSync({
          'ppt/presentation.xml': strToU8(
            `<p:presentation ${NS}><p:sldIdLst/><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`
          )
        }),
      NO_SLIDES_MESSAGE
    ]
  ];

  for (const [what, build, message] of cases) {
    it(`refuses ${what} with its own message, and never reaches the layout engine`, async () => {
      layoutCalls = 0;
      await expect(convert(build())).rejects.toThrow(StaplerError);
      await expect(convert(build())).rejects.toThrow(message.slice(0, 40));
      expect(layoutCalls).toBe(0);
    }, 30_000);
  }

  it('refuses a package that lists a slide it does not contain', async () => {
    layoutCalls = 0;
    const bytes = zipSync({
      'ppt/presentation.xml': strToU8(
        `<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>` +
          '<p:sldSz cx="9144000" cy="6858000"/></p:presentation>'
      ),
      'ppt/_rels/presentation.xml.rels': strToU8(
        '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>'
      )
    });
    await expect(convert(bytes)).rejects.toThrow('not in the package');
    expect(layoutCalls).toBe(0);
  }, 30_000);

  it('refuses a deck whose every slide would come out blank, naming the likely cause', async () => {
    layoutCalls = 0;
    // A slide with a shape that holds no text at all — the shape of a deck whose
    // words live only in a layout placeholder.
    const bytes = packageWith('<p:sp><p:spPr/><p:txBody><a:p/></p:txBody></p:sp>');
    await expect(convert(bytes)).rejects.toThrow(StaplerError);
    await expect(convert(bytes)).rejects.toThrow('slide layout or master');
    expect(layoutCalls).toBe(0);
    expect(PPTX_EMPTY_DECK_MESSAGE).toContain('untouched');
  }, 30_000);
});

/* ================================================================== *
 * Cancellation and progress — both phases
 * ================================================================== */

describe('CNV-13 — cancellation and progress', () => {
  it('cancels during the read phase without ever laying anything out', async () => {
    layoutCalls = 0;
    const controller = new AbortController();
    controller.abort();
    await expect(
      convert((await pptToPdfPptx()).slice(), {}, { signal: controller.signal })
    ).rejects.toThrow(/cancel/i);
    expect(layoutCalls).toBe(0);
  }, 60_000);

  it('cancels during the layout phase, after the read has finished', async () => {
    layoutCalls = 0;
    const controller = new AbortController();
    await expect(
      convert(
        (await pptToPdfPptx()).slice(),
        {},
        {
          signal: controller.signal,
          // Past 0.5 the read is done and the layout engine is running, so this
          // is the second phase's own checkpoint being exercised — not the
          // between-phases guard in `operations.ts`.
          onProgress: fraction => {
            if (fraction > 0.55) controller.abort();
          }
        }
      )
    ).rejects.toThrow(/cancel/i);
    expect(layoutCalls).toBe(1);
  }, 60_000);

  it('reports determinate progress that never goes backwards and reaches both phases', async () => {
    const result = await convert((await pptToPdfPptx()).slice());
    expect(result.progress.length).toBeGreaterThan(3);
    for (const fraction of result.progress) {
      expect(fraction).toBeGreaterThanOrEqual(0);
      expect(fraction).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < result.progress.length; i++) {
      expect(result.progress[i]).toBeGreaterThanOrEqual(result.progress[i - 1]);
    }
    // Both bands are visited: the read is 0–0.5 and the layout 0.5–1.
    expect(result.progress.some(fraction => fraction < 0.5)).toBe(true);
    expect(result.progress.some(fraction => fraction >= 0.5)).toBe(true);
  }, 60_000);
});

/* ================================================================== *
 * The reader's CNV-13 additions
 * ================================================================== */

describe('CNV-13 — the reader’s group, table and run-property support', () => {
  it('maps a grouped shape out of the group’s child coordinate space', async () => {
    // The group occupies (1000000, 2000000) 2000000 × 1000000 on the slide, and
    // its children are written in a 1000000 × 500000 space — a 2× mapping.
    const group =
      '<p:grpSp><p:nvGrpSpPr/><p:grpSpPr><a:xfrm>' +
      '<a:off x="1000000" y="2000000"/><a:ext cx="2000000" cy="1000000"/>' +
      '<a:chOff x="0" y="0"/><a:chExt cx="1000000" cy="500000"/>' +
      '</a:xfrm></p:grpSpPr>' +
      textShape('Grouped', 100000, 50000) +
      '</p:grpSp>';
    const deck = await readPptx(packageWith(group + textShape('Ungrouped', 100000, 50000)));
    const shapes = deck.slides[0].shapes;
    expect(shapes).toHaveLength(2);

    const grouped = shapes.find(shape => shape.text === 'Grouped')!;
    expect(grouped.grouped).toBe(true);
    expect(grouped.x).toBe(1000000 + 100000 * 2);
    expect(grouped.y).toBe(2000000 + 50000 * 2);
    expect(grouped.cx).toBe(2000000 * 2);
    expect(grouped.cy).toBe(500000 * 2);

    // The ungrouped sibling, written at the same numbers, is *not* moved — which
    // is what makes the assertion above about the group rather than about an
    // offset applied to everything.
    const plain = shapes.find(shape => shape.text === 'Ungrouped')!;
    expect(plain.grouped).toBeUndefined();
    expect(plain.x).toBe(100000);
    expect(plain.y).toBe(50000);
  });

  it('composes nested groups, and does not close the outer group at the inner one’s end tag', async () => {
    const inner =
      '<p:grpSp><p:nvGrpSpPr/><p:grpSpPr><a:xfrm>' +
      '<a:off x="0" y="0"/><a:ext cx="1000000" cy="500000"/>' +
      '<a:chOff x="0" y="0"/><a:chExt cx="500000" cy="250000"/>' +
      '</a:xfrm></p:grpSpPr>' +
      textShape('Deep', 100000, 50000) +
      '</p:grpSp>';
    const outer =
      '<p:grpSp><p:nvGrpSpPr/><p:grpSpPr><a:xfrm>' +
      '<a:off x="1000000" y="1000000"/><a:ext cx="2000000" cy="1000000"/>' +
      '<a:chOff x="0" y="0"/><a:chExt cx="1000000" cy="500000"/>' +
      '</a:xfrm></p:grpSpPr>' +
      inner +
      // A sibling *after* the nested group. A non-greedy scan closes the outer
      // group at the inner group's `</p:grpSp>` and loses this shape entirely.
      textShape('After the nested group', 200000, 100000) +
      '</p:grpSp>';
    const deck = await readPptx(packageWith(outer));
    const shapes = deck.slides[0].shapes;
    expect(shapes.map(shape => shape.text)).toEqual(['Deep', 'After the nested group']);

    // Outer maps ×2, inner maps ×2 again: 100000 → 1000000 + 100000 × 4.
    const deep = shapes[0];
    expect(deep.x).toBe(1000000 + 100000 * 4);
    expect(deep.y).toBe(1000000 + 50000 * 4);
    expect(shapes[1].x).toBe(1000000 + 200000 * 2);
  });

  it('leaves a group with a zero child extent where its children were written', async () => {
    const group =
      '<p:grpSp><p:nvGrpSpPr/><p:grpSpPr><a:xfrm>' +
      '<a:off x="500000" y="500000"/><a:ext cx="1000000" cy="1000000"/>' +
      '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/>' +
      '</a:xfrm></p:grpSpPr>' +
      textShape('Undivided', 100000, 100000) +
      '</p:grpSp>';
    const deck = await readPptx(packageWith(group));
    const shape = deck.slides[0].shapes[0];
    // The offset still applies; the scale does not, because there is none to
    // read. What must never happen is a division by zero.
    expect(Number.isFinite(shape.x)).toBe(true);
    expect(shape.x).toBe(500000 + 100000);
    expect(shape.cx).toBe(2000000);
  });

  it('reads a table’s grid, and a graphic frame’s own p:xfrm', async () => {
    const table =
      '<p:graphicFrame><p:xfrm><a:off x="900000" y="800000"/><a:ext cx="4000000" cy="1000000"/>' +
      '</p:xfrm><a:graphic><a:graphicData><a:tbl>' +
      '<a:tblGrid><a:gridCol w="2000000"/><a:gridCol w="2000000"/></a:tblGrid>' +
      '<a:tr h="400000"><a:tc><a:txBody><a:p><a:r><a:rPr sz="1400"/><a:t>Left</a:t></a:r></a:p>' +
      '</a:txBody></a:tc><a:tc hMerge="1"><a:txBody><a:p/></a:txBody></a:tc></a:tr>' +
      '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
    const deck = await readPptx(packageWith(table));
    const shape = deck.slides[0].shapes[0];
    expect(shape.kind).toBe('table');
    // The `p:`-namespaced transform is read: without it every table on every
    // slide sits at (0, 0) with no size.
    expect(shape.x).toBe(900000);
    expect(shape.y).toBe(800000);
    expect(shape.cx).toBe(4000000);
    expect(shape.table!.columnWidths).toEqual([2000000, 2000000]);
    expect(shape.table!.rowHeights).toEqual([400000]);
    expect(shape.table!.rows[0][0].paragraphs[0].runs[0].text).toBe('Left');
    expect(shape.table!.rows[0][1].merged).toBe(true);
    // The cell text is on the slide's own comparison surface too.
    expect(deck.slides[0].text).toContain('Left');
  });

  it('reads run size, bold, italic, alignment, level and a literal bullet', async () => {
    const shape =
      '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="4000000" cy="1000000"/></a:xfrm>' +
      '</p:spPr><p:txBody><a:bodyPr/>' +
      '<a:p><a:pPr algn="ctr" lvl="2"><a:buChar char="•"/></a:pPr>' +
      '<a:r><a:rPr sz="2400" b="1"/><a:t>Bold</a:t></a:r>' +
      '<a:r><a:rPr sz="2400" i="1"/><a:t> italic</a:t></a:r></a:p>' +
      '<a:p><a:pPr algn="r"><a:buNone/></a:pPr><a:r><a:rPr/><a:t>Plain</a:t></a:r></a:p>' +
      '</p:txBody></p:sp>';
    const deck = await readPptx(packageWith(shape));
    const [first, second] = deck.slides[0].shapes[0].paragraphs!;
    expect(first.align).toBe('center');
    expect(first.level).toBe(2);
    expect(first.bullet).toBe('•');
    expect(first.runs).toEqual([
      { text: 'Bold', bold: true, italic: false, sizePt: 24 },
      { text: ' italic', bold: false, italic: true, sizePt: 24 }
    ]);
    expect(second.align).toBe('right');
    expect(second.bullet).toBeUndefined();
    // No `sz` at all: the size is *absent*, not defaulted here — the converter
    // decides, and reports that it did.
    expect(second.runs[0].sizePt).toBeUndefined();
  });

  it('turns a soft line break into a hard break rather than joining two lines', async () => {
    const shape =
      '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="4000000" cy="1000000"/></a:xfrm>' +
      '</p:spPr><p:txBody><a:p><a:r><a:rPr sz="1800"/><a:t>Before</a:t></a:r><a:br/>' +
      '<a:r><a:rPr sz="1800"/><a:t>After</a:t></a:r></a:p></p:txBody></p:sp>';
    const deck = await readPptx(packageWith(shape));
    expect(deck.slides[0].shapes[0].paragraphs![0].runs.map(run => run.text)).toEqual([
      'Before',
      '\n',
      'After'
    ]);
  });

  it('hands back media bytes only when asked', async () => {
    const bytes = await pptToPdfPptx();
    const without = await readPptx(bytes.slice());
    expect(without.slides[1].media[0].bytes).toBeUndefined();
    expect(without.slides[1].media[0].byteLength).toBeGreaterThan(0);

    const with_ = await readPptx(bytes.slice(), { includeMediaBytes: true });
    expect(with_.slides[1].media[0].bytes!.length).toBe(with_.slides[1].media[0].byteLength);
    // The same instance for both slides that reference the part, which is what
    // makes "embed once" possible without comparing bytes.
    expect(with_.slides[1].media[0].bytes).toBe(with_.slides[3].media[0].bytes);
  }, 60_000);

  it('counts element depth rather than matching the nearest end tag', () => {
    const found = childElements('<a><a>inner</a>tail</a><b/><a>second</a>', new Set(['a']));
    expect(found.map(element => element.body)).toEqual(['<a>inner</a>tail', 'second']);
  });
});

/* ================================================================== *
 * Caps and disclosures
 * ================================================================== */

describe('CNV-13 — what is left out is counted and named', () => {
  it('reports runs drawn at the default size because the deck stated none', () => {
    const shape = textShapeModel('No size');
    shape.paragraphs![0].runs[0] = { text: 'No size', bold: false, italic: false };
    const result = deckToBlocks(deckOf([shape]));
    expect(result.notes).toContain(defaultSizeNote(1));
    expect(defaultSizeNote(1)).toContain(`${DEFAULT_FONT_POINTS}pt`);
    const canvas = result.blocks[0];
    expect(canvas.kind).toBe('canvas');
    if (canvas.kind !== 'canvas') throw new Error('unreachable');
    const item = canvas.items[0];
    expect(item.kind === 'text' && item.fontSize).toBe(DEFAULT_FONT_POINTS);
  });

  it('reports rotated and flipped shapes rather than pretending they were drawn', () => {
    const rotated = textShapeModel('Sideways');
    rotated.rot = 60000 * 45;
    const flipped = textShapeModel('Mirrored');
    flipped.flipH = true;
    const result = deckToBlocks(deckOf([rotated, flipped]));
    expect(result.notes).toContain(rotatedNote(2));
    // Both are still *drawn*, at their stated place — reported, not dropped.
    const canvas = result.blocks[0];
    if (canvas.kind !== 'canvas') throw new Error('unreachable');
    expect(canvas.items).toHaveLength(2);
  });

  it('gives a placeholder with no box of its own the rest of the slide, and says so', async () => {
    // A shape with no `<a:xfrm>` at all — which is what a placeholder that
    // inherits its geometry from the slide layout looks like, and is ordinary in
    // a deck a person authored. Read as a zero-width box it would wrap to one
    // character per line: a page missing no text and unreadable, which is the
    // worst of both outcomes.
    const sentence = 'This placeholder inherits its box from the layout and still has to be read';
    const bytes = packageWith(
      `<p:sp><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1800"/><a:t>${sentence}` +
        '</a:t></a:r></a:p></p:txBody></p:sp>'
    );
    const deck = await readPptx(bytes.slice());
    expect(deck.slides[0].shapes[0].cx).toBe(0);

    const model = deckToBlocks(await readPptx(bytes.slice(), { includeMediaBytes: true }));
    const canvas = model.blocks[0];
    if (canvas.kind !== 'canvas') throw new Error('unreachable');
    const item = canvas.items[0];
    expect(item.kind).toBe('text');
    // The whole slide, not one point.
    expect(item.width).toBeCloseTo(toPoints(9144000), 1);
    expect(model.notes).toContain(unpositionedNote(1));

    // …and the sentence really does come back out of the PDF as a sentence.
    const result = await convert(bytes);
    expect((await pagesOf(result.bytes))[0].replace(/\s+/g, ' ')).toContain(sentence);
  }, 60_000);

  it('reports numbered bullets losing their numbers', () => {
    const shape = textShapeModel('An item');
    shape.paragraphs![0].autoNumbered = true;
    const result = deckToBlocks(deckOf([shape]));
    expect(result.notes).toContain(autoNumberedNote(1));
  });

  it('caps the slide count and says exactly which slides are missing', () => {
    const deck = deckOf([textShapeModel('One')]);
    const template = deck.slides[0];
    deck.slides = Array.from({ length: MAX_SLIDES + 3 }, (_, index) => ({
      ...template,
      slideNumber: index + 1
    }));
    const result = deckToBlocks(deck);
    expect(result.blocks).toHaveLength(MAX_SLIDES);
    expect(result.notes).toContain(slideCapNote(MAX_SLIDES + 3));
  });

  it('caps the shapes on one slide and says how many were left out', () => {
    const shapes = Array.from({ length: MAX_ITEMS_PER_SLIDE + 2 }, () => textShapeModel('Shape'));
    const result = deckToBlocks(deckOf(shapes));
    const canvas = result.blocks[0];
    if (canvas.kind !== 'canvas') throw new Error('unreachable');
    expect(canvas.items).toHaveLength(MAX_ITEMS_PER_SLIDE);
    expect(result.notes).toContain(itemCapNote(1, 2));
  });

  it('states the ticket’s own out-of-scope items in the copy the panel renders', () => {
    const all = PPT_LIMITATIONS.join(' ').toLowerCase();
    for (const excluded of ['transition', 'animation', 'speaker note']) {
      expect(all).toContain(excluded);
    }
    // …and the fidelity gaps this direction really has.
    for (const excluded of ['layouts and masters', 'font', 'colour', 'rotated']) {
      expect(all).toContain(excluded);
    }
  });
});

/* ================================================================== *
 * The preview the save button waits for
 * ================================================================== */

describe('CNV-13 — the preview describes the file that would be saved', () => {
  it('returns one outline row per page, built from the blocks that were drawn', async () => {
    const deckBytes = await pptToPdfPptx();
    const deck = await readPptx(deckBytes.slice());
    const result = await convert(deckBytes.slice());

    expect(result.outline).toHaveLength(result.pageCount);
    result.outline.forEach((item, index) => {
      expect(item.pageIndex).toBe(index);
      expect(item.kind).toBe('canvas');
      // The row's text is the slide's own leading text, so a slide that landed
      // on the wrong page is visible in the panel without rendering anything.
      expect(deck.slides[index].text).toContain(item.text.replace(/…$/, '').trim().slice(0, 30));
    });

    expect(result.slides.map(slide => slide.number)).toEqual([1, 2, 3, 4]);
    expect(result.slides[1].images).toBe(1);
    expect(result.slides[2].tables).toBe(1);
    expect(result.slideWidth).toBeCloseTo(PPT_TO_PDF.slide.widthPt, 1);
    expect(result.slideHeight).toBe(PPT_TO_PDF.slide.heightPt);
  }, 60_000);

  it('carries the deck’s own title into the PDF, ahead of the file name', async () => {
    const result = await convert((await pptToPdfPptx()).slice(), { documentName: 'ignored-name' });
    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getTitle()).toBe(PPT_TO_PDF.title);
  }, 60_000);
});

/* ================================================================== *
 * The second review pass — the four defects an independent audit found
 *
 * Each block below reproduces the audit's own repro first (what the code
 * returned before the fix, asserted as *no longer* happening) and then grades
 * the new behaviour, twice over where the fix is positional: once on the model
 * and once on the produced PDF's own bytes.
 * ================================================================== */

/** A text shape with an explicit box, for the geometry cases. */
function sizedShape(text: string, box: { x: number; y: number; cx: number; cy: number }): string {
  return (
    `<p:sp><p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/>` +
    `<a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1800"/><a:t>${text}</a:t></a:r></a:p>` +
    '</p:txBody></p:sp>'
  );
}

/** A `_rels` part for the slide, so a frame or a picture can reference a part. */
function relsPart(entries: Array<[string, string]>): string {
  return (
    '<Relationships>' +
    entries.map(([id, target]) => `<Relationship Id="${id}" Target="${target}"/>`).join('') +
    '</Relationships>'
  );
}

function pictureShape(relId: string): string {
  return (
    `<p:pic><p:nvPicPr/><p:blipFill><a:blip r:embed="${relId}"/></p:blipFill>` +
    '<p:spPr><a:xfrm><a:off x="500000" y="500000"/><a:ext cx="2000000" cy="1500000"/>' +
    '</a:xfrm></p:spPr></p:pic>'
  );
}

/**
 * A group whose own `<a:xfrm>` carries `rot` and `flipH`, mapping its child
 * space 1:1 onto a 2000000-wide rectangle at x = 1000000.
 *
 * 1:1 on purpose: it makes the mirror the *only* thing that can move the child,
 * so the assertions below cannot be satisfied by a scale that happens to be
 * right.
 */
const FLIPPED_CHILD = { x: 0, y: 100000, cx: 1200000, cy: 400000 };

function flippedGroup(attributes: string, child = sizedShape('Mirrored', FLIPPED_CHILD)): string {
  return (
    `<p:grpSp><p:nvGrpSpPr/><p:grpSpPr><a:xfrm ${attributes}>` +
    '<a:off x="1000000" y="2000000"/><a:ext cx="2000000" cy="1000000"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="2000000" cy="1000000"/>' +
    '</a:xfrm></p:grpSpPr>' +
    child +
    '</p:grpSp>'
  );
}

describe('CNV-13 — a rotated or flipped group is neither discarded nor uncounted', () => {
  it('mirrors a flipped group’s child coordinate space, and reports the rotation', async () => {
    const bytes = packageWith(flippedGroup('rot="2700000" flipH="1"'));
    const shape = (await readPptx(bytes.slice())).slides[0].shapes[0];

    // The audit's repro: this shape used to come back at the group's own left
    // edge with `{rot: 0}` and no flip flags at all, because a group's `rot`,
    // `flipH` and `flipV` were never read. All four assertions fail on that
    // reading.
    expect(shape.x).not.toBe(1000000);
    expect(shape.rot).not.toBe(0);
    // A flip mirrors the child *space*: a child against the group's left edge
    // belongs against its right edge. 1000000 + 2000000 − 1200000.
    expect(shape.x).toBe(1800000);
    expect(shape.cx).toBe(1200000); // a width, never a direction
    // flipV is not set, so the vertical axis is untouched.
    expect(shape.y).toBe(2100000);
    expect(shape.cy).toBe(400000);
    // The group's 45° reaches the consumer, and so does the fact that its
    // *position* consequence was not applied.
    expect(shape.rot).toBe(2700000);
    expect(shape.flipH).toBe(true);
    expect(shape.flipV).toBeUndefined();
    expect(shape.groupRotated).toBe(true);

    // …and the panel's promise ("the count is reported with the conversion") is
    // now true for a group. It used to produce `notes: []`.
    const model = deckToBlocks(await readPptx(bytes.slice(), { includeMediaBytes: true }));
    expect(model.notes).not.toEqual([]);
    expect(model.notes).toContain(rotatedNote(1));
    expect(model.notes).toContain(rotatedGroupNote(1));
    expect(rotatedGroupNote(1)).toContain('rotated group');
  });

  it('draws that mirrored child at its mirrored place in the produced PDF', async () => {
    const result = await convert(packageWith(flippedGroup('rot="2700000" flipH="1"')));
    const page = await linesOf(result.bytes, 0);
    const line = page.lines.find(candidate =>
      candidate.runs
        .map(run => run.text)
        .join('')
        .includes('Mirrored')
    );
    expect(line).toBeDefined();
    // Read out of the file: 1800000 EMU is 141.7pt. The unmirrored reading puts
    // it at 78.7pt, which is what this file used to write.
    expect(line!.x).toBeCloseTo(toPoints(1800000), 0);
    expect(line!.x).not.toBeCloseTo(toPoints(1000000), 0);
  }, 60_000);

  it('cancels a flip nested inside a flip rather than mirroring twice', async () => {
    // A flipped group inside a flipped group is a mirror of a mirror: the child
    // is back where it was written, and is *not* reported as flipped.
    const inner =
      '<p:grpSp><p:nvGrpSpPr/><p:grpSpPr><a:xfrm flipH="1">' +
      '<a:off x="0" y="0"/><a:ext cx="2000000" cy="1000000"/>' +
      '<a:chOff x="0" y="0"/><a:chExt cx="2000000" cy="1000000"/>' +
      '</a:xfrm></p:grpSpPr>' +
      sizedShape('Mirrored', FLIPPED_CHILD) +
      '</p:grpSp>';
    const deck = await readPptx(packageWith(flippedGroup('flipH="1"', inner)));
    const shape = deck.slides[0].shapes[0];
    expect(shape.x).toBe(1000000);
    expect(shape.cx).toBe(1200000);
    expect(shape.flipH).toBeUndefined();
    expect(shape.groupRotated).toBeUndefined();
    // Nothing to disclose, so nothing is claimed: the rotated/flipped note is
    // absent rather than reporting a shape that is neither.
    const model = deckToBlocks(await readPptx(packageWith(flippedGroup('flipH="1"', inner))));
    expect(model.notes).not.toContain(rotatedNote(1));
  });

  it('mirrors the vertical axis for flipV, and keeps a group with no child rectangle upright', async () => {
    const vertical = await readPptx(packageWith(flippedGroup('flipV="1"')));
    const shape = vertical.slides[0].shapes[0];
    expect(shape.x).toBe(1000000); // untouched
    // 2000000 + 1000000 − (100000 + 400000): mirrored inside the group's rect.
    expect(shape.y).toBe(2500000);
    expect(shape.cy).toBe(400000);
    expect(shape.flipV).toBe(true);

    // A group stating an orientation but no `<a:chOff>`/`<a:chExt>` states no
    // mapping — the children stay where they were written, and the orientation
    // is still reported rather than lost with the rest of the transform.
    const noMapping =
      '<p:grpSp><p:nvGrpSpPr/><p:grpSpPr><a:xfrm rot="5400000" flipH="1">' +
      '<a:off x="1000000" y="2000000"/><a:ext cx="2000000" cy="1000000"/>' +
      '</a:xfrm></p:grpSpPr>' +
      sizedShape('Unmapped', FLIPPED_CHILD) +
      '</p:grpSp>';
    const partial = (await readPptx(packageWith(noMapping))).slides[0].shapes[0];
    expect(partial.x).toBe(FLIPPED_CHILD.x);
    expect(partial.rot).toBe(5400000);
    expect(partial.flipH).toBe(true);
    expect(partial.groupRotated).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Charts and SmartArt: text out of their own parts, and a note either way
 * ------------------------------------------------------------------ */

const CHART_URI = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const DIAGRAM_URI = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';

function chartFrame(uri = CHART_URI, reference = '<c:chart r:id="rId2"/>'): string {
  return (
    '<p:graphicFrame><p:nvGraphicFramePr/>' +
    '<p:xfrm><a:off x="900000" y="800000"/><a:ext cx="6000000" cy="3000000"/></p:xfrm>' +
    `<a:graphic><a:graphicData uri="${uri}">${reference}</a:graphicData></a:graphic>` +
    '</p:graphicFrame>'
  );
}

/** A chart part shaped like PowerPoint's: a rich title plus cached strings. */
function chartPart(labels: readonly string[] = ['North', 'South'], title = 'Revenue by region') {
  const points = labels
    .map((label, index) => `<c:pt idx="${index}"><c:v>${label}</c:v></c:pt>`)
    .join('');
  return (
    `<c:chartSpace ${NS}><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:rPr sz="1400"/>` +
    `<a:t>${title}</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:ser>` +
    '<c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/>' +
    '<c:pt idx="0"><c:v>2024 actuals</c:v></c:pt></c:strCache></c:strRef></c:tx>' +
    `<c:cat><c:strRef><c:f>Sheet1!$A$2</c:f><c:strCache>${points}</c:strCache></c:strRef></c:cat>` +
    '<c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>41</c:v></c:pt></c:numCache></c:numRef>' +
    '</c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>'
  );
}

describe('CNV-13 — a chart or SmartArt is read out of its own part, or named', () => {
  it('extracts a chart’s title, series name and category labels from ppt/charts/chart1.xml', async () => {
    const bytes = packageWith(chartFrame(), {
      'ppt/slides/_rels/slide1.xml.rels': relsPart([['rId2', '../charts/chart1.xml']]),
      'ppt/charts/chart1.xml': chartPart()
    });
    const deck = await readPptx(bytes.slice());
    const shape = deck.slides[0].shapes[0];

    // The audit's repro: the frame's own body holds no text, so this used to be
    // skipped entirely — no shape, nothing on the slide's comparison surface,
    // and `notes: []`. Every assertion here fails on that reading.
    expect(shape.kind).toBe('graphic');
    expect(shape.graphicKind).toBe('chart');
    expect(shape.text).toContain('Revenue by region');
    expect(shape.x).toBe(900000); // the frame's own `p:xfrm`, as for a table
    // The slide's text — the round trip's comparison surface — now includes it.
    expect(deck.slides[0].text).toContain('Revenue by region');
    expect(deck.slides[0].text).toContain('2024 actuals');
    expect(deck.slides[0].text).toContain('North');
    // A numeric cache is deliberately not text: a bar's height is not a label.
    expect(deck.slides[0].text).not.toContain('41');

    const model = deckToBlocks(await readPptx(bytes.slice(), { includeMediaBytes: true }));
    // Four strings: the title, the series name and two categories.
    expect(model.notes).toContain(
      graphicFrameNote({ slideNumber: 1, kind: 'chart', extracted: 4, dropped: 0 })
    );
    expect(model.notes.join(' ')).toContain('is not drawn');

    // …and it really does come back out of the produced PDF.
    const result = await convert(bytes.slice());
    expect((await pagesOf(result.bytes))[0].replace(/\s+/g, ' ')).toContain('Revenue by region');
  }, 60_000);

  it('reads SmartArt node text from its data part', async () => {
    const bytes = packageWith(chartFrame(DIAGRAM_URI, '<dgm:relIds r:dm="rId3"/>'), {
      'ppt/slides/_rels/slide1.xml.rels': relsPart([['rId3', '../diagrams/data1.xml']]),
      'ppt/diagrams/data1.xml':
        `<dgm:dataModel ${NS}><dgm:ptLst><dgm:pt><dgm:t><a:p><a:r><a:rPr sz="1200"/>` +
        '<a:t>Discovery</a:t></a:r></a:p></dgm:t></dgm:pt><dgm:pt><dgm:t><a:p><a:r>' +
        '<a:rPr sz="1200"/><a:t>Delivery</a:t></a:r></a:p></dgm:t></dgm:pt></dgm:ptLst>' +
        '</dgm:dataModel>'
    });
    const deck = await readPptx(bytes.slice());
    expect(deck.slides[0].shapes[0].graphicKind).toBe('diagram');
    expect(deck.slides[0].text).toContain('Discovery');
    expect(deck.slides[0].text).toContain('Delivery');

    const model = deckToBlocks(await readPptx(bytes.slice(), { includeMediaBytes: true }));
    expect(model.notes).toContain(
      graphicFrameNote({ slideNumber: 1, kind: 'diagram', extracted: 2, dropped: 0 })
    );
    expect(model.notes.join(' ')).toContain('SmartArt diagram');
  });

  it('names a chart whose part holds no text it can read, next to real content', async () => {
    const bytes = packageWith(chartFrame() + sizedShape('Real content', FLIPPED_CHILD), {
      // No `_rels` part at all: the reference does not resolve, which is what a
      // damaged package or an unreadable embedded object looks like.
    });
    const model = deckToBlocks(await readPptx(bytes.slice(), { includeMediaBytes: true }));
    expect(model.notes).toContain(
      graphicFrameNote({ slideNumber: 1, kind: 'chart', extracted: 0, dropped: 0 })
    );
    expect(model.notes.join(' ')).toContain('nothing on the page stands for it');
    // The slide is not blank — the other shape is real — so the deck converts,
    // and the note is the only trace of the chart.
    expect(model.slides[0].empty).toBe(false);
  });

  it('caps a chart’s labels and says how many it left out', () => {
    const many = Array.from({ length: MAX_GRAPHIC_TEXT_RUNS + 5 }, (_, i) => `Region ${i}`);
    const extracted = graphicPartText(chartPart(many));
    // 1 title + 1 series name + 60 cap.
    expect(extracted.runs).toHaveLength(MAX_GRAPHIC_TEXT_RUNS);
    expect(extracted.dropped).toBe(7);
    expect(
      graphicFrameNote({ slideNumber: 3, kind: 'chart', extracted: 60, dropped: 7 })
    ).toContain('7 further labels');
  });

  it('states in the panel’s own copy that chart and SmartArt drawings are not reproduced', () => {
    const claim = PPT_LIMITATIONS.find(limitation => /Charts and SmartArt/.test(limitation));
    expect(claim).toBeDefined();
    expect(claim).toContain('are not drawn');
    // The wording the audit found false — "contribute their text only", which
    // was untrue for the realistic case where that text is in another part —
    // is gone from the list entirely.
    expect(PPT_LIMITATIONS.join(' ')).not.toContain('contribute their text only');
  });
});

/* ------------------------------------------------------------------ *
 * The preview says which pages will be blank
 * ------------------------------------------------------------------ */

describe('CNV-13 — a partially blank deck is visible in the mandatory preview', () => {
  /** One slide with real text, then three whose shapes carry none. */
  function partiallyBlankDeck(): PptxDeck {
    const blank = (number: number): PptxDeck['slides'][number] => ({
      slideNumber: number,
      part: `ppt/slides/slide${number}.xml`,
      runs: [],
      paragraphs: [],
      text: '',
      shapes: [
        {
          kind: 'text',
          x: 0,
          y: 0,
          cx: 2000000,
          cy: 500000,
          rot: 0,
          text: '',
          paragraphs: []
        }
      ],
      media: []
    });
    const deck = deckOf([textShapeModel('Only slide one has anything on it')]);
    deck.slides = [deck.slides[0], blank(2), blank(3), blank(4)];
    return deck;
  }

  it('marks the specific slides that will come out blank, not just a count', () => {
    const model = deckToBlocks(partiallyBlankDeck());

    // Per slide, which is what the panel renders on the row itself.
    expect(model.slides.map(slide => slide.empty)).toEqual([false, true, true, true]);
    // …and named in the notes, so the numbers are in the preview's own text.
    // Before the fix this deck produced no note at all: `empty` was computed and
    // read by nothing outside the all-or-nothing refusal.
    expect(model.notes).toContain(blankSlidesNote([2, 3, 4]));
    expect(blankSlidesNote([2, 3, 4])).toContain('Slides 2, 3 and 4');
    expect(blankSlidesNote([2])).toContain('Slide 2 will be a blank page');
    // The row's own marker names the likely cause, in the same words.
    expect(BLANK_SLIDE_LABEL).toContain('appears blank');
    expect(BLANK_SLIDE_LABEL).toContain('slide layout');

    // The deck still converts: a partially blank deck is disclosed, not refused.
    expect(model.blocks).toHaveLength(4);
  });

  it('treats a table with nothing in any cell as a blank page rather than content', () => {
    const table: PptxDeck['slides'][number]['shapes'][number] = {
      kind: 'table',
      x: 0,
      y: 0,
      cx: 4000000,
      cy: 1000000,
      rot: 0,
      table: {
        columnWidths: [2000000, 2000000],
        rowHeights: [400000],
        rows: [
          [
            { paragraphs: [], merged: false },
            { paragraphs: [], merged: false }
          ]
        ]
      }
    };
    const deck = deckOf([textShapeModel('Content')]);
    deck.slides = [
      deck.slides[0],
      { ...deck.slides[0], slideNumber: 2, shapes: [table], runs: [], paragraphs: [], text: '' }
    ];
    const model = deckToBlocks(deck);
    // The grid is still drawn — it is real furniture — but it says nothing, so
    // the page is reported blank instead of looking like content.
    expect(model.slides[1].tables).toBe(1);
    expect(model.slides[1].empty).toBe(true);
    expect(model.notes).toContain(emptyTableNote(2));
    expect(model.notes).toContain(blankSlidesNote([2]));
  });
});

/* ------------------------------------------------------------------ *
 * The all-blank refusal keeps the diagnosis it already made
 * ------------------------------------------------------------------ */

describe('CNV-13 — the blank-deck refusal names the real cause', () => {
  it('blames the missing picture, not the slide layout, when that is what failed', async () => {
    layoutCalls = 0;
    const bytes = packageWith(pictureShape('rId9'), {
      // The relationship resolves, the part does not exist — a package that lost
      // its media, which the converter diagnoses exactly.
      'ppt/slides/_rels/slide1.xml.rels': relsPart([['rId9', '../media/gone.png']])
    });
    const error = await convert(bytes).then(
      () => null,
      (err: unknown) => err as Error
    );
    expect(error).toBeInstanceOf(StaplerError);
    // Before the fix this threw `PPTX_EMPTY_DECK_MESSAGE`: the user was told to
    // look at their slide master because of an image failure the code had
    // already identified and written into a note.
    expect(error!.message).not.toContain('slide layout or master');
    expect(error!.message).toContain(missingImageNote(1));
    expect(error!.message).toContain('untouched');
    expect(layoutCalls).toBe(0);
  }, 30_000);

  it('blames the format, not the slide layout, for a deck whose only picture is an EMF', async () => {
    layoutCalls = 0;
    const bytes = packageWith(pictureShape('rId4'), {
      'ppt/slides/_rels/slide1.xml.rels': relsPart([['rId4', '../media/diagram1.emf']]),
      'ppt/media/diagram1.emf': 'not really an EMF, but the extension is what decides'
    });
    const error = await convert(bytes).then(
      () => null,
      (err: unknown) => err as Error
    );
    expect(error).toBeInstanceOf(StaplerError);
    expect(error!.message).not.toContain('slide layout or master');
    expect(error!.message).toContain('EMF');
    expect(error!.message).toContain(unsupportedImageNote(['EMF']));
    expect(layoutCalls).toBe(0);
  }, 30_000);

  it('blames the chart when a chart is all the deck had', () => {
    const deck = deckOf([
      {
        kind: 'graphic',
        x: 0,
        y: 0,
        cx: 4000000,
        cy: 3000000,
        rot: 0,
        graphicKind: 'chart'
      }
    ]);
    deck.slides[0].runs = [];
    deck.slides[0].text = '';
    expect(() => deckToBlocks(deck)).toThrow('holds a chart');
    expect(() => deckToBlocks(deck)).not.toThrow('slide layout or master');
  });

  it('still falls back to the layout-inheritance message when nothing else is known', async () => {
    layoutCalls = 0;
    const bytes = packageWith('<p:sp><p:spPr/><p:txBody><a:p/></p:txBody></p:sp>');
    await expect(convert(bytes)).rejects.toThrow('slide layout or master');
    expect(PPTX_EMPTY_DECK_MESSAGE).toContain('untouched');
    expect(layoutCalls).toBe(0);
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * The element scan cannot be desynchronised by character data
 * ------------------------------------------------------------------ */

describe('CNV-13 — CDATA and comments are opaque to the element scan', () => {
  it('does not close an element at a tag written inside a CDATA section', () => {
    // The audit's repro. Before the fix the scan closed the first `<a>` at the
    // `</a>` *inside* the CDATA section, so the element list desynchronised and
    // the middle "real" text was lost — the one way this walker could return a
    // *wrong* element rather than a missed one, which its own module comment
    // says cannot happen.
    const found = childElements('<a><![CDATA[</a>]]>real</a><a>second</a>', new Set(['a']));
    expect(found.map(element => element.body)).toEqual(['<![CDATA[</a>]]>real', 'second']);
  });

  it('ignores an element written inside a comment', () => {
    const found = childElements(
      '<a>kept</a><!-- <a>ignored</a> --><a>also kept</a>',
      new Set(['a'])
    );
    expect(found.map(element => element.body)).toEqual(['kept', 'also kept']);
  });

  it('keeps a run’s text when the part writes it as CDATA', async () => {
    const shape =
      '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="4000000" cy="1000000"/></a:xfrm>' +
      '</p:spPr><p:txBody><a:p><a:r><a:rPr sz="1800"/><a:t><![CDATA[Text & <angle>]]></a:t>' +
      '</a:r></a:p></p:txBody></p:sp>';
    const deck = await readPptx(packageWith(shape));
    // The scan steps over the section; the text inside it is still the run's,
    // literally — a CDATA section's content is not entity-decoded, and the
    // markers themselves are not part of it.
    expect(deck.slides[0].shapes[0].paragraphs![0].runs).toEqual([
      { text: 'Text & <angle>', bold: false, italic: false, sizePt: 18 }
    ]);
    expect(deck.slides[0].text).toBe('Text & <angle>');
  });
});

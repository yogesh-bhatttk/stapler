/**
 * CNV-12 — PDF → PowerPoint (PPTX), graded against real output bytes.
 *
 * The acceptance criterion is a `.pptx` with one slide per page whose per-slide
 * extracted text, "via a round-trip through `pptx-reader.ts`", matches the source
 * page's text content. So this file runs the production pipeline end to end and
 * then reads the produced file back **two independent ways**:
 *
 *  • **`pptx-reader.ts`**, which unzips the OOXML package and walks
 *    `ppt/presentation.xml` → `<p:sldIdLst>` → each `ppt/slides/slideN.xml`. It
 *    shares no code with the writer, so agreement between them is evidence
 *    rather than the writer confirming itself. Slide *order* comes from the
 *    deck's own id list, not from sorting part names.
 *  • the **source PDF's own text**, read through the same `render` worker method
 *    CNV-04's text export uses (`extractText`). The comparison is therefore
 *    "what pdf.js says page N holds" against "what the package says slide N
 *    holds" — neither side is a copy of the fixture's string constants, so a
 *    conversion that dropped or reordered a page fails here.
 *
 * pdf.js runs through its `legacy` build, the same way every other unit test
 * that needs a real parse does. What it is *not* doing is spawning workers:
 * `vi.mock('comlink')` makes the worker modules importable in Node (all three
 * call `Comlink.expose` at import time), and `vi.mock('../../src/core/workers')`
 * leases the three **real** worker implementations in place of three real
 * Workers. The function under test is therefore `operations.convertPdfToPptx`
 * itself — its own sequencing, its own progress bands and all of its refusal
 * branches — not a re-implementation of it.
 *
 * What this file cannot prove is in the ticket's Status line: nothing here opens
 * PowerPoint or LibreOffice Impress. Nor does it prove the image archive is
 * *transferred* rather than cloned — Comlink is stubbed here, so that claim is
 * measured against real `postMessage` behaviour in `pdf-to-ppt-transfer.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  inlineImagePdf,
  PDF_TO_PPT,
  PDF_TO_PPT_BOXES,
  PDF_TO_PPT_ROTATED_TEXT,
  pdfToPptCroppedPdf,
  pdfToPptFormXObjectPdf,
  pdfToPptOffsetMediaBoxPdf,
  pdfToPptPdf,
  pdfToPptRotatedTextPdf,
  sharedImagePdf,
  textPdf
} from '../e2e/fixtures';
import {
  displayedSize,
  fitPageToSlide,
  isEmptyPlan,
  MAX_BOXES_PER_SLIDE,
  MAX_BOX_CHARS,
  pageTextLines,
  planSlides,
  PPTX_LIMITATIONS,
  rotatePoint,
  slideRotation,
  textBaselineAngle,
  textTypeSize,
  type PageBox,
  type PageSlideData
} from '../../src/core/convert/slides';
import {
  decodeXmlText,
  NOT_A_PRESENTATION_MESSAGE,
  NOT_A_ZIP_MESSAGE,
  OLE2_MESSAGE,
  readPptx,
  resolvePart
} from '../../src/core/convert/pptx-reader';
import { hasXfaMarker, XFA_CONVERT_MESSAGE } from '../../src/core/pdf/xfa';
import { StaplerError } from '../../src/core/errors';
import { encodePng } from '../../src/core/png';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  // `createJobHandle` wraps its port in `Comlink.proxy`, so the stub needs it as
  // soon as a real `operations.ts` entry point is called.
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

/** How many times the writer was reached. A refusal must leave this at 0. */
let buildPptxCalls = 0;
/** How many times the placement walk ran, so its phase can be told apart. */
let placementCalls = 0;

vi.mock('../../src/core/workers', async () => {
  const { renderWorkerImpl } = await import('../../src/core/workers/render.worker');
  const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
  const { convertWorkerImpl } = await import('../../src/core/workers/convert.worker');
  type Bytes = Uint8Array;

  // `.slice()` stands in for the structured clone the real Comlink boundary
  // performs. Without it the passes fight over one buffer: pdf.js takes
  // ownership of (and detaches) what `loadDocument` is given, so the image
  // passes that follow would receive a zero-length array — an artefact of
  // calling the implementations in-process, not of the code under test.
  const renderApi = {
    loadDocument: (bytes: Bytes, password?: string) =>
      renderWorkerImpl.loadDocument(bytes.slice(), password),
    extractPageSlide: (handle: string, pageIndex: number) =>
      renderWorkerImpl.extractPageSlide(handle, pageIndex),
    extractText: (handle: string, pageIndex: number, mode: 'text' | 'markdown') =>
      renderWorkerImpl.extractText(handle, pageIndex, mode),
    closeDocument: (handle: string) => renderWorkerImpl.closeDocument(handle)
  };
  const processApi = {
    extractImages: (bytes: Bytes, pageIndices: number[]) =>
      processWorkerImpl.extractImages(bytes.slice(), pageIndices),
    imagePlacements: (
      bytes: Bytes,
      pageIndices: number[],
      job?: Parameters<typeof processWorkerImpl.imagePlacements>[2]
    ) => {
      placementCalls++;
      return processWorkerImpl.imagePlacements(bytes.slice(), pageIndices, job);
    }
  };
  const convertApi = {
    buildPptx: (...args: Parameters<typeof convertWorkerImpl.buildPptx>) => {
      buildPptxCalls++;
      return convertWorkerImpl.buildPptx(...args);
    }
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

const { convertPdfToPptx } = await import('../../src/core/operations');
const { renderWorker } = await import('../../src/core/workers');

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(`tests/fixtures/${name}`));
}

/** The production entry point, nothing else. */
async function convert(
  bytes: Uint8Array,
  options: { includeText?: boolean; includeImages?: boolean; documentName?: string } = {},
  jobOptions: Parameters<typeof convertPdfToPptx>[2] = {}
) {
  return convertPdfToPptx(
    bytes,
    {
      includeText: options.includeText ?? true,
      includeImages: options.includeImages ?? true,
      ...(options.documentName !== undefined ? { documentName: options.documentName } : {})
    },
    jobOptions
  );
}

/** The source document's own per-page text, through CNV-04's extraction path. */
async function sourcePageText(bytes: Uint8Array): Promise<string[]> {
  const out: string[] = [];
  await renderWorker.lease(async api => {
    const { handle, pageCount } = await api.loadDocument(bytes.slice());
    try {
      for (let i = 0; i < pageCount; i++) {
        out.push(await api.extractText(handle, i, 'text'));
      }
    } finally {
      await api.closeDocument(handle);
    }
  });
  return out;
}

/** Words, lower-cased, so the comparison is about content and not about spacing. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(word => word.length > 0);
}

/** EMU per point, so a stated PDF coordinate can be compared to slide XML. */
const EMU_PER_POINT = 914400 / 72;

/** US Letter, box origin at (0, 0) — the case a test about something else wants. */
const LETTER_BOX: PageBox = { x: 0, y: 0, width: 612, height: 792 };

/**
 * One page of extracted slide data, with the boring fields filled in.
 *
 * `box` carries an **origin** as well as a size, because a page's `/CropBox` or
 * `/MediaBox` need not start at (0, 0); the default here is the (0, 0) case so a
 * test that is not about the crop does not have to mention it.
 */
function slidePage(page: {
  pageIndex?: number;
  box?: Partial<PageBox>;
  rotation?: 0 | 90 | 180 | 270;
  lines?: PageSlideData['lines'];
  droppedLines?: number;
  rotatedLines?: number;
  mirroredLines?: number;
}): PageSlideData {
  return {
    pageIndex: page.pageIndex ?? 0,
    box: { x: 0, y: 0, width: 612, height: 792, ...page.box },
    rotation: page.rotation ?? 0,
    lines: page.lines ?? [],
    droppedLines: page.droppedLines ?? 0,
    rotatedLines: page.rotatedLines ?? 0,
    mirroredLines: page.mirroredLines ?? 0
  };
}

/** One laid-out line, with the fields a positioning test does not care about. */
function slideLine(line: {
  text?: string;
  x?: number;
  baseline?: number;
  width?: number;
  size?: number;
  angle?: number;
  truncated?: number;
}): PageSlideData['lines'][number] {
  return {
    runs: [{ text: line.text ?? 'line', bold: false, italic: false }],
    x: line.x ?? 0,
    baseline: line.baseline ?? 700,
    width: line.width ?? 100,
    size: line.size ?? 12,
    angle: line.angle ?? 0,
    truncated: line.truncated ?? 0
  };
}

/**
 * The four-page fixture, built once.
 *
 * Not a micro-optimisation: `pdfToPptPdf()` embeds a 480x320 PNG, and building
 * it ten times over the course of this file was measurable CPU that starved
 * other test files' default 5-second timeouts when the whole suite runs in
 * parallel. The same reasoning applies to the three cached conversions below.
 * Each cache holds a read-only result that several assertions share; every test
 * that needs its *own* run (progress bands, cancellation, the network stubs)
 * still does one.
 */
let fixtureCache: Uint8Array | undefined;
async function source(): Promise<Uint8Array> {
  fixtureCache ??= await pdfToPptPdf();
  // A fresh copy per caller: `loadDocument` hands its argument to pdf.js, which
  // takes ownership of (and may detach) it.
  return fixtureCache.slice();
}

let deckCache: Awaited<ReturnType<typeof convert>> | undefined;
/** The fixture converted with both options on; every read-only assertion shares it. */
async function deck() {
  deckCache ??= await convert(await source(), { documentName: 'review.pdf' });
  return deckCache;
}

let imagesOffCache: Awaited<ReturnType<typeof convert>> | undefined;
async function deckWithoutImages() {
  imagesOffCache ??= await convert(await source(), { includeImages: false });
  return imagesOffCache;
}

let textOffCache: Awaited<ReturnType<typeof convert>> | undefined;
async function deckWithoutText() {
  textOffCache ??= await convert(await source(), { includeText: false });
  return textOffCache;
}

describe('CNV-12 — PDF to PPTX round trip', () => {
  it('produces one slide per page whose text matches that page, read back independently', async () => {
    const result = await deck();
    const [expected, actual] = await Promise.all([
      sourcePageText(await source()),
      readPptx(result.bytes)
    ]);

    // --- one slide per page, in page order ---------------------------------
    expect(result.pageCount).toBe(4);
    expect(result.slideCount).toBe(4);
    expect(actual.slides).toHaveLength(4);
    expect(actual.slides.map(slide => slide.part)).toEqual([
      'ppt/slides/slide1.xml',
      'ppt/slides/slide2.xml',
      'ppt/slides/slide3.xml',
      'ppt/slides/slide4.xml'
    ]);

    // --- each slide holds its own page's text, and nobody else's -----------
    // Compared word-set to word-set: the writer splits a page into one box per
    // line, so the slide's text is the page's words with the line breaks gone.
    for (let i = 0; i < 4; i++) {
      const from = words(expected[i]);
      const to = words(actual.slides[i].text);
      expect(to, `slide ${i + 1} carries every word of page ${i + 1}`).toEqual(from);
    }

    // …and that is not a vacuous check: the pages really do hold different text.
    expect(words(expected[0]).length).toBeGreaterThan(20);
    expect(new Set(expected.map(text => text.trim())).size).toBe(4);
  }, 180_000);

  it('takes the deck’s single slide size from the first page, in real EMU', async () => {
    const result = await deck();
    const read = await readPptx(result.bytes);
    // US Letter: 612 × 792 pt.
    expect(result.slideWidth).toBe(612);
    expect(result.slideHeight).toBe(792);
    expect(read.slideWidth).toBe(Math.round(612 * EMU_PER_POINT));
    expect(read.slideHeight).toBe(Math.round(792 * EMU_PER_POINT));
  }, 180_000);

  it('places page 1’s title box at the rectangle the page drew it at', async () => {
    const result = await deck();
    const read = await readPptx(result.bytes);
    const title = read.slides[0].shapes.find(
      shape => shape.kind === 'text' && shape.text?.includes(PDF_TO_PPT.page1.title)
    );
    expect(title, 'the title is a shape of its own').toBeTruthy();

    // The claim under test: the box's top-left is the line's left edge and its
    // baseline plus the documented 0.8em ascent, in points, converted to EMU.
    const { x, y, size } = PDF_TO_PPT.page1.titleAt;
    const expectedX = x * EMU_PER_POINT;
    const expectedY = (792 - (y + size * 0.8)) * EMU_PER_POINT;
    // Within a point: pptxgenjs rounds inches to EMU, and pdf.js reports a
    // baseline to within rounding of what pdf-lib wrote.
    expect(Math.abs(title!.x - expectedX)).toBeLessThan(EMU_PER_POINT);
    expect(Math.abs(title!.y - expectedY)).toBeLessThan(EMU_PER_POINT);
    expect(title!.rot).toBe(0);

    // Position is measured, not defaulted: the body block below it is lower on
    // the slide and starts at the same left edge.
    const body = read.slides[0].shapes.find(
      shape => shape.kind === 'text' && shape.text === PDF_TO_PPT.page1.body[0]
    );
    expect(body).toBeTruthy();
    expect(body!.y).toBeGreaterThan(title!.y);
    expect(Math.abs(body!.x - title!.x)).toBeLessThan(EMU_PER_POINT);
  }, 180_000);

  it('writes one text box per line of the page, not one per paragraph', async () => {
    const result = await deck();
    const read = await readPptx(result.bytes);
    const texts = read.slides[0].shapes
      .filter(shape => shape.kind === 'text')
      .map(shape => shape.text ?? '');
    // The three body lines are three separate shapes. CNV-08's block model
    // merges exactly these into one reflowable paragraph, which is the thing
    // this tool must *not* do — a merged paragraph has no single position.
    for (const line of PDF_TO_PPT.page1.body) {
      expect(texts, `"${line}" is its own box`).toContain(line);
    }
  }, 180_000);

  it('keeps bold and italic as real run properties', async () => {
    const result = await deck();
    const slide = strFromU8(unzipSync(result.bytes)['ppt/slides/slide1.xml']);
    // Graded off the drawing-ML, not off the model: `b="1"`/`i="1"` on an
    // `<a:rPr>` is what PowerPoint reads.
    const boldRun = new RegExp(
      `<a:rPr[^>]*\\bb="1"[^>]*>[\\s\\S]*?</a:rPr><a:t>${PDF_TO_PPT.page1.boldRun}\\s*</a:t>`
    );
    const italicRun = new RegExp(
      `<a:rPr[^>]*\\bi="1"[^>]*>[\\s\\S]*?</a:rPr><a:t>${PDF_TO_PPT.page1.italicRun}\\s*</a:t>`
    );
    expect(slide).toMatch(boldRun);
    expect(slide).toMatch(italicRun);
  }, 180_000);

  it('embeds the image as a real media part with a real relationship', async () => {
    const result = await deck();
    const parts = unzipSync(result.bytes);
    const media = Object.keys(parts).filter(
      name => name.startsWith('ppt/media/') && !name.endsWith('/')
    );
    // Pages 1 and 4 draw the *same* image object, so CNV-06 extracts one file
    // and the deck holds one media part — the "encode once, not once per page"
    // rule, all the way through to the package.
    expect(media).toHaveLength(1);
    // PNG signature: CNV-06 hands the image over without re-encoding it.
    expect([...parts[media[0]].subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(parts[media[0]].length).toBeGreaterThan(1000);

    // …and both slides really reference it. A relationship without a part, or a
    // part nothing references, is the shape of a file PowerPoint repairs.
    const read = await readPptx(result.bytes);
    expect(result.imageCount).toBe(2);
    for (const index of [0, 3]) {
      const slide = read.slides[index];
      expect(slide.media.map(entry => entry.part)).toEqual([media[0]]);
      const picture = slide.shapes.find(shape => shape.kind === 'picture');
      expect(picture, `slide ${index + 1} has a picture`).toBeTruthy();
      expect(picture!.relationshipId).toBe(slide.media[0].relationshipId);
    }
    // Slides 2 and 3 have no image, so they reference no media at all.
    expect(read.slides[1].media).toEqual([]);
    expect(read.slides[2].media).toEqual([]);
  }, 180_000);

  it('places the picture at the rectangle the content stream drew it at', async () => {
    const result = await deck();
    const read = await readPptx(result.bytes);
    const picture = read.slides[0].shapes.find(shape => shape.kind === 'picture')!;
    const box = PDF_TO_PPT.page1.image;

    // PDF space is y-up from the bottom-left; the slide is y-down from the top.
    expect(Math.abs(picture.x - box.x * EMU_PER_POINT)).toBeLessThan(EMU_PER_POINT);
    expect(Math.abs(picture.y - (792 - box.y - box.height) * EMU_PER_POINT)).toBeLessThan(
      EMU_PER_POINT
    );
    expect(Math.abs(picture.cx - box.width * EMU_PER_POINT)).toBeLessThan(EMU_PER_POINT);
    expect(Math.abs(picture.cy - box.height * EMU_PER_POINT)).toBeLessThan(EMU_PER_POINT);

    // The *second* placement of the same object is at its own, different
    // rectangle — so this is a per-placement measurement and not one size
    // applied to every use of the image.
    const second = read.slides[3].shapes.find(shape => shape.kind === 'picture')!;
    const other = PDF_TO_PPT.page4.image;
    expect(Math.abs(second.cx - other.width * EMU_PER_POINT)).toBeLessThan(EMU_PER_POINT);
    expect(second.cx).toBeLessThan(picture.cx);
  }, 180_000);

  it('draws pictures before text, so an OCR text layer is not hidden under the scan', async () => {
    const result = await deck();
    const read = await readPptx(result.bytes);
    // `shapesOf` preserves painting order, and PowerPoint paints in that order:
    // the picture must come first on a slide that has both.
    expect(read.slides[0].shapes[0].kind).toBe('picture');
    expect(read.slides[0].shapes.some(shape => shape.kind === 'text')).toBe(true);
  }, 180_000);

  it('rotates a /Rotate 90 page into the deck’s frame instead of ignoring it', async () => {
    const result = await deck();
    const read = await readPptx(result.bytes);
    const slide = read.slides[2];
    const heading = slide.shapes.find(shape => shape.text?.includes('rotated ninety'.slice(0, 7)));
    expect(heading, 'the rotated page’s heading is on slide 3').toBeTruthy();
    // OOXML stores rotation in 60000ths of a degree, about the shape's centre.
    expect(heading!.rot).toBe(90 * 60000);

    // The page is Letter portrait with `/Rotate 90`, so it *displays* landscape
    // (792 × 612) and has to be fitted into the deck's 612 × 792 slide. Scaled
    // by 612/792 and centred, the whole page occupies a band down the middle.
    const fit = 612 / 792;
    const centreY = 792 / 2;
    const bandHalf = (612 * fit) / 2;
    const centre = (heading!.y + heading!.cy / 2) / EMU_PER_POINT;
    expect(centre).toBeGreaterThan(centreY - bandHalf);
    expect(centre).toBeLessThan(centreY + bandHalf);

    // And an unrotated page's boxes carry no rotation at all, so `rot` is
    // written from the page rather than always.
    expect(read.slides[0].shapes.every(shape => shape.rot === 0)).toBe(true);
  }, 180_000);

  it('scales a differently-sized page to the one slide size, and says it did', async () => {
    const result = await deck();
    const read = await readPptx(result.bytes);
    // Page 2 is A4 (595.28 × 841.89) in a Letter deck, so it is scaled by
    // 792/841.89 and centred horizontally.
    const scale = 792 / 841.89;
    const heading = read.slides[1].shapes.find(shape =>
      shape.text?.includes(PDF_TO_PPT.page2.heading)
    );
    expect(heading).toBeTruthy();
    const offsetX = (612 - 595.28 * scale) / 2;
    const expectedX = (offsetX + PDF_TO_PPT.page2.headingAt.x * scale) * EMU_PER_POINT;
    expect(Math.abs(heading!.x - expectedX)).toBeLessThan(EMU_PER_POINT);

    // The mixed-size limitation is *reported*, not left for the user to notice.
    expect(result.notes.join('\n')).toMatch(/not the same size as the first page/);
    expect(result.notes.join('\n')).toMatch(/one slide size per deck/);
  }, 180_000);

  it('titles the deck from the documentName option, not from a live signal', async () => {
    // The same regression CNV-08's audit found: the title used to come from a
    // live `activeDoc` read partway through a multi-await function, so a tab
    // switch mid-conversion could title the output after a different document.
    const result = await deck();
    const read = await readPptx(result.bytes);
    expect(read.title).toBe('review.pdf');
    const core = strFromU8(unzipSync(result.bytes)['docProps/core.xml']);
    expect(core).toContain('<dc:title>review.pdf</dc:title>');
  }, 180_000);

  it('falls back to a generic title when no documentName is given', async () => {
    const result = await deckWithoutImages();
    expect((await readPptx(result.bytes)).title).toBe('Converted presentation');
  }, 180_000);

  it('describes the output for the mandatory preview, slide by slide', async () => {
    const result = await deck();
    // The outline comes back *from the worker*, derived from the very plan the
    // file was written from — not recomputed here from something else.
    expect(result.outline.map(item => `${item.slideNumber}:${item.pageIndex}`)).toEqual([
      '1:0',
      '2:1',
      '3:2',
      '4:3'
    ]);
    expect(result.outline[0].imageCount).toBe(1);
    expect(result.outline[1].imageCount).toBe(0);
    expect(result.outline[3].imageCount).toBe(1);
    expect(result.outline[0].text).toContain(PDF_TO_PPT.page1.title);
    // The counts in the preview are the counts in the file.
    const read = await readPptx(result.bytes);
    for (let i = 0; i < 4; i++) {
      expect(read.slides[i].shapes.filter(shape => shape.kind === 'text')).toHaveLength(
        result.outline[i].textBoxCount
      );
      expect(read.slides[i].shapes.filter(shape => shape.kind === 'picture')).toHaveLength(
        result.outline[i].imageCount
      );
    }
    expect(result.textBoxCount).toBe(result.outline.reduce((n, item) => n + item.textBoxCount, 0));
  }, 180_000);

  it('leaves images out on request, keeping every word of text', async () => {
    const result = await deckWithoutImages();
    expect(result.imageCount).toBe(0);
    expect(
      Object.keys(unzipSync(result.bytes)).some(
        name => name.startsWith('ppt/media/') && !name.endsWith('/')
      )
    ).toBe(false);
    const read = await readPptx(result.bytes);
    expect(read.slides).toHaveLength(4);
    expect(read.slides[0].text).toContain(PDF_TO_PPT.page1.title);
  }, 180_000);

  it('leaves text out on request — the switch an OCR’d scan needs', async () => {
    const result = await deckWithoutText();
    expect(result.textBoxCount).toBe(0);
    expect(result.imageCount).toBe(2);
    const read = await readPptx(result.bytes);
    // Four slides still, because "one slide per page" does not depend on the
    // page having text.
    expect(read.slides).toHaveLength(4);
    expect(read.slides.every(slide => slide.text === '')).toBe(true);
    expect(read.slides[0].shapes.filter(shape => shape.kind === 'picture')).toHaveLength(1);
  }, 180_000);

  it('reports determinate, monotonic progress across all three passes', async () => {
    // Not decoration: this is the evidence that the *real* `convertPdfToPptx`
    // ran its own sequence rather than a helper standing in for it — the text
    // band (0..0.5), the image band (0.5..0.62), the placement band
    // (0.62..0.75) and the writer's band (0.75..1) are its bands, defined
    // nowhere else.
    const progress: number[] = [];
    await convert(await source(), {}, { onProgress: fraction => progress.push(fraction ?? 0) });
    expect(progress.length).toBeGreaterThan(4);
    for (const fraction of progress) {
      expect(fraction).toBeGreaterThanOrEqual(0);
      expect(fraction).toBeLessThanOrEqual(1);
    }
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    expect(progress.some(fraction => fraction >= 0.5)).toBe(true);
    expect(progress.some(fraction => fraction >= 0.62)).toBe(true);
    expect(progress.some(fraction => fraction >= 0.75)).toBe(true);
  }, 180_000);
});

describe('CNV-12 — the network is never touched, proved by making it throw', () => {
  it('never constructs an XMLHttpRequest or calls fetch during a conversion with images', async () => {
    // `pptxgenjs` carries a browser media path that resolves an image with
    // `new XMLHttpRequest()` — for any media relationship whose `data` is unset.
    // `pptx-writer.ts` therefore sets `data` on every `addImage` and never sets
    // `path`. That is a claim about a dependency's internals, so it is checked
    // by making the network *throw* for the duration of a real conversion that
    // really does embed images.
    const globals = globalThis as unknown as Record<string, unknown>;
    const original = {
      XMLHttpRequest: globals.XMLHttpRequest,
      fetch: globals.fetch,
      WebSocket: globals.WebSocket
    };
    const attempts: string[] = [];
    globals.XMLHttpRequest = class {
      constructor() {
        attempts.push('XMLHttpRequest');
        throw new Error('network access is forbidden');
      }
    };
    globals.fetch = () => {
      attempts.push('fetch');
      throw new Error('network access is forbidden');
    };
    globals.WebSocket = class {
      constructor() {
        attempts.push('WebSocket');
        throw new Error('network access is forbidden');
      }
    };

    try {
      const result = await convert(await source());
      // The conversion really did embed images — otherwise this test would pass
      // by having exercised nothing.
      expect(result.imageCount).toBe(2);
      expect(
        Object.keys(unzipSync(result.bytes)).filter(
          name => name.startsWith('ppt/media/') && !name.endsWith('/')
        )
      ).toHaveLength(1);
    } finally {
      globals.XMLHttpRequest = original.XMLHttpRequest;
      globals.fetch = original.fetch;
      globals.WebSocket = original.WebSocket;
    }

    expect(attempts, 'nothing reached for the network').toEqual([]);
  }, 180_000);

  it('holds no static import of pptxgenjs anywhere in src/', async () => {
    // The lazy-chunk guarantee, asserted against the source tree rather than
    // taken on trust: a top-level `import PptxGenJS from 'pptxgenjs'` would put
    // 500 KB into whichever chunk first touched it. The only permitted forms are
    // the dynamic `import()` in `pptx-writer.ts` and an erased `import type`.
    const { execFileSync } = await import('node:child_process');
    const hits = execFileSync(
      'grep',
      ['-rn', '--include=*.ts', '--include=*.tsx', 'pptxgenjs', 'src'],
      { encoding: 'utf8' }
    )
      .split('\n')
      .filter(line => line.length > 0);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      const isDynamic = /await import\('pptxgenjs'\)/.test(hit);
      const isTypeOnly = /^\S+:\d+:import type /.test(hit);
      const isComment = /^\S+:\d+:\s*(\*|\/\/)/.test(hit);
      expect(
        isDynamic || isTypeOnly || isComment,
        `only a dynamic import, an \`import type\`, or a comment may name pptxgenjs: ${hit}`
      ).toBe(true);
    }
  });
});

describe('CNV-12 — one shared image is one media part, not one per slide', () => {
  it('documents the library behaviour the dedup pass exists to fix', async () => {
    // Asserted *first*, on `pptxgenjs` directly, so this test cannot silently
    // stop being about anything: the library dedupes media only within one
    // slide and only by comparing the `path` a caller passed, and it names every
    // part `image-<slideNum>-<n>`. Two slides carrying byte-identical `data`
    // therefore produce two identical parts.
    const { default: PptxGenJS } = await import('pptxgenjs');
    const png =
      'image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    const raw = new PptxGenJS();
    raw.defineLayout({ name: 'T', width: 8.5, height: 11 });
    raw.layout = 'T';
    for (let i = 0; i < 3; i++) {
      raw.addSlide().addImage({ data: png, x: 1, y: 1, w: 1, h: 1 });
    }
    const before = (await raw.write({ outputType: 'uint8array' })) as Uint8Array;
    const rawParts = Object.keys(unzipSync(before)).filter(
      name => name.startsWith('ppt/media/') && !name.endsWith('/')
    );
    expect(rawParts, 'the library really does write one part per slide').toHaveLength(3);

    // …and the pass collapses them, repointing every relationship.
    const { dedupeMediaParts } = await import('../../src/core/convert/pptx-writer');
    const after = await dedupeMediaParts(before);
    const read = await readPptx(after);
    expect(
      Object.keys(unzipSync(after)).filter(
        name => name.startsWith('ppt/media/') && !name.endsWith('/')
      )
    ).toHaveLength(1);
    // All three slides still have a picture, and all three point at the part
    // that survived — a repointed relationship, not a dropped one.
    expect(read.slides).toHaveLength(3);
    for (const slide of read.slides) {
      expect(slide.media).toHaveLength(1);
      expect(slide.media[0].part).toBe(rawParts[0]);
      expect(slide.media[0].byteLength).toBeGreaterThan(0);
      const picture = slide.shapes.find(shape => shape.kind === 'picture');
      expect(picture!.relationshipId).toBe(slide.media[0].relationshipId);
    }
    expect(after.byteLength).toBeLessThan(before.byteLength);
  }, 120_000);

  it('leaves a deck with no duplicated media byte-identical', async () => {
    // The "never do work you do not need" half: with nothing to collapse the
    // package is not unzipped and re-zipped, so the returned value is the very
    // array that came in.
    const { dedupeMediaParts } = await import('../../src/core/convert/pptx-writer');
    const result = await deckWithoutImages();
    const again = await dedupeMediaParts(result.bytes);
    expect(again).toBe(result.bytes);
  }, 180_000);

  it('keeps a deck small when one image is drawn on every page', async () => {
    // The claim at document scale, and the one that decides whether this tool
    // is usable on a real document. CMP-03's own fixture: six A4 pages that all
    // draw the *same* 1600 x 1200 photo. `pptxgenjs` would write six copies of
    // it; the deck must hold one, and its total size must therefore sit just
    // above one copy rather than at six.
    const result = await convert(await sharedImagePdf(6));
    expect(result.slideCount).toBe(6);
    // Six placements — the picture is on every slide, so nothing was dropped.
    expect(result.imageCount).toBe(6);

    const parts = unzipSync(result.bytes);
    const media = Object.keys(parts).filter(
      name => name.startsWith('ppt/media/') && !name.endsWith('/')
    );
    expect(media).toHaveLength(1);
    const imageBytes = parts[media[0]].length;
    expect(imageBytes).toBeGreaterThan(500_000);
    // The whole deck is within a third again of the single image it carries.
    // Six copies would put it past 3x, which is the failure this asserts
    // against — and it is asserted as a *ratio* so it cannot drift with the
    // fixture's photo size.
    expect(result.bytes.byteLength).toBeLessThan(imageBytes * 1.35);

    // Every slide still references it, so the collapse repointed rather than
    // dropped.
    const read = await readPptx(result.bytes);
    expect(read.slides).toHaveLength(6);
    for (const slide of read.slides) {
      expect(slide.media.map(entry => entry.part)).toEqual([media[0]]);
      expect(slide.shapes.filter(shape => shape.kind === 'picture')).toHaveLength(1);
    }
  }, 240_000);

  it('keeps two genuinely different images apart', async () => {
    // The check that matters if identity is ever compared by hash instead of by
    // bytes: two different images must stay two parts.
    const doc = await PDFDocument.create();
    const png = (level: number) =>
      encodePng({
        width: 8,
        height: 8,
        bitDepth: 8,
        colorType: 2,
        samples: new Uint8Array(8 * 8 * 3).fill(level)
      });
    const first = await doc.embedPng(png(30));
    const second = await doc.embedPng(png(220));
    const page = doc.addPage([300, 300]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('two different images', { x: 20, y: 280, size: 10, font });
    page.drawImage(first, { x: 20, y: 150, width: 60, height: 60 });
    page.drawImage(second, { x: 120, y: 150, width: 60, height: 60 });

    const result = await convert(await doc.save());
    expect(result.imageCount).toBe(2);
    const parts = Object.keys(unzipSync(result.bytes)).filter(
      name => name.startsWith('ppt/media/') && !name.endsWith('/')
    );
    expect(parts).toHaveLength(2);
  }, 120_000);
});

describe('CNV-12 — unsupported input is refused, not half-converted', () => {
  it('refuses an XFA form from `convertPdfToPptx` itself, before any deck work', async () => {
    buildPptxCalls = 0;
    const bytes = fixture('xfa.pdf');
    expect(hasXfaMarker(bytes)).toBe(true);
    const failure = await convert(bytes).then(
      () => null,
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(StaplerError);
    expect((failure as StaplerError).kind).toBe('UnsupportedFeature');
    expect((failure as StaplerError).message).toBe(XFA_CONVERT_MESSAGE);
    // Nothing was written, and nothing was even attempted.
    expect(buildPptxCalls).toBe(0);
    // …and the fixture the conversion is meant to accept is not a false positive.
    expect(hasXfaMarker(await source())).toBe(false);
  }, 60_000);

  it('refuses an encrypted document from `convertPdfToPptx` itself', async () => {
    buildPptxCalls = 0;
    const failure = await convert(fixture('encrypted.pdf')).then(
      () => null,
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(StaplerError);
    expect((failure as StaplerError).kind).toBe('Encrypted');
    expect(buildPptxCalls).toBe(0);
  }, 60_000);

  it('refuses a deck that would have nothing on any slide, rather than writing one', async () => {
    // Both options off is the reachable case; a scanned PDF with no text layer
    // reaches the same refusal with images on but nothing embeddable.
    const failure = await convert(await source(), {
      includeText: false,
      includeImages: false
    }).then(
      () => null,
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(StaplerError);
    expect((failure as StaplerError).kind).toBe('UnsupportedFeature');
    expect((failure as StaplerError).message).toMatch(/Nothing could be placed on any slide/);
    expect((failure as StaplerError).message).toMatch(/run the OCR tool/);
  }, 180_000);

  it('names a JPEG 2000 image as unplaceable instead of embedding garbage', () => {
    const page = slidePage({});
    const plan = planSlides([page], {
      includeText: true,
      includeImages: true,
      placements: [
        {
          pageIndex: 0,
          objectNumber: 7,
          name: 'Im1',
          x: 10,
          y: 10,
          width: 100,
          height: 50,
          axisAligned: true
        }
      ],
      entries: [
        {
          pageIndex: 0,
          objectNumber: 7,
          name: 'Im1',
          fileName: 'page-001-image-01.jp2',
          status: 'extracted'
        }
      ],
      archivedFiles: new Set(['page-001-image-01.jp2'])
    });
    expect(plan.slides[0].images).toEqual([]);
    expect(plan.notes[0]).toContain('jp2');
    expect(plan.notes[0]).toContain('the PDF still has it');
    expect(isEmptyPlan(plan)).toBe(true);
  });

  it("passes CNV-06's own skip reason through instead of dropping the image quietly", () => {
    const plan = planSlides([slidePage({ pageIndex: 2 })], {
      includeText: true,
      includeImages: true,
      placements: [
        {
          pageIndex: 2,
          objectNumber: 9,
          name: 'Im1',
          x: 0,
          y: 0,
          width: 8,
          height: 8,
          axisAligned: true
        }
      ],
      entries: [
        {
          pageIndex: 2,
          objectNumber: 9,
          name: 'Im1',
          status: 'skipped',
          note: 'JBIG2 data is an embedded segment sequence.'
        }
      ],
      archivedFiles: new Set()
    });
    expect(plan.notes[0]).toBe('Page 3: JBIG2 data is an embedded segment sequence.');
  });

  it('counts images the page never draws instead of one note per page', () => {
    // An unused `/XObject` entry inherited by every page of a long document
    // would otherwise produce one identical line per page, burying the notes
    // that matter. Two pages here, one aggregate note.
    const page = (pageIndex: number): PageSlideData =>
      slidePage({
        pageIndex,
        lines: [slideLine({ text: `page ${pageIndex + 1}`, x: 40, width: 40, size: 11 })]
      });
    const entry = (pageIndex: number) => ({
      pageIndex,
      objectNumber: 12,
      name: 'Im1',
      fileName: 'page-001-image-01.png',
      status: 'extracted' as const
    });

    const plan = planSlides([page(0), page(1)], {
      includeText: true,
      includeImages: true,
      // No placements at all: the resource is present and never painted.
      placements: [],
      entries: [entry(0), entry(1)],
      archivedFiles: new Set(['page-001-image-01.png'])
    });
    expect(plan.slides.every(slide => slide.images.length === 0)).toBe(true);
    const matching = plan.notes.filter(note => /never drawn by that page/.test(note));
    expect(matching).toHaveLength(1);
    expect(matching[0]).toContain('2 image(s)');
    expect(matching[0]).toContain('Nothing visible on any page is missing');
  });

  it('reports a direct (unnumbered) image object rather than guessing which file it is', () => {
    const plan = planSlides([slidePage({ box: { width: 200, height: 200 } })], {
      includeText: true,
      includeImages: true,
      placements: [
        {
          pageIndex: 0,
          objectNumber: -1,
          name: 'Im9',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          axisAligned: true
        }
      ],
      entries: [],
      archivedFiles: new Set()
    });
    expect(plan.slides[0].images).toEqual([]);
    expect(plan.notes[0]).toContain('/Im9');
    expect(plan.notes[0]).toContain('stored directly in the page');
  });
});

describe('CNV-12 — cancellation, in both phases', () => {
  it('cancels before the writer is ever reached, with a signal already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    buildPptxCalls = 0;
    await expect(convert(await source(), {}, { signal: controller.signal })).rejects.toThrow();
    // Cancellation is a refusal too: an aborted job must not have written a
    // deck on its way to throwing.
    expect(buildPptxCalls).toBe(0);
  }, 180_000);

  it('cancels during the page-reading phase, before images are even collected', async () => {
    // Aborted on the first progress report, which lands inside the render loop.
    const controller = new AbortController();
    buildPptxCalls = 0;
    placementCalls = 0;
    const before = placementCalls;
    const progress: number[] = [];
    await expect(
      convert(
        await source(),
        {},
        {
          signal: controller.signal,
          onProgress: fraction => {
            progress.push(fraction ?? 0);
            controller.abort();
          }
        }
      )
    ).rejects.toThrow();
    expect(buildPptxCalls).toBe(0);
    expect(placementCalls, 'the image passes were never entered').toBe(before);
    expect(Math.max(...progress)).toBeLessThan(0.5);
  }, 180_000);

  it('cancels during the pptx-build phase, after every page was read', async () => {
    // The phase the first two tests do not reach. `buildPptx` checkpoints once
    // per slide inside `pptx-writer.ts`, and `convertPdfToPptx` maps that band
    // onto 0.75..1 — so aborting on the first report strictly above 0.75 aborts
    // inside the writer, with the reading already finished.
    const controller = new AbortController();
    buildPptxCalls = 0;
    const progress: number[] = [];
    await expect(
      convert(
        await source(),
        {},
        {
          signal: controller.signal,
          onProgress: fraction => {
            progress.push(fraction ?? 0);
            if ((fraction ?? 0) > 0.75) controller.abort();
          }
        }
      )
    ).rejects.toThrow();

    // Unlike the two tests above, the writer *was* entered — this is a
    // cancellation of the last phase, not of the first.
    expect(buildPptxCalls, 'the writer really ran').toBe(1);
    expect(
      progress.some(fraction => fraction > 0.75),
      'progress crossed the inter-phase gate into the writer band'
    ).toBe(true);
    expect(Math.max(...progress)).toBeLessThan(1);
  }, 180_000);
});

describe('CNV-12 — image placement comes from the content stream', () => {
  it('finds an image drawn inside a Form XObject, through its matrix and BBox', async () => {
    // The page's own content stream never names the image — only the form. A
    // resource-dictionary walk (CNV-06's) finds the *bytes*; only a
    // content-stream walk finds where it lands.
    const result = await convert(await pdfToPptFormXObjectPdf());
    expect(result.imageCount).toBe(1);

    const read = await readPptx(result.bytes);
    const picture = read.slides[0].shapes.find(shape => shape.kind === 'picture')!;
    expect(picture).toBeTruthy();

    // The form maps a 100 × 100 unit box to (100, 400) via its `/Matrix`, and
    // its `/BBox` is 60 wide — so the image is 60 × 100 points at (100, 400) in
    // PDF space, which on a 400 × 600 page is (100, 100) from the top.
    expect(Math.abs(picture.x - 100 * EMU_PER_POINT)).toBeLessThan(EMU_PER_POINT);
    expect(Math.abs(picture.y - 100 * EMU_PER_POINT)).toBeLessThan(EMU_PER_POINT);
    expect(Math.abs(picture.cx - 60 * EMU_PER_POINT)).toBeLessThan(EMU_PER_POINT);
    expect(Math.abs(picture.cy - 100 * EMU_PER_POINT)).toBeLessThan(EMU_PER_POINT);
    // The clip is doing real work: without it the picture would be 100 wide.
    expect(picture.cx).toBeLessThan(picture.cy);
  }, 120_000);

  it('refuses an inline image by name, and does not claim a filter failed', async () => {
    // An inline image's binary payload sits in the operator stream, so
    // tokenising it yields garbage tokens that can read as `q`/`Q`/`cm`/`Do` —
    // which would corrupt the CTM and could emit a placement for an image that
    // is not there. RED-02's `parseContentStream` throws on `ID`; this asserts
    // the placement pass reports *that* reason rather than the decode one, and
    // that the page's text still reaches its slide.
    const result = await convert(await inlineImagePdf());
    expect(result.slideCount).toBe(1);
    expect(result.imageCount).toBe(0);

    const joined = result.notes.join('\n');
    expect(joined).toMatch(/^Page 1: no image on this page could be placed/);
    expect(joined, 'the reason names inline images').toMatch(/inline images/);
    expect(joined, 'and does not misdescribe it as a filter problem').not.toMatch(
      /filter chain Stapler cannot decode/
    );

    // The text is not collateral damage: the slide still carries it.
    const read = await readPptx(result.bytes);
    expect(read.slides[0].text).toContain('Page with an inline image');
  }, 120_000);

  it('places nothing, and complains about nothing, for a page with no images', async () => {
    const result = await convert(await textPdf(2));
    expect(result.imageCount).toBe(0);
    expect(result.slideCount).toBe(2);
    expect(result.notes).toEqual([]);
  }, 120_000);
});

describe('CNV-12 — a page whose box does not start at the origin', () => {
  /** The one text shape whose text contains `needle`, from a produced deck. */
  async function shapeWithText(bytes: Uint8Array, needle: string) {
    const read = await readPptx(bytes);
    const shape = read.slides[0].shapes.find(
      candidate => candidate.kind === 'text' && (candidate.text ?? '').includes(needle)
    );
    expect(shape, `a text box holds "${needle}"`).toBeTruthy();
    return shape!;
  }

  it("places a cropped page's title where the reader sees it, not at its raw coordinate", async () => {
    // The audit's own worked example, reproduced exactly. A 24pt run drawn at
    // raw (150, 700) on a page cropped to [100 100 612 792] belongs at
    // (50, 72.8) on the slide. Before the box origin was carried it landed at
    // (150, −27.2) — off the top edge, and 100 pt to the right.
    const expected = PDF_TO_PPT_BOXES.crop.expected;
    const result = await convert(await pdfToPptCroppedPdf());

    // The slide is the *crop's* size, which pdf.js's viewport already got right
    // — so this passing was never the part in doubt.
    expect(result.slideWidth).toBeCloseTo(expected.slide.width, 3);
    expect(result.slideHeight).toBeCloseTo(expected.slide.height, 3);

    const title = await shapeWithText(result.bytes, 'Cropped title');
    expect(Math.abs(title.x - expected.title.x * EMU_PER_POINT)).toBeLessThan(EMU_PER_POINT);
    expect(Math.abs(title.y - expected.title.y * EMU_PER_POINT)).toBeLessThan(EMU_PER_POINT);

    // Stated as the defect as well as the fix: the pre-fix coordinates are the
    // raw ones, and they are *not* what came out. −27.2 pt is off the slide.
    const raw = PDF_TO_PPT_BOXES.crop.titleAt;
    expect(Math.abs(title.x - raw.x * EMU_PER_POINT)).toBeGreaterThan(EMU_PER_POINT);
    expect(title.y).toBeGreaterThan(0);

    // Every box is on the slide, not only the title: the second line too.
    const footer = await shapeWithText(result.bytes, 'A second line');
    expect(footer.x).toBeGreaterThan(0);
    expect(footer.y).toBeLessThan(expected.slide.height * EMU_PER_POINT);
    expect(footer.y).toBeGreaterThan(title.y);
  }, 180_000);

  it("places a cropped page's picture against the same origin its text uses", async () => {
    // The other half of the fix. The placement walk reports raw content-stream
    // coordinates, so a picture displaced by the crop while the text was not
    // would be the worse failure — text and image disagreeing about one page.
    const expected = PDF_TO_PPT_BOXES.crop.expected;
    const result = await convert(await pdfToPptCroppedPdf());
    const read = await readPptx(result.bytes);
    const picture = read.slides[0].shapes.find(shape => shape.kind === 'picture');
    expect(picture, 'the page draws one picture').toBeTruthy();

    expect(Math.abs(picture!.x - expected.image.x * EMU_PER_POINT)).toBeLessThan(EMU_PER_POINT);
    expect(Math.abs(picture!.y - expected.image.y * EMU_PER_POINT)).toBeLessThan(EMU_PER_POINT);
    // The size is unaffected by the origin — asserted so a fix that translated
    // the rectangle by scaling it instead would fail here.
    expect(Math.abs(picture!.cx - expected.image.width * EMU_PER_POINT)).toBeLessThan(
      EMU_PER_POINT
    );
    expect(Math.abs(picture!.cy - expected.image.height * EMU_PER_POINT)).toBeLessThan(
      EMU_PER_POINT
    );

    // And it agrees with the text: both were drawn at the same raw x.
    const title = await shapeWithText(result.bytes, 'Cropped title');
    expect(Math.abs(picture!.x - title.x)).toBeLessThan(EMU_PER_POINT);
  }, 180_000);

  it('carries the origin of an offset /MediaBox, where there is no /CropBox to read', async () => {
    // The origin cannot be taken from a `/CropBox`: this page has none, and its
    // media box starts at (20, 30). pdf.js's view box falls back to the media
    // box, which is why the origin is read from there rather than from a crop.
    const expected = PDF_TO_PPT_BOXES.media.expected;
    const result = await convert(await pdfToPptOffsetMediaBoxPdf());
    expect(result.slideWidth).toBeCloseTo(expected.slide.width, 3);
    expect(result.slideHeight).toBeCloseTo(expected.slide.height, 3);

    const heading = await shapeWithText(result.bytes, 'An offset media box');
    expect(Math.abs(heading.x - expected.heading.x * EMU_PER_POINT)).toBeLessThan(EMU_PER_POINT);
    expect(Math.abs(heading.y - expected.heading.y * EMU_PER_POINT)).toBeLessThan(EMU_PER_POINT);

    const read = await readPptx(result.bytes);
    const picture = read.slides[0].shapes.find(shape => shape.kind === 'picture')!;
    expect(Math.abs(picture.x - expected.image.x * EMU_PER_POINT)).toBeLessThan(EMU_PER_POINT);
    expect(Math.abs(picture.y - expected.image.y * EMU_PER_POINT)).toBeLessThan(EMU_PER_POINT);
  }, 180_000);

  it('is a no-op for the ordinary page, whose box already starts at the origin', () => {
    // The regression guard: subtracting a zero origin has to change nothing, so
    // the same line through a box at (0, 0) and through a box at (100, 100)
    // differ by exactly that origin and nothing else.
    const line = slideLine({ x: 150, baseline: 700, width: 200, size: 24 });
    const atOrigin = planSlides([slidePage({ box: { width: 512, height: 692 }, lines: [line] })], {
      includeText: true,
      includeImages: false,
      placements: null,
      entries: null,
      archivedFiles: new Set()
    });
    const cropped = planSlides(
      [slidePage({ box: { x: 100, y: 100, width: 512, height: 692 }, lines: [line] })],
      {
        includeText: true,
        includeImages: false,
        placements: null,
        entries: null,
        archivedFiles: new Set()
      }
    );
    const a = atOrigin.slides[0].boxes[0];
    const b = cropped.slides[0].boxes[0];
    expect(a.x - b.x).toBeCloseTo(100, 10);
    expect(b.y - a.y).toBeCloseTo(100, 10);
    expect(b.width).toBeCloseTo(a.width, 10);
    expect(b.height).toBeCloseTo(a.height, 10);
    // The old, wrong answer for the cropped page is `a`'s coordinates.
    expect(a.y).toBeCloseTo(692 - (700 + 24 * 0.8) + 24 * 1.2 * 0.5 - 24 * 1.2 * 0.5, 6);
  });

  it('applies the origin under /Rotate as well, in the right order', () => {
    // The origin is removed *before* the quarter turn, because the rotation is
    // about the displayed box and not about raw user space. Reversing the two
    // puts a rotated cropped page off the slide in the other direction.
    const line = slideLine({ x: 150, baseline: 700, width: 100, size: 20 });
    const plan = planSlides(
      [
        slidePage({ box: { x: 100, y: 100, width: 400, height: 600 }, lines: [line], rotation: 90 })
      ],
      {
        includeText: true,
        includeImages: false,
        placements: null,
        entries: null,
        archivedFiles: new Set()
      }
    );
    // Box-relative: origin (50, 600), centre (100, 604) y-up → (100, −4) y-down.
    // A quarter turn maps (u, v) → (boxHeight − v, u) = (604, 100).
    const box = plan.slides[0].boxes[0];
    expect(box.x + box.width / 2).toBeCloseTo(604, 6);
    expect(box.y + box.height / 2).toBeCloseTo(100, 6);
    expect(box.rotate).toBe(90);
  });
});

describe('CNV-12 — text drawn at an angle inside the page', () => {
  it('reads a rotated run’s real angle and real type size off its transform', () => {
    // The two numbers the old path lost. A quarter-turn run's `transform[3]` is
    // zero, so the type size fell back to a hardcoded 12 and the angle was
    // never looked for at all.
    expect(textBaselineAngle([12, 0, 0, 12, 0, 0])).toEqual({ angle: 0, mirrored: false });
    expect(textTypeSize([12, 0, 0, 12, 0, 0])).toBeCloseTo(12, 10);

    const quarter = [0, 18, -18, 0, 100, 100];
    expect(textBaselineAngle(quarter).angle).toBeCloseTo(90, 10);
    expect(textTypeSize(quarter)).toBeCloseTo(18, 10);
    // …which is the assertion that fails on the old rule.
    expect(Math.abs(quarter[3])).toBe(0);

    const diagonal = [21.213, 21.213, -21.213, 21.213, 0, 0];
    expect(textBaselineAngle(diagonal).angle).toBeCloseTo(45, 3);
    expect(textTypeSize(diagonal)).toBeCloseTo(30, 2);

    // A 180° rotation has a positive determinant and is a rotation.
    expect(textBaselineAngle([-12, 0, 0, -12, 0, 0]).angle).toBeCloseTo(180, 10);
    // A *mirror* does not: rotating the box would flip the glyphs twice, so it
    // stays horizontal and is counted instead of being silently turned.
    expect(textBaselineAngle([0, 12, 12, 0, 0, 0])).toEqual({ angle: 0, mirrored: true });
    // Matrix jitter is not an angle.
    expect(textBaselineAngle([12, 0.0005, 0, 12, 0, 0]).angle).toBe(0);
    // A nonsense transform reaches the geometry as 0, never as NaN.
    expect(textBaselineAngle([NaN, 0, 0, 12, 0, 0])).toEqual({ angle: 0, mirrored: false });
  });

  it('keeps an angled run out of the horizontal line grouping', () => {
    // `layoutLines` buckets by shared `transform[5]`, which is meaningless for a
    // sideways run — and it is shared with four other exports, so it is fed only
    // horizontal runs. Two runs at the same `y`, one turned: two lines, not one.
    const page = pageTextLines(
      [
        { str: 'flat', transform: [12, 0, 0, 12, 40, 300], width: 20, height: 12 },
        { str: 'turned', transform: [0, 18, -18, 0, 200, 300], width: 40, height: 18 }
      ],
      0,
      { x: 0, y: 0, width: 400, height: 400 },
      0
    );
    expect(page.lines).toHaveLength(2);
    expect(page.rotatedLines).toBe(1);
    expect(page.mirroredLines).toBe(0);
    const [flat, turned] = page.lines;
    expect(flat.angle).toBe(0);
    expect(flat.size).toBeCloseTo(12, 10);
    expect(turned.angle).toBeCloseTo(90, 10);
    // The size the old path defaulted to 12 for.
    expect(turned.size).toBeCloseTo(18, 10);
  });

  it('writes a real rot and a real font size for a sideways header, end to end', async () => {
    const f = PDF_TO_PPT_ROTATED_TEXT;
    const result = await convert(await pdfToPptRotatedTextPdf());
    const slide = strFromU8(unzipSync(result.bytes)['ppt/slides/slide1.xml']);
    const read = await readPptx(result.bytes);
    const shape = (needle: string) =>
      read.slides[0].shapes.find(
        candidate => candidate.kind === 'text' && (candidate.text ?? '').includes(needle)
      )!;

    /** One `<p:sp>` element's XML, found by the text it holds. */
    const shapeXml = (needle: string) => {
      const found = slide.split('<p:sp>').find(part => part.includes(needle));
      expect(found, `slide XML holds a shape for "${needle}"`).toBeTruthy();
      return found!;
    };

    // A run turned a quarter turn anticlockwise in PDF space is a 270° shape in
    // PowerPoint's clockwise frame. 270 × 60000 EMU-degrees.
    const sideways = shape('Sideways column header');
    expect(sideways.rot).toBe(270 * 60000);
    // Its real size, graded off that shape's own drawing-ML: 18pt is 1800
    // hundredths. The old path wrote 1200 here, from a hardcoded default,
    // because `|transform[3]|` is zero for a quarter-turn run.
    const sidewaysXml = shapeXml('Sideways column header');
    expect(sidewaysXml).toContain('sz="1800"');
    expect(sidewaysXml).not.toContain('sz="1200"');

    // The diagonal watermark: 45° anticlockwise is a 315° shape, at 30pt.
    expect(shape('DRAFT DIAGONAL').rot).toBe(315 * 60000);
    expect(shapeXml('DRAFT DIAGONAL')).toContain('sz="3000"');

    // The control line really is the 12pt one, so the two assertions above are
    // about the rotated shapes and not about the page's only size.
    expect(shapeXml('Upright control line')).toContain('sz="1200"');

    // And the upright control line carries no rotation at all, so `rot` is
    // written from the run rather than always.
    expect(shape('Upright control line').rot).toBe(0);

    // The sideways box is laid out in its own unrotated frame — wider than it is
    // tall, because it holds one line of text — and PowerPoint turns it.
    expect(sideways.cx).toBeGreaterThan(sideways.cy * 2);
    // Its centre: the baseline origin is (100, 100), the advance runs upward, so
    // the centre sits 0.2 em to the *left* of the origin's x.
    expect(
      Math.abs(sideways.x + sideways.cx / 2 - (100 - f.sideways.size * 0.2) * EMU_PER_POINT)
    ).toBeLessThan(EMU_PER_POINT);
  }, 180_000);

  it('says so in the preview rather than flattening angled text in silence', async () => {
    const result = await convert(await pdfToPptRotatedTextPdf());
    const angled = result.notes.filter(note => /drawn at an angle/.test(note));
    expect(angled).toHaveLength(1);
    expect(angled[0]).toContain('Page 1');
    expect(angled[0]).toContain('2 line(s)');
    // Mirrored runs get their own line, and this page has none.
    expect(result.notes.some(note => /mirrored/.test(note))).toBe(false);
  }, 180_000);

  it('reports a mirrored run as not reproduced instead of turning it', () => {
    const page = pageTextLines(
      [{ str: 'mirrored', transform: [0, 12, 12, 0, 40, 300], width: 20, height: 12 }],
      0,
      { x: 0, y: 0, width: 400, height: 400 },
      0
    );
    expect(page.mirroredLines).toBe(1);
    expect(page.rotatedLines).toBe(0);
    expect(page.lines[0].angle).toBe(0);

    const plan = planSlides([page], {
      includeText: true,
      includeImages: false,
      placements: null,
      entries: null,
      archivedFiles: new Set()
    });
    expect(plan.notes.some(note => /mirrored/.test(note))).toBe(true);
    expect(plan.slides[0].boxes[0].rotate).toBe(0);
  });

  it('states the angled-text gap in the limitation list the panel renders', () => {
    const all = PPTX_LIMITATIONS.join(' ');
    expect(all).toContain('Text drawn at an angle');
    expect(all).toContain('its own text box rather than being joined into one');
    expect(all).toContain('mirrored');
  });
});

describe('CNV-12 — the geometry, in isolation', () => {
  it('maps each rotation’s corners the way a viewer displays them', () => {
    // Unrotated page 612 × 792, top-left origin. Checked at the corner because
    // that is where a sign error is unmistakable.
    expect(rotatePoint(0, 0, 0, 612, 792)).toEqual({ u: 0, v: 0 });
    // 90° clockwise: the top-left corner becomes the top-right of a 792-wide
    // displayed page.
    expect(rotatePoint(0, 0, 90, 612, 792)).toEqual({ u: 792, v: 0 });
    expect(rotatePoint(612, 792, 90, 612, 792)).toEqual({ u: 0, v: 612 });
    // 180°: opposite corner.
    expect(rotatePoint(0, 0, 180, 612, 792)).toEqual({ u: 612, v: 792 });
    // 270° (anticlockwise): the top-left becomes the bottom-left.
    expect(rotatePoint(0, 0, 270, 612, 792)).toEqual({ u: 0, v: 612 });
  });

  it('swaps the displayed side lengths for a quarter turn only', () => {
    // The origin is deliberately non-zero: a page's displayed *size* does not
    // depend on where its box starts, only on how big the box is.
    const page = { box: { x: 33, y: 44, width: 612, height: 792 } };
    expect(displayedSize({ ...page, rotation: 0 })).toEqual({ width: 612, height: 792 });
    expect(displayedSize({ ...page, rotation: 90 })).toEqual({ width: 792, height: 612 });
    expect(displayedSize({ ...page, rotation: 180 })).toEqual({ width: 612, height: 792 });
    expect(displayedSize({ ...page, rotation: 270 })).toEqual({ width: 792, height: 612 });
  });

  it('fits a page to the slide uniformly and centres it, never stretching it', () => {
    const same = fitPageToSlide(
      { box: { x: 0, y: 0, width: 612, height: 792 }, rotation: 0 },
      612,
      792
    );
    expect(same).toEqual({ scale: 1, offsetX: 0, offsetY: 0, rescaled: false });

    // A landscape page in a portrait slide: scaled by width and letterboxed
    // vertically, with one scale for both axes.
    const wide = fitPageToSlide(
      { box: { x: 0, y: 0, width: 792, height: 612 }, rotation: 0 },
      612,
      792
    );
    expect(wide.scale).toBeCloseTo(612 / 792, 10);
    expect(wide.offsetX).toBeCloseTo(0, 10);
    expect(wide.offsetY).toBeGreaterThan(0);
    expect(wide.rescaled).toBe(true);

    // A degenerate page is passed through rather than producing NaN geometry.
    expect(
      fitPageToSlide({ box: { x: 0, y: 0, width: 0, height: 0 }, rotation: 0 }, 612, 792)
    ).toEqual({
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      rescaled: false
    });
  });

  it('snaps /Rotate and survives a missing or nonsense one', () => {
    expect(slideRotation(0)).toBe(0);
    expect(slideRotation(90)).toBe(90);
    expect(slideRotation(-90)).toBe(270);
    expect(slideRotation(450)).toBe(90);
    // A malformed file can leave `page.rotate` absent or non-numeric; that must
    // reach the geometry as 0, not as NaN.
    expect(slideRotation(undefined)).toBe(0);
    expect(slideRotation(null)).toBe(0);
    expect(slideRotation(Number.NaN)).toBe(0);
  });

  it('caps the boxes per slide and the characters per box, and counts what it cut', () => {
    /** A pdf.js-shaped run. PDF space, so a larger `y` is higher on the page. */
    const run = (str: string, x: number, y: number, size = 11) => ({
      str,
      transform: [size, 0, 0, size, x, y],
      width: str.length * size * 0.5,
      height: size
    });

    // More lines than the cap: every extra is counted, never silently gone.
    const many = Array.from({ length: MAX_BOXES_PER_SLIDE + 12 }, (_, i) =>
      run(`line ${i}`, 40, 10_000 - i * 14)
    );
    const page = pageTextLines(many, 0, LETTER_BOX, 0);
    expect(page.lines).toHaveLength(MAX_BOXES_PER_SLIDE);
    expect(page.droppedLines).toBe(12);
    const plan = planSlides([page], {
      includeText: true,
      includeImages: false,
      placements: null,
      entries: null,
      archivedFiles: new Set()
    });
    expect(plan.notes.join('\n')).toMatch(/12 line\(s\) of text were left out/);

    // One absurdly long line: shortened to the cap and reported.
    const long = pageTextLines([run('x'.repeat(MAX_BOX_CHARS + 50), 40, 700)], 0, LETTER_BOX, 0);
    expect(long.lines[0].runs[0].text).toHaveLength(MAX_BOX_CHARS);
    expect(long.lines[0].truncated).toBe(50);
    const longPlan = planSlides([long], {
      includeText: true,
      includeImages: false,
      placements: null,
      entries: null,
      archivedFiles: new Set()
    });
    expect(longPlan.notes.join('\n')).toMatch(/were shortened to 1000 characters/);
  });

  it('does not claim it shortened a line that is exactly the cap long', () => {
    // The boundary. `lineToRuns` measures exactly how much it removed, and a
    // line of exactly MAX_BOX_CHARS has nothing removed from it — so reporting
    // it as "shortened" would be the converter misdescribing its own output,
    // which is the class of defect this ticket already had to fix once.
    const exact = 'y'.repeat(MAX_BOX_CHARS);
    const page = pageTextLines(
      [{ str: exact, transform: [11, 0, 0, 11, 40, 700], width: exact.length * 5.5, height: 11 }],
      0,
      LETTER_BOX,
      0
    );
    expect(page.lines[0].runs[0].text).toBe(exact);
    expect(page.lines[0].truncated).toBe(0);

    const plan = planSlides([page], {
      includeText: true,
      includeImages: false,
      placements: null,
      entries: null,
      archivedFiles: new Set()
    });
    expect(plan.notes.join('\n')).not.toMatch(/were shortened/);

    // One character more, and it *is* reported — so the assertion above is
    // about the boundary and not about the note never being written.
    const over = pageTextLines(
      [
        {
          str: `${exact}z`,
          transform: [11, 0, 0, 11, 40, 700],
          width: exact.length * 5.5,
          height: 11
        }
      ],
      0,
      LETTER_BOX,
      0
    );
    expect(over.lines[0].truncated).toBe(1);
    expect(
      planSlides([over], {
        includeText: true,
        includeImages: false,
        placements: null,
        entries: null,
        archivedFiles: new Set()
      }).notes.join('\n')
    ).toMatch(/were shortened/);
  });

  it('reinstates the space a producer implied by position, like the text export does', () => {
    const run = (
      str: string,
      x: number,
      width: number,
      style: { bold?: boolean; italic?: boolean } = {}
    ) => ({ str, transform: [11, 0, 0, 11, x, 700], width, height: 11, ...style });

    const page = pageTextLines(
      [
        run('Revenue rose', 56, 68),
        run('12 percent', 127, 55, { bold: true }),
        run('against', 185, 40)
      ],
      0,
      LETTER_BOX,
      0
    );
    expect(page.lines[0].runs).toEqual([
      { text: 'Revenue rose', bold: false, italic: false },
      { text: ' 12 percent', bold: true, italic: false },
      { text: ' against', bold: false, italic: false }
    ]);
    // The same joined line CNV-08's `lineRuns` produces from the same runs —
    // the shared rule, pinned so the two cannot drift.
    expect(page.lines[0].runs.map(part => part.text).join('')).toBe(
      'Revenue rose 12 percent against'
    );
  });

  it('states its limitations as data, so the panel and the converter cannot disagree', () => {
    // The panel renders this list verbatim; the ticket requires the widest gap
    // of the six converters to be stated plainly before the tool runs.
    expect(PPTX_LIMITATIONS.length).toBeGreaterThanOrEqual(10);
    const all = PPTX_LIMITATIONS.join(' ');
    for (const claim of [
      'does not reflow',
      'no bullets',
      'All text is black',
      'One slide size for the whole deck',
      'JPEG 2000',
      'invisible text layer',
      'Positioning is approximate'
    ]) {
      expect(all, `the limitation list mentions "${claim}"`).toContain(claim);
    }
  });
});

describe('CNV-12 — the reader refuses what it cannot read', () => {
  it('refuses bytes that are not a ZIP at all', async () => {
    await expect(readPptx(new TextEncoder().encode('this is plain text'))).rejects.toThrow(
      NOT_A_ZIP_MESSAGE
    );
    // The mirror of CNV-11's finding about SheetJS: a permissive reader would
    // find no slides in this and report an empty deck as a success.
    await expect(readPptx(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).rejects.toThrow(
      NOT_A_ZIP_MESSAGE
    );
    await expect(readPptx(new Uint8Array(0))).rejects.toThrow(/file is empty/);
  });

  it('names the OLE2 case, which is a legacy .ppt or a protected .pptx', async () => {
    const ole2 = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    await expect(readPptx(ole2)).rejects.toThrow(OLE2_MESSAGE);
  });

  it('refuses a valid ZIP that is not a presentation', async () => {
    const { zipSync } = await import('fflate');
    const zip = zipSync({ 'hello.txt': new TextEncoder().encode('not a deck') });
    await expect(readPptx(zip)).rejects.toThrow(NOT_A_PRESENTATION_MESSAGE);
  });

  it('refuses a package whose slide id list points at a missing part', async () => {
    const result = await deck();
    const parts = unzipSync(result.bytes);
    delete parts['ppt/slides/slide3.xml'];
    const { zipSync } = await import('fflate');
    await expect(readPptx(zipSync(parts))).rejects.toThrow(/not in the package/);
  }, 180_000);

  it('refuses a package whose slide id list points at an undeclared relationship', async () => {
    // The same class of damage as a missing part, and the same treatment.
    // Skipping it would quietly return a deck with fewer slides than the file
    // claims — and a per-slide assertion would then compare slide N against
    // page N+1 and fail somewhere far from the cause.
    const result = await deck();
    const parts = { ...unzipSync(result.bytes) };
    const relsPart = 'ppt/_rels/presentation.xml.rels';
    const { strToU8, zipSync } = await import('fflate');
    const rels = strFromU8(parts[relsPart]);
    // Find the relationship id the third slide is listed under and delete it.
    const presentation = strFromU8(parts['ppt/presentation.xml']);
    const ids = [...presentation.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map(m => m[1]);
    expect(ids).toHaveLength(4);
    parts[relsPart] = strToU8(rels.replace(new RegExp(`<Relationship Id="${ids[2]}"[^>]*/>`), ''));
    await expect(readPptx(zipSync(parts))).rejects.toThrow(/is not\s+declared|not declared/);
  }, 180_000);

  it('reads slides in the deck’s own order, not in filename order', async () => {
    // `slide10` sorts before `slide2`, so a reader that sorted part names would
    // silently reorder any deck of ten or more slides — and a per-slide text
    // assertion would then be comparing the wrong page. Twelve pages settles it.
    const result = await convert(await textPdf(12), { includeImages: false });
    const read = await readPptx(result.bytes);
    expect(read.slides).toHaveLength(12);
    expect(read.slides.map(slide => slide.part)).toEqual(
      Array.from({ length: 12 }, (_, i) => `ppt/slides/slide${i + 1}.xml`)
    );
    // `textPdf` writes a per-page marker, so out-of-order slides are visible.
    read.slides.forEach((slide, index) => {
      expect(slide.text).toContain(`Stapler fixture page ${index + 1}`);
    });
  }, 240_000);

  it('decodes XML entities rather than comparing escaped text', async () => {
    expect(decodeXmlText('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;')).toBe(
      'a & b <c> "d" \'e\''
    );
    expect(decodeXmlText('&#65;&#x42;')).toBe('AB');
    // An unknown entity is left alone rather than mangled.
    expect(decodeXmlText('&nosuch;')).toBe('&nosuch;');

    // …and it matters on real output: an ampersand in the source page has to
    // come back out as an ampersand.
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([300, 300]).drawText('Ampersand & angle < brackets >', {
      x: 20,
      y: 200,
      size: 11,
      font
    });
    const result = await convert(await doc.save(), { includeImages: false });
    const read = await readPptx(result.bytes);
    expect(read.slides[0].text).toBe('Ampersand & angle < brackets >');
    // The raw XML really did escape it, so the decode is doing work.
    expect(strFromU8(unzipSync(result.bytes)['ppt/slides/slide1.xml'])).toContain('&amp;');
  }, 120_000);

  it('resolves a relationship target against the part that declared it', () => {
    expect(resolvePart('ppt/slides/slide1.xml', '../media/image1.png')).toBe(
      'ppt/media/image1.png'
    );
    expect(resolvePart('ppt/presentation.xml', 'slides/slide1.xml')).toBe('ppt/slides/slide1.xml');
    expect(resolvePart('ppt/slides/slide1.xml', '/ppt/media/image1.png')).toBe(
      'ppt/media/image1.png'
    );
  });
});

/**
 * The gate itself (PLAN §5.5). The action bar disables its primary CTA whenever
 * `commitGate(toolId)` is non-null, and `commit.ts`'s `pdf-to-ppt` handler
 * refuses again if it is reached anyway — so this state machine is the gating
 * logic, not a decoration around it.
 */
describe('CNV-12 — the mandatory-preview gate', () => {
  const result = () => ({
    bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    pageCount: 2,
    slideCount: 2,
    imageCount: 1,
    textBoxCount: 9,
    slideWidth: 612,
    slideHeight: 792,
    outline: [],
    notes: []
  });

  it('starts closed, opens only on a preview, and closes again on reset', async () => {
    const { commitGate } = await import('../../src/ui/tools/commit-gate');
    const state = await import('../../src/ui/tools/convert/pdf-to-ppt-state');

    // Importing the panel's state module is what arms the gate, so the save
    // action is blocked before the panel has ever been mounted.
    expect(commitGate('pdf-to-ppt')).toBe(state.PDF_TO_PPT_GATE);
    expect(state.pdfToPptPreview.value).toBeNull();

    state.setPdfToPptPreview(result(), 'doc-1');
    expect(commitGate('pdf-to-ppt')).toBeNull();
    expect(state.pdfToPptPreviewDocId.value).toBe('doc-1');

    state.resetPdfToPptPreview();
    expect(commitGate('pdf-to-ppt')).toBe(state.PDF_TO_PPT_GATE);
    expect(state.pdfToPptPreview.value).toBeNull();
    expect(state.pdfToPptPreviewDocId.value).toBeNull();
  });

  it('closes again when the document is edited, not only when it is switched', async () => {
    // CNV-08's audit finding, built in here from the start: keying on the
    // document *id* alone left a preview valid across an edit — deleting or
    // rotating a page — because none of those change the id.
    const state = await import('../../src/ui/tools/convert/pdf-to-ppt-state');
    const { commitGate } = await import('../../src/ui/tools/commit-gate');
    const { historyVersion } = await import('../../src/core/history');
    const store = await import('../../src/core/store');

    const pageKey = 'ppt-page-1';
    const doc = {
      id: 'doc-ppt-edit',
      name: 'edited.pdf',
      pages: [{ key: pageKey, sourceDocId: 'src-1', sourceIndex: 0, rotation: 0 }],
      annotations: [],
      dirty: false
    };
    store.documents.value = [doc];
    store.activeDocId.value = doc.id;

    state.setPdfToPptPreview(result(), doc.id, historyVersion.value);
    expect(commitGate('pdf-to-ppt')).toBeNull();
    expect(state.pdfToPptPreviewIsStale(doc.id)).toBe(false);

    // A real mutation through the real store mutator — not a hand-incremented
    // counter.
    const before = historyVersion.value;
    store.rotatePages(doc.id, [pageKey], 90);
    expect(historyVersion.value).not.toBe(before);
    expect(store.documents.value[0].pages[0].rotation).toBe(90);

    expect(state.pdfToPptPreviewIsStale(doc.id)).toBe(true);
    state.resetPdfToPptPreview();
    expect(commitGate('pdf-to-ppt')).toBe(state.PDF_TO_PPT_GATE);

    // A preview taken *after* the edit is fresh again, so the invalidation is
    // not a permanent lock.
    state.setPdfToPptPreview(result(), doc.id, historyVersion.value);
    expect(state.pdfToPptPreviewIsStale(doc.id)).toBe(false);

    // An undo is a change too: the document it describes is the pre-rotation one.
    const history = await import('../../src/core/history');
    history.undo();
    expect(state.pdfToPptPreviewIsStale(doc.id)).toBe(true);

    state.resetPdfToPptPreview();
    store.documents.value = [];
    store.activeDocId.value = null;
  });

  it('treats a preview with no recorded revision as stale rather than valid', async () => {
    const state = await import('../../src/ui/tools/convert/pdf-to-ppt-state');
    state.setPdfToPptPreview(result(), 'doc-x');
    expect(state.pdfToPptPreviewRevision.value).toBeNull();
    expect(state.pdfToPptPreviewIsStale('doc-x')).toBe(true);
    state.resetPdfToPptPreview();
  });

  it('gates one tool without gating any other', async () => {
    const { commitGate, setCommitGate } = await import('../../src/ui/tools/commit-gate');
    setCommitGate('pdf-to-ppt', 'blocked');
    expect(commitGate('pdf-to-ppt')).toBe('blocked');
    expect(commitGate('merge')).toBeNull();
    expect(commitGate('pdf-to-word')).toBeNull();
    setCommitGate('pdf-to-ppt', null);
    expect(commitGate('pdf-to-ppt')).toBeNull();
  });
});

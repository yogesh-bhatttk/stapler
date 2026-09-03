/**
 * CNV-08 — the DOCX writer's worker.
 *
 * It owns exactly one library, `docx`, and it is the fifth worker for the same
 * reason the other four are split the way they are (see `index.ts`): the split is
 * by *library*, so the bundle holds one copy of each. That is also why this worker
 * takes a block model rather than PDF bytes — reading the PDF needs pdf.js and
 * pdf-lib, and both already live in `render` and `process` respectively. Handing
 * bytes in here instead would put a third copy of pdf.js and a second copy of
 * pdf-lib in the build to save one Comlink hop. `operations.ts`'s
 * `convertPdfToDocx` is where the three workers are sequenced.
 *
 * What it does take as raw bytes is CNV-06's image archive, unopened. Unzipping it
 * and deciding what can be embedded is real work over potentially tens of
 * megabytes, and the NFRs give the main thread a 50ms budget — so the archive is
 * *transferred* in and opened here, which also means image bytes cross the worker
 * boundary once rather than being cloned into the model first.
 *
 * That transfer is why the archive is a *top-level parameter* of `buildDocx` and
 * not a field of an `{ archive, entries }` wrapper, which is how it was first
 * written. Comlink reads its transfer list off each top-level argument only
 * (`toWireValue` looks the value up in `transferCache` and never recurses into a
 * plain object's properties), so a `Comlink.transfer`-marked array nested inside
 * an object literal loses its marker and gets structured-cloned instead —
 * silently copying every image byte, which is the exact cost this signature
 * exists to avoid. Keep the `Uint8Array` at the top level.
 *
 * `docx` itself is loaded lazily inside `docx-writer.ts`, so importing this module
 * costs nothing until a conversion runs. The same is true of the two libraries
 * later tickets added behind the same rule — `mammoth` (CNV-09, in
 * `docx-reader.ts`) and `xlsx` (CNV-11, in `xlsx-reader.ts`) — which is why they
 * are methods here rather than a sixth and seventh worker: this worker is where
 * the Office-format libraries live, one lazy chunk each.
 */
import * as Comlink from 'comlink';
import { buildDocx } from '../convert/docx-writer';
import {
  attachImageBlocks,
  previewOutline,
  type DocxModel,
  type DocxPreviewItem
} from '../convert/blocks';
import { readDocxAsHtml } from '../convert/docx-reader';
import { readXlsxAsBlocks, type SheetSummary } from '../convert/xlsx-reader';
import { parseHtmlBlocks, type LayoutBlock } from '../convert/html-to-pdf-blocks';
import {
  EMPTY_WORKBOOK_MESSAGE,
  planWorkbook,
  type PageSheetData,
  type XlsxPreviewItem
} from '../convert/sheets';
import { buildXlsx as buildXlsxFile } from '../convert/xlsx-writer';
import {
  EMPTY_DECK_MESSAGE,
  isEmptyPlan,
  planSlides,
  type PageSlideData,
  type PptxPreviewItem
} from '../convert/slides';
import { buildPptx as buildPptxFile } from '../convert/pptx-writer';
import { readPptxAsBlocks, type SlideSummary } from '../convert/pptx-slides';
import { fromUnknown, unsupported } from '../errors';
import { checkpoint, subJob, type JobHandle } from './protocol';
import type { ExtractedImageEntry, ImagePlacementReport } from './process.worker';

export interface DocxBuildResult {
  bytes: Uint8Array;
  /** How many images were actually embedded. */
  imageCount: number;
  /**
   * Everything recognised and deliberately not converted, each with its reason —
   * the caller's own list plus whatever the image pass added.
   */
  skipped: string[];
  /** Block-by-block description of what was written, for the mandatory preview. */
  outline: DocxPreviewItem[];
}

/** CNV-10 — what `buildXlsx` hands back. */
export interface XlsxBuildResult {
  bytes: Uint8Array;
  /** How many sheets the workbook carries, tables and page text together. */
  sheetCount: number;
  /** How many of those came from a detected table. */
  tableCount: number;
  /** Everything recognised and deliberately not written, each with its reason. */
  skipped: string[];
  /** Sheet-by-sheet description of what was written, for the mandatory preview. */
  outline: XlsxPreviewItem[];
}

/** CNV-09 — what `docxToBlocks` hands back to be laid out onto PDF pages. */
export interface DocxBlocksResult {
  blocks: LayoutBlock[];
  /** Everything recognised and deliberately not carried across, with reasons. */
  notes: string[];
  /** `mammoth`'s own warnings, verbatim. */
  warnings: string[];
}

/** CNV-11 — what `xlsxToBlocks` hands back to be laid out onto PDF pages. */
export interface XlsxBlocksResult {
  blocks: LayoutBlock[];
  /** Everything recognised and deliberately not carried across, with reasons. */
  notes: string[];
  /** One entry per converted sheet, in output order. */
  sheets: SheetSummary[];
  /** The workbook's own title from its core properties, if it set one. */
  title?: string;
}

/** CNV-13 — what `pptxToBlocks` hands back to be laid out onto PDF pages. */
export interface PptxBlocksResult {
  blocks: LayoutBlock[];
  /** Everything recognised and deliberately not carried across, with reasons. */
  notes: string[];
  /** One entry per converted slide, in the deck's own order. */
  slides: SlideSummary[];
  /** The deck's slide size in points, so the caller can size the PDF page to it. */
  slideWidth: number;
  slideHeight: number;
  /** The deck's own title from its core properties, if it set one. */
  title?: string;
}

/** CNV-12 — what `buildPptx` hands back. */
export interface PptxBuildResult {
  bytes: Uint8Array;
  slideCount: number;
  /** How many pictures were actually placed, across every slide. */
  imageCount: number;
  /** How many positioned text boxes were written, across every slide. */
  textBoxCount: number;
  /** Slide size in points, so the panel can state the deck's real dimensions. */
  slideWidth: number;
  slideHeight: number;
  /** Everything recognised and deliberately not placed, each with its reason. */
  notes: string[];
  /** Slide-by-slide description of what was written, for the mandatory preview. */
  outline: PptxPreviewItem[];
}

export interface ConvertJob {
  /**
   * CNV-09 — reads a `.docx` and returns the generalized block model.
   *
   * It stops at the model rather than producing the PDF for the same
   * library-split reason this worker exists at all (see `index.ts`): drawing
   * pages needs pdf-lib, which already lives in the `process` worker, and
   * pulling a second copy of it in here to save one Comlink hop would undo the
   * split. `operations.ts`'s `convertDocxToPdf` sequences the two.
   *
   * The `.docx` bytes are a top-level parameter so the caller can `handOver`
   * them — Comlink reads a transfer marker off top-level arguments only, which
   * CNV-08's audit finding 1 established the hard way.
   */
  docxToBlocks(bytes: Uint8Array, job?: JobHandle): Promise<DocxBlocksResult>;

  /**
   * CNV-11 — reads an `.xlsx` and returns the same generalized block model,
   * one heading plus one grid per visible sheet.
   *
   * Here for the same two reasons `docxToBlocks` is. First the library split
   * (see `index.ts`): this worker owns the Office-format libraries, and
   * `xlsx` is loaded lazily inside `xlsx-reader.ts`, so importing this module
   * still costs nothing until a conversion runs. Second, it stops at the model
   * rather than producing the PDF, because drawing pages needs pdf-lib, which
   * already lives in the `process` worker — `operations.ts`'s
   * `convertXlsxToPdf` sequences the two.
   *
   * The workbook bytes are a top-level parameter so the caller can `handOver`
   * them; Comlink reads a transfer marker off top-level arguments only.
   */
  xlsxToBlocks(bytes: Uint8Array, job?: JobHandle): Promise<XlsxBlocksResult>;

  /**
   * CNV-13 — reads a `.pptx` and returns the same generalized block model, one
   * `canvas` block per slide.
   *
   * A method here rather than a sixth worker, and for a reason that is *not*
   * the library split its two siblings cite: this reader owns no library at all.
   * `pptx-reader.ts` is a hand-rolled walk over `fflate`, which is already a
   * runtime dependency, so nothing lazy is loaded and no bundle argument is at
   * stake. What puts it here instead is the other half of the same rule — it
   * stops at the model, because drawing the pages needs pdf-lib, which lives in
   * the `process` worker. `operations.ts`'s `convertPptxToPdf` sequences the
   * two, and the read is real work over potentially hundreds of slides, which
   * the NFRs keep off the main thread regardless of which library does it.
   *
   * The deck's bytes are a top-level parameter so the caller can `handOver`
   * them; Comlink reads a transfer marker off top-level arguments only.
   */
  pptxToBlocks(bytes: Uint8Array, job?: JobHandle): Promise<PptxBlocksResult>;

  /**
   * Writes the block model out as a `.docx`, embedding what it can of CNV-06's
   * image archive. Progress and cancellation ride the shared job protocol, same
   * as every other long operation.
   *
   * `imageArchive` is the stored ZIP and `imageEntries` its per-image report.
   * They are two parameters rather than one object on purpose — see the module
   * comment: only a top-level argument can carry a Comlink transfer.
   */
  buildDocx(
    model: DocxModel,
    imageArchive: Uint8Array | null,
    imageEntries: ExtractedImageEntry[],
    job?: JobHandle
  ): Promise<DocxBuildResult>;

  /**
   * CNV-10 — plans the workbook from the per-page data and writes the `.xlsx`.
   *
   * A method on this worker rather than a sixth worker, and rather than
   * main-thread work: zipping a workbook's worth of XML is exactly the >50ms
   * the NFRs keep off the main thread. Nothing here is transferred *in* — the
   * page data is strings — so, unlike `buildDocx` and `docxToBlocks`, argument
   * order carries no transfer meaning. The finished bytes are transferred out.
   */
  buildXlsx(
    pages: PageSheetData[],
    options: { includePageText: boolean; title?: string },
    job?: JobHandle
  ): Promise<XlsxBuildResult>;

  /**
   * CNV-12 — plans the deck from the per-page data and writes the `.pptx`.
   *
   * A method here rather than a sixth worker, for the reason this module's
   * comment gives: this worker owns the Office-format libraries, one lazy chunk
   * each, and `pptxgenjs` is the fourth of them (loaded inside
   * `pptx-writer.ts`, never statically).
   *
   * `imageArchive` is CNV-06's ZIP, unopened, and it is a **top-level
   * parameter** for exactly the reason `buildDocx`'s is: Comlink reads a
   * transfer marker off top-level arguments only, so nesting it inside the
   * options object would silently structured-clone every image byte. That was
   * CNV-08 audit finding 1 and it is pinned by
   * `tests/unit/pdf-to-ppt-transfer.test.ts`.
   */
  buildPptx(
    pages: PageSlideData[],
    imageArchive: Uint8Array | null,
    input: {
      includeText: boolean;
      includeImages: boolean;
      placements: ImagePlacementReport[];
      entries: ExtractedImageEntry[];
      droppedPlacements: Record<number, number>;
      title: string;
    },
    job?: JobHandle
  ): Promise<PptxBuildResult>;
}

export const convertWorkerImpl: ConvertJob = {
  async docxToBlocks(bytes, job) {
    const { html, messages } = await readDocxAsHtml(bytes, job);
    await checkpoint(job, 0.6, 'Reading the document structure');
    const { blocks, notes } = parseHtmlBlocks(html);
    await checkpoint(job, 0.95, 'Reading the document structure');

    // Image bytes are transferred rather than cloned on the way out — they came
    // straight out of a base64 decode here and nothing in this worker reads them
    // again. Dedup guards against two blocks ever sharing one buffer, which
    // would make `postMessage` throw on a repeated transferable.
    const buffers = new Set<ArrayBuffer>();
    for (const block of blocks) {
      if (block.kind === 'image') buffers.add(block.data.buffer as ArrayBuffer);
    }
    return Comlink.transfer({ blocks, notes, warnings: messages }, [...buffers]);
  },

  async xlsxToBlocks(bytes, job) {
    const { blocks, notes, sheets, title } = await readXlsxAsBlocks(bytes, job);
    await checkpoint(job, 1, 'Reading the workbook');
    // Nothing to transfer: a spreadsheet's blocks are headings, paragraphs and
    // grids of strings — there is no image buffer in the model, so a transfer
    // list would be empty and the structured clone is the whole cost.
    return { blocks, notes, sheets, ...(title !== undefined ? { title } : {}) };
  },

  async pptxToBlocks(bytes, job) {
    const read = await readPptxAsBlocks(bytes, job);

    // Picture bytes are *transferred* out rather than cloned. They are
    // `fflate`'s own output — nothing in this worker reads them again once the
    // model is built — and a deck's images are the only part of this model with
    // any size to it.
    //
    // The dedup is not a nicety: `unzipSync` returns a stored entry as a
    // *subarray of the package*, so several pictures can share one
    // `ArrayBuffer`, and one image drawn on several slides is deliberately the
    // same instance in every canvas that shows it (that shared identity is what
    // lets the layout engine embed it once). `postMessage` throws on a repeated
    // transferable, so the list has to be a set of distinct buffers.
    const buffers = new Set<ArrayBuffer>();
    for (const block of read.blocks) {
      if (block.kind !== 'canvas') continue;
      for (const item of block.items) {
        if (item.kind === 'image') buffers.add(item.data.buffer as ArrayBuffer);
      }
    }
    return Comlink.transfer(read, [...buffers]);
  },

  async buildDocx(model, imageArchive, imageEntries, job) {
    const skipped = [...model.skipped];
    let imageCount = 0;

    if (imageArchive && imageEntries.length > 0) {
      await checkpoint(job, 0, 'Reading the embedded images');
      let files: Record<string, Uint8Array> = {};
      try {
        // `{ level: 0 }` on the way in (CNV-06 stores rather than deflates, since
        // PNG and JPEG are already compressed), so this is a copy per entry, not
        // an inflate.
        const { unzipSync } = await import('fflate');
        files = unzipSync(imageArchive);
      } catch (err) {
        // A ZIP we cannot reopen costs the images, not the conversion — the text
        // is already extracted and is worth handing over with an explanation.
        skipped.push(
          `No images were embedded: their archive could not be read (${fromUnknown(err).message}).`
        );
      }
      imageCount = attachImageBlocks(model.pages, imageEntries, files, skipped);
    }

    const bytes = await buildDocx({ ...model, skipped }, job);
    // The outline is derived from the model the file was *just* written from, so
    // the preview and the bytes cannot describe different documents.
    const outline = previewOutline(model.pages);
    return Comlink.transfer({ bytes, imageCount, skipped, outline }, [bytes.buffer]);
  },

  async buildXlsx(pages, options, job) {
    await checkpoint(job, 0.1, 'Planning the workbook');
    const plan = planWorkbook(pages, options.includePageText);

    if (plan.sheets.length === 0) {
      // Reached only when every page's text was excluded by the caller's own
      // option, since a document with no text at all is refused earlier, in
      // `operations.ts`, before this worker is leased. Writing a workbook with
      // no sheets would produce a file Excel offers to repair.
      throw unsupported(EMPTY_WORKBOOK_MESSAGE);
    }

    await checkpoint(job, 0.4, 'Writing the spreadsheet');
    const bytes = buildXlsxFile(plan.sheets, { title: options.title });
    await checkpoint(job, 1, 'Writing the spreadsheet');

    // The outline is derived from the very plan the file was written from, so
    // the preview and the bytes cannot describe different workbooks.
    return Comlink.transfer(
      {
        bytes,
        sheetCount: plan.sheets.length,
        tableCount: plan.tableCount,
        skipped: plan.skipped,
        outline: plan.outline
      },
      [bytes.buffer]
    );
  },

  async buildPptx(pages, imageArchive, input, job) {
    const notes: string[] = [];

    // The archive is opened here, in the worker, for the reason `buildDocx`'s
    // module comment gives: unzipping a document's worth of image bytes is
    // exactly the >50ms main-thread work the NFRs forbid.
    let files: Record<string, Uint8Array> = {};
    if (input.includeImages && imageArchive && imageArchive.length > 0) {
      await checkpoint(job, 0, 'Reading the embedded images');
      try {
        // `{ level: 0 }` on the way in (CNV-06 stores rather than deflates), so
        // this is a copy per entry, not an inflate.
        const { unzipSync } = await import('fflate');
        files = unzipSync(imageArchive);
      } catch (err) {
        // A ZIP we cannot reopen costs the pictures, not the deck — the text is
        // already extracted and is worth handing over with an explanation.
        notes.push(
          `No images were placed: their archive could not be read (${fromUnknown(err).message}).`
        );
      }
    }

    await checkpoint(job, 0.1, 'Planning the slides');
    const plan = planSlides(pages, {
      includeText: input.includeText,
      includeImages: input.includeImages,
      placements: input.includeImages ? input.placements : null,
      entries: input.includeImages ? input.entries : null,
      // Empty entries are excluded, not merely absent ones. `addSlide` skips a
      // zero-length image rather than handing the library nothing, so counting
      // it as archived here would make the plan claim a picture the file does
      // not carry — and `imageCount` and the preview's per-slide counts are both
      // read off this plan. Filtering here means `imageRefusal` names it in the
      // notes and every count stays exact.
      archivedFiles: new Set(Object.keys(files).filter(name => files[name].length > 0)),
      droppedPlacements: input.droppedPlacements
    });

    if (isEmptyPlan(plan)) {
      // Refused *before* any bytes exist. A deck of blank slides is a file the
      // user has to diagnose; naming OCR and the two options is the useful
      // answer, and it is the same policy CNV-10 applies to a scan.
      throw unsupported(EMPTY_DECK_MESSAGE);
    }

    const bytes = await buildPptxFile(
      plan,
      { title: input.title, images: files },
      subJob(job, 0.15, 1)
    );

    // Counted off the very plan the file was written from, so the preview and
    // the bytes cannot describe different decks.
    return Comlink.transfer(
      {
        bytes,
        slideCount: plan.slides.length,
        imageCount: plan.slides.reduce((n, slide) => n + slide.images.length, 0),
        textBoxCount: plan.slides.reduce((n, slide) => n + slide.boxes.length, 0),
        slideWidth: plan.slideWidth,
        slideHeight: plan.slideHeight,
        notes: [...notes, ...plan.notes],
        outline: plan.outline
      },
      [bytes.buffer]
    );
  }
};

Comlink.expose(convertWorkerImpl);

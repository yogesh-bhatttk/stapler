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
 * costs nothing until a conversion runs.
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
import { parseHtmlBlocks, type LayoutBlock } from '../convert/html-to-pdf-blocks';
import { fromUnknown } from '../errors';
import { checkpoint, type JobHandle } from './protocol';
import type { ExtractedImageEntry } from './process.worker';

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

/** CNV-09 — what `docxToBlocks` hands back to be laid out onto PDF pages. */
export interface DocxBlocksResult {
  blocks: LayoutBlock[];
  /** Everything recognised and deliberately not carried across, with reasons. */
  notes: string[];
  /** `mammoth`'s own warnings, verbatim. */
  warnings: string[];
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
  }
};

Comlink.expose(convertWorkerImpl);

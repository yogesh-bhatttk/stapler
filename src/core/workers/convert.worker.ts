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

export interface ConvertJob {
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

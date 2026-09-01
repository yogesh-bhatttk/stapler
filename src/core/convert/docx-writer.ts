/**
 * CNV-08 — the block model → a real `.docx`.
 *
 * The `docx` package is loaded with a dynamic `import()`, never a static one, for
 * the same reason `heic2any` (CNV-03) and `tesseract.js` (OCR) are: nothing in its
 * dependency tree (jszip, xml-js, hash.js, nanoid) is parsed or evaluated until
 * someone actually converts a document, and it stays out of the 900KB initial
 * bundle `scripts/check-bundle-size.js` measures. It is a real bundled
 * dependency — pure JS, no WASM, no network — so this is a lazy *chunk*, not a
 * remote fetch (PLAN §5.4).
 *
 * `Packer.toArrayBuffer` rather than `toBuffer`: the latter asks jszip for a
 * `nodebuffer`, which does not exist in a worker.
 */

import { internal } from '../errors';
import { checkpoint, type JobHandle } from '../workers/protocol';
import type { DocxBlock, DocxModel } from './blocks';

/**
 * Tables fill the text column. Given `WidthType.PERCENTAGE`, `docx` turns a plain
 * number into the `"100%"` string OOXML wants, so this is a percentage and not the
 * fiftieths-of-a-percent unit `w:tblW` uses when written by hand.
 */
const FULL_WIDTH_PCT = 100;

/**
 * Builds the `.docx`. Every block the model carries is written; anything that
 * could not be converted was already recorded in `model.skipped` by the caller
 * and is reported to the user rather than silently dropped here.
 */
export async function buildDocx(model: DocxModel, job?: JobHandle): Promise<Uint8Array> {
  await checkpoint(job, 0, 'Building the Word document');

  const {
    Document,
    HeadingLevel,
    ImageRun,
    Packer,
    Paragraph,
    Table,
    TableCell,
    TableRow,
    TextRun,
    WidthType
  } = await import('docx');

  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];

  const runsOf = (block: Extract<DocxBlock, { kind: 'paragraph' | 'heading' }>) =>
    block.runs.map(run => new TextRun({ text: run.text, bold: run.bold, italics: run.italic }));

  const totalBlocks = model.pages.reduce((sum, page) => sum + page.blocks.length, 0);
  let done = 0;

  for (let p = 0; p < model.pages.length; p++) {
    const page = model.pages[p];
    // A page break between source pages, not around every block: Word repaginates
    // its own way, and the ticket says pagination is not guaranteed. The break is
    // still worth writing — it keeps a source page's content together, which is
    // what a reader comparing the two documents expects.
    const pageBreakBefore = p > 0;
    let first = true;

    for (const block of page.blocks) {
      done += 1;
      await checkpoint(
        job,
        totalBlocks === 0 ? 0.9 : (done / totalBlocks) * 0.9,
        `Writing page ${page.pageIndex + 1} of ${model.pages.length}`
      );

      const breakHere = pageBreakBefore && first;
      first = false;

      switch (block.kind) {
        case 'heading':
          children.push(
            new Paragraph({
              heading: block.level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
              pageBreakBefore: breakHere,
              children: runsOf(block)
            })
          );
          break;

        case 'paragraph':
          children.push(new Paragraph({ pageBreakBefore: breakHere, children: runsOf(block) }));
          break;

        case 'table': {
          // A page break cannot sit on a Table, so it goes on an empty paragraph
          // ahead of it rather than being dropped.
          if (breakHere) children.push(new Paragraph({ pageBreakBefore: true, children: [] }));
          const columnCount = block.rows.reduce((max, row) => Math.max(max, row.length), 0);
          if (columnCount === 0) break;
          children.push(
            new Table({
              width: { size: FULL_WIDTH_PCT, type: WidthType.PERCENTAGE },
              rows: block.rows.map(
                row =>
                  new TableRow({
                    children: Array.from({ length: columnCount }, (_, c) => {
                      // Every row is padded to the widest row's column count.
                      // A short `<w:tr>` is what makes Word report the file as
                      // needing repair, and a repaired table is not an intact one.
                      const cell = row[c] ?? '';
                      return new TableCell({
                        children: [new Paragraph({ children: [new TextRun(cell)] })]
                      });
                    })
                  })
              )
            })
          );
          // Word requires a paragraph after a table; two adjacent tables would
          // otherwise merge into one.
          children.push(new Paragraph({ children: [] }));
          break;
        }

        case 'image':
          children.push(
            new Paragraph({
              pageBreakBefore: breakHere,
              children: [
                new ImageRun({
                  type: block.format,
                  data: block.data,
                  transformation: { width: block.width, height: block.height },
                  altText: { name: block.altText, description: block.altText, title: block.altText }
                })
              ]
            })
          );
          break;
      }
    }
  }

  // An empty body is not a valid `.docx` body in every reader, and handing the
  // user a file that will not open is worse than telling them the conversion
  // found nothing.
  if (children.length === 0) {
    throw internal('This PDF produced no text or images to convert.');
  }

  const doc = new Document({
    title: model.title,
    sections: [{ children }]
  });

  await checkpoint(job, 0.95, 'Packing the Word document');
  const packed = await Packer.toArrayBuffer(doc);
  return new Uint8Array(packed);
}

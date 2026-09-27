/**
 * CNV-08 — the block model → a real `.docx`.
 *
 * The `docx` package is loaded with a dynamic `import()`, never a static one, for
 * the same reason the HEIC decoder (CNV-03) and `tesseract.js` (OCR) are: nothing in its
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
import { translate } from '../i18n';
import { checkpoint, type JobHandle } from '../workers/protocol';
import type { DocxModel, DocxRun } from './blocks';
import { isRtlRunGroup, isRtlText } from './text-direction';
import { stripInvalidXmlChars as xmlSafe } from './xml-chars';

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
  await checkpoint(job, 0, translate('Building the Word document'));

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

  /**
   * A paragraph's runs, each carrying its own direction.
   *
   * `rightToLeft` is `docx`'s name for `<w:rtl/>` in the run properties
   * (`IRunOptionsBase.rightToLeft`), which is a genuine *run*-level property in
   * WordprocessingML — unlike DrawingML, where direction lives only on the
   * paragraph. So an English phrase quoted inside an Arabic sentence keeps its
   * own direction rather than being force-flagged with the paragraph.
   *
   * `paragraphRtl` is the fallback for a run with no strong character of its
   * own (a page number, a run of punctuation left over from run merging): it
   * inherits the paragraph instead of silently reverting to LTR mid-sentence.
   *
   * The flag is *omitted* rather than written as `false` for LTR runs, so an
   * all-Latin document's `document.xml` is byte-for-byte what it was before this
   * change — `<w:rtl w:val="false"/>` on every run would be noise, and a
   * conversion that has nothing to say about direction should say nothing.
   */
  const runsOf = (runs: readonly DocxRun[], paragraphRtl: boolean) =>
    runs.map(
      run =>
        new TextRun({
          // Every string handed to `docx` goes through `xmlSafe`: the package
          // escapes `& < >` but not the control characters XML 1.0 forbids,
          // and one of those makes Word refuse the file (CONV-3).
          text: xmlSafe(run.text),
          bold: run.bold,
          italics: run.italic,
          ...(isRtlText(run.text, paragraphRtl) ? { rightToLeft: true } : {})
        })
    );

  /** The text of a group of runs, for the container-level direction decision. */
  const groupRtl = (runs: readonly DocxRun[]) => isRtlRunGroup(runs.map(run => run.text));

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
        translate('Writing page {n} of {total}', {
          n: page.pageIndex + 1,
          total: model.pages.length
        })
      );

      const breakHere = pageBreakBefore && first;
      first = false;

      switch (block.kind) {
        case 'heading': {
          // `bidirectional` is `docx`'s name for `<w:bidi/>` in the paragraph
          // properties (`IParagraphPropertiesOptionsBase.bidirectional`). It is
          // what makes Word right-align the paragraph and resolve its bidi
          // embedding level as RTL; without it, correctly-decoded Arabic or
          // Hebrew lands left-aligned and in the wrong order.
          const rtl = groupRtl(block.runs);
          children.push(
            new Paragraph({
              heading: block.level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
              pageBreakBefore: breakHere,
              ...(rtl ? { bidirectional: true } : {}),
              children: runsOf(block.runs, rtl)
            })
          );
          break;
        }

        case 'paragraph': {
          const rtl = groupRtl(block.runs);
          children.push(
            new Paragraph({
              pageBreakBefore: breakHere,
              ...(rtl ? { bidirectional: true } : {}),
              children: runsOf(block.runs, rtl)
            })
          );
          break;
        }

        case 'table': {
          // A page break cannot sit on a Table, so it goes on an empty paragraph
          // ahead of it rather than being dropped.
          if (breakHere) children.push(new Paragraph({ pageBreakBefore: true, children: [] }));
          const columnCount = block.rows.reduce((max, row) => Math.max(max, row.length), 0);
          if (columnCount === 0) break;
          // Decided over every cell at once. `visuallyRightToLeft` is `docx`'s
          // name for `<w:bidiVisual/>` in the table properties
          // (`ITableOptions.visuallyRightToLeft`), which puts the first column
          // on the right — the column order a reader of an RTL table expects,
          // and the direct analogue of the sheet-level flag `xlsx-writer.ts`
          // sets. Cell direction is still decided per cell underneath it, so a
          // Latin identifier column inside an Arabic table keeps its own.
          const tableRtl = isRtlRunGroup(block.rows.flat());
          children.push(
            new Table({
              width: { size: FULL_WIDTH_PCT, type: WidthType.PERCENTAGE },
              ...(tableRtl ? { visuallyRightToLeft: true } : {}),
              rows: block.rows.map(
                row =>
                  new TableRow({
                    children: Array.from({ length: columnCount }, (_, c) => {
                      // Every row is padded to the widest row's column count.
                      // A short `<w:tr>` is what makes Word report the file as
                      // needing repair, and a repaired table is not an intact one.
                      const cell = xmlSafe(row[c] ?? '');
                      const cellRtl = isRtlText(cell, tableRtl);
                      return new TableCell({
                        children: [
                          new Paragraph({
                            ...(cellRtl ? { bidirectional: true } : {}),
                            children: [
                              new TextRun({
                                text: cell,
                                ...(cellRtl ? { rightToLeft: true } : {})
                              })
                            ]
                          })
                        ]
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
                  altText: {
                    name: xmlSafe(block.altText),
                    description: xmlSafe(block.altText),
                    title: xmlSafe(block.altText)
                  }
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
    throw internal(translate('This PDF produced no text or images to convert.'));
  }

  const doc = new Document({
    title: xmlSafe(model.title),
    sections: [{ children }]
  });

  await checkpoint(job, 0.95, translate('Packing the Word document'));
  const packed = await Packer.toArrayBuffer(doc);
  return new Uint8Array(packed);
}

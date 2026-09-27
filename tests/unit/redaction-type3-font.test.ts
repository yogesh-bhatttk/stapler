/**
 * Type 3 fonts and redaction glyph measurement — AUDIT §3, third bullet.
 *
 * Every font type except `/Type3` measures its glyphs in a glyph space the spec
 * fixes at 1/1000 em. A Type 3 font carries its own `/FontMatrix` instead, and
 * `dvips`/LaTeX — which is where nearly all Type 3 in the wild comes from —
 * routinely uses something like 1/100 or 1/2048. Reading those widths as
 * thousandths made a 24pt, ten-glyph run that spans ~144pt of page measure
 * ~0.14pt wide, so no mark could ever be found to overlap it.
 *
 * That was never a leak: `checkRegionText` re-extracts the region with pdf.js,
 * which measures the font properly, and blocks the save on the mismatch. It did
 * mean redaction was unusable — *every* save on such a document refused — which
 * is what these cases are about.
 *
 * Two levels: the interpreter's own arithmetic, and a real Type 3 document
 * driven through `applyRedactions` with the result read back out of the
 * produced bytes.
 */
import { describe, expect, it, vi } from 'vitest';
import { PDFArray, PDFDocument, PDFName, type PDFRef } from 'pdf-lib';
import {
  filterContentStream,
  parseContentStream,
  serializeStatements,
  tokenizeContentStream,
  type FontInfo,
  type Rect
} from '../../src/core/pdf/interpreter';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));

const { processWorkerImpl } = await import('../../src/core/workers/process.worker');

const enc = (s: string) => new TextEncoder().encode(s);

function filterText(source: string, boxes: Rect[], font: FontInfo) {
  const statements = parseContentStream(tokenizeContentStream(enc(source)));
  const result = filterContentStream(statements, boxes, undefined, undefined, () => font);
  return new TextDecoder().decode(serializeStatements(result.filtered));
}

describe('glyphSpaceScale drives the interpreter’s advance arithmetic', () => {
  // Ten glyphs at 24pt, each 60 units wide in a glyph space of 1/100 — so
  // 0.6 em, 14.4pt each, 144pt for the run, drawn from x=50.
  const widths = new Map<number, number>();
  for (let code = 32; code < 127; code++) widths.set(code, 60);
  const type3: FontInfo = { twoByte: false, widths, glyphSpaceScale: 0.01 };
  const SOURCE = 'BT /F1 24 Tf 1 0 0 1 50 700 Tm (ABCDEFGHIJ) Tj ET\n';

  it('finds the run under a mark covering where it really is drawn', () => {
    // 50..194 horizontally, 700..724 vertically — the run's true extent.
    const covered = filterText(SOURCE, [{ x: 40, y: 690, width: 170, height: 45 }], type3);
    expect(covered).not.toContain('ABCDEFGHIJ');
  });

  it('measured as thousandths, the same mark misses it entirely', () => {
    // The old behaviour, reproduced by dropping the scale: the run is measured
    // at 60/1000 em per glyph — 0.144pt in total — so a mark 170pt wide over
    // the same origin still only overlaps the first hairline of it.
    const asThousandths: FontInfo = { twoByte: false, widths };
    const kept = filterText(SOURCE, [{ x: 100, y: 690, width: 110, height: 45 }], asThousandths);
    expect(kept).toContain('ABCDEFGHIJ');

    // With the real scale, a mark starting at x=100 lands in the middle of the
    // run and takes the glyphs it covers, leaving the earlier ones.
    const split = filterText(SOURCE, [{ x: 100, y: 690, width: 110, height: 45 }], type3);
    expect(split).not.toContain('ABCDEFGHIJ');
    expect(split).toContain('TJ');
  });

  it('leaves every other font type measuring exactly as it did', () => {
    const simple: FontInfo = { twoByte: false, widths: new Map([[65, 600]]) };
    const scaled: FontInfo = { ...simple, glyphSpaceScale: 0.001 };
    const source = 'BT /F1 10 Tf 1 0 0 1 0 0 Tm (AAAA) Tj ET\n';
    const mark = [{ x: 12, y: -5, width: 5, height: 20 }];
    expect(filterText(source, mark, simple)).toBe(filterText(source, mark, scaled));
  });
});

/**
 * A page drawing one run in a Type 3 font whose `/FontMatrix` is 1/100.
 *
 * `/CharProcs` holds real (if trivial) glyph procedures so the file is a
 * legitimate Type 3 document rather than a dictionary shaped like one.
 */
async function type3Document(text: string, fontMatrix: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);

  const charProcs: Record<string, PDFRef> = {};
  const differences: (number | PDFName)[] = [32];
  for (let code = 32; code < 127; code++) {
    const glyph = `g${code}`;
    differences.push(PDFName.of(glyph));
    // `60 0 d0` declares the advance; the box is the ink.
    charProcs[glyph] = doc.context.register(doc.context.flateStream(enc('60 0 d0 0 0 60 60 re f')));
  }

  const font = doc.context.register(
    doc.context.obj({
      Type: 'Font',
      Subtype: 'Type3',
      FontBBox: [0, 0, 60, 60],
      FontMatrix: fontMatrix,
      CharProcs: doc.context.obj(charProcs),
      Encoding: doc.context.obj({ Type: 'Encoding', Differences: differences }),
      FirstChar: 32,
      LastChar: 126,
      Widths: Array.from({ length: 95 }, () => 60)
    })
  );

  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: doc.context.obj({ T3: font }) }));
  page.node.set(
    PDFName.of('Contents'),
    doc.context.register(
      doc.context.flateStream(enc(`BT /T3 24 Tf 1 0 0 1 50 700 Tm (${text}) Tj ET`))
    )
  );
  return doc.save({ useObjectStreams: false });
}

/** One page's content streams, decompressed, as latin1 text. */
async function pageContent(bytes: Uint8Array): Promise<string> {
  const { decodeStream } = await import('../../src/core/pdf/interpreter');
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPage(0).node.Contents();
  if (!contents) return '';
  // `any`: pdf-lib exposes no common interface for "a stream I can read bytes
  // from" across PDFRawStream and PDFContentStream.
  const streams: any[] =
    contents instanceof PDFArray
      ? contents.asArray().map(ref => doc.context.lookup(ref))
      : [contents];
  let out = '';
  for (const stream of streams) {
    const raw: Uint8Array = stream.getContents();
    const flate = String(stream.dict?.get(PDFName.of('Filter'))) === '/FlateDecode';
    out += new TextDecoder('latin1').decode(flate ? await decodeStream(raw) : raw);
  }
  return out;
}

describe('applyRedactions on a real Type 3 document (§3)', () => {
  const SECRET = 'TYPE3SECRET';

  it('removes the run the mark actually sits on', async () => {
    const bytes = await type3Document(SECRET, [0.01, 0, 0, 0.01, 0, 0]);
    expect(await pageContent(bytes)).toContain(SECRET);

    // The run is drawn from x=50: 11 glyphs at 14.4pt each, so 50..208pt,
    // baseline 700. The mark deliberately starts at x=120 — past where the
    // run would *end* (66pt) if its widths were read as thousandths, so a
    // regression stops removing anything at all rather than removing it by
    // accident from the left-hand edge.
    const out = await processWorkerImpl.applyRedactions(bytes, [
      { pageIndex: 0, x: 0.2, y: 0.09, width: 0.2, height: 0.06 }
    ]);
    expect(await pageContent(out)).not.toContain(SECRET);
  });

  it('leaves a run the mark misses alone, so it is not simply removing everything', async () => {
    const bytes = await type3Document(SECRET, [0.01, 0, 0, 0.01, 0, 0]);
    // Far below the run — nothing to do here.
    const out = await processWorkerImpl.applyRedactions(bytes, [
      { pageIndex: 0, x: 0.05, y: 0.8, width: 0.35, height: 0.06 }
    ]);
    expect(await pageContent(out)).toContain(SECRET);
  });

  it('still handles the identity matrix Type 3 case, where one unit is one em', async () => {
    const bytes = await type3Document(SECRET, [1, 0, 0, 1, 0, 0]);
    // 60 units per glyph at an em per unit is 1440pt per glyph: the first
    // glyph alone spans the page, so the same mark reaches it.
    const out = await processWorkerImpl.applyRedactions(bytes, [
      { pageIndex: 0, x: 0.2, y: 0.09, width: 0.2, height: 0.06 }
    ]);
    expect(await pageContent(out)).not.toContain(SECRET);
  });
});

/**
 * HRD-40 — a text-only document must not grow through redaction.
 *
 * The audit measured a 100-page text-only file going 75 KB → 150 KB through
 * redaction with nothing heavy removed. Every font and content stream was
 * already copied exactly once (one copier per rebuild, PDF-7); the growth was
 * `@cantoo/pdf-lib`'s writer refusing to put the catalog, the page tree and
 * the page leaves into object streams, so every rebuilt page dictionary was
 * written in clear text while the producer's had been compressed.
 *
 * Every assertion re-parses the produced bytes: page count, page text through
 * pdf.js, the shared font's object count, and the absence of the redacted
 * string from every decoded stream.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream
} from 'pdf-lib';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));

const { processWorkerImpl: W } = await import('../../src/core/workers/process.worker');
const { compactStructuralObjects } = await import('../../src/core/pdf/compact-save');
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const SECRET = 'ACCT-7731-SECRET';
const PAGES = 100;
const LINE = 'The quick brown fox jumps over the lazy dog while the committee reviews the minutes.';

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  const doc = await task.promise;
  const texts: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    texts.push(content.items.map(item => ('str' in item ? item.str : '')).join(' '));
  }
  await task.destroy();
  return texts;
}

/** Every decodable stream plus the raw bytes, as latin1. */
async function everything(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  let all = Buffer.from(bytes).toString('latin1');
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    try {
      all += Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1');
    } catch {
      // An image codec cannot hold the plain-text secret.
    }
  }
  return all;
}

async function fontCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  let n = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(PDFName.of('Type')) === PDFName.of('Font')) n++;
  }
  return n;
}

/**
 * A text-only 100-page file the way most producers write one: one shared font,
 * a page of prose each, page dictionaries packed into object streams. The
 * secret sits on page 50 on a line of its own.
 */
async function textOnlyFixture(): Promise<{ bytes: Uint8Array; secretBox: number[] }> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let secretBox: number[] = [];
  for (let p = 0; p < PAGES; p++) {
    const page = doc.addPage([612, 792]);
    for (let l = 0; l < 30; l++) {
      page.drawText(`${p + 1}.${l + 1} ${LINE}`, { x: 50, y: 740 - l * 22, size: 10, font });
    }
    if (p === 49) {
      const y = 60;
      page.drawText(SECRET, { x: 50, y, size: 12, font });
      const width = font.widthOfTextAtSize(SECRET, 12);
      // Normalised, origin top-left, padded a little around the glyphs.
      secretBox = [45 / 612, (792 - (y + 14)) / 792, (width + 10) / 612, 20 / 792];
    }
  }
  const bytes = await compactStructuralObjects(doc).save({ useObjectStreams: true });
  return { bytes, secretBox };
}

describe('redaction output size on text-only files (HRD-40)', () => {
  it('a 100-page text-only file with one redaction is not materially larger than its input', async () => {
    const { bytes, secretBox } = await textOnlyFixture();
    const [x, y, width, height] = secretBox;
    const before = await pageTexts(bytes);
    expect(before[49]).toContain(SECRET);

    const redacted = await W.applyRedactions(
      bytes.slice(),
      [{ pageIndex: 49, x, y, width, height, text: SECRET }],
      undefined,
      undefined as never
    );
    // The pipeline's mandatory scrub runs next and must not undo the saving.
    const scrubbed = await W.scrubMetadata(redacted.slice(), undefined, undefined as never);

    for (const output of [redacted, scrubbed]) {
      expect(output.length).toBeLessThanOrEqual(bytes.length * 1.05);
      const after = await pageTexts(output);
      expect(after).toHaveLength(PAGES);
      expect(after[49]).not.toContain(SECRET);
      // Everything else on every page is still there.
      after.forEach((text, i) => expect(text).toContain(`${i + 1}.30 ${LINE.slice(0, 20)}`));
      expect(await everything(output)).not.toContain(SECRET);
      // The shared font is copied once, not once per page.
      expect(await fontCount(output)).toBe(1);
    }
  });

  it('page dictionaries are compressed, so no `/Type /Page` is written in clear text', async () => {
    const { bytes } = await textOnlyFixture();
    const out = await W.applyRedactions(
      bytes.slice(),
      [{ pageIndex: 0, x: 0.9, y: 0.95, width: 0.05, height: 0.03 }],
      undefined,
      undefined as never
    );
    const raw = Buffer.from(out).toString('latin1');
    expect(raw).not.toMatch(/\/Type\s*\/Page\b/);
    expect(raw).not.toMatch(/\/Type\s*\/Catalog\b/);
    // And it is still a document both parsers read the same way.
    expect((await PDFDocument.load(out)).getPageCount()).toBe(PAGES);
    expect(await pageTexts(out)).toHaveLength(PAGES);
  });

  it('the 100-page corpus fixture keeps its size through redact → scrub', async () => {
    const bytes = new Uint8Array(readFileSync('tests/fixtures/100-page.pdf'));
    // "Page 4" at (50, 800) in 24 pt on an A4 page.
    const region = { pageIndex: 3, x: 45 / 595.28, y: 15 / 841.89, width: 0.15, height: 0.04 };
    const redacted = await W.applyRedactions(
      bytes.slice(),
      [region],
      undefined,
      undefined as never
    );
    const scrubbed = await W.scrubMetadata(redacted.slice(), undefined, undefined as never);
    expect(redacted.length).toBeLessThanOrEqual(bytes.length * 1.05);
    expect(scrubbed.length).toBeLessThanOrEqual(bytes.length * 1.05);
    const texts = await pageTexts(scrubbed);
    expect(texts).toHaveLength(100);
    expect(texts[3]).not.toContain('Page 4');
    expect(texts[4]).toContain('Page 5');
  });

  it('an incremental save is left to pdf-lib', async () => {
    const { bytes } = await textOnlyFixture();
    const doc = await PDFDocument.load(bytes, { forIncrementalUpdate: true } as never);
    doc.getPage(0).drawText('x');
    const incremental = await compactStructuralObjects(doc).save({ useObjectStreams: true });
    expect(incremental.length).toBeGreaterThan(bytes.length);
    expect(Buffer.from(incremental).subarray(0, bytes.length).equals(Buffer.from(bytes))).toBe(
      true
    );
    expect((await PDFDocument.load(incremental)).getPageCount()).toBe(PAGES);
  });
});

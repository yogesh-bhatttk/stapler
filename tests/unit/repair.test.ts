/**
 * GAP-6 — Repair, graded on real bytes.
 *
 * Every repaired output is re-opened by *both* parsers the app uses — pdf-lib
 * (strict, the same `loadPdfDocument` every tool goes through) and pdf.js (the
 * renderer) — and its page count and text are read back. A repair that
 * "succeeds" on a file neither can open is exactly what must never ship.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { repairPdfBytes, inflatePartial } from '../../src/core/pdf/repair';
import { loadPdfDocument } from '../../src/core/pdf/load';

const FIXTURES = path.resolve(__dirname, '../fixtures');
const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));

async function pdfjsOpen(bytes: Uint8Array): Promise<{ pages: number; text: string[] }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const text: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text.push(
      content.items
        .map(item => ('str' in item ? item.str : ''))
        .join(' ')
        .trim()
    );
  }
  const pages = doc.numPages;
  await task.destroy();
  return { pages, text };
}

async function pdfjsRefuses(bytes: Uint8Array): Promise<boolean> {
  try {
    await pdfjsOpen(bytes);
    return false;
  } catch {
    return true;
  }
}

async function makeTextPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Repair page ${i + 1}`, { x: 72, y: 700, size: 18, font });
  }
  return doc.save({ useObjectStreams: false });
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

describe('repair — the real truncated fixtures', () => {
  for (const name of ['truncated.pdf', 'truncated-mid-body.pdf']) {
    it(`${name}: the normal parsers refuse it, the repaired output opens in both`, async () => {
      const input = fixture(name);
      // The premise: this is a file the import refuses.
      expect(await pdfjsRefuses(input)).toBe(true);
      await expect(loadPdfDocument(input).then(d => d.getPageCount())).rejects.toBeTruthy();

      const outcome = await repairPdfBytes(input);
      expect(outcome.changed).toBe(true);
      expect(outcome.pageCount).toBeGreaterThan(0);
      expect(outcome.findings.length).toBeGreaterThan(0);

      const strict = await loadPdfDocument(outcome.bytes);
      expect(strict.getPageCount()).toBe(outcome.pageCount);
      const opened = await pdfjsOpen(outcome.bytes);
      expect(opened.pages).toBe(outcome.pageCount);
      // The recovered page carries the fixture's real text, not an empty page.
      expect(opened.text[0]).toContain('Stapler fixture page 1');
    });
  }

  it('truncated-header-only.pdf: recovers the partial first page content, and says it was cut off', async () => {
    const outcome = await repairPdfBytes(fixture('truncated-header-only.pdf'));
    const opened = await pdfjsOpen(outcome.bytes);
    expect(opened.pages).toBe(outcome.pageCount);
    expect(outcome.warnings.join(' ')).toMatch(/cut off/);
  });

  it('refuses a file that is not a PDF, with a reason', async () => {
    await expect(repairPdfBytes(fixture('not-a-pdf.pdf'))).rejects.toMatchObject({
      kind: 'CorruptDocument'
    });
  });

  it('refuses an encrypted file rather than writing it back unprotected', async () => {
    await expect(repairPdfBytes(fixture('encrypted.pdf'))).rejects.toMatchObject({
      kind: 'Encrypted'
    });
  });

  it('reports "nothing to repair" for a healthy file', async () => {
    const outcome = await repairPdfBytes(fixture('text-2.pdf'));
    expect(outcome.changed).toBe(false);
    expect(outcome.pageCount).toBe(2);
  });
});

describe('repair — damaged variants built here', () => {
  it('a wrong startxref offset: xref rebuilt, every page kept', async () => {
    const good = latin1(await makeTextPdf(3));
    const at = good.lastIndexOf('startxref');
    const broken = good.slice(0, at) + 'startxref\n12\n%%EOF\n';
    const outcome = await repairPdfBytes(new Uint8Array(Buffer.from(broken, 'latin1')));
    expect(outcome.pageCount).toBe(3);
    expect(outcome.findings.join(' ')).toMatch(/cross-reference/);
    const opened = await pdfjsOpen(outcome.bytes);
    expect(opened.pages).toBe(3);
    expect(opened.text[2]).toContain('Repair page 3');
  });

  it('cut off before the xref and trailer: pages recovered through the catalog', async () => {
    const good = latin1(await makeTextPdf(4));
    const cut = good.slice(0, good.indexOf('\nxref'));
    const outcome = await repairPdfBytes(new Uint8Array(Buffer.from(cut, 'latin1')));
    expect(outcome.pageCount).toBe(4);
    expect(outcome.findings.join(' ')).toMatch(/cut off/);
    expect((await pdfjsOpen(outcome.bytes)).pages).toBe(4);
  });

  it('a dangling annotation, a dangling content stream and a broken object are dropped and counted', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.drawText('Survivor', { x: 72, y: 700, size: 18, font });
    const ctx = doc.context;
    // An annotation reference to an object that does not exist, and a second
    // content stream reference to nothing.
    page.node.set(
      (await import('pdf-lib')).PDFName.of('Annots'),
      ctx.obj([(await import('pdf-lib')).PDFRef.of(900, 0)])
    );
    const contents = page.node.Contents();
    const { PDFArray, PDFName, PDFRef } = await import('pdf-lib');
    const list =
      contents instanceof PDFArray ? contents : ctx.obj([page.node.get(PDFName.of('Contents'))!]);
    list.push(PDFRef.of(901, 0));
    page.node.set(PDFName.of('Contents'), list);
    let text = latin1(await doc.save({ useObjectStreams: false }));
    // A syntactically broken object in the middle of the file.
    text = text.replace(
      /\n(\d+) 0 obj\n<<\n\/Type \/Font/,
      '\n$1 0 obj\n<< /Broken [ 1 2 \n>>\nendobj\n777 0 obj\n<<\n/Type /Font'
    );
    const outcome = await repairPdfBytes(new Uint8Array(Buffer.from(text, 'latin1')));
    const all = outcome.findings.join(' ');
    expect(all).toMatch(/broken annotation/);
    expect(all).toMatch(/page content that no longer exists/);
    const opened = await pdfjsOpen(outcome.bytes);
    expect(opened.pages).toBe(1);
    expect(opened.text[0]).toContain('Survivor');
  });

  it('a page tree with a missing kid: rebuilt, remaining pages kept in order', async () => {
    const good = latin1(await makeTextPdf(3));
    // Point the second kid at an object that does not exist.
    const kids = /\/Kids \[ (\d+) 0 R (\d+) 0 R (\d+) 0 R \]/.exec(good);
    expect(kids).not.toBeNull();
    const broken = good.replace(kids![0], `/Kids [ ${kids![1]} 0 R 999 0 R ${kids![3]} 0 R ]`);
    const outcome = await repairPdfBytes(new Uint8Array(Buffer.from(broken, 'latin1')));
    expect(outcome.pageCount).toBe(2);
    expect(outcome.findings.join(' ')).toMatch(/page tree/);
    const opened = await pdfjsOpen(outcome.bytes);
    expect(opened.text).toEqual([
      expect.stringContaining('Repair page 1'),
      expect.stringContaining('Repair page 3')
    ]);
  });
});

describe('inflatePartial', () => {
  it('returns the decodable prefix of a truncated zlib stream', async () => {
    const { zlibSync } = await import('fflate');
    const source = new TextEncoder().encode('BT /F1 12 Tf (hello) Tj ET\n'.repeat(400));
    const packed = zlibSync(source);
    const partial = inflatePartial(packed.subarray(0, Math.floor(packed.length / 2)));
    expect(partial.complete).toBe(false);
    expect(partial.bytes.length).toBeGreaterThan(0);
    expect(Buffer.from(partial.bytes).toString()).toBe(
      Buffer.from(source.subarray(0, partial.bytes.length)).toString()
    );
    expect(inflatePartial(packed).complete).toBe(true);
  });
});

describe('repair — audit 2026-10-01 regressions', () => {
  async function encryptedPdf(): Promise<Uint8Array> {
    const { PDFString } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([612, 792]).drawText('Secret', { x: 72, y: 700, size: 18, font });
    const handler = doc.context.register(
      doc.context.obj({
        Filter: 'Standard',
        V: 2,
        R: 3,
        Length: 128,
        P: -4,
        O: PDFString.of('owner'),
        U: PDFString.of('user')
      })
    );
    doc.context.trailerInfo.Encrypt = handler;
    return doc.save({ useObjectStreams: false });
  }

  it('PDF-1: refuses an encrypted file whose trailer was cut off', async () => {
    const text = latin1(await encryptedPdf());
    const cut = text.slice(0, text.lastIndexOf('\nxref'));
    // The premise: the trailer (and its /Encrypt) is gone.
    expect(cut).not.toMatch(/trailer/);
    await expect(repairPdfBytes(new Uint8Array(Buffer.from(cut, 'latin1')))).rejects.toMatchObject({
      kind: 'Encrypted',
      message: expect.stringContaining('This file is encrypted')
    });
  });

  it('PDF-1: refuses when only the security handler dictionary survives (no /Encrypt key)', async () => {
    const text = latin1(await encryptedPdf());
    // Cut the trailer and rename every `/Encrypt` so only the handler's own
    // dictionary (/Filter /Standard with /O and /U) is evidence.
    const cut = text.slice(0, text.lastIndexOf('\nxref')).replace(/\/Encrypt\b/g, '/Xncrypt');
    await expect(repairPdfBytes(new Uint8Array(Buffer.from(cut, 'latin1')))).rejects.toMatchObject({
      kind: 'Encrypted'
    });
  });

  async function pdfWithFakeHeaderInStream(compress: boolean): Promise<Uint8Array> {
    const { PDFArray, PDFName } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([300, 300]);
    page.drawText('Real text', { x: 20, y: 200, size: 18, font });
    const fake = '% 99 0 obj << /Type /Catalog >> stream\nxx\nendstream\n';
    const extra = compress ? doc.context.flateStream(fake) : doc.context.stream(fake);
    const contents = page.node.get(PDFName.of('Contents'))!;
    const list = contents instanceof PDFArray ? contents : doc.context.obj([contents]);
    list.push(doc.context.register(extra));
    page.node.set(PDFName.of('Contents'), list);
    return doc.save({ useObjectStreams: false });
  }

  it('PDF-3: an intact file with "99 0 obj" inside a content stream round-trips as already valid', async () => {
    const input = await pdfWithFakeHeaderInStream(false);
    const outcome = await repairPdfBytes(input);
    expect(outcome.changed).toBe(false);
    expect(outcome.findings).toEqual([]);
    const strict = await loadPdfDocument(outcome.bytes);
    expect(strict.context.lookup((await import('pdf-lib')).PDFRef.of(99, 0))).toBeUndefined();
    expect((await pdfjsOpen(outcome.bytes)).text[0]).toContain('Real text');
  });

  it('a damaged, unencrypted file with "/Encrypt" printed inside a stream is still repaired', async () => {
    const { PDFArray, PDFName } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([300, 300]);
    page.drawText('Real text', { x: 20, y: 200, size: 18, font });
    // A page that prints PDF syntax: the bytes "/Encrypt 5 0 R" are stream data.
    const extra = doc.context.stream('% trailer << /Encrypt 5 0 R >>\n');
    const contents = page.node.get(PDFName.of('Contents'))!;
    const list = contents instanceof PDFArray ? contents : doc.context.obj([contents]);
    list.push(doc.context.register(extra));
    page.node.set(PDFName.of('Contents'), list);
    const text = latin1(await doc.save({ useObjectStreams: false }));
    expect(text).toContain('/Encrypt 5 0 R'); // the premise
    const cut = text.slice(0, text.lastIndexOf('\nxref'));
    const outcome = await repairPdfBytes(new Uint8Array(Buffer.from(cut, 'latin1')));
    expect(outcome.changed).toBe(true);
    expect((await pdfjsOpen(outcome.bytes)).text[0]).toContain('Real text');
  });

  it('PDF-3: in a damaged file, an object header inside stream data is not salvaged', async () => {
    const text = latin1(await pdfWithFakeHeaderInStream(false));
    const cut = text.slice(0, text.lastIndexOf('\nxref'));
    const outcome = await repairPdfBytes(new Uint8Array(Buffer.from(cut, 'latin1')));
    expect(outcome.findings.join(' ')).not.toMatch(/Recovered/);
    const strict = await loadPdfDocument(outcome.bytes);
    expect(strict.context.lookup((await import('pdf-lib')).PDFRef.of(99, 0))).toBeUndefined();
    expect(strict.getPageCount()).toBe(1);
    expect((await pdfjsOpen(outcome.bytes)).text[0]).toContain('Real text');
  });
});

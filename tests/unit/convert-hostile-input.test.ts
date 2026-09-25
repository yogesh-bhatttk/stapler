/**
 * CONV-4 / CONV-5 — hostile OOXML packages.
 *
 *  • CONV-4: slide XML with tens of thousands of `<a:t>` openers and no closer
 *    used to take the pptx reader quadratic time (a 1.4 KB zip pinned the
 *    convert worker for 29 s). It must now finish in well under a second.
 *  • CONV-5: a package that declares more uncompressed bytes (or entries) than
 *    the budget is refused from the central directory, before anything is
 *    inflated — for .pptx, .docx and .xlsx alike — and the pptx reader no
 *    longer inflates media it was not asked for. An entry that *understates*
 *    its size is refused too: every entry is inflated bounded by, and checked
 *    against, its declared size, and mammoth/SheetJS only see a stored repack.
 */
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { elementBodies, readPptx } from '../../src/core/convert/pptx-reader';
import { readDocxAsHtml } from '../../src/core/convert/docx-reader';
import { readXlsxAsBlocks } from '../../src/core/convert/xlsx-reader';
import {
  assertZipWithinBudget,
  inflateZipVetted,
  MAX_ZIP_ENTRIES,
  readZipDirectory,
  repackStored
} from '../../src/core/convert/zip-guard';

const NS = 'xmlns:p="p" xmlns:a="a" xmlns:r="r"';

function deck(slideXml: string, extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    'ppt/presentation.xml': strToU8(
      `<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>` +
        '<p:sldSz cx="9144000" cy="6858000"/></p:presentation>'
    ),
    'ppt/_rels/presentation.xml.rels': strToU8(
      '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>'
    ),
    'ppt/slides/slide1.xml': strToU8(slideXml),
    ...extra
  });
}

const slide = (body: string) =>
  `<p:sld ${NS}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r>${body}</a:r></a:p>` +
  '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>';

/**
 * Rewrites every central-directory entry's declared uncompressed size. The
 * guard must refuse on the declaration alone, without inflating anything.
 */
function forgeDeclaredSize(zip: Uint8Array, size: number): Uint8Array {
  const out = zip.slice();
  const view = new DataView(out.buffer);
  for (let i = 0; i + 46 <= out.length; i++) {
    if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, size, true);
  }
  return out;
}

describe('CONV-4: pptx reader is linear on unclosed elements', () => {
  it('the audit probe input (80k unclosed <a:t>) reads in under a second', async () => {
    const bytes = deck(slide('<a:t>x'.repeat(80_000)));
    const t = performance.now();
    await readPptx(bytes).catch(() => undefined);
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it('unclosed <a:p>, comments, CDATA and tags without ">" are all linear', async () => {
    const hostile = [
      '<a:p>x'.repeat(50_000),
      '<!--x'.repeat(50_000),
      '<![CDATA[x'.repeat(50_000),
      '<a:t <a:t '.repeat(50_000),
      '<p:sp x="'.repeat(50_000)
    ];
    for (const body of hostile) {
      const t = performance.now();
      await readPptx(deck(slide(body))).catch(() => undefined);
      expect(performance.now() - t, body.slice(0, 12)).toBeLessThan(1000);
    }
  });

  it('elementBodies keeps the lazy-regex semantics on well-formed input', () => {
    const xml =
      '<a:p><a:pPr algn="l"/><a:r><a:t>one</a:t></a:r><a:r><a:t xml:space="preserve"> two</a:t>' +
      '</a:r></a:p><a:p/><a:p><a:t/><a:t>three</a:t></a:p>';
    expect(elementBodies(xml, 'a:t')).toEqual(['one', ' two', 'three']);
    expect(elementBodies(xml, 'a:p')).toHaveLength(2);
    expect(elementBodies(xml, 'a:p', 1)).toHaveLength(1);
  });

  it('text inside CDATA and around comments is still read', async () => {
    const d = await readPptx(
      deck(slide('<!-- <a:t>hidden</a:t> --><a:t>a<![CDATA[&amp;<b>]]>c</a:t>'))
    );
    expect(d.slides[0].runs).toContain('a&amp;<b>c');
  });
});

describe('CONV-5: decompression budget', () => {
  it('pptx does not inflate media it was not asked for, but still reports its size', async () => {
    const media = new Uint8Array(8 * 1024 * 1024);
    const bytes = zipSync(
      {
        'ppt/presentation.xml': strToU8(
          `<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`
        ),
        'ppt/_rels/presentation.xml.rels': strToU8(
          '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>'
        ),
        'ppt/slides/slide1.xml': strToU8(slide('<a:t>hi</a:t>')),
        'ppt/slides/_rels/slide1.xml.rels': strToU8(
          '<Relationships><Relationship Id="rId2" Target="../media/image1.png"/></Relationships>'
        ),
        'ppt/media/image1.png': media
      },
      { level: 9 }
    );
    const lean = await readPptx(bytes);
    expect(lean.slides[0].media[0].byteLength).toBe(media.length);
    expect(lean.slides[0].media[0].bytes).toBeUndefined();
    const full = await readPptx(bytes, { includeMediaBytes: true });
    expect(full.slides[0].media[0].bytes?.length).toBe(media.length);
  });

  it('refuses a pptx whose parts declare more than the budget, before inflating', async () => {
    const bytes = forgeDeclaredSize(deck(slide('<a:t>hi</a:t>')), 200 * 1024 * 1024);
    await expect(readPptx(bytes)).rejects.toThrow(/more than 256 MB|larger than the 32 MB/);
  });

  it('refuses a docx and an xlsx whose entries declare more than 256 MB', async () => {
    const pkg = zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'a.bin': new Uint8Array(16),
      'b.bin': new Uint8Array(16)
    });
    const forged = forgeDeclaredSize(pkg, 100 * 1024 * 1024);
    await expect(readDocxAsHtml(forged)).rejects.toThrow(/more than 256 MB/);
    await expect(readXlsxAsBlocks(forged)).rejects.toThrow(/more than 256 MB/);
  });

  it('refuses a package with more than the entry limit', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i <= MAX_ZIP_ENTRIES; i++) files[`f${i}`] = new Uint8Array(0);
    const bytes = zipSync(files, { level: 0 });
    expect(() => assertZipWithinBudget(bytes, 'workbook')).toThrow(/more than 10,000 files/);
    await expect(readDocxAsHtml(bytes)).rejects.toThrow(/more than 10,000 files/);
  });

  it('reads a normal directory exactly and leaves a non-zip to the reader', () => {
    const bytes = zipSync({ 'a.xml': strToU8('<a/>'), 'b/c.bin': new Uint8Array(1000) });
    const dir = readZipDirectory(bytes);
    expect(dir?.entries.map(e => [e.name, e.uncompressedSize])).toEqual([
      ['a.xml', 4],
      ['b/c.bin', 1000]
    ]);
    expect(readZipDirectory(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]))).toBeNull();
  });
});

/**
 * Rewrites one named entry's declared uncompressed size, in the central
 * directory only (which is what every reader here sizes from).
 */
function forgeEntrySize(zip: Uint8Array, name: string, size: number): Uint8Array {
  const out = zip.slice();
  const view = new DataView(out.buffer);
  const want = strToU8(name);
  for (let i = 0; i + 46 <= out.length; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const len = view.getUint16(i + 28, true);
    const got = out.subarray(i + 46, i + 46 + len);
    if (len === want.length && got.every((b, k) => b === want[k])) {
      view.setUint32(i + 24, size, true);
    }
  }
  return out;
}

describe('CONV-5: actual inflated size is enforced, not just the declared size', () => {
  // 64 MB of zeros deflates to ~64 KB. Declared as 1 KB, it sails under the
  // central-directory budget — the case jszip (mammoth) and SheetJS would have
  // inflated in full, since neither bounds inflation by the declared size.
  const bomb = () =>
    forgeEntrySize(
      zipSync({
        '[Content_Types].xml': strToU8('<Types/>'),
        'word/document.xml': strToU8('<w:document/>'),
        'xl/workbook.xml': strToU8('<workbook/>'),
        'ppt/presentation.xml': strToU8('<p:presentation/>'),
        'pad.bin': new Uint8Array(64 * 1024 * 1024)
      }),
      'pad.bin',
      1024
    );

  it('refuses an entry that understates its size, in all three readers', async () => {
    const bytes = bomb();
    expect(bytes.length).toBeLessThan(1024 * 1024);
    expect(() => assertZipWithinBudget(bytes, 'workbook')).not.toThrow();
    const understates = /understates how large its part pad\.bin is/;
    await expect(readDocxAsHtml(bytes)).rejects.toThrow(understates);
    await expect(readXlsxAsBlocks(bytes)).rejects.toThrow(understates);
    // pptx inflates everything but unrequested media, so pad.bin is read too.
    await expect(readPptx(bytes)).rejects.toThrow(understates);
  });

  it('inflates within one byte of the declared size, never the real one', () => {
    let peak = 0;
    expect(() =>
      inflateZipVetted(bomb(), 'workbook', {
        inspect: entry => {
          peak = Math.max(peak, entry.uncompressedSize);
        }
      })
    ).toThrow(/decompression bomb/);
    expect(peak).toBe(1024);
  });

  it('refuses an entry that overstates its size as damaged, not silently short', () => {
    const bytes = forgeEntrySize(zipSync({ 'a.xml': strToU8('<a>hello</a>') }), 'a.xml', 1000);
    expect(() => inflateZipVetted(bytes, 'workbook')).toThrow(/a\.xml is shorter than/);
  });

  it('hands the downstream readers a stored-only copy of exactly the vetted bytes', () => {
    const files = { 'a.xml': strToU8('<a/>'.repeat(1000)), 'b/c.bin': new Uint8Array(5000) };
    const vetted = inflateZipVetted(zipSync(files), 'workbook');
    expect(vetted).toEqual(files);
    const packed = repackStored(vetted!);
    const dir = readZipDirectory(packed);
    expect(dir?.entries.map(e => e.method)).toEqual([0, 0]);
    expect(inflateZipVetted(packed, 'workbook')).toEqual(files);
  });

  it('leaves a non-zip to the caller (null)', () => {
    expect(inflateZipVetted(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]), 'workbook')).toBeNull();
  });
});

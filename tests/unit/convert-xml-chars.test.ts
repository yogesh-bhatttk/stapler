/**
 * CONV-3 — PDF→Word and PDF→PowerPoint must never write a character XML 1.0
 * forbids.
 *
 * A PDF text layer with a broken `/ToUnicode` map routinely yields U+0001,
 * U+0008, U+FFFE or a lone surrogate. The `docx` package and pptxgenjs escape
 * `& < >` but pass those through, and one of them anywhere in a part makes Word
 * report "unreadable content" and PowerPoint demand a repair. This test builds
 * both packages from a model whose every string (runs, table cells, title, alt
 * text) carries the whole bad set, unzips the real output, and scans every XML
 * part.
 */
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { buildDocx } from '../../src/core/convert/docx-writer';
import { buildPptx } from '../../src/core/convert/pptx-writer';
import { buildXlsx } from '../../src/core/convert/xlsx-writer';
import { stripInvalidXmlChars } from '../../src/core/convert/xml-chars';
import type { DocxModel } from '../../src/core/convert/blocks';
import type { SlidePlan } from '../../src/core/convert/slides';

const NONCHARS = String.fromCharCode(0xfffe, 0xffff);
const BAD = `A\u0000B\u0001C\u0008D\u000BE\u000CF\u001FG${NONCHARS[0]}H${NONCHARS[1]}I\uD800J\uDFFFK`;
const INVALID = new RegExp(`[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F${NONCHARS}]`);

/** A lone surrogate: a high not followed by a low, or a low not preceded by a high. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** A 1×1 PNG, so the image alt-text path is exercised too. */
const PNG_1X1 = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
  ),
  c => c.charCodeAt(0)
);

function assertCleanPackage(bytes: Uint8Array): string[] {
  const files = unzipSync(bytes);
  const xmlParts = Object.keys(files).filter(n => n.endsWith('.xml') || n.endsWith('.rels'));
  expect(xmlParts.length).toBeGreaterThan(0);
  for (const name of xmlParts) {
    // `strFromU8` decodes UTF-8; a lone surrogate encoded as WTF-8 decodes to
    // U+FFFD, so the raw bytes are checked for the 0xED 0xA0-0xBF lead too.
    const raw = files[name];
    for (let i = 0; i + 1 < raw.length; i++) {
      if (raw[i] === 0xed && raw[i + 1] >= 0xa0 && raw[i + 1] <= 0xbf) {
        throw new Error(`${name} contains a UTF-8-encoded surrogate at byte ${i}`);
      }
    }
    const xml = strFromU8(raw);
    const m = INVALID.exec(xml);
    expect(m, m ? `${name}: U+${m[0].charCodeAt(0).toString(16)} at ${m.index}` : name).toBeNull();
    expect(hasLoneSurrogate(xml), name).toBe(false);
  }
  return xmlParts.map(n => strFromU8(files[n]));
}

describe('stripInvalidXmlChars (CONV-3)', () => {
  it('drops every XML-1.0-illegal code point and keeps tab/LF/CR and astral pairs', () => {
    expect(stripInvalidXmlChars(BAD)).toBe('ABCDEFGHIJK');
    expect(stripInvalidXmlChars('a\tb\nc\rd\u{1F600}e')).toBe('a\tb\nc\rd\u{1F600}e');
    const plain = 'plain text';
    expect(stripInvalidXmlChars(plain)).toBe(plain);
  });
});

describe('OOXML writers never emit illegal XML characters (CONV-3)', () => {
  it('docx: runs, headings, table cells, alt text and docProps title', async () => {
    const model: DocxModel = {
      title: `Title${BAD}`,
      skipped: [],
      pages: [
        {
          pageIndex: 0,
          blocks: [
            { kind: 'heading', level: 1, runs: [{ text: BAD, bold: true, italic: false }] },
            { kind: 'paragraph', runs: [{ text: BAD, bold: false, italic: true }] },
            { kind: 'table', rows: [[BAD, 'ok'], [BAD]] },
            { kind: 'image', data: PNG_1X1, format: 'png', width: 10, height: 10, altText: BAD }
          ]
        }
      ]
    } as DocxModel;
    const parts = assertCleanPackage(await buildDocx(model));
    // The text survived minus the bad characters — not dropped wholesale.
    expect(parts.some(xml => xml.includes('ABCDEFGHIJK'))).toBe(true);
    expect(parts.some(xml => xml.includes('TitleABCDEFGHIJK'))).toBe(true);
  });

  it('pptx: text runs, alt text and docProps title', async () => {
    const plan: SlidePlan = {
      slideWidth: 612,
      slideHeight: 792,
      outline: [],
      notes: [],
      slides: [
        {
          pageIndex: 0,
          images: [
            {
              x: 10,
              y: 10,
              width: 20,
              height: 20,
              rotate: 0,
              fileName: 'img.png',
              format: 'png',
              altText: BAD
            }
          ],
          boxes: [
            {
              x: 20,
              y: 100,
              width: 200,
              height: 14,
              fontSize: 12,
              rotate: 0,
              runs: [{ text: BAD, bold: false, italic: false }]
            }
          ]
        }
      ]
    } as unknown as SlidePlan;
    const parts = assertCleanPackage(
      await buildPptx(plan, { title: `Title${BAD}`, images: { 'img.png': PNG_1X1 } })
    );
    expect(parts.some(xml => xml.includes('ABCDEFGHIJK'))).toBe(true);
    expect(parts.some(xml => xml.includes('TitleABCDEFGHIJK'))).toBe(true);
  });

  it('xlsx still strips after the helper moved to xml-chars.ts', async () => {
    const bytes = buildXlsx([{ name: `S${BAD}`, rows: [[BAD]] }], { title: BAD });
    assertCleanPackage(bytes);
  });
});

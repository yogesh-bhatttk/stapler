/**
 * Content-stream interpreter regressions (AUDIT-FINDINGS §1).
 *
 * Every assertion here is about *bytes in the output stream*, not intent: a
 * redaction that "covers" content is the bug these tests exist to catch.
 */
import { describe, expect, it } from 'vitest';
import {
  GraphicsState,
  decodeStringToken,
  filterContentStream,
  parseContentStream,
  serializeStatements,
  tokenizeContentStream,
  type FontInfo,
  type Rect
} from '../../src/core/pdf/interpreter';

const enc = (s: string) => new TextEncoder().encode(s);
const filterText = (source: string, boxes: Rect[], resolveFont?: (n: string) => FontInfo) => {
  const statements = parseContentStream(tokenizeContentStream(enc(source)));
  const result = filterContentStream(statements, boxes, undefined, undefined, resolveFont);
  return {
    ...result,
    text: new TextDecoder().decode(serializeStatements(result.filtered))
  };
};

describe('vector content under a redaction region (§1, critical)', () => {
  const region: Rect[] = [{ x: 90, y: 90, width: 60, height: 60 }];

  it('removes a stroked path that overlaps the region, not just covers it', () => {
    const { text } = filterText('1 0 0 RG 2 w 100 100 m 140 140 l S\n', region);
    expect(text).not.toContain(' m\n');
    expect(text).not.toContain(' l\n');
    expect(text).not.toContain('S');
  });

  it('removes a filled rectangle that overlaps the region', () => {
    const { text } = filterText('0 g 95 95 40 40 re f\n', region);
    expect(text).not.toContain('re');
    expect(text).not.toMatch(/(^|\n)f\n/);
  });

  it.each(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*'])(
    'removes geometry painted with %s',
    op => {
      const { text } = filterText(`95 95 40 40 re ${op}\n`, region);
      expect(text.trim()).toBe('');
    }
  );

  it('keeps a path that does not reach the region', () => {
    const { text } = filterText('10 10 m 20 20 l S\n', region);
    expect(text).toContain('m');
    expect(text).toContain('l');
    expect(text).toContain('S');
  });

  it('measures the path through the CTM, not in raw user space', () => {
    // The path is drawn at 10,10 but a `cm` scales it by 20, putting it across
    // the region. Ignoring the CTM would keep it.
    const { text } = filterText('q 20 0 0 20 0 0 cm 5 5 m 6 6 l S Q\n', region);
    expect(text.split('\n').filter(Boolean)).toEqual(['q', '20 0 0 20 0 0 cm', 'Q']);
  });

  it('leaves a clipping path (W n) in place — it paints nothing', () => {
    const { text } = filterText('95 95 40 40 re W n\n', region);
    expect(text).toContain('re');
    expect(text).toContain('W');
    expect(text).toContain('n');
  });
});

describe('q nesting is not exponential (§1, high)', () => {
  it('filters depth-40 nesting in well under a second', () => {
    const depth = 40;
    const source =
      'q 1 0 0 1 1 1 cm '.repeat(depth) + '10 10 m 20 20 l S ' + 'Q '.repeat(depth) + '\n';
    const statements = parseContentStream(tokenizeContentStream(enc(source)));

    const started = performance.now();
    const result = filterContentStream(statements, [{ x: 0, y: 0, width: 5, height: 5 }]);
    const elapsed = performance.now() - started;

    expect(result.filtered.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500);
  });

  it('restores state correctly through deep nesting', () => {
    const depth = 40;
    const source = 'q 2 0 0 2 0 0 cm '.repeat(depth) + 'Q '.repeat(depth) + '\n';
    const statements = parseContentStream(tokenizeContentStream(enc(source)));
    const state = new GraphicsState();
    const result = filterContentStream(statements, [], state);
    expect(result.finalState.ctm).toEqual([1, 0, 0, 1, 0, 0]);
  });
});

describe('string decoding (§1, medium)', () => {
  const token = (src: string) => tokenizeContentStream(enc(src))[0];

  it('unescapes literal strings rather than counting backslashes', () => {
    expect(Array.from(decodeStringToken(token('(A\\)B)')))).toEqual([65, 41, 66]);
    expect(Array.from(decodeStringToken(token('(\\101)')))).toEqual([65]);
    expect(Array.from(decodeStringToken(token('(a\\nb)')))).toEqual([97, 10, 98]);
  });

  it('decodes hex strings, padding an odd trailing digit', () => {
    expect(Array.from(decodeStringToken(token('<4142>')))).toEqual([0x41, 0x42]);
    expect(Array.from(decodeStringToken(token('<414>')))).toEqual([0x41, 0x40]);
  });
});

describe('text width no longer a 0.6em byte count (§1, medium)', () => {
  // A box just wide enough for five glyphs of a 10pt CID font at 1000/1000 em.
  const wideRegion: Rect[] = [{ x: 150, y: 0, width: 40, height: 40 }];

  it('counts a two-byte CID string by glyph pairs, not by bytes', () => {
    const cid: FontInfo = { twoByte: true, defaultWidth: 1000 };
    const simple: FontInfo = { twoByte: false, defaultWidth: 1000 };
    // Ten bytes = five CID glyphs = 50pt at 10pt. Two shows therefore span
    // 0..50 and 50..100, clear of a region at x 150..190.
    //
    // Counting the same bytes singly (the old behaviour, and what a /Type0
    // font used to get) makes each show 100pt, so the second spans 100..200
    // and is measured as overlapping — the run gets deleted, taking text the
    // user never marked. The double-count is only visible once the advance is
    // fed back into the text matrix, which is exactly how it compounds in a
    // real BT/ET block.
    const source = 'BT /F1 10 Tf 0 0 Td <00410042004300440045> Tj <00410042004300440045> Tj ET\n';
    const asCid = filterText(source, wideRegion, () => cid);
    const asSimple = filterText(source, wideRegion, () => simple);
    expect(asCid.text.match(/Tj/g)).toHaveLength(2);
    expect(asSimple.text.match(/Tj/g)).toHaveLength(1);
  });

  it('applies Tz horizontal scaling to the advance', () => {
    const font: FontInfo = { twoByte: false, defaultWidth: 1000 };
    // 10 glyphs x 10pt = 100pt at Tz 100; 200pt at Tz 200, which reaches x=150.
    const region: Rect[] = [{ x: 150, y: 0, width: 20, height: 20 }];
    const at100 = filterText('BT /F1 10 Tf 100 Tz (ABCDEFGHIJ) Tj ET\n', region, () => font);
    const at200 = filterText('BT /F1 10 Tf 200 Tz (ABCDEFGHIJ) Tj ET\n', region, () => font);
    expect(at100.text).toContain('Tj');
    expect(at200.text).not.toContain('Tj');
  });

  it('applies Tc character spacing to the advance', () => {
    const font: FontInfo = { twoByte: false, defaultWidth: 1000 };
    const region: Rect[] = [{ x: 150, y: 0, width: 20, height: 20 }];
    const noTc = filterText('BT /F1 10 Tf (ABCDEFGHIJ) Tj ET\n', region, () => font);
    const withTc = filterText('BT /F1 10 Tf 10 Tc (ABCDEFGHIJ) Tj ET\n', region, () => font);
    expect(noTc.text).toContain('Tj');
    expect(withTc.text).not.toContain('Tj');
  });

  it('applies Tw word spacing only to single-byte code 32', () => {
    const font: FontInfo = { twoByte: false, defaultWidth: 100 };
    const region: Rect[] = [{ x: 60, y: 0, width: 20, height: 20 }];
    // 5 glyphs x 1pt + 2 spaces; Tw 40 adds 80pt, reaching the region.
    const noTw = filterText('BT /F1 10 Tf (A B C) Tj ET\n', region, () => font);
    const withTw = filterText('BT /F1 10 Tf 40 Tw (A B C) Tj ET\n', region, () => font);
    expect(noTw.text).toContain('Tj');
    expect(withTw.text).not.toContain('Tj');
  });

  it('uses per-glyph /Widths when the font supplies them', () => {
    const widths = new Map<number, number>([[65, 2000]]);
    const font: FontInfo = { twoByte: false, widths, defaultWidth: 100 };
    const region: Rect[] = [{ x: 90, y: 0, width: 20, height: 20 }];
    // 5 A's at 2000/1000 em x 10pt = 100pt, which reaches x=90.
    const wide = filterText('BT /F1 10 Tf (AAAAA) Tj ET\n', region, () => font);
    // The same five codes at the fallback 100/1000 em are 5pt wide.
    const narrow = filterText('BT /F1 10 Tf (BBBBB) Tj ET\n', region, () => font);
    expect(wide.text).not.toContain('Tj');
    expect(narrow.text).toContain('Tj');
  });

  it('subtracts TJ kerning from the advance', () => {
    const font: FontInfo = { twoByte: false, defaultWidth: 1000 };
    const region: Rect[] = [{ x: 95, y: 0, width: 20, height: 20 }];
    const kerned = filterText('BT /F1 10 Tf [(ABCDEFGHIJ) 50000] TJ ET\n', region, () => font);
    const plain = filterText('BT /F1 10 Tf [(ABCDEFGHIJ)] TJ ET\n', region, () => font);
    // 10 glyphs = 100pt reaches x=95; a 50000/1000 em leftward kern pulls the
    // measured end back to 0pt, so it no longer does.
    expect(plain.text).not.toContain('TJ');
    expect(kerned.text).toContain('TJ');
  });
});

describe('Tc/Tw/Tz survive q/Q like the rest of the graphics state', () => {
  it('restores text state on Q', () => {
    const source = 'q 10 Tc 50 Tw 200 Tz Q\n';
    const statements = parseContentStream(tokenizeContentStream(enc(source)));
    const result = filterContentStream(statements, []);
    expect(result.finalState.charSpacing).toBe(0);
    expect(result.finalState.wordSpacing).toBe(0);
    expect(result.finalState.horizontalScale).toBe(1);
  });
});

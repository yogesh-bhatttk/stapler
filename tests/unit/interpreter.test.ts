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
  stripTextObjects,
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

/**
 * OCR-04 — clearing a broken pre-existing text layer before writing a fresh
 * one from a re-OCR pass.
 */
describe('stripTextObjects', () => {
  const strip = (source: string) => {
    const statements = parseContentStream(tokenizeContentStream(enc(source)));
    const result = stripTextObjects(statements);
    return { ...result, text: new TextDecoder().decode(serializeStatements(result.filtered)) };
  };

  it('removes an invisible text object entirely, counting it', () => {
    const result = strip('q 1 0 0 1 0 0 cm /Im0 Do Q\nBT 3 Tr /F1 12 Tf 10 700 Td (Hello) Tj ET\n');
    expect(result.removed).toBe(1);
    expect(result.text).not.toContain('BT');
    expect(result.text).not.toContain('Tj');
    // The image draw around it survives untouched.
    expect(result.text).toContain('/Im0 Do');
  });

  it('removes a text object whose `Tr 3` was set before `BT`, scoped by q/Q', () => {
    // The exact shape `textLayer.ts`'s own `drawInvisibleWords` emits: one
    // `Tr` covering several words' worth of BT/ET blocks, not one per block.
    const result = strip('q\n3 Tr\nBT /F1 12 Tf (Hello) Tj ET\nBT /F1 12 Tf (World) Tj ET\nQ\n');
    expect(result.removed).toBe(2);
    expect(result.text).not.toContain('Tj');
  });

  it('does not misjudge a later block after an unsafe span, defaulting to unknown', () => {
    // The first BT block is left alone (its internal `q`/`Q` is foreign to a
    // text object). Inside that untouched span, `3 Tr` is set and then
    // restored back by `Q` — the real, rendered state after this block is
    // *visible*. A flat textual scan that just remembers "the last Tr value
    // seen" would wrongly conclude "invisible" (it saw the `3` and never
    // un-saw it), and strip the second block's real, visible "(b)" on that
    // wrong belief. Marking the state unknown after any unsafe span is what
    // prevents that.
    const result = strip('BT (a) Tj q 3 Tr Q ET\nBT (b) Tj ET\n');
    expect(result.removed).toBe(0);
    expect(result.text).toContain('(a)');
    expect(result.text).toContain('(b)');
  });

  it('removes multiple invisible text objects and counts each', () => {
    const result = strip('BT 3 Tr (a) Tj ET\nBT 3 Tr (b) Tj ET\nBT 3 Tr (c) Tj ET\n');
    expect(result.removed).toBe(3);
    expect(result.text.trim()).toBe('');
  });

  it('never removes visible text drawn with a fill colour', () => {
    // `0 0 0 rg` is exactly the shape pdf-lib's own `drawText` emits for
    // ordinary, user-visible black text — the regression this test guards
    // against: an earlier version of the "every operator must be a text
    // operator" guard alone happened to reject this block too (because `rg`
    // is not a text operator), which looked safe but was safe for the wrong
    // reason. The real, load-bearing property is the missing `3 Tr`: no
    // mainstream OCR layer omits it, and no visible text needs one.
    const result = strip('BT 0 0 0 rg /F1 12 Tf 10 700 Td (Hello) Tj ET\n');
    expect(result.removed).toBe(0);
    expect(result.text).toContain('Tj');
  });

  it('leaves visible text alone even when every operator inside is otherwise a text operator', () => {
    // Isolates the invisible-mode requirement from the "no foreign operator"
    // guard: this block is built entirely from operators in the safe set, so
    // only the missing `3 Tr` protects it.
    const withoutTr = strip('BT /F1 12 Tf (Hello) Tj ET\n');
    const explicitlyVisible = strip('BT 0 Tr /F1 12 Tf (Hello) Tj ET\n');
    expect(withoutTr.removed).toBe(0);
    expect(withoutTr.text).toContain('Tj');
    expect(explicitlyVisible.removed).toBe(0);
    expect(explicitlyVisible.text).toContain('Tj');
  });

  it('leaves an invisible text object alone if it contains a non-text operator', () => {
    // Not a realistic producer, but if one exists this must not risk an
    // unbalanced q/Q by deleting only half of a pair.
    const result = strip('BT 3 Tr (a) Tj q 1 0 0 1 0 0 cm Q ET\n');
    expect(result.removed).toBe(0);
    expect(result.text).toContain('BT');
    expect(result.text).toContain('ET');
  });

  it('leaves an unterminated BT alone rather than guessing where it ends', () => {
    const result = strip('BT 3 Tr /F1 12 Tf (Hello) Tj\n');
    expect(result.removed).toBe(0);
    expect(result.text).toContain('BT');
  });

  it('leaves a stream with no text objects untouched', () => {
    const result = strip('q 1 0 0 1 0 0 cm /Im0 Do Q\n');
    expect(result.removed).toBe(0);
    expect(result.text).toContain('/Im0 Do');
  });
});

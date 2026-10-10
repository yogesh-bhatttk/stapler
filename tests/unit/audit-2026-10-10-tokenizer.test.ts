/**
 * AUDIT-2026-10-10 P1 — `tokenizeContentStream` must terminate on any input.
 *
 * A stray `)`, `{` or `}` is a delimiter that no branch consumed, so the
 * regular-token branch pushed an empty operator without advancing and looped
 * until the heap ran out. Inline image samples (`BI … ID <binary> EI`) are where
 * those bytes turn up in practice, and the residual-text scan tokenises every
 * page's content — so a single inline image on a page the user never marked
 * hung the whole redaction.
 */
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import {
  parseContentStream,
  serializeStatements,
  tokenizeContentStream,
  type Token
} from '../../src/core/pdf/interpreter';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));

const bytesOf = (text: string) => Uint8Array.from(text, c => c.charCodeAt(0) & 0xff);
const textOf = (token: Token) => String.fromCharCode(...token.bytes);
const operators = (tokens: Token[]) => tokens.filter(t => t.type === 'operator').map(textOf);

/** Deterministic PRNG (mulberry32), so a failing case can be reproduced. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Concatenates latin-1 text and raw bytes. */
function stream(...parts: (string | Uint8Array)[]): Uint8Array {
  const chunks = parts.map(p => (typeof p === 'string' ? bytesOf(p) : p));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

describe('stray delimiters', () => {
  it('terminates on a lone ), { and }', () => {
    for (const source of [')', '{', '}', 'q ) Q', 'q { } Q', ')))}}}{{{', '1 0 0 1 0 0 cm )']) {
      const tokens = tokenizeContentStream(bytesOf(source));
      expect(tokens.every(t => t.bytes.length > 0)).toBe(true);
    }
  });

  it('keeps { and } as one-byte operators, so a round trip preserves them', () => {
    const statements = parseContentStream(tokenizeContentStream(bytesOf('q { } 0 0 m Q')));
    expect(statements.map(s => textOf(s.operator))).toEqual(['q', '{', '}', 'm', 'Q']);
    const again = parseContentStream(tokenizeContentStream(serializeStatements(statements)));
    expect(again.map(s => textOf(s.operator))).toEqual(['q', '{', '}', 'm', 'Q']);
  });

  it('drops a stray ) but reads everything around it', () => {
    const tokens = tokenizeContentStream(bytesOf('10 20 ) 30 40 re f'));
    expect(tokens.map(textOf)).toEqual(['10', '20', '30', '40', 're', 'f']);
  });
});

describe('inline image data is skipped, not tokenised', () => {
  it('reads the operators after a sample run of ) } {', () => {
    const tokens = tokenizeContentStream(
      stream('q BI /W 1 /H 1 /CS /RGB /BPC 8 ID ', Uint8Array.of(0x29, 0x7d, 0x7b), ' EI Q')
    );
    expect(operators(tokens)).toEqual(['q', 'BI', 'ID', 'EI', 'Q']);
  });

  it('does not read a "(string)" in the samples as a string operand', () => {
    const tokens = tokenizeContentStream(
      stream('BI /W 9 /H 1 /CS /G /BPC 8 ID (SECRET!) EI BT (kept) Tj ET')
    );
    const strings = tokens.filter(t => t.type === 'string').map(textOf);
    expect(strings).toEqual(['(kept)']);
    expect(operators(tokens)).toEqual(['BI', 'ID', 'EI', 'BT', 'Tj', 'ET']);
  });

  it('uses a declared /L when the data itself contains " EI "', () => {
    // Six sample bytes: NUL, space, E, I, space, NUL — an "EI" in the data.
    const data = Uint8Array.of(0x00, 0x20, 0x45, 0x49, 0x20, 0x00);
    const tokens = tokenizeContentStream(
      stream('BI /W 6 /H 1 /CS /G /BPC 8 /L 6 ID ', data, ' EI Q')
    );
    expect(operators(tokens)).toEqual(['BI', 'ID', 'EI', 'Q']);
  });

  it('without /L, passes over an "EI" that is followed by more binary', () => {
    const data = Uint8Array.of(0x01, 0x20, 0x45, 0x49, 0x20, 0x00, 0x9f, 0xff, 0x02, 0x29);
    const tokens = tokenizeContentStream(stream('BI /W 10 /H 1 /CS /G /BPC 8 ID ', data, ' EI Q'));
    expect(operators(tokens)).toEqual(['BI', 'ID', 'EI', 'Q']);
  });

  it('an unterminated image swallows the rest of the stream, not a loop', () => {
    const tokens = tokenizeContentStream(stream('q BI /W 1 /H 1 ID ', Uint8Array.of(0x29, 0x7b)));
    expect(operators(tokens)).toEqual(['q', 'BI', 'ID']);
  });

  it('parseContentStream still refuses a stream with an inline image', () => {
    const tokens = tokenizeContentStream(
      stream('q BI /W 1 /H 1 /CS /G /BPC 8 ID ', Uint8Array.of(0x29), ' EI Q')
    );
    expect(() => parseContentStream(tokens)).toThrow(/inline image/i);
  });

  it('fuzz: random samples full of ( ) { } < > % [ ] terminate quickly', () => {
    const random = rng(0x5eed);
    const hostile = [0x28, 0x29, 0x7b, 0x7d, 0x3c, 0x3e, 0x25, 0x5b, 0x5d, 0x2f, 0x5c, 0x0a];
    const started = Date.now();
    for (let run = 0; run < 2000; run++) {
      const length = 1 + Math.floor(random() * 96);
      const data = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        data[i] =
          random() < 0.5
            ? hostile[Math.floor(random() * hostile.length)]
            : Math.floor(random() * 256);
      }
      // Never an accidental " EI " in the samples, so the expected tail is exact.
      for (let i = 1; i + 1 < length; i++)
        if (data[i] === 0x45 && data[i + 1] === 0x49) data[i] = 0;
      const source = stream(
        'q 10 0 0 10 50 50 cm BI /W ',
        String(length),
        ' /H 1 /CS /G /BPC 8 ID ',
        data,
        ' EI Q BT /F1 12 Tf (after) Tj ET'
      );
      const tokens = tokenizeContentStream(source);
      expect(operators(tokens).slice(-6)).toEqual(['EI', 'Q', 'BT', 'Tf', 'Tj', 'ET']);
    }
    // 2000 streams; the broken tokenizer never finished the first that had a `)`.
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('fuzz: arbitrary bytes anywhere in a stream always terminate', () => {
    const random = rng(42);
    for (let run = 0; run < 2000; run++) {
      const data = new Uint8Array(1 + Math.floor(random() * 200));
      for (let i = 0; i < data.length; i++) data[i] = Math.floor(random() * 256);
      const tokens = tokenizeContentStream(data);
      expect(tokens.every(t => t.bytes.length > 0)).toBe(true);
    }
  });
});

describe('residual-text scan over a page with an inline image', () => {
  async function twoPagePdf(page2: string): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const second = doc.addPage([200, 200]);
    second.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.stream(bytesOf(page2)))
    );
    return doc.save();
  }

  // A 1×1 RGB inline image whose three samples are 0x29 0x7d 0x7b — ")}{" — on
  // page 2, which is not the marked page.
  const INLINE = 'q 10 0 0 10 50 50 cm BI /W 1 /H 1 /CS /RGB /BPC 8 ID \x29\x7d\x7b EI Q';

  it('finishes, and finds nothing that is not there', async () => {
    const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
    const pdf = await twoPagePdf(INLINE);
    const result = await processWorkerImpl.scanResidualText(pdf, ['anything'], [0]);
    expect(result.found).toEqual([]);
    expect(result.undecodableStreams).toBe(0);
  }, 10_000);

  it('still reads the text drawn after the inline image', async () => {
    const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
    const pdf = await twoPagePdf(`${INLINE}\nBT /F1 12 Tf 10 10 Td (LEFTOVERSECRET) Tj ET`);
    const result = await processWorkerImpl.scanResidualText(pdf, ['leftoversecret'], [0]);
    expect(result.found.length).toBeGreaterThan(0);
  }, 10_000);
});

/**
 * PDF-8 — a content stream the parser cannot read is reported for what it is.
 * Only an inline image (`BI … ID … EI`) is "an inline image"; any other
 * parse failure gets its own reason instead of being misdescribed.
 */
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';

const POISON = 'STAPLER-UNREADABLE';

vi.mock('../../src/core/pdf/interpreter', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/pdf/interpreter')>();
  return {
    ...actual,
    tokenizeContentStream: (bytes: Uint8Array) => {
      if (Buffer.from(bytes).toString('latin1').includes(POISON)) {
        throw new RangeError('tokenizer gave up');
      }
      return actual.tokenizeContentStream(bytes);
    }
  };
});

const { planGrayscale } = await import('../../src/core/pdf/grayscale');

async function pageWith(content: string): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  page.node.set(
    PDFName.of('Contents'),
    doc.context.register(doc.context.stream(Buffer.from(content, 'latin1')))
  );
  return PDFDocument.load(await doc.save());
}

describe('grayscale parse failures (PDF-8)', () => {
  it('an inline image is reported as an inline image', async () => {
    const doc = await pageWith(
      '1 0 0 rg q 4 0 0 4 0 0 cm BI /W 1 /H 1 /CS /RGB /BPC 8 ID \xff\x00\x00 EI Q'
    );
    const [plan] = await planGrayscale(doc, [0], 'gray');
    expect(plan.rasterReasons).toEqual(['contains an inline image']);
  });

  it('any other unreadable content is not called an inline image', async () => {
    const doc = await pageWith(`1 0 0 rg 0 0 10 10 re f % ${POISON}`);
    const [plan] = await planGrayscale(doc, [0], 'gray');
    expect(plan.rasterReasons).toEqual(['has drawing instructions Stapler cannot read']);
  });
});

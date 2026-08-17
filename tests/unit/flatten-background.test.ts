import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { processWorkerImpl } from '../../src/core/workers/process.worker';

const ONE_PIXEL_PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL1lwAAAABJRU5ErkJggg=='
  ),
  c => c.charCodeAt(0)
);

describe('OPS-13: flatten background', () => {
  it('never mistakes a full-page scan for a removable background', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const scan = await doc.embedPng(ONE_PIXEL_PNG);
    page.drawImage(scan, { x: 0, y: 0, width: 300, height: 400 });
    const input = await doc.save();

    const output = await processWorkerImpl.flattenBackground(input, 'all', '#ffffff');

    // No qualifying vector fill exists, so the exact source bytes are returned
    // instead of replacing the scan with an opaque white rectangle.
    expect(output).toEqual({ bytes: input, changed: false });
  });
});

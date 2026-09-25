import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { processWorkerImpl } from '../../src/core/workers/process.worker';
import { parseContentStream, tokenizeContentStream } from '../../src/core/pdf/interpreter';

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

/**
 * AUDIT-2026-09-25 PDF-3. Dropping only the `f` left `0 0 612 792 re` as the
 * current path, so the *next* fill painted the whole page in its colour.
 */
describe('OPS-13: flatten background drops the whole path (PDF-3)', () => {
  async function pageWith(content: string): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)));
    return doc.save();
  }

  async function outputContent(bytes: Uint8Array): Promise<string> {
    const doc = await PDFDocument.load(bytes);
    const contents = doc.getPage(0).node.Contents() as PDFRawStream;
    return new TextDecoder('latin1').decode(decodePDFRawStream(contents).decode());
  }

  /** Every path-construction run with the painter that consumes it. */
  function paintedPaths(content: string): string[] {
    const text = (bytes: Uint8Array) => String.fromCharCode(...bytes);
    const statements = parseContentStream(tokenizeContentStream(new TextEncoder().encode(content)));
    const runs: string[] = [];
    let current: string[] = [];
    for (const stmt of statements) {
      const op = text(stmt.operator.bytes);
      const full = [...stmt.operands.map(t => text(t.bytes)), op].join(' ');
      if (['re', 'm', 'l', 'h', 'c', 'v', 'y'].includes(op)) current.push(full);
      else if (['f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'S', 's', 'n'].includes(op)) {
        runs.push([...current, op].join(' '));
        current = [];
      } else if (current.length > 0 && op !== 'W' && op !== 'W*') {
        // Anything else between construction and paint: a dangling path.
        runs.push([...current, '<dangling>'].join(' '));
        current = [];
      }
    }
    if (current.length > 0) runs.push([...current, '<dangling>'].join(' '));
    return runs;
  }

  it('removes the construction run with its painter, so a later fill stays small', async () => {
    const input = await pageWith('1 1 0 rg 0 0 612 792 re f\n0 0 0 rg 100 100 10 10 re f\n');
    const result = await processWorkerImpl.flattenBackground(input, 0, '#ffffff');
    expect(result.changed).toBe(true);

    const content = await outputContent(result.bytes);
    const runs = paintedPaths(content);
    // The injected white page rectangle (inside q…Q), then the small black
    // square — and nothing else. Specifically, no page-sized `re` survives in
    // the original content to be swept up by the later `f`.
    expect(runs).toEqual(['0 0 612 792 re f', '100 100 10 10 re f']);
    expect(content).not.toContain('1 1 0 rg 0 0 612 792 re');
    const originalPart = content.slice(content.indexOf('Q') + 1);
    expect(originalPart).not.toMatch(/612 792 re/);
    expect(originalPart).toContain('0 0 0 rg');
  });

  it('keeps the stroke of a fill-and-stroke background (B → S)', async () => {
    const input = await pageWith('0 0 612 792 re B\n0 0 0 rg 100 100 10 10 re f\n');
    const result = await processWorkerImpl.flattenBackground(input, 0, '#ffffff');
    expect(result.changed).toBe(true);
    const runs = paintedPaths(await outputContent(result.bytes));
    expect(runs).toEqual(['0 0 612 792 re f', '0 0 612 792 re S', '100 100 10 10 re f']);
  });

  it('refuses a page-sized path that is also a clip (W before the painter)', async () => {
    const input = await pageWith('0 0 612 792 re W f\n0 0 0 rg 100 100 10 10 re f\n');
    const result = await processWorkerImpl.flattenBackground(input, 0, '#ffffff');
    expect(result).toEqual({ bytes: input, changed: false });
  });
});

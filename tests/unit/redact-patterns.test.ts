import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { locatePatterns, type PatternCategory, type PatternRun } from '../../src/core/patterns';

// The worker module calls `Comlink.expose` at import time, which needs a real
// message port. Same stub `process.test.ts` uses to import the implementation.
vi.mock('comlink', () => ({ expose: vi.fn(), transfer: vi.fn(value => value) }));
import { processWorkerImpl } from '../../src/core/workers/process.worker';
import { silentJob } from '../../src/core/workers/protocol';

/**
 * RED-05 end to end, against a real fixture rather than a string literal.
 *
 * The scanner in the render worker is `locatePatterns` plus pdf.js; this test
 * supplies the same pdf.js text items the worker would, so what is asserted here
 * is what the panel would offer. The second half proves the other half of the
 * acceptance criterion: a suggestion that is *not* accepted survives the export
 * untouched, because only accepted regions are ever handed to `applyRedactions`.
 */
type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let cached: PdfjsModule | undefined;
async function pdfjs(): Promise<PdfjsModule> {
  cached ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  return cached;
}

const EMAIL = 'jane.doe@example.com';
const PHONE = '(555) 010-9999';
const SSN = '123-45-6789';
const CARD = '4111 1111 1111 1111';
const IPV4 = '192.168.10.42';
const IPV6 = '2001:0db8:85a3:0000:0000:8a2e:0370:7334';

/**
 * One instance of each pattern, plus prose that must produce no suggestions.
 *
 * Each sensitive value gets its own line so the "accept one, leave the rest"
 * test below has an unambiguous declined value to check per pattern kind; the
 * last test in this file covers same-line, same-run precision directly.
 */
const LINES = [
  'Case notes, revision 3.14.15, filed 2024-11-03 at 12:00:00.',
  `Reach the claimant at ${EMAIL} for correspondence.`,
  `Daytime telephone ${PHONE} rings the front desk.`,
  `Social Security Number ${SSN} is held on file.`,
  `Corporate card ${CARD} paid the filing fee.`,
  `Host ${IPV4} logged the session.`,
  `Address ${IPV6} answered the probe.`,
  'Reference 000-00-0000 is the placeholder row for lot 5551234.'
];

async function pdfOf(lines: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 300]);
  lines.forEach((line, index) => {
    page.drawText(line, { x: 40, y: 260 - index * 24, size: 9, font });
  });
  return doc.save();
}

const fixture = () => pdfOf(LINES);

/** The text items the render worker feeds `locatePatterns`. */
async function runsOf(bytes: Uint8Array): Promise<{ runs: PatternRun[]; w: number; h: number }> {
  const lib = await pdfjs();
  const pdf = await lib.getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const runs = content.items.filter((item): item is PatternRun & { str: string } => 'str' in item);
  return { runs, w: viewport.width, h: viewport.height };
}

async function textOf(bytes: Uint8Array): Promise<string> {
  const lib = await pdfjs();
  const pdf = await lib.getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
  let out = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    out += content.items.map(item => ('str' in item ? item.str : '')).join('');
  }
  return out;
}

describe('RED-05 scanning a fixture', () => {
  it('surfaces exactly one of each pattern and nothing from the prose', async () => {
    const { runs, w, h } = await runsOf(await fixture());
    const found = locatePatterns(runs, w, h);

    expect(found.map(item => [item.category, item.text] as [PatternCategory, string])).toEqual([
      ['email', EMAIL],
      ['phone', PHONE],
      ['ssn', SSN],
      ['credit-card', CARD],
      ['ip', IPV4],
      ['ip', IPV6]
    ]);

    // Every suggestion has a rectangle inside the page, or it could not be
    // reviewed, accepted, or verified.
    for (const item of found) {
      expect(item.boxes.length).toBeGreaterThan(0);
      for (const box of item.boxes) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(1.001);
        expect(box.width).toBeGreaterThan(0);
        expect(box.height).toBeGreaterThan(0);
      }
    }
  });

  it('removes an accepted suggestion and leaves a declined one intact in the export', async () => {
    const bytes = await fixture();
    const { runs, w, h } = await runsOf(bytes);
    const found = locatePatterns(runs, w, h);

    // Accept the SSN only. Everything else is declined, so nothing else is ever
    // handed to the redaction pipeline.
    const accepted = found.filter(item => item.category === 'ssn');
    const regions = accepted.flatMap(item =>
      item.boxes.map(box => ({
        pageIndex: 0,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        text: box.text
      }))
    );
    expect(regions.length).toBeGreaterThan(0);

    const output = await processWorkerImpl.applyRedactions(bytes, regions, silentJob);
    const text = await textOf(output);

    expect(text).not.toContain(SSN);
    for (const declined of [EMAIL, PHONE, CARD, IPV4, IPV6]) {
      expect(text.replace(/\s+/g, ' ')).toContain(declined);
    }
  });

  it('removes only the marked value from a shared run, leaving the rest of the line', async () => {
    // RED-02 granularity: redaction now operates on the glyphs a mark actually
    // covers, not the whole show-text operator it intersects — so a declined
    // value typeset in the *same* run/line as an accepted one survives.
    const bytes = await pdfOf([`SSN ${SSN} and card ${CARD} on one line.`]);
    const { runs, w, h } = await runsOf(bytes);
    const ssn = locatePatterns(runs, w, h).filter(item => item.category === 'ssn');

    const output = await processWorkerImpl.applyRedactions(
      bytes,
      ssn.flatMap(item => item.boxes.map(box => ({ pageIndex: 0, ...box }))),
      silentJob
    );
    const text = await textOf(output);
    expect(text).not.toContain(SSN);
    expect(text.replace(/\s+/g, ' ')).toContain(CARD);
  });
});

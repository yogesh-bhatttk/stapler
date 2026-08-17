/**
 * SGN-02 — signature-line detection against a *drawn* rule.
 *
 * The detector used to match text runs only, so it saw `______________` and missed
 * the way real forms are actually built: a stroked line or a hairline filled
 * rectangle with a small "Signature" / "Date" caption under it. These tests build
 * exactly that with pdf-lib, run pdf.js's real operator list over it, and grade the
 * pure geometry functions the worker uses.
 *
 * pdf.js's legacy build runs in Node; the worker module's own pdf.js setup (which
 * needs `self.location` and an OffscreenCanvas) is mocked out so the module can be
 * imported at all.
 */
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));

vi.mock('../../src/core/workers/pdfjs-setup', async () => {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return { pdfjsLib, openDocument: () => ({ promise: Promise.reject(new Error('unused')) }) };
});

const { horizontalRulesFromOps, signatureRulesToRegions, overlapsRegion } =
  await import('../../src/core/workers/render.worker');
type PathOpCodes = import('../../src/core/workers/render.worker').PathOpCodes;

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

/**
 * One page carrying, top to bottom:
 *  • a stroked signature rule with a "Signature" caption beneath it,
 *  • a 0.8pt filled rectangle acting as a rule, captioned "Date",
 *  • a full-width table border with no caption anywhere near it,
 *  • a short 20pt tick, captioned "Signature" — too short to sign on.
 */
async function buildForm() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

  page.drawLine({
    start: { x: 72, y: 600 },
    end: { x: 330, y: 600 },
    thickness: 1,
    color: rgb(0, 0, 0)
  });
  page.drawText('Signature', { x: 72, y: 585, size: 9, font });

  page.drawRectangle({ x: 380, y: 600, width: 150, height: 0.8, color: rgb(0, 0, 0) });
  page.drawText('Date', { x: 380, y: 585, size: 9, font });

  // A table border: long and thin, but nothing to sign.
  page.drawLine({
    start: { x: 40, y: 300 },
    end: { x: 572, y: 300 },
    thickness: 0.5,
    color: rgb(0, 0, 0)
  });
  page.drawText('Line items and quantities', { x: 40, y: 285, size: 9, font });

  // Too short to be a signature line even though it is captioned.
  page.drawLine({
    start: { x: 72, y: 150 },
    end: { x: 92, y: 150 },
    thickness: 1,
    color: rgb(0, 0, 0)
  });
  page.drawText('Signature', { x: 72, y: 135, size: 9, font });

  return doc.save();
}

async function analyse(bytes: Uint8Array) {
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const opList = await page.getOperatorList();
  const content = await page.getTextContent();
  const runs = (content.items as { str?: string }[]).filter(
    (item): item is { str: string; width: number; height: number; transform: number[] } =>
      typeof item.str === 'string'
  );
  const rules = horizontalRulesFromOps(
    Array.from(opList.fnArray),
    opList.argsArray,
    pdfjs.OPS as unknown as PathOpCodes
  );
  return { rules, runs, viewport };
}

describe('SGN-02: vector-drawn signature lines', () => {
  it('finds a stroked rule and a hairline filled rectangle as rules', async () => {
    const { rules } = await analyse(await buildForm());

    // The stroked signature rule, the filled "Date" rule, and the table border.
    // The 20pt tick is below the minimum length and is not a rule.
    expect(rules.length).toBe(3);

    const signatureRule = rules.find(r => Math.abs(r.x - 72) < 2 && Math.abs(r.y - 600) < 2);
    expect(signatureRule).toBeDefined();
    // 258pt long, ~1pt thick — the stroke's own line width, not a zero-height box.
    expect(signatureRule!.width).toBeGreaterThan(255);
    expect(signatureRule!.height).toBeLessThanOrEqual(3);

    const dateRule = rules.find(r => Math.abs(r.x - 380) < 2);
    expect(dateRule).toBeDefined();
    expect(dateRule!.width).toBeCloseTo(150, 0);
    expect(dateRule!.height).toBeCloseTo(0.8, 1);
  }, 30000);

  it('offers only the captioned rules, on the rule and above it', async () => {
    const { rules, runs, viewport } = await analyse(await buildForm());
    const regions = signatureRulesToRegions(rules, runs, viewport, 0);

    expect(regions.map(r => r.text).sort()).toEqual(['Date', 'Signature']);

    const signature = regions.find(r => r.text === 'Signature')!;
    // Left edge and width follow the drawn rule.
    expect(signature.x * viewport.width).toBeCloseTo(71.5, 0);
    expect(signature.width * viewport.width).toBeCloseTo(259, 0);
    // The box sits above the rule: in top-left coordinates, its bottom edge is the
    // rule's own top edge (792 - 600 = 192 from the top).
    const bottom = (signature.y + signature.height) * viewport.height;
    // 191.5, not 192: the stroke's 1pt width straddles the path, so the painted
    // top edge is half a point above y=600.
    expect(bottom).toBeCloseTo(191.5, 1);
    expect(signature.height * viewport.height).toBeGreaterThanOrEqual(24);
  }, 30000);

  it('does not offer an uncaptioned table border', async () => {
    const { rules, runs, viewport } = await analyse(await buildForm());
    const regions = signatureRulesToRegions(rules, runs, viewport, 0);
    // The table rule at y=300 has only "Line items and quantities" under it.
    expect(regions.some(r => Math.abs((1 - r.y - r.height) * viewport.height - 300) < 5)).toBe(
      false
    );
  }, 30000);

  it('ignores a rotated (vertical) rule', () => {
    // A 200pt rule drawn down the page: long and thin in path space, but the CTM
    // turns it on its side, and nobody signs on a vertical line.
    const ops = pdfjs.OPS as unknown as PathOpCodes;
    const fnArray = [ops.save, ops.transform, ops.constructPath, ops.restore];
    const argsArray = [null, [0, 1, -1, 0, 0, 0], [ops.fill, [[]], [0, 0, 200, 0.8]], null];
    const rules = horizontalRulesFromOps(fnArray, argsArray, ops);
    // Under the rotation the painted box is 0.8 wide and 200 tall — not a rule.
    expect(rules).toEqual([]);
  });

  it('overlapsRegion suppresses a duplicate suggestion at the same spot', () => {
    const a = { pageIndex: 0, x: 0.1, y: 0.2, width: 0.4, height: 0.04, text: 'Signature' };
    const b = { pageIndex: 0, x: 0.11, y: 0.205, width: 0.4, height: 0.04, text: 'Signature' };
    const far = { pageIndex: 0, x: 0.6, y: 0.8, width: 0.3, height: 0.04, text: 'Date' };
    expect(overlapsRegion(a, b)).toBe(true);
    expect(overlapsRegion(a, far)).toBe(false);
  });
});

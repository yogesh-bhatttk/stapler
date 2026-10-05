import { PDFDocument } from 'pdf-lib';
import { readFileSync, statSync } from 'node:fs';
import { unzipSync } from 'fflate';
import type { Page } from '@playwright/test';
import { ensureFixture, textPdf } from '../fixtures';
import { commitAndRead, dismissToasts, gotoTool } from '../helpers';
import { drawnText } from '../pdf-bytes';
import { expect, expectClean, test } from './extension-fixtures';

/**
 * HRD-54 / AUDIT-2026-09-25 M4, M8 — the per-tool flows, run against the real
 * packaged extension (`dist/ext` under its MV3 CSP, no test hooks), not just
 * the web preview. Each flow is the same user path as its `tool-flows.spec.ts`
 * twin and is judged on the exported bytes; each also fails on any network
 * request, CSP violation or page error (`expectClean`).
 *
 * Merge is covered in `extension.spec.ts`; HEIC import (HRD-51) is here.
 */

/** Imports through the real file input; images pause on the options dialog first. */
async function importInto(editor: Page, file: string) {
  await editor.locator('input[type="file"]').first().setInputFiles(file);
  const options = editor.getByRole('dialog', { name: /Import \d+ image/ });
  const grid = editor.getByRole('listbox', { name: /Pages of/ });
  await expect(options.or(grid)).toBeVisible({ timeout: 30_000 });
  if (await options.isVisible()) {
    await options.getByRole('button', { name: 'Import', exact: true }).click();
  }
  await expect(grid).toBeVisible({ timeout: 60_000 });
  return grid;
}

/** RGB at fractional positions of the first thumbnail, once it has painted. */
async function thumbnailPixels(editor: Page, points: [number, number][]) {
  await editor.waitForFunction(
    () => {
      const canvas = document.querySelector<HTMLCanvasElement>('[role="option"] canvas');
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx || canvas.width < 2 || canvas.height < 2) return false;
      return ctx.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data[3] > 0;
    },
    undefined,
    { timeout: 60_000 }
  );
  return editor.evaluate(points => {
    const canvas = document.querySelector<HTMLCanvasElement>('[role="option"] canvas')!;
    const ctx = canvas.getContext('2d')!;
    return points.map(([fx, fy]) => {
      const x = Math.min(canvas.width - 1, Math.round(fx * canvas.width));
      const y = Math.min(canvas.height - 1, Math.round(fy * canvas.height));
      const d = ctx.getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2]];
    });
  }, points);
}

test.describe('HRD-51 — HEIC in the packaged extension', () => {
  test('photo-rotated.heic imports upright: 400×300 page, red top-left, blue bottom-right', async ({
    editor,
    diagnostics
  }) => {
    test.setTimeout(120_000);
    await importInto(editor, 'tests/fixtures/photo-rotated.heic');

    // Stored as 300×400 with an orientation transform; upright it is 400×300.
    const [topLeft, bottomRight] = await thumbnailPixels(editor, [
      [0.05, 0.05],
      [0.95, 0.95]
    ]);
    expect(topLeft[0], 'red top-left').toBeGreaterThan(150);
    expect(topLeft[0] - topLeft[2]).toBeGreaterThan(50);
    expect(bottomRight[2], 'blue bottom-right').toBeGreaterThan(150);
    expect(bottomRight[2] - bottomRight[0]).toBeGreaterThan(50);

    const bytes = await commitAndRead(editor, /View changes/i);
    const output = await PDFDocument.load(bytes);
    expect(output.getPageCount()).toBe(1);
    const { width, height } = output.getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([400, 300]);
    await expectClean(editor, diagnostics);
  });

  test('sample.heic imports as a landscape page at its own size', async ({
    editor,
    diagnostics
  }) => {
    test.setTimeout(120_000);
    await importInto(editor, 'tests/fixtures/sample.heic');
    const bytes = await commitAndRead(editor, /View changes/i);
    const { width, height } = (await PDFDocument.load(bytes)).getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([1440, 960]);
    await expectClean(editor, diagnostics);
  });
});

test.describe('HRD-54 — tool flows in the packaged extension', () => {
  test('split: extracting pages 2–3 gives exactly those pages', async ({ editor, diagnostics }) => {
    const file = await ensureFixture('text-10.pdf', () => textPdf(10));
    const grid = await importInto(editor, file);
    await gotoTool(editor, 'split');

    await grid.getByRole('option', { name: /^Page 2 of/ }).click();
    await grid.getByRole('option', { name: /^Page 3 of/ }).click({ modifiers: ['Shift'] });
    await expect(editor.getByText('2 selected').first()).toBeVisible();

    const bytes = await commitAndRead(editor, 'Split / extract');
    const output = await PDFDocument.load(bytes);
    expect(output.getPageCount()).toBe(2);
    expect(await drawnText(bytes)).toContain('Line 1 of body text on page 2.');
    await expectClean(editor, diagnostics);
  });

  test('compress: the raster path shrinks a scan and keeps its pages', async ({
    editor,
    diagnostics
  }) => {
    test.setTimeout(180_000);
    const scan = 'tests/fixtures/scanned_skewed.pdf';
    await importInto(editor, scan);
    await gotoTool(editor, 'compress');

    await editor.getByRole('button', { name: /Analyse without changing/ }).click();
    await expect(editor.getByText(/Re-rendered as images/i)).toBeVisible({ timeout: 90_000 });
    const bytes = await commitAndRead(editor, 'Compress & export');

    const before = await PDFDocument.load(readFileSync(scan));
    const after = await PDFDocument.load(bytes);
    expect(after.getPageCount()).toBe(before.getPageCount());
    // CMP-02's band, as on the web preview.
    const reduction = 1 - bytes.length / statSync(scan).size;
    expect(reduction).toBeGreaterThan(0.7);
    expect(reduction).toBeLessThan(0.9);
    await expectClean(editor, diagnostics);
  });

  test('redact: a verified redaction removes the text from the bytes', async ({
    editor,
    diagnostics
  }) => {
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await importInto(editor, file);
    await gotoTool(editor, 'redact');

    await editor.getByLabel('Find and mark text').fill('Line 1 of body text on page 1.');
    await editor.getByRole('button', { name: 'Mark every occurrence' }).click();
    await expect(editor.getByText('Marks (1)')).toBeVisible();
    await editor.getByRole('button', { name: 'Verify & apply' }).click();
    await expect(editor.getByText('Redaction verified and applied')).toBeVisible({
      timeout: 60_000
    });
    await dismissToasts(editor);

    await gotoTool(editor, 'organize');
    const bytes = await commitAndRead(editor, 'View changes');
    const text = await drawnText(bytes);
    expect(text).not.toContain('Line 1 of body text on page 1.');
    expect(text).toContain('Line 2 of body text on page 1.');
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(6);
    await expectClean(editor, diagnostics);
  });

  test('sign: a text stamp is drawn into the exported page', async ({ editor, diagnostics }) => {
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await importInto(editor, file);
    await gotoTool(editor, 'sign');

    await editor.getByRole('button', { name: 'Text', exact: true }).click();
    await editor.getByRole('group', { name: /Stamp placement area/ }).focus();
    await editor.keyboard.press('Enter');
    await editor.getByLabel('Stamp text').fill('Signed in the extension');

    const bytes = await commitAndRead(editor, 'Export signed PDF');
    expect(await drawnText(bytes)).toContain('Signed in the extension');
    await expectClean(editor, diagnostics);
  });

  test('watermark: the stamp text is drawn on the exported page', async ({
    editor,
    diagnostics
  }) => {
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await importInto(editor, file);
    await gotoTool(editor, 'watermark');

    await editor.getByRole('textbox', { name: 'Text', exact: true }).fill('EXTENSION DRAFT');
    await editor.getByLabel('Position').selectOption('bottom-center');

    const bytes = await commitAndRead(editor, /View changes/i);
    expect(await drawnText(bytes)).toContain('EXTENSION DRAFT');
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(6);
    await expectClean(editor, diagnostics);
  });

  test('pdf to images: a ZIP of one PNG per page', async ({ editor, diagnostics }) => {
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await importInto(editor, file);
    await gotoTool(editor, 'pdf-to-img');

    await editor.getByRole('radio', { name: 'PNG' }).check();
    const zip = unzipSync(await commitAndRead(editor, 'Export images'));
    const names = Object.keys(zip).sort();
    expect(names).toHaveLength(6);
    for (const name of names) {
      expect(name).toMatch(/\.png$/);
      // \x89PNG — real PNG data, rendered by pdf.js in the render worker.
      expect(Array.from(zip[name].subarray(0, 4)), name).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(zip[name].byteLength, name).toBeGreaterThan(1000);
    }
    await expectClean(editor, diagnostics);
  });

  test('image to size: a HEIC photo comes out as a JPEG at or under 20 KB', async ({
    editor,
    diagnostics
  }) => {
    test.setTimeout(120_000);
    await gotoTool(editor, 'image-to-size');
    await editor.getByRole('checkbox', { name: 'Aim for a file size' }).check();
    await editor.getByRole('button', { name: '20 KB', exact: true }).click();
    await expect(editor.locator('[data-image-target-amount]')).toHaveValue('20');

    const chooser = editor.waitForEvent('filechooser');
    await editor.getByRole('button', { name: 'Choose an image' }).click();
    await (await chooser).setFiles('tests/fixtures/sample.heic');
    await expect(editor.locator('[data-image-size-file="sample.heic"]')).toBeVisible({
      timeout: 60_000
    });

    const download = editor.waitForEvent('download', { timeout: 60_000 });
    await editor.getByRole('button', { name: 'Resize & save' }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe('sample-20kb.jpg');
    const bytes = new Uint8Array(readFileSync((await saved.path())!));
    expect(bytes.byteLength).toBeLessThanOrEqual(20_000);
    expect(Array.from(bytes.subarray(0, 3))).toEqual([0xff, 0xd8, 0xff]);
    await expect(editor.locator('[data-image-size-outcome]')).toHaveAttribute(
      'data-image-size-bytes',
      String(bytes.byteLength)
    );
    await expectClean(editor, diagnostics);
  });
});

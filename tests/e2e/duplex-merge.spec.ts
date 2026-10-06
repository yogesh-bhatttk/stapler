import { expect, test, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { confirmExportReviewIfShown, gotoTool, openApp } from './helpers';

/**
 * OPS-20 AC — "5 odd + 5 even pages (even reversed) produce pages 1–10 in
 * order, verified by text on each output page".
 *
 * The real duplex case: two files, as two single-sided passes of a sheet
 * feeder produce them. The fronts scan holds pages 1, 3, 5, 7, 9; the backs
 * scan, fed the stack upside down, holds 10, 8, 6, 4, 2. Both go into Merge,
 * get interleaved, and the saved file's text is read back page by page with
 * pdf.js — the order a reader would see, not the order of the page list.
 */

async function scan(pageNumbers: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const n of pageNumbers) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Duplex page ${n} of 10`, { x: 50, y: 780, size: 20, font });
  }
  return doc.save();
}

/** Each page's text, as pdf.js extracts it from the saved bytes. */
async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const texts: string[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      texts.push(
        content.items
          .map(item => ('str' in item ? item.str : ''))
          .join('')
          .trim()
      );
    }
  } finally {
    await task.destroy();
  }
  return texts;
}

async function addToMerge(page: Page, file: string, pagesAfter: number) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add PDFs or images' }).click();
  await (await chooser).setFiles(file);
  await expect(page.getByRole('listbox', { name: /Pages of/ }).getByRole('option')).toHaveCount(
    pagesAfter,
    { timeout: 30_000 }
  );
}

test('OPS-20: fronts and reversed backs merged and interleaved save in reading order', async ({
  page
}, info) => {
  const fronts = info.outputPath('fronts.pdf');
  const backs = info.outputPath('backs.pdf');
  writeFileSync(fronts, await scan([1, 3, 5, 7, 9]));
  writeFileSync(backs, await scan([10, 8, 6, 4, 2]));

  await openApp(page);
  await gotoTool(page, 'merge');
  await addToMerge(page, fronts, 5);
  await addToMerge(page, backs, 10);

  // Two files, five pages each: the split point is suggested from the files.
  await expect(page.getByLabel('Number of front pages')).toHaveValue('5');
  await expect(page.getByRole('checkbox', { name: /Backs are in reverse order/ })).toBeChecked();
  await page.getByRole('button', { name: 'Interleave pages' }).click();
  await expect(page.getByText('Pages interleaved.')).toBeVisible();

  const download = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: /View changes/ }).click();
  await confirmExportReviewIfShown(page, download);
  const bytes = new Uint8Array(readFileSync((await (await download).path())!));

  expect(await pageTexts(bytes)).toEqual(
    Array.from({ length: 10 }, (_, i) => `Duplex page ${i + 1} of 10`)
  );
});

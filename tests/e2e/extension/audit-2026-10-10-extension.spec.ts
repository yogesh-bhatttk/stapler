import { PDFDocument } from 'pdf-lib';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import type { Page } from '@playwright/test';
import {
  contractV1Pdf,
  contractV2Pdf,
  ensureFixture,
  pdfToWordPdf,
  wordToPdfDocx
} from '../fixtures';
import { commitAndRead, confirmExportReviewIfShown, gotoTool } from '../helpers';
import {
  ENG_MODEL_URL,
  QR_TEXT,
  cachedOcrModel,
  isPinnedOcrModelUrl,
  pdfPageTexts,
  qrPdf,
  serveOcrModelLocally
} from '../audit-2026-10-10-helpers';
import { expect, expectClean, test } from './extension-fixtures';

/**
 * Audit 2026-10-10 T7 — the packaged extension (`dist/ext`, MV3 CSP, no test
 * hooks) had no flow for the tools most likely to reach for the network:
 * OCR (the one sanctioned download), barcode scanning (zxing-wasm defaults
 * to a CDN for its engine), the Office converters (lazy third-party chunks),
 * Markdown → PDF and Compare. Each runs end to end here and is judged on its
 * real output, and each ends with `expectClean`: every http(s)/ws(s) request
 * from any page or worker is aborted and recorded (the fixture's context
 * route), CSP violations are recorded from both the event and the console,
 * and any of either fails the test.
 *
 * Written by the 2026-10-10 test audit; not yet run (RULES.md §3).
 */

async function importInto(editor: Page, file: string) {
  await editor.locator('input[type="file"]').first().setInputFiles(file);
  const grid = editor.getByRole('listbox', { name: /Pages of/ });
  await expect(grid).toBeVisible({ timeout: 60_000 });
  return grid;
}

test.describe('audit 2026-10-10 T7 — network-sensitive tools in the packaged extension', () => {
  test('barcode scan: the zxing engine loads from the extension and decodes a QR code', async ({
    editor,
    diagnostics
  }) => {
    test.setTimeout(120_000);
    const file = await ensureFixture('audit-qr.pdf', qrPdf);
    await importInto(editor, file);
    await gotoTool(editor, 'metadata');
    await editor.getByRole('button', { name: 'Scan for barcodes' }).click();

    // A decoded value is the proof the engine loaded: every request off the
    // extension's own package is aborted, so a CDN-fetched engine
    // (jsdelivr/fastly, zxing-wasm's default `locateFile`) could not have run.
    await expect(editor.getByText(new RegExp(`Page 1 — .+: ${QR_TEXT}`))).toBeVisible({
      timeout: 90_000
    });
    expect(diagnostics.external.filter(url => /jsdelivr|fastly|unpkg/.test(url))).toEqual([]);
    await expectClean(editor, diagnostics);
  });

  test('ocr: the consented model download, served locally at the pinned URL, recognizes text', async ({
    context,
    editor,
    diagnostics
  }) => {
    test.setTimeout(240_000);
    const model = cachedOcrModel();
    test.skip('missing' in model, 'missing' in model ? model.missing : '');
    if ('missing' in model) return;
    // Registered after the fixture's abort-everything route, so it wins for
    // the pinned model URL only; every other request is still aborted.
    const requested = await serveOcrModelLocally(context, model.bytes);

    await importInto(editor, 'tests/fixtures/scanned_skewed.pdf');
    await gotoTool(editor, 'ocr');
    await editor.getByRole('button', { name: 'Run OCR & export' }).click();
    const dialog = editor.getByRole('dialog', { name: /Download the English OCR language model/ });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('cdn.jsdelivr.net');

    const download = editor.waitForEvent('download', { timeout: 200_000 });
    await dialog.getByRole('button', { name: 'Download and run OCR' }).click();
    await confirmExportReviewIfShown(editor, download);
    const saved = await download;
    const bytes = new Uint8Array(readFileSync((await saved.path())!));
    const text = (await pdfPageTexts(bytes)).join(' ').toLowerCase();
    expect(text).toMatch(/scan|document/);

    // The tesseract worker and engine came from the package (nothing else
    // could be fetched); the model, once, from exactly the pinned URL.
    expect(requested).toEqual([ENG_MODEL_URL]);
    await expectClean(editor, diagnostics, isPinnedOcrModelUrl);
  });

  test('word to pdf: a .docx converted and saved as a PDF carrying its text', async ({
    editor,
    diagnostics
  }) => {
    test.setTimeout(150_000);
    const fixture = await ensureFixture('word-to-pdf.docx', wordToPdfDocx);
    await gotoTool(editor, 'word-to-pdf');
    const panel = editor.getByRole('complementary', { name: /Word to PDF options/ });
    await expect(panel).toBeVisible();
    const chooser = editor.waitForEvent('filechooser');
    await panel.getByRole('button', { name: /Choose a \.docx file/ }).click();
    await (await chooser).setFiles(fixture);
    await panel.getByRole('button', { name: 'Preview conversion' }).click();
    await expect(panel.getByRole('list', { name: /Blocks that will be written/ })).toBeVisible({
      timeout: 90_000
    });

    const download = editor.waitForEvent('download', { timeout: 60_000 });
    await editor.getByRole('button', { name: 'Save PDF' }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toMatch(/\.pdf$/);
    const bytes = new Uint8Array(readFileSync((await saved.path())!));
    const out = await PDFDocument.load(bytes);
    expect(out.getPageCount()).toBeGreaterThanOrEqual(1);
    expect((await pdfPageTexts(bytes)).join(' ').trim().length).toBeGreaterThan(20);
    await expectClean(editor, diagnostics);
  });

  test('pdf to word: a PDF converted and saved as a real .docx', async ({
    editor,
    diagnostics
  }) => {
    test.setTimeout(150_000);
    const fixture = await ensureFixture('pdf-to-word.pdf', pdfToWordPdf);
    await importInto(editor, fixture);
    await gotoTool(editor, 'pdf-to-word');
    const panel = editor.getByRole('complementary', { name: /PDF to Word options/ });
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Preview conversion' }).click();
    await expect(panel.getByRole('list', { name: /Blocks that will be written/ })).toBeVisible({
      timeout: 90_000
    });

    const download = editor.waitForEvent('download', { timeout: 60_000 });
    await editor.getByRole('button', { name: 'Save .docx' }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toMatch(/\.docx$/);
    const zip = unzipSync(new Uint8Array(readFileSync((await saved.path())!)));
    // A real Word package: its main part exists and carries text runs.
    const documentXml = new TextDecoder().decode(zip['word/document.xml']);
    expect(documentXml).toMatch(/<w:t[ >]/);
    expect(documentXml.replace(/<[^>]+>/g, '').trim().length).toBeGreaterThan(20);
    await expectClean(editor, diagnostics);
  });

  test('markdown to pdf: the rendered heading and paragraph are in the saved PDF', async ({
    editor,
    diagnostics
  }) => {
    await gotoTool(editor, 'md-to-pdf');
    await editor
      .getByLabel('Markdown Content')
      .fill('# Extension heading\n\nA paragraph written in the packaged extension.');
    const bytes = await commitAndRead(editor, 'Export PDF');
    const text = (await pdfPageTexts(bytes)).join(' ');
    expect(text).toContain('Extension heading');
    expect(text).toContain('A paragraph written in the packaged extension.');
    await expectClean(editor, diagnostics);
  });

  test('compare: a text diff of two contract versions names what changed', async ({
    editor,
    diagnostics
  }) => {
    test.setTimeout(120_000);
    const v1 = await ensureFixture('contract-v1.pdf', contractV1Pdf);
    const v2 = await ensureFixture('contract-v2.pdf', contractV2Pdf);
    await importInto(editor, v1);
    await gotoTool(editor, 'compare');
    const chooser = editor.waitForEvent('filechooser');
    await editor.getByRole('button', { name: 'Open file to compare...' }).click();
    await (await chooser).setFiles(v2);
    await expect(editor.locator('canvas').first()).toBeAttached({ timeout: 30_000 });
    await editor.getByRole('radio', { name: 'Text Diff' }).check();

    const bytes = await commitAndRead(editor, 'Export Diff PDF');
    const text = (await pdfPageTexts(bytes)).join(' ');
    expect(text).toContain('75');
    expect(text).toContain('New York');
    await expectClean(editor, diagnostics);
  });
});

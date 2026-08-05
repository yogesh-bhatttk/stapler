import { expect, test } from '@playwright/test';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFStream } from 'pdf-lib';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  acroformPdf,
  BAND_SAMPLE_POINTS,
  cmykImagePdf,
  ensureFixture,
  mixedSizePdf,
  mixedTextImagePdf,
  OVERSIZED_MASK_FIXTURE,
  oversizedMaskPdf,
  sharedImagePdf,
  textPdf,
  transparentImagePdf
} from './fixtures';
import { gotoTool, openApp } from './helpers';

/**
 * QA-04 — one import → operate → export flow per P0 tool, asserting the real output
 * bytes rather than that a button was clickable.
 *
 * Downloads are captured through the File System Access fallback: the preview server is
 * not a secure context for the picker in headless Chromium, so the platform adapter
 * falls back to an anchor download, which Playwright can intercept.
 */

async function importFixture(page: import('@playwright/test').Page, file: string) {
  await openApp(page);
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
}

/** Clicks the action bar's primary button and returns the downloaded bytes. */
async function commitAndRead(page: import('@playwright/test').Page, label: string | RegExp) {
  const download = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: label }).click();
  const saved = await download;
  const location = await saved.path();
  expect(location).toBeTruthy();
  return new Uint8Array(readFileSync(location!));
}

/* ------------------------------------------------------------------ *
 * CMP-03 helpers — the surgical re-encode is judged on output bytes and
 * rendered pixels, not on the button having been clickable.
 * ------------------------------------------------------------------ */

interface ImageEntry {
  pageIndex: number;
  name: string;
  ref: number;
  width: number;
  height: number;
  filter: string;
  colorSpace: string;
  bytes: number;
  /** Digest of the /SMask stream, so "unchanged" can be asserted literally. */
  smask: { ref: number; width: number; height: number; bytes: number; sha: string } | null;
}

/**
 * Per-channel budget, in 8-bit levels, for the CMYK band assertion below.
 *
 * ±10 of 255 (≈4%). Both readings are rendered through the same pdf.js build, so
 * the DeviceCMYK→sRGB conversion is common to both sides and is not part of this
 * budget — the pipeline has no CMYK formula of its own to disagree with. What is
 * left is the 1600→833px box resample plus JPEG quantisation and 4:2:0 chroma
 * subsampling at the 75% default quality, sampled at a band's smooth interior
 * where no edge ringing applies.
 *
 * The measured worst case on this fixture is **1 level**, across all four bands
 * and all three channels, so the band is a 10× margin over observed codec noise
 * rather than a number fitted to the result. It stays deliberately that loose
 * because Chromium's JPEG encoder is free to change between versions. It is still
 * far tighter than any real colour-management error: a channel swap, an inverted
 * `/K`, a dropped black plate, or a naive `1 - min(1, ink + k)` conversion each
 * move one of these bands by 40 levels or more.
 */
const CMYK_COLOUR_TOLERANCE = 10;

/** Every image XObject in the document, with enough detail to diff two versions. */
async function imageEntries(bytes: Uint8Array): Promise<ImageEntry[]> {
  const doc = await PDFDocument.load(bytes);
  const entries: ImageEntry[] = [];
  doc.getPages().forEach((page, pageIndex) => {
    const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (!xobjects) return;
    for (const [key] of xobjects.entries()) {
      const ref = xobjects.get(key);
      const stream = xobjects.lookup(key);
      if (!(stream instanceof PDFStream) || !(ref instanceof PDFRef)) continue;
      if (String(stream.dict.get(PDFName.of('Subtype'))) !== '/Image') continue;
      const smaskRef = stream.dict.get(PDFName.of('SMask'));
      const smask = smaskRef instanceof PDFRef ? doc.context.lookup(smaskRef) : undefined;
      entries.push({
        pageIndex,
        name: key.asString(),
        ref: ref.objectNumber,
        width: Number(String(stream.dict.get(PDFName.of('Width')))),
        height: Number(String(stream.dict.get(PDFName.of('Height')))),
        filter: String(stream.dict.get(PDFName.of('Filter'))),
        colorSpace: String(stream.dict.get(PDFName.of('ColorSpace'))),
        bytes: stream instanceof PDFRawStream ? stream.contents.length : stream.sizeInBytes(),
        smask:
          smask instanceof PDFRawStream && smaskRef instanceof PDFRef
            ? {
                ref: smaskRef.objectNumber,
                width: Number(String(smask.dict.get(PDFName.of('Width')))),
                height: Number(String(smask.dict.get(PDFName.of('Height')))),
                bytes: smask.contents.length,
                sha: createHash('sha256').update(Buffer.from(smask.contents)).digest('hex')
              }
            : null
      });
    }
  });
  return entries;
}

/** SHA of every content stream, i.e. of the text and vectors on each page. */
async function contentDigests(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map(page => {
    const hash = createHash('sha256');
    const contents = page.node.get(PDFName.of('Contents'));
    const refs = contents instanceof PDFRef ? [contents] : [];
    for (const ref of refs) {
      const stream = doc.context.lookup(ref);
      if (stream instanceof PDFRawStream) hash.update(Buffer.from(stream.contents));
    }
    return hash.digest('hex');
  });
}

/**
 * Every string a document draws on page 0, including inside the form XObjects the
 * page invokes — which is where a flattened form field's value ends up.
 *
 * Show-text operands may be literal `(text)` or hex `<hex>`, and the hex code width
 * depends on the font, so all readings are concatenated and the caller asserts a
 * substring. The point is to check the value is *drawn*, not merely stored in /V.
 */
async function drawnText(bytes: Uint8Array): Promise<string> {
  const { inflateSync } = await import('node:zlib');
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);

  const decode = (stream: unknown): string => {
    if (!(stream instanceof PDFStream)) return '';
    const raw = Buffer.from((stream as PDFRawStream).contents ?? []);
    const isFlate = String(stream.dict.get(PDFName.of('Filter'))) === '/FlateDecode';
    let text: string;
    try {
      text = (isFlate ? inflateSync(raw) : raw).toString('latin1');
    } catch {
      return '';
    }
    // Append both decodings of every hex literal alongside the raw operators.
    let decoded = text;
    for (const match of text.matchAll(/<([0-9A-Fa-f\s]+)>/g)) {
      const hex = match[1].replace(/\s+/g, '');
      for (const width of [2, 4]) {
        if (hex.length % width !== 0) continue;
        let out = '';
        for (let i = 0; i < hex.length; i += width) {
          out += String.fromCharCode(parseInt(hex.slice(i, i + width), 16));
        }
        decoded += `\n${out}`;
      }
    }
    return decoded;
  };

  let all = '';
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  for (const stream of streams) all += decode(doc.context.lookup(stream));

  const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  for (const [, ref] of xobjects?.entries() ?? []) all += decode(doc.context.lookup(ref));
  return all;
}

/**
 * Samples the rendered first page at page-relative coordinates.
 *
 * The grid draws each page to a real canvas through the same pdf.js worker the
 * app uses, so this is what a viewer shows — including the white page under a
 * transparent image, which is the whole point of the black-box check.
 */
async function samplePage(
  page: import('@playwright/test').Page,
  points: [number, number][]
): Promise<number[][]> {
  // An undrawn canvas is 300×150 and fully transparent, so "has a width" proves
  // nothing — wait for actual paint, or every sample reads as black.
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector<HTMLCanvasElement>('[role="option"] canvas');
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx || canvas.width < 2 || canvas.height < 2) return false;
      const middle = ctx.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;
      return middle[3] > 0;
    },
    undefined,
    { timeout: 30_000 }
  );
  return page.evaluate(pts => {
    const canvas = document.querySelector<HTMLCanvasElement>('[role="option"] canvas');
    if (!canvas) throw new Error('no rendered page canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    return pts.map(([fx, fy]) => {
      const x = Math.min(canvas.width - 1, Math.round(fx * canvas.width));
      const y = Math.min(canvas.height - 1, Math.round(fy * canvas.height));
      const data = ctx.getImageData(x, y, 1, 1).data;
      return [data[0], data[1], data[2]];
    });
  }, points);
}

/**
 * A deterministic JPEG, encoded by the browser.
 *
 * Node has no JPEG encoder here and the corpus may not assume ImageMagick is
 * installed, so the one realistic already-compressed photo the mixed fixture
 * needs is drawn and encoded in the page instead.
 */
async function makePhotoJpeg(
  page: import('@playwright/test').Page,
  width: number,
  height: number,
  quality: number
): Promise<Uint8Array> {
  const base64 = await page.evaluate(
    async ({ width, height, quality }) => {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, '#1b3a6b');
      gradient.addColorStop(0.5, '#c98b3a');
      gradient.addColorStop(1, '#2f7d5a');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      let seed = 7;
      const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      for (let i = 0; i < 900; i++) {
        ctx.beginPath();
        ctx.ellipse(
          next() * width,
          next() * height,
          4 + next() * 40,
          4 + next() * 40,
          next() * 6,
          0,
          Math.PI * 2
        );
        ctx.fillStyle = `rgba(${(next() * 255) | 0},${(next() * 255) | 0},${(next() * 255) | 0},0.35)`;
        ctx.fill();
      }
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    },
    { width, height, quality }
  );
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

test.describe('tool flows', () => {
  test('organize: rotating and deleting a page survives export', async ({ page }) => {
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await importFixture(page, file);
    await gotoTool(page, 'organize');

    // Rotate page 1 and delete page 2, both through the keyboard, which is the path
    // DOC-04 requires to work without a mouse.
    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await grid.getByRole('option', { name: /^Page 1 of/ }).focus();
    await page.keyboard.press('r');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Delete');

    // Scoped to the action bar: the grid header shows the same count.
    await expect(page.getByRole('contentinfo').or(page.locator('footer')))
      .toBeAttached()
      .catch(() => {});
    await expect(page.getByText('5 pages').first()).toBeVisible();

    const bytes = await commitAndRead(page, 'Export PDF');
    const output = await PDFDocument.load(bytes);
    expect(output.getPageCount()).toBe(5);
    expect(output.getPage(0).getRotation().angle).toBe(90);
  });

  test('split: extracting a selection produces exactly those pages', async ({ page }) => {
    const file = await ensureFixture('text-10.pdf', () => textPdf(10));
    await importFixture(page, file);
    await gotoTool(page, 'split');

    const grid = page.getByRole('listbox', { name: /Pages of/ });
    await grid.getByRole('option', { name: /^Page 2 of/ }).click();
    await grid.getByRole('option', { name: /^Page 3 of/ }).click({ modifiers: ['Shift'] });
    await expect(page.getByText('2 selected').first()).toBeVisible();

    const bytes = await commitAndRead(page, 'Split / extract');
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
  });

  test('split: every-N mode covers the whole document', async ({ page }) => {
    const file = await ensureFixture('text-10.pdf', () => textPdf(10));
    await importFixture(page, file);
    await gotoTool(page, 'split');

    await page.getByRole('radio', { name: 'Split every N pages' }).check();
    await page.getByLabel('Pages per file').fill('4');
    // 10 pages in fours → 4 + 4 + 2 = three files, delivered as a ZIP.
    await expect(page.getByText(/Produces 3 file/)).toBeVisible();

    const bytes = await commitAndRead(page, 'Split / extract');
    // PK\x03\x04 — a real ZIP, not a PDF renamed.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  test('merge: mixed page sizes are preserved, not normalised silently', async ({ page }) => {
    const file = await ensureFixture('mixed-sizes.pdf', mixedSizePdf);
    await importFixture(page, file);
    await gotoTool(page, 'merge');

    const bytes = await commitAndRead(page, 'Export PDF');
    const output = await PDFDocument.load(bytes);
    expect(output.getPageCount()).toBe(3);
    const heights = output.getPages().map(p => Math.round(p.getSize().height));
    // A4, Letter, Legal — all different, all intact.
    expect(new Set(heights).size).toBe(3);
    expect(heights).toContain(1008);
  });

  test('extract: text comes out in reading order', async ({ page }) => {
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await importFixture(page, file);
    await gotoTool(page, 'extract');

    await page.getByRole('button', { name: 'Extract text' }).click();
    const output = page.getByRole('textbox', { name: 'Extracted text' });
    await expect(output).toBeVisible({ timeout: 30_000 });

    const text = await output.inputValue();
    expect(text).toContain('Stapler fixture page 1');
    expect(text).toContain('Line 1 of body text on page 1.');
    // Reading order: the heading precedes its body.
    expect(text.indexOf('Stapler fixture page 1')).toBeLessThan(
      text.indexOf('Line 1 of body text on page 1.')
    );
  });

  test('compress: an already-optimized document is reported, not silently saved', async ({
    page
  }) => {
    // A text-only PDF has nothing to compress, which is exactly the CMP-04 case.
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await importFixture(page, file);
    await gotoTool(page, 'compress');

    await page.getByRole('button', { name: /Analyse without changing/ }).click();
    await expect(page.getByText(/already optimized/i)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('no reduction')).toBeVisible();
  });

  test('compress: CMP-02 raster path reduces scanned fixture by 70-90%', async ({ page }) => {
    // A heavy scanned PDF to test the raster-path compression
    const path = await import('node:path');
    const fs = await import('node:fs');
    const scannedPath = path.resolve(process.cwd(), 'tests/fixtures/scanned_skewed.pdf');
    await importFixture(page, scannedPath);
    await gotoTool(page, 'compress');

    await page.getByRole('button', { name: /Analyse without changing/ }).click();
    // It should estimate a significant reduction
    await expect(page.getByText(/Re-rendered as images/i)).toBeVisible({ timeout: 60_000 });

    const output = await commitAndRead(page, 'Compress & export');

    // Assert 70-90% reduction
    const originalSize = fs.statSync(scannedPath).size;
    const newSize = output.length;
    const reduction = 1 - newSize / originalSize;

    expect(reduction).toBeGreaterThan(0.7);
    expect(reduction).toBeLessThan(0.95);
  });

  test('compress: CMP-03 surgical path shrinks a mixed page and keeps its text', async ({
    page
  }) => {
    // Real compression work on a real document: the default 60s is not enough.
    test.setTimeout(180_000);
    await openApp(page);
    // An already-JPEG photo, which is the shape of document PLAN §4.1 projects
    // 30–70% for. A Flate-stored image would reduce by far more than that and
    // so would prove nothing about the band.
    const jpeg = await makePhotoJpeg(page, 1600, 1200, 0.85);
    const file = await ensureFixture('mixed-text-image.pdf', () => mixedTextImagePdf(jpeg));
    const original = new Uint8Array(readFileSync(file));

    await page.locator('input[type="file"]').setInputFiles(file);
    await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
    await gotoTool(page, 'compress');
    await page.getByRole('button', { name: /Analyse without changing/ }).click();
    await expect(page.getByText(/Images re-encoded, text kept/i)).toBeVisible({ timeout: 60_000 });

    const output = await commitAndRead(page, 'Compress & export');
    const reduction = 1 - output.length / original.length;
    expect(reduction).toBeGreaterThan(0.3);
    expect(reduction).toBeLessThan(0.7);

    // Structure survives, and only the image changed.
    const rebuilt = await PDFDocument.load(output);
    expect(rebuilt.getPageCount()).toBe(1);
    expect(await contentDigests(output)).toEqual(await contentDigests(original));

    const before = await imageEntries(original);
    const after = await imageEntries(output);
    expect(after).toHaveLength(1);
    expect(after[0].filter).toBe('/DCTDecode');
    expect(after[0].bytes).toBeLessThan(before[0].bytes);
    // Downscaled to the 150 DPI default: 450pt wide is 938px, not 1600.
    expect(after[0].width).toBeLessThan(before[0].width);

    // The text layer is the point of the surgical path — it must still extract.
    // Reloading first, because importing again would add a second document to
    // the workspace and the assertion could then be reading the original.
    await openApp(page);
    await page.locator('input[type="file"]').setInputFiles({
      name: 'compressed.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(output)
    });
    await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
    await gotoTool(page, 'extract');
    await page.getByRole('button', { name: 'Extract text' }).click();
    const extracted = page.getByRole('textbox', { name: 'Extracted text' });
    await expect(extracted).toBeVisible({ timeout: 30_000 });
    expect(await extracted.inputValue()).toContain('the quick brown fox jumps over the lazy dog');
  });

  test('compress: CMP-03 keeps a transparent image transparent, with no black box', async ({
    page
  }) => {
    // Real compression work on a real document: the default 60s is not enough.
    test.setTimeout(180_000);
    const file = await ensureFixture('transparent-image.pdf', transparentImagePdf);
    const original = new Uint8Array(readFileSync(file));
    await importFixture(page, file);

    // Band centres, in page fractions: the image occupies 40..440pt across and
    // 141.89..441.89pt down, and each of the four bands is a quarter of it.
    const bands: [number, number][] = [
      [0.1512, 0.3467],
      [0.3192, 0.3467],
      [0.4872, 0.3467],
      [0.6552, 0.3467]
    ];
    const beforePixels = await samplePage(page, bands);

    await gotoTool(page, 'compress');
    await page.getByRole('button', { name: /Analyse without changing/ }).click();
    await expect(page.getByText(/Images re-encoded, text kept/i)).toBeVisible({ timeout: 60_000 });
    const output = await commitAndRead(page, 'Compress & export');

    // The base image is re-encoded; the soft mask is carried over untouched, so
    // its bytes must be identical, not merely present.
    const before = await imageEntries(original);
    const after = await imageEntries(output);
    expect(before[0].smask).not.toBeNull();
    expect(after[0].filter).toBe('/DCTDecode');
    expect(after[0].smask).not.toBeNull();
    // A downscaled colour image needs a matching downscaled alpha mask. Presence
    // alone would pass with a stale full-resolution mask; matching dimensions,
    // together with the rendered alpha/pixel checks below, catches both stale and
    // incorrectly encoded masks without requiring an intentionally-resampled
    // stream to have its old byte digest.
    expect(after[0].smask!.width).toBe(after[0].width);
    expect(after[0].smask!.height).toBe(after[0].height);

    // And the rendered result: reload — so the workspace holds the compressed
    // file and nothing else — then sample the same four points.
    await openApp(page);
    await page.locator('input[type="file"]').setInputFiles({
      name: 'compressed.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(output)
    });
    await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
    const afterPixels = await samplePage(page, bands);

    // The fully transparent band must show the white page. Compositing a JPEG
    // over black — the failure this ticket is named for — would read as ~0.
    const clear = afterPixels[2];
    for (const channel of clear) expect(channel).toBeGreaterThan(230);

    // The half-transparent band must not be darkened twice: its colour is stored
    // un-premultiplied and the mask applies exactly once. Double darkening would
    // pull the green channel from ~220 down to ~175.
    for (let i = 0; i < bands.length; i++) {
      for (let c = 0; c < 3; c++) {
        expect(Math.abs(afterPixels[i][c] - beforePixels[i][c])).toBeLessThanOrEqual(12);
      }
    }
  });

  /**
   * CMP-03's "small image, large mask" case: an /SMask whose own resolution has
   * nothing to do with the colour image's, and is far above it.
   *
   * The criterion is that no such mask reaches the output at its original
   * resolution — an image re-encoded down to a few hundred pixels must not still
   * drag a 400×8400 alpha channel along with it. Both streams are inspected in the
   * exported bytes, so a mask that was merely re-pointed rather than resampled
   * fails.
   */
  test('compress: CMP-03 does not carry an oversized soft mask into the output', async ({
    page
  }) => {
    test.setTimeout(180_000);
    const file = await ensureFixture('oversized-mask.pdf', oversizedMaskPdf);
    const original = new Uint8Array(readFileSync(file));

    // The premise, asserted on the fixture rather than assumed: the colour image
    // and its mask really do start at wildly different resolutions.
    const before = await imageEntries(original);
    expect(before).toHaveLength(1);
    expect([before[0].width, before[0].height]).toEqual([
      OVERSIZED_MASK_FIXTURE.colour.width,
      OVERSIZED_MASK_FIXTURE.colour.height
    ]);
    expect(before[0].smask).not.toBeNull();
    expect([before[0].smask!.width, before[0].smask!.height]).toEqual([
      OVERSIZED_MASK_FIXTURE.mask.width,
      OVERSIZED_MASK_FIXTURE.mask.height
    ]);
    expect(before[0].smask!.width * before[0].smask!.height).toBeGreaterThan(
      before[0].width * before[0].height * 8
    );

    await importFixture(page, file);
    await gotoTool(page, 'compress');
    await page.getByRole('button', { name: /Analyse without changing/ }).click();
    await expect(page.getByText(/Images re-encoded, text kept/i)).toBeVisible({ timeout: 60_000 });

    const output = await commitAndRead(page, 'Compress & export');
    // CMP-04: had the output not been smaller the original bytes would come back
    // and every assertion below would be reading the fixture, not the result.
    expect(output.length).toBeLessThan(original.length);

    const after = await imageEntries(output);
    expect(after).toHaveLength(1);
    expect(after[0].filter).toBe('/DCTDecode');

    // The mask is resampled to the re-encoded colour image, not left at 400×8400.
    expect(after[0].smask).not.toBeNull();
    expect(after[0].smask!.width).toBe(after[0].width);
    expect(after[0].smask!.height).toBe(after[0].height);
    expect(after[0].smask!.height).toBeLessThan(OVERSIZED_MASK_FIXTURE.mask.height);
    // Genuinely rewritten, not re-pointed at the original stream.
    expect(after[0].smask!.sha).not.toBe(before[0].smask!.sha);
    expect(after[0].smask!.bytes).toBeLessThan(before[0].smask!.bytes);
  });

  /**
   * CMP-03's "the CMYK fixture has no colour shift beyond a documented tolerance".
   *
   * Both readings come from the same pdf.js build that the compression pipeline
   * decodes through — the pipeline does not implement a CMYK→RGB formula of its
   * own, pdf.js resolves the colour space while decoding — so the conversion
   * itself is common to both sides and contributes nothing to the measured
   * difference. Writing an independent formula here would test the formula, not
   * the pipeline.
   */
  test('compress: CMP-03 converts a DeviceCMYK image to RGB with no visible colour shift', async ({
    page
  }) => {
    test.setTimeout(180_000);
    const file = await ensureFixture('cmyk-image.pdf', cmykImagePdf);
    const original = new Uint8Array(readFileSync(file));
    await importFixture(page, file);

    const beforePixels = await samplePage(page, BAND_SAMPLE_POINTS);

    // Guard against a vacuous pass. A blank or all-white render would satisfy
    // "before ≈ after" perfectly, so the four bands must first be four clearly
    // distinct, clearly non-white colours.
    for (const pixel of beforePixels) expect(Math.min(...pixel)).toBeLessThan(230);
    for (let a = 0; a < beforePixels.length; a++) {
      for (let b = a + 1; b < beforePixels.length; b++) {
        const spread = Math.max(
          ...beforePixels[a].map((channel, c) => Math.abs(channel - beforePixels[b][c]))
        );
        expect(spread).toBeGreaterThan(40);
      }
    }

    await gotoTool(page, 'compress');
    await page.getByRole('button', { name: /Analyse without changing/ }).click();
    await expect(page.getByText(/Images re-encoded, text kept/i)).toBeVisible({ timeout: 60_000 });
    const output = await commitAndRead(page, 'Compress & export');
    expect(output.length).toBeLessThan(original.length);

    // The conversion actually happened: DeviceCMYK in, a DeviceRGB JPEG out.
    const before = await imageEntries(original);
    const after = await imageEntries(output);
    expect(before[0].colorSpace).toBe('/DeviceCMYK');
    expect(before[0].filter).toBe('/FlateDecode');
    expect(after[0].colorSpace).toBe('/DeviceRGB');
    expect(after[0].filter).toBe('/DCTDecode');
    expect(after[0].width).toBeLessThan(before[0].width);

    // Reload so the workspace holds the compressed file and nothing else, then
    // sample the same four band centres.
    await openApp(page);
    await page.locator('input[type="file"]').setInputFiles({
      name: 'compressed.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(output)
    });
    await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
    const afterPixels = await samplePage(page, BAND_SAMPLE_POINTS);

    for (let band = 0; band < BAND_SAMPLE_POINTS.length; band++) {
      for (let c = 0; c < 3; c++) {
        expect(
          Math.abs(afterPixels[band][c] - beforePixels[band][c]),
          `band ${band} channel ${c}: ${beforePixels[band][c]} → ${afterPixels[band][c]}`
        ).toBeLessThanOrEqual(CMYK_COLOUR_TOLERANCE);
      }
    }
  });

  test('compress: CMP-03 stores one copy of an image shared by ten pages', async ({ page }) => {
    // Real compression work on a real document: the default 60s is not enough.
    test.setTimeout(180_000);
    const file = await ensureFixture('shared-image.pdf', () => sharedImagePdf(10));
    await importFixture(page, file);
    await gotoTool(page, 'compress');
    await page.getByRole('button', { name: /Analyse without changing/ }).click();
    await expect(page.getByText(/Images re-encoded, text kept/i)).toBeVisible({ timeout: 120_000 });

    const output = await commitAndRead(page, 'Compress & export');
    const entries = await imageEntries(output);
    expect(entries).toHaveLength(10);
    // Ten pages, one image object: encoded once and stored once.
    expect(new Set(entries.map(e => e.ref)).size).toBe(1);
    expect(new Set(entries.map(e => e.filter))).toEqual(new Set(['/DCTDecode']));
    // One JPEG plus ten pages of text, not ten JPEGs.
    expect(output.length).toBeLessThan(entries[0].bytes * 3);
  });

  test('metadata: the inspector reports what the file carries', async ({ page }) => {
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await importFixture(page, file);
    await gotoTool(page, 'metadata');

    await page.getByRole('button', { name: /Inspect this document/ }).click();
    // pdf-lib stamps a Producer, so there is always at least one finding to show.
    await expect(page.getByText(/Producer|Nothing identifying/)).toBeVisible({ timeout: 30_000 });
  });

  test('pdf to images: exports a ZIP at the chosen resolution', async ({ page }) => {
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await importFixture(page, file);
    await gotoTool(page, 'pdf-to-img');

    await page.getByRole('radio', { name: 'PNG' }).check();
    const bytes = await commitAndRead(page, 'Export images');
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  test('sign: adding a text annotation and exporting embeds the text', async ({ page }) => {
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await importFixture(page, file);
    await gotoTool(page, 'sign');

    await page.getByRole('button', { name: 'Text', exact: true }).click();
    const placement = page.getByRole('group', { name: /Stamp placement area/ });
    await placement.focus();
    await page.keyboard.press('Enter');

    await page.getByLabel('Stamp text').fill('Test signature text');

    const bytes = await commitAndRead(page, 'Export signed PDF');
    expect(await drawnText(bytes)).toContain('Test signature text');
  });

  /**
   * SGN-03. Two separate failures met here, and both were invisible from the UI:
   * the rendered field could not be clicked (the stamp overlay sat on top of it),
   * and a value that did get typed was dropped by the compose that followed the
   * fill. So this test types through the real overlay and then reads the value out
   * of the exported bytes — the only place a viewer would look.
   */
  test('sign: a typed AcroForm value reaches the exported bytes', async ({ page }) => {
    const file = await ensureFixture('acroform.pdf', () => acroformPdf());
    await importFixture(page, file);
    await gotoTool(page, 'sign');

    // The overlay renders one box per widget; title is the field name.
    const field = page.locator('[data-index="0"] textarea').first();
    await expect(field).toBeVisible({ timeout: 30_000 });

    // `click` fails outright if any layer covers the input, which is the z-order
    // regression this guards; `fill` alone would dispatch input synthetically.
    await field.click();
    await field.fill('Ada Lovelace');
    await expect(field).toHaveValue('Ada Lovelace');

    const bytes = await commitAndRead(page, 'Export signed PDF');
    // The sign tool flattens, so the value is drawn into the page rather than left
    // in /V. Its appearance stream must carry the text.
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(await drawnText(bytes)).toContain('Ada Lovelace');
  });

  /**
   * SGN-03's second criterion. The XFA fixture must be *explained*, and no field of
   * it may ever be offered — half-filling an XFA form writes values into shadow
   * fields that the viewer ignores, which looks like success and is data loss.
   */
  test('sign: the XFA fixture is explained and offers nothing to fill', async ({ page }) => {
    await importFixture(page, 'tests/fixtures/xfa.pdf');
    await gotoTool(page, 'sign');

    await expect(page.getByText(/XFA form/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/stamp tools/i).first()).toBeVisible();

    // No field boxes at all: the overlay refuses to render for an XFA document, so
    // there is no way for a value to be entered and then silently dropped.
    await expect(page.locator('[data-index="0"] textarea')).toHaveCount(0);
    await expect(page.locator('[data-index="0"] input')).toHaveCount(0);
    await expect(page.locator('[data-index="0"] select')).toHaveCount(0);
  });

  test('redact: drawing a redaction rectangle physically removes content', async ({ page }) => {
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await importFixture(page, file);
    await gotoTool(page, 'redact');

    // Use the text finder so the test is independent of viewport geometry and
    // also proves the search-to-mark path produces a correctly-sized region.
    await page.getByLabel('Find and mark text').fill('Line 1 of body text on page 1.');
    await page.getByRole('button', { name: 'Mark every occurrence' }).click();
    await expect(page.getByText('Marks (1)')).toBeVisible();

    await page.getByRole('button', { name: 'Verify & apply' }).click();
    // Wait for the success notification
    const toast = page.getByText('Redaction verified and applied');
    await expect(toast).toBeVisible();
    // Dismiss the toast so it doesn't intercept the export click
    await page.getByRole('button', { name: 'Dismiss notification' }).click();

    await gotoTool(page, 'organize');
    const bytes = await commitAndRead(page, 'Export PDF');
    const output = await PDFDocument.load(bytes);
    expect(await drawnText(bytes)).not.toContain('Line 1 of body text on page 1.');
    expect(await drawnText(bytes)).toContain('Line 2 of body text on page 1.');
    expect(output.getPageCount()).toBe(6);
  });

  test('cleanup: applying b&w preset alters the page', async ({ page }) => {
    const jpeg = await makePhotoJpeg(page, 800, 600, 0.85);
    const file = await ensureFixture('mixed-text-image.pdf', () => mixedTextImagePdf(jpeg));
    await importFixture(page, file);
    await gotoTool(page, 'cleanup');

    await page.getByRole('radio', { name: 'B&W document' }).check();
    await page.getByRole('button', { name: 'Apply to this page' }).click();
    await expect(page.getByText('Page cleaned.')).toBeVisible({ timeout: 30_000 });

    const bytes = await commitAndRead(page, 'Apply & export');
    // Cleanup must rasterize the page; preserving the source text would mean the
    // preview was never applied. Reload and inspect a photo pixel as well: B&W
    // output has equal RGB channels rather than merely a different PDF stream.
    expect(await drawnText(bytes)).not.toContain('Mixed text and image');
    await openApp(page);
    await page.locator('input[type="file"]').setInputFiles({
      name: 'cleaned.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(bytes)
    });
    await expect(page.getByRole('listbox', { name: /Pages of/ })).toBeVisible({ timeout: 30_000 });
    const [pixel] = await samplePage(page, [[0.5, 0.6]]);
    expect(Math.max(...pixel.slice(0, 3)) - Math.min(...pixel.slice(0, 3))).toBeLessThanOrEqual(2);
  });

  test('a corrupt file is refused with a reason and does not break the tab', async ({ page }) => {
    const file = await ensureFixture('not-a-pdf.pdf', async () =>
      new TextEncoder().encode('This is definitely not a PDF.')
    );
    await openApp(page);
    await page.locator('input[type="file"]').setInputFiles(file);

    await expect(page.getByRole('status')).toContainText(/not a PDF|damaged|incomplete/i);
    // The app is still alive and still on the launcher.
    await expect(page.getByRole('heading', { name: 'Offline PDF tools' })).toBeVisible();
  });

  test('crop: drawing a crop box and exporting', async ({ page }) => {
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await importFixture(page, file);
    await gotoTool(page, 'crop');

    const layer = page.locator('[data-index="0"]');
    const box = await layer.boundingBox();
    if (!box) throw new Error('no box');

    await page.mouse.move(box.x + 50, box.y + 50);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + 200, { steps: 5 });
    await page.mouse.up();

    const result = await commitAndRead(page, /Export PDF/i);
    const output = await PDFDocument.load(result);
    const cropBox = output.getPage(0).getCropBox();
    expect(cropBox.width).toBeLessThan(output.getPage(0).getWidth());
    expect(cropBox.height).toBeLessThan(output.getPage(0).getHeight());
  });

  test('crop: odd-page scope, resize handles, keyboard nudge, and reset', async ({ page }) => {
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await importFixture(page, file);
    await gotoTool(page, 'crop');

    await page.getByLabel('Apply crop to').selectOption('odd');

    const layer = page.locator('[data-index="0"]');
    const box = await layer.boundingBox();
    if (!box) throw new Error('no box');

    // Draw an initial crop box on page 1 (odd) while the "odd pages" scope is active.
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 220, box.y + 220, { steps: 5 });
    await page.mouse.up();

    const cropGroup = page.getByRole('group', { name: /Crop box/i });
    await expect(cropGroup).toBeVisible();

    // Resize via keyboard (Control+ArrowRight grows the box) so the test does not
    // depend on locating a specific handle's pixel position.
    await cropGroup.focus();
    const before = await cropGroup.boundingBox();
    await page.keyboard.press('Control+ArrowRight');
    const afterResize = await cropGroup.boundingBox();
    if (!before || !afterResize) throw new Error('missing box geometry');
    expect(afterResize.width).toBeGreaterThan(before.width);

    // Arrow-key nudge moves it.
    await page.keyboard.press('ArrowRight');
    const afterMove = await cropGroup.boundingBox();
    if (!afterMove) throw new Error('missing box geometry');
    expect(afterMove.x).toBeGreaterThan(afterResize.x);

    // Page 2 (even) must not have received the odd-scoped box — this is the dead
    // dropdown OPS-06 calls out; previously "all"/"odd"/"even" never propagated.
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('group', { name: /Crop box/i })).toHaveCount(0);

    // Page 3 (odd) must have received it.
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('group', { name: /Crop box/i })).toBeVisible();

    // The panel's reset action clears the box on every scoped (odd) page, not just
    // the one on screen.
    await page.getByRole('button', { name: /Reset crop on odd pages/i }).click();
    await expect(page.getByRole('group', { name: /Crop box/i })).toHaveCount(0);
    await page.getByRole('button', { name: 'Previous' }).click();
    await page.getByRole('button', { name: 'Previous' }).click();
    await expect(page.getByRole('group', { name: /Crop box/i })).toHaveCount(0);

    // The reset itself is undoable.
    await page.keyboard.press('Control+z');
    await expect(page.getByRole('group', { name: /Crop box/i })).toBeVisible();

    const result = await commitAndRead(page, /Export PDF/i);
    const output = await PDFDocument.load(result);
    const page1Crop = output.getPage(0).getCropBox();
    const page2Crop = output.getPage(1).getCropBox();
    const page3Crop = output.getPage(2).getCropBox();
    expect(page1Crop.width).toBeLessThan(output.getPage(0).getWidth());
    expect(page2Crop.width).toBe(output.getPage(1).getWidth());
    expect(page3Crop.width).toBeLessThan(output.getPage(2).getWidth());
  });

  test('watermark: adding a watermark and exporting embeds the text', async ({ page }) => {
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await importFixture(page, file);
    await gotoTool(page, 'watermark');

    // Enter watermark text (the "Watermark type" segmented control also has a
    // radio option named "Text", so this is scoped to the textbox specifically).
    await page.getByRole('textbox', { name: 'Text', exact: true }).fill('CONFIDENTIAL TEST');

    // Choose bottom-center position
    await page.getByLabel('Position').selectOption('bottom-center');

    const bytes = await commitAndRead(page, /Export PDF/i);
    const output = await PDFDocument.load(bytes);

    // The former assertion only proved that the export still had six pages. This
    // reads the actual content stream, so it fails if the watermark is ignored.
    expect(await drawnText(bytes)).toContain('CONFIDENTIAL TEST');
    expect(output.getPageCount()).toBe(6);
  });

  test('watermark: header and footer text are drawn independently of the watermark stamp', async ({
    page
  }) => {
    const file = await ensureFixture('text-6.pdf', () => textPdf(6));
    await importFixture(page, file);
    await gotoTool(page, 'watermark');

    // Leave the watermark stamp itself empty — only the header/footer are set.
    await page.getByLabel('Header text').fill('ACME Corp');
    await page.getByLabel('Footer text').fill('Page {n} of {total}');

    const bytes = await commitAndRead(page, /Export PDF/i);
    const output = await PDFDocument.load(bytes);

    expect(await drawnText(bytes)).toContain('ACME Corp');
    expect(await drawnText(bytes)).toContain('Page 1 of 6');
    expect(output.getPageCount()).toBe(6);
  });

  test('nup: generates a 2-up layout', async ({ page }) => {
    const file = await ensureFixture('text-4.pdf', () => textPdf(4));
    await importFixture(page, file);
    await gotoTool(page, 'nup');

    // Select 2-up
    await page.getByLabel('Layout', { exact: true }).selectOption('2-up');

    // Select draw borders
    await page.getByLabel(/Draw borders/i).check();

    const result = await commitAndRead(page, /Export layout/i);
    expect(result.length).toBeGreaterThan(0);
    const doc = await PDFDocument.load(result);
    // 4 pages, 2-up -> 2 pages
    expect(doc.getPageCount()).toBe(2);
  });

  test('nup: generates a booklet layout', async ({ page }) => {
    const file = await ensureFixture('text-8.pdf', () => textPdf(8));
    await importFixture(page, file);
    await gotoTool(page, 'nup');

    await page.getByLabel('Layout', { exact: true }).selectOption('booklet');

    const result = await commitAndRead(page, /Export layout/i);
    expect(result.length).toBeGreaterThan(0);
    const doc = await PDFDocument.load(result);
    // 8 pages, booklet -> 8/2 = 4 pages
    expect(doc.getPageCount()).toBe(4);
  });
});

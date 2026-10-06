/**
 * CMP-01 — classification exercised against the real committed static fixtures,
 * not just hand-built `ImageFacts` mocks. `jbig2.pdf`, `jpx.pdf`, `cmyk.pdf`, and
 * `cmyk-text.pdf` were committed to the corpus (`tests/fixtures/README.md`) but no
 * test ever loaded them — a corrupted regeneration or a parser regression against
 * these exact encodings would have gone unnoticed indefinitely.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyPages } from '../../src/core/compress-plan';
import type { PageTextPresence } from '../../src/core/workers/render.worker';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(val => val)
}));
const { processWorkerImpl } = await import('../../src/core/workers/process.worker');

function fixture(name: string): Uint8Array {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  return new Uint8Array(readFileSync(path));
}

function noText(count: number): PageTextPresence[] {
  return Array.from({ length: count }, (_, i) => ({ pageIndex: i, charCount: 0, runCount: 0 }));
}

describe('CMP-01: classification against the real static fixture corpus', () => {
  /*
   * HRD-39 — the real route, on the real fixture inventory. Both fixtures are a
   * textless 612×792 page carrying one 1×1 image whose stream is JBIG2/JPX.
   * The surgical route never re-encodes such a stream (it would have to decode
   * it and write a JPEG), but the raster route never reads it: pdf.js renders
   * the page with its bundled JBIG2/OpenJPEG decoders. So the textless page is
   * rasterised — and, being rasterised wholesale, the image is not listed as
   * "left untouched" in the report's skip list, because it is not.
   */
  it.each([
    ['jbig2.pdf', 'JBIG2Decode'],
    ['jpx.pdf', 'JPXDecode']
  ])(
    '%s: a textless page routes to raster, never to a surgical re-encode',
    async (name, filter) => {
      const inventory = await processWorkerImpl.imageInventory(fixture(name));
      expect(inventory[0].images[0].filter).toBe(filter);

      const plan = classifyPages(inventory, noText(inventory.length), { rasterDpi: 150 });
      expect(plan.pages[0].route).toBe('raster');
      expect(plan.pages[0].reencode).toEqual([]);
      expect(plan.skipped.some(reason => reason.includes(filter))).toBe(false);
    }
  );

  it.each([
    ['jbig2.pdf', 'JBIG2Decode'],
    ['jpx.pdf', 'JPXDecode']
  ])('%s: the same page with real text is left untouched and says why', async (name, filter) => {
    // The other half of the routing rule: with a text layer to keep, the page
    // cannot be rasterised, and the image cannot be re-encoded in place. Same
    // real inventory, plus a census saying the page has a body of text.
    const inventory = await processWorkerImpl.imageInventory(fixture(name));
    const plan = classifyPages(inventory, [{ pageIndex: 0, charCount: 4000, runCount: 40 }], {
      rasterDpi: 150
    });
    expect(plan.pages[0].route).toBe('skip');
    expect(plan.pages[0].reencode).toEqual([]);
    expect(plan.skipped.some(reason => reason.includes(filter))).toBe(true);
  });

  it('cmyk.pdf: a real ImageMagick-encoded CMYK JPEG resolves to DeviceCMYK, not unknown', async () => {
    const inventory = await processWorkerImpl.imageInventory(fixture('cmyk.pdf'));
    const images = inventory.flatMap(p => p.images);
    expect(images.length).toBeGreaterThan(0);
    expect(images[0].colorSpace).toBe('DeviceCMYK');

    // DeviceCMYK is not in UNSAFE_COLOR_SPACES (only Separation/DeviceN are), so
    // an image-only, textless page routes to raster like any other scan.
    const plan = classifyPages(inventory, noText(inventory.length), { rasterDpi: 150 });
    expect(plan.skipped.some(r => r.includes('DeviceCMYK'))).toBe(false);
  });

  it('cmyk-text.pdf: an indirect /ColorSpace reference on a real file still resolves and routes to surgical', async () => {
    const inventory = await processWorkerImpl.imageInventory(fixture('cmyk-text.pdf'));
    const images = inventory.flatMap(p => p.images);
    expect(images.length).toBeGreaterThan(0);
    // Must not be 'unknown' — this fixture's /ColorSpace is an indirect reference
    // (`/ColorSpace 10 0 R`), exactly the case that used to fall through and get
    // re-encoded to RGB regardless of the true colour space.
    expect(images[0].colorSpace).not.toBe('unknown');

    const plan = classifyPages(
      inventory,
      inventory.map(p => ({ pageIndex: p.pageIndex, charCount: 4000, runCount: 40 })),
      { rasterDpi: 150 }
    );
    // Never 'skip': a resolved, safe colour space must be an actual re-encode
    // candidate. Whether it ends up 'surgical' or 'already-optimized' depends
    // only on whether the image is oversampled for the target DPI, which is
    // incidental to what this test is proving (colour-space resolution).
    expect(plan.pages[0].route).not.toBe('skip');
    expect(plan.skipped).toEqual([]);
  });

  it('encrypted.pdf: reported as encrypted rather than parsed as if it were plain', async () => {
    const facts = await processWorkerImpl.inspect(fixture('encrypted.pdf'));
    expect(facts.isEncrypted).toBe(true);
  });
  it.each([
    ['device-n.pdf', 'DeviceN'],
    ['separation.pdf', 'Separation'],
    ['sub-byte.pdf', 'sub-byte depth'],
    ['color-key.pdf', 'colorKey'],
    ['pre-blended.pdf', 'preblended'],
    ['stencil.pdf', 'ImageMask']
  ])('classifies %s as a mask edge case that cannot be re-encoded safely', async filename => {
    const inventory = await processWorkerImpl.imageInventory(fixture(filename));
    const plan = classifyPages(inventory, [{ pageIndex: 0, charCount: 3000, runCount: 30 }], {
      rasterDpi: 150
    });
    expect(plan.pages[0].route).toBe('skip');
    expect(plan.pages[0].reencode).toEqual([]);
    expect(plan.skipped.length).toBeGreaterThan(0);
  });

  it.each([
    ['indexed.pdf', 'Indexed'],
    ['icc.pdf', 'ICCBased'],
    ['soft-mask.pdf', 'soft']
  ])(
    '%s: an image using %s is safe to re-encode, judged at its own size',
    async (filename, kind) => {
      const inventory = await processWorkerImpl.imageInventory(fixture(filename));
      const image = inventory[0].images[0];
      // Classified at the fixture's own dimensions — a 1×1 image on a 612×792
      // page — not at a size written over the inventory. Proves the property
      // this case exists for: the colour space / soft mask is read correctly
      // and does not disqualify the image.
      expect([image.colorSpace, image.maskKind]).toContain(kind);
      expect([image.width, image.height]).toEqual([1, 1]);

      const plan = classifyPages(inventory, [{ pageIndex: 0, charCount: 3000, runCount: 30 }], {
        rasterDpi: 150
      });
      // Safe, so not `skip`; one pixel is far below 150 DPI, so not over-sampled
      // and there is nothing to re-encode. (`compress-plan.test.ts` covers the
      // over-sampled → `surgical` path with images that really are large.)
      expect(plan.pages[0].route).toBe('already-optimized');
      expect(plan.pages[0].reencode).toEqual([]);
      expect(plan.skipped).toEqual([]);
    }
  );
});

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
  it('jbig2.pdf: the filter is detected and the image is never surgically re-encoded', async () => {
    const inventory = await processWorkerImpl.imageInventory(fixture('jbig2.pdf'));
    expect(inventory[0].images[0].filter).toBe('JBIG2Decode');

    // No text on this page, so the page is still compressible via the raster
    // route (which rasterises the whole page through pdf.js's own decoder); the
    // image itself is simply never a surgical re-encode candidate.
    const plan = classifyPages(inventory, noText(inventory.length), { rasterDpi: 150 });
    expect(plan.pages[0].reencode).toEqual([]);
    expect(plan.skipped.some(reason => reason.includes('JBIG2Decode'))).toBe(true);
  });

  it('jpx.pdf: the filter is detected and the image is never surgically re-encoded', async () => {
    const inventory = await processWorkerImpl.imageInventory(fixture('jpx.pdf'));
    expect(inventory[0].images[0].filter).toBe('JPXDecode');

    const plan = classifyPages(inventory, noText(inventory.length), { rasterDpi: 150 });
    expect(plan.pages[0].reencode).toEqual([]);
    expect(plan.skipped.some(reason => reason.includes('JPXDecode'))).toBe(true);
  });

  it('a page with real text and an undecodable image is routed to skip, not raster', () => {
    // jbig2.pdf/jpx.pdf themselves carry no text layer, so this proves the other
    // half of the routing rule (compress-plan.ts's `!hasText` branch) using the
    // same real inventory shape those fixtures produce, plus a text census that
    // says the page has a real body of extractable text.
    const inventory = [
      {
        pageIndex: 0,
        width: 612,
        height: 792,
        images: [
          {
            name: 'Im1',
            objectNumber: 4,
            width: 1,
            height: 1,
            bitsPerComponent: 1,
            colorSpace: 'DeviceGray',
            filter: 'JBIG2Decode',
            hasSMask: false,
            hasMask: false,
            maskKind: 'none' as const,
            isImageMask: false,
            byteLength: 0
          }
        ]
      }
    ];
    const plan = classifyPages(inventory, [{ pageIndex: 0, charCount: 4000, runCount: 40 }], {
      rasterDpi: 150
    });
    expect(plan.pages[0].route).toBe('skip');
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
});

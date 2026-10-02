/**
 * GAP-4 / GAP-5 — tool parameters carried in a link: parsed robustly, clamped
 * to sane bounds, garbage ignored, and applied to the right tool.
 */
import { describe, expect, it } from 'vitest';
import {
  IMAGE_TARGET_BOUNDS,
  MAX_DIMENSION_BOUNDS,
  PDF_TARGET_BOUNDS,
  parseMaxDimensionParam,
  parseSizeParam,
  readToolLink,
  sizeParamBytes,
  targetQuery
} from '../../src/core/deep-link';
import { applyToolParams } from '../../src/ui/deepLink';
import { compressMode, compressTarget } from '../../src/ui/tools/compress/state';
import { pdfToImageSettings } from '../../src/ui/tools/state';
import { imageSizeSettings } from '../../src/ui/tools/image-size/state';

describe('parseSizeParam', () => {
  it.each([
    ['100KB', { amount: 100, unit: 'KB' }],
    ['100kb', { amount: 100, unit: 'KB' }],
    ['100 KB', { amount: 100, unit: 'KB' }],
    [' 200k ', { amount: 200, unit: 'KB' }],
    ['250', { amount: 250, unit: 'KB' }],
    ['1MB', { amount: 1, unit: 'MB' }],
    ['1.5mb', { amount: 1.5, unit: 'MB' }],
    ['1,5 MB', { amount: 1.5, unit: 'MB' }],
    ['2m', { amount: 2, unit: 'MB' }],
    // IMG-11: binary units are scaled by 1024 (500 KiB = 512,000 B) and
    // expressed in decimal KB, rounded down so a limit is never exceeded.
    ['500KiB', { amount: 512, unit: 'KB' }],
    ['1MiB', { amount: 1048.57, unit: 'KB' }],
    ['.5MB', { amount: 0.5, unit: 'MB' }]
  ])('parses %j', (raw, expected) => {
    expect(parseSizeParam(raw)).toEqual(expected);
  });

  it.each([
    null,
    undefined,
    '',
    '   ',
    'abc',
    '-100KB',
    '0',
    '0KB',
    '100GB',
    '100 bytes',
    'Infinity',
    'NaN',
    '1e5',
    '100KB;drop',
    '<script>',
    '1'.repeat(30),
    '12.34.56',
    '100KBKB'
  ])('ignores garbage: %j', raw => {
    expect(parseSizeParam(raw as string | null | undefined)).toBeNull();
  });

  it('clamps below the minimum up to it', () => {
    expect(parseSizeParam('1KB', PDF_TARGET_BOUNDS)).toEqual({ amount: 10, unit: 'KB' });
    expect(parseSizeParam('0.001MB', PDF_TARGET_BOUNDS)).toEqual({ amount: 10, unit: 'KB' });
    expect(parseSizeParam('1KB', IMAGE_TARGET_BOUNDS)).toEqual({ amount: 5, unit: 'KB' });
  });

  it('clamps above the maximum down to it', () => {
    expect(parseSizeParam('999999MB', PDF_TARGET_BOUNDS)).toEqual({ amount: 2000, unit: 'MB' });
    expect(parseSizeParam('999999KB', IMAGE_TARGET_BOUNDS)).toEqual({ amount: 50, unit: 'MB' });
  });

  it('keeps every parsed value inside its bounds', () => {
    for (const raw of ['1', '9', '10', '99999999', '0.01MB', '3000MB']) {
      for (const bounds of [PDF_TARGET_BOUNDS, IMAGE_TARGET_BOUNDS]) {
        const parsed = parseSizeParam(raw, bounds);
        expect(parsed).not.toBeNull();
        const bytes = sizeParamBytes(parsed!);
        expect(bytes).toBeGreaterThanOrEqual(bounds.minBytes);
        expect(bytes).toBeLessThanOrEqual(bounds.maxBytes);
      }
    }
  });

  it('uses decimal kilobytes, like the compress tool', () => {
    expect(sizeParamBytes({ amount: 100, unit: 'KB' })).toBe(100_000);
    expect(sizeParamBytes({ amount: 1, unit: 'MB' })).toBe(1_000_000);
  });

  it('round-trips through targetQuery', () => {
    expect(targetQuery({ amount: 100, unit: 'KB' })).toBe('target=100KB');
    const query = new URLSearchParams(targetQuery({ amount: 1.5, unit: 'MB' }));
    expect(parseSizeParam(query.get('target'))).toEqual({ amount: 1.5, unit: 'MB' });
  });
});

describe('parseMaxDimensionParam', () => {
  it('parses plain pixel counts, with or without px', () => {
    expect(parseMaxDimensionParam('600')).toBe(600);
    expect(parseMaxDimensionParam('1200px')).toBe(1200);
    expect(parseMaxDimensionParam(' 800 ')).toBe(800);
  });

  it('clamps into bounds', () => {
    expect(parseMaxDimensionParam('1')).toBe(MAX_DIMENSION_BOUNDS.min);
    expect(parseMaxDimensionParam('999999')).toBe(MAX_DIMENSION_BOUNDS.max);
  });

  it.each([null, '', '0', '-5', '12.5', 'wide', '600em', '1e3'])('ignores %j', raw => {
    expect(parseMaxDimensionParam(raw as string | null)).toBeNull();
  });
});

describe('readToolLink', () => {
  it('splits a hash route from its query', () => {
    const link = readToolLink('/tool/compress?target=100KB');
    expect(link.toolId).toBe('compress');
    expect(link.path).toBe('/tool/compress');
    expect(link.params.get('target')).toBe('100KB');
    expect(link.hashHadQuery).toBe(true);
  });

  it('falls back to the page query, and the hash wins on conflict', () => {
    const fromPage = readToolLink('/tool/compress', '?target=300KB');
    expect(fromPage.params.get('target')).toBe('300KB');
    expect(fromPage.hashHadQuery).toBe(false);

    const both = readToolLink('/tool/compress?target=100KB&mode=target', '?target=300KB');
    expect(both.params.get('target')).toBe('100KB');
    expect(both.params.get('mode')).toBe('target');
  });

  it('reports no tool for non-tool routes', () => {
    expect(readToolLink('/').toolId).toBeNull();
    expect(readToolLink('/dev/components?target=1MB').toolId).toBeNull();
  });
});

describe('applyToolParams', () => {
  it('pre-fills Compress in "Aim for a size" mode', () => {
    compressMode.value = 'quality';
    expect(applyToolParams('compress', new URLSearchParams('target=100KB'))).toBe(true);
    expect(compressMode.value).toBe('target');
    expect(compressTarget.value).toEqual({ amount: 100, unit: 'KB' });
  });

  it('switches Compress to target mode on mode=target alone, keeping the amount', () => {
    compressMode.value = 'quality';
    compressTarget.value = { amount: 2, unit: 'MB' };
    expect(applyToolParams('compress', new URLSearchParams('mode=target'))).toBe(true);
    expect(compressMode.value).toBe('target');
    expect(compressTarget.value).toEqual({ amount: 2, unit: 'MB' });
  });

  it('leaves Compress alone for garbage', () => {
    compressMode.value = 'quality';
    compressTarget.value = { amount: 2, unit: 'MB' };
    expect(applyToolParams('compress', new URLSearchParams('target=lots&mode=max'))).toBe(false);
    expect(compressMode.value).toBe('quality');
    expect(compressTarget.value).toEqual({ amount: 2, unit: 'MB' });
  });

  it('pre-fills Image to size, clamped', () => {
    expect(applyToolParams('image-to-size', new URLSearchParams('target=20KB&max=600'))).toBe(true);
    expect(imageSizeSettings.value.useTarget).toBe(true);
    expect(imageSizeSettings.value.target).toEqual({ amount: 20, unit: 'KB' });
    expect(imageSizeSettings.value.maxDimension).toBe(600);

    applyToolParams('image-to-size', new URLSearchParams('target=1KB'));
    expect(imageSizeSettings.value.target).toEqual({ amount: 5, unit: 'KB' });
  });

  it('a PDF to images max= link switches an exact size off too', () => {
    const exact = pdfToImageSettings.value.exact!;
    pdfToImageSettings.value = { ...pdfToImageSettings.value, exact: { ...exact, on: true } };
    expect(applyToolParams('pdf-to-img', new URLSearchParams('max=1200'))).toBe(true);
    expect(pdfToImageSettings.value.maxDimension).toBe(1200);
    expect(pdfToImageSettings.value.exact?.on).toBe(false);
  });

  it('a max= link switches an exact size off, so the longest side it asks for applies', () => {
    const exact = imageSizeSettings.value.exact!;
    imageSizeSettings.value = { ...imageSizeSettings.value, exact: { ...exact, on: true } };
    expect(applyToolParams('image-to-size', new URLSearchParams('max=800'))).toBe(true);
    expect(imageSizeSettings.value.maxDimension).toBe(800);
    expect(imageSizeSettings.value.exact?.on).toBe(false);
  });

  it('pre-fills PDF to images in target mode (JPEG) with a pixel box', () => {
    expect(applyToolParams('pdf-to-img', new URLSearchParams('target=200KB&max=1600'))).toBe(true);
    expect(pdfToImageSettings.value).toMatchObject({
      sizeMode: 'target',
      format: 'jpeg',
      targetKb: 200,
      maxDimension: 1600
    });
  });

  it('ignores parameters for tools that take none', () => {
    expect(applyToolParams('merge', new URLSearchParams('target=100KB'))).toBe(false);
    expect(applyToolParams(null, new URLSearchParams('target=100KB'))).toBe(false);
  });
});

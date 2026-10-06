/**
 * AUDIT-2026-10-01 X-15 — `parseRecipe` is the only gate between a recipe read
 * back from IndexedDB (or imported from a file) and the batch runner. Each case
 * here is a shape storage can actually hold.
 */
import { describe, expect, it } from 'vitest';
import { parseRecipe } from '../../src/ui/tools/batch/recipe-settings';

const compress = { dpi: 150, quality: 0.75 };
const watermark = {
  kind: 'text',
  text: 'DRAFT',
  image: null,
  imageScale: 0.35,
  position: 'center',
  opacity: 0.5,
  rotation: 45,
  fontSize: 72,
  color: '#08090a',
  startAt: 1,
  pageRange: 'all'
};
const headerFooter = {
  headerText: 'Head',
  headerAlign: 'center',
  footerText: '',
  footerAlign: 'right',
  fontSize: 10,
  pageRange: '1-3'
};
const nup = { layout: '2-up', margin: 10, gutter: 5, drawBorders: false };
const normalize = { targetSize: 'A4', scaleMode: 'fit' };

describe('parseRecipe', () => {
  it('accepts every slice a current build saves, unchanged', () => {
    const result = parseRecipe({
      tools: ['watermark', 'normalize', 'nup', 'compress'],
      settings: { compress, watermark, headerFooter, nup, normalize }
    });
    expect(result).toEqual({
      ok: true,
      recipe: {
        tools: ['watermark', 'normalize', 'nup', 'compress'],
        settings: { compress, watermark, headerFooter, nup, normalize }
      }
    });
  });

  it('keeps an image watermark read back from IndexedDB', () => {
    const image = {
      bytes: new Uint8Array([1, 2]),
      format: 'png',
      width: 4,
      height: 3,
      name: 'a.png'
    };
    const result = parseRecipe({
      tools: ['watermark'],
      settings: { watermark: { ...watermark, kind: 'image', image } }
    });
    expect(result.ok && result.recipe.settings.watermark?.image?.bytes).toEqual(image.bytes);
  });

  it('treats missing, undefined and null slices as "not configured"', () => {
    for (const settings of [undefined, null, {}, { compress: null, nup: undefined }]) {
      expect(parseRecipe({ tools: ['compress'], settings })).toEqual({
        ok: true,
        recipe: { tools: ['compress'], settings: {} }
      });
    }
  });

  it('drops keys it does not know instead of passing them on', () => {
    const result = parseRecipe({
      tools: ['compress'],
      settings: { compress: { ...compress, preset: 'smallest' }, futureTool: { x: 1 } }
    });
    expect(result).toEqual({ ok: true, recipe: { tools: ['compress'], settings: { compress } } });
  });

  it('reports every wrong field by path', () => {
    const result = parseRecipe({
      tools: ['compress', 'watermark', 'nup', 'normalize'],
      settings: {
        compress: { dpi: '150', quality: Number.NaN },
        watermark: { ...watermark, position: 'middle', color: 'red', opacity: 4 },
        headerFooter: 'none',
        nup: { ...nup, drawBorders: 'yes' },
        normalize: { targetSize: 'A3', scaleMode: 'fit' }
      }
    });
    expect(result).toEqual({
      ok: false,
      problems: [
        'compress.dpi',
        'compress.quality',
        'watermark.position',
        'watermark.opacity',
        'watermark.color',
        'headerFooter',
        'nup.drawBorders',
        'normalize.targetSize'
      ]
    });
  });

  it('rejects a field that is missing, since every field predates recipes', () => {
    const rest: Record<string, unknown> = { ...headerFooter };
    delete rest.fontSize;
    expect(parseRecipe({ tools: [], settings: { headerFooter: rest } })).toEqual({
      ok: false,
      problems: ['headerFooter.fontSize']
    });
  });

  it('rejects an image watermark that went through JSON (bytes became an object)', () => {
    const viaJson: unknown = JSON.parse(
      JSON.stringify({
        ...watermark,
        kind: 'image',
        image: { bytes: new Uint8Array([1]), format: 'png', width: 1, height: 1, name: 'a' }
      })
    );
    expect(parseRecipe({ tools: ['watermark'], settings: { watermark: viaJson } })).toEqual({
      ok: false,
      problems: ['watermark.image']
    });
  });

  it('rejects tools that are not an array of strings, and settings that are not an object', () => {
    expect(parseRecipe({ tools: 'compress', settings: [] })).toEqual({
      ok: false,
      problems: ['tools', 'settings']
    });
    expect(parseRecipe({ tools: ['compress', 3], settings: {} })).toEqual({
      ok: false,
      problems: ['tools']
    });
  });
});

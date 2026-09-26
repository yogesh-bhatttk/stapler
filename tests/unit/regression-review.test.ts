/**
 * Regressions the post-fix review (2026-09-26) found in the audit fixes
 * themselves, each pinned against the real module.
 */
import { describe, expect, it } from 'vitest';
import { effectiveDpi, OCR_DPI } from '../../src/core/ocr/runOcr';
import { MAX_RENDER_PIXELS, clampRenderScale } from '../../src/core/render-limits';

describe('R-RT-3: OCR places words at the DPI the page was actually rendered at', () => {
  it('reports the requested DPI when the render was not clamped', () => {
    // Letter at 300 dpi: 612 pt → 2550 px.
    expect(effectiveDpi(2550, 612)).toBeCloseTo(OCR_DPI, 5);
  });

  it('reports the lower DPI when the render worker clamped an A0 page', () => {
    const a0 = { width: 2384, height: 3370 };
    const requested = OCR_DPI / 72;
    const { scale, clamped } = clampRenderScale(a0.width, a0.height, requested);
    expect(clamped).toBe(true);
    const bitmapWidth = Math.ceil(a0.width * scale);
    expect(bitmapWidth * Math.ceil(a0.height * scale)).toBeLessThanOrEqual(MAX_RENDER_PIXELS);
    // Words must be mapped with this DPI, not OCR_DPI: using OCR_DPI put them
    // at ~69% of their true position.
    const dpi = effectiveDpi(bitmapWidth, a0.width);
    expect(dpi).toBeLessThan(OCR_DPI * 0.75);
    expect(dpi).toBeCloseTo(72 * scale, 0);
  });

  it('falls back to the requested DPI when the page size is unknown', () => {
    expect(effectiveDpi(1000, undefined)).toBe(OCR_DPI);
  });
});

import { fuzzyRank } from '../../src/core/fuzzy';
import { TOOLS } from '../../src/core/tools';

describe('R-UI-2/3: search ranks the same as before translation was added', () => {
  // The palette's haystacks, as CommandPalette builds them in English.
  const tools = TOOLS.map(tool => ({
    label: tool.title,
    text: [`${tool.title} Tools`, `${tool.title} ${tool.group}`] as const
  }));
  const actions = ['Undo', 'Redo', 'Select all pages', 'Go home'].map(label => ({
    label,
    text: `${label} Document`
  }));
  const rank = (q: string) => fuzzyRank([...tools, ...actions], q, item => item.text)[0]?.label;

  it('"red" opens Redact rather than running Redo', () => {
    expect(rank('red')).toBe('Redact');
  });

  it('"sp" and "spl" put Split & extract first on the Home search', () => {
    const home = (q: string) =>
      fuzzyRank(TOOLS, q, tool => [`${tool.title} ${tool.group} ${tool.summary}`])[0]?.title;
    expect(home('spl')).toBe('Split & extract');
  });
});

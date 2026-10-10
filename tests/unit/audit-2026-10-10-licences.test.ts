import { describe, expect, it } from 'vitest';
import path from 'node:path';
import * as licences from '../../scripts/third-party-licenses.mjs';

/**
 * Audit 2026-10-10 (Licences) — the Noto Sans Devanagari and Liberation Sans
 * fonts vendored in `src/` shipped without their SIL OFL text (the dependency
 * walk only sees npm packages), and the LGPL-3.0 libheif-js entry carried no
 * source link, no replacement notice and no GPL-3.0 text. Rendered here from
 * the real repository, the same call `vite.config.ts` makes.
 */
type Entry = { name: string; files: { file: string; text: string }[]; notice: string[] };
const { collectThirdPartyLicenses, renderThirdPartyLicenses } = licences as unknown as {
  collectThirdPartyLicenses(root: string, o?: { shipped?: (n: string) => boolean }): Entry[];
  renderThirdPartyLicenses(entries: Entry[], product: string): string;
};

const root = path.resolve(__dirname, '../..');
// Only libheif-js "shipped", as if it were the only bundled package: the
// vendored fonts must appear regardless of what the bundle narrowing keeps.
const entries = collectThirdPartyLicenses(root, { shipped: name => name === 'libheif-js' });
const text = renderThirdPartyLicenses(entries, 'Stapler');

describe('audit 2026-10-10: vendored font licences ship', () => {
  it.each([
    ['Noto Sans Devanagari (font)', 'src/core/ocr/assets/NotoSansDevanagari-OFL.txt'],
    ['Liberation Sans Regular (font)', 'src/core/pdf/assets/LICENSE_LIBERATION']
  ])('%s with its full SIL OFL 1.1 text', (name, file) => {
    const entry = entries.find(e => e.name === name);
    expect(entry?.files.map(f => f.file)).toEqual([file]);
    expect(entry?.files[0].text).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
    expect(text).toContain(`${name}\nLicense: OFL-1.1`);
  });
});

describe('audit 2026-10-10: libheif-js LGPL notice', () => {
  const block = text.slice(
    text.indexOf('libheif-js@'),
    text.indexOf('\n=====', text.indexOf('libheif-js@'))
  );

  it('links the corresponding source and says the library may be replaced', () => {
    expect(block).toContain('License: LGPL-3.0');
    expect(block).toContain('https://github.com/strukturag/libheif');
    expect(block).toContain('https://github.com/strukturag/libde265');
    expect(block).toContain('https://github.com/catdad-experiments/libheif-js');
    expect(block).toMatch(/you may replace this library with a modified version/i);
  });

  it('reproduces the LGPL-3.0 and the GPL-3.0 texts', () => {
    expect(block).toContain('GNU LESSER GENERAL PUBLIC LICENSE');
    expect(block).toContain('--- libheif-wasm/LICENSE ---');
    expect(block).toMatch(/GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
  });

  it('no longer names the removed heic2any', () => {
    expect(text).not.toContain('heic2any');
  });
});

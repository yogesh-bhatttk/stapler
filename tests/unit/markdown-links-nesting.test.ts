/**
 * CONV-11 / CONV-12 — Markdown→PDF link targets and hostile nesting/size.
 *
 *  • CONV-11: a non-ASCII URL used to be written byte-per-code-unit into
 *    `/URI` (`https://例え.jp/パス` → mojibake), and `javascript:`/`file:`
 *    targets were written verbatim. Link URIs are now ASCII-normalised through
 *    `URL`, and only http/https/mailto become annotations; the rest are drawn as
 *    plain text and counted in `notes`.
 *  • CONV-12: 5,000 nested `>` threw a raw "Maximum call stack size exceeded";
 *    it is now a clear refusal, and oversize input is refused up front.
 */
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import {
  MARKDOWN_TOO_LARGE_MESSAGE,
  MARKDOWN_TOO_NESTED_MESSAGE,
  MAX_MARKDOWN_CHARS,
  markdownToPdfBytes,
  safeLinkUri
} from '../../src/core/markdown-to-pdf';

async function linkUris(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const out: string[] = [];
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookup(i, PDFDict);
      const action = annot.lookup(PDFName.of('A'), PDFDict);
      const uri = action.lookup(PDFName.of('URI'));
      out.push(uri instanceof PDFString ? uri.asString() : String(uri));
    }
  }
  return out;
}

describe('safeLinkUri (CONV-11)', () => {
  it('percent-encodes / punycodes non-ASCII and keeps only http, https and mailto', () => {
    expect(safeLinkUri('https://例え.jp/パス')).toBe('https://xn--r8jz45g.jp/%E3%83%91%E3%82%B9');
    expect(safeLinkUri('mailto:a@example.com')).toBe('mailto:a@example.com');
    expect(safeLinkUri(' http://example.com/a b ')).toBe('http://example.com/a%20b');
    expect(safeLinkUri('javascript:alert(1)')).toBeNull();
    expect(safeLinkUri('JavaScript:alert(1)')).toBeNull();
    expect(safeLinkUri('file:///etc/passwd')).toBeNull();
    expect(safeLinkUri('data:text/html,x')).toBeNull();
    expect(safeLinkUri('relative/page.html')).toBeNull();
    expect(safeLinkUri(undefined)).toBeNull();
  });
});

describe('markdownToPdfBytes links (CONV-11)', () => {
  it('writes ASCII URIs for safe links and drops unsafe ones with a note', async () => {
    const md =
      '[jp](https://例え.jp/パス) [ok](https://example.com/x) ' +
      '[js](javascript:alert(1)) [file](file:///etc/passwd) [mail](mailto:a@example.com)';
    const result = await markdownToPdfBytes(md);
    const uris = await linkUris(result.bytes);
    expect(uris).toEqual([
      'https://xn--r8jz45g.jp/%E3%83%91%E3%82%B9',
      'https://example.com/x',
      'mailto:a@example.com'
    ]);
    for (const uri of uris) expect(/^[\x21-\x7e]+$/.test(uri)).toBe(true);
    expect(result.notes.join(' ')).toMatch(/2 links were kept as plain text/);
  });

  it('has no notes for a plain document, and counts omitted images', async () => {
    expect((await markdownToPdfBytes('# Title\n\nText.')).notes).toEqual([]);
    const withImage = await markdownToPdfBytes('Look: ![a chart](chart.png)');
    expect(withImage.notes.join(' ')).toMatch(/1 image was left out/);
  });
});

describe('markdownToPdfBytes hostile input (CONV-12)', () => {
  it('refuses 5,000 nested quotes with a clear message, not a raw RangeError', async () => {
    await expect(markdownToPdfBytes('>'.repeat(5000) + ' x')).rejects.toThrow(
      MARKDOWN_TOO_NESTED_MESSAGE
    );
  });

  it('refuses input over the size cap', async () => {
    await expect(markdownToPdfBytes('a'.repeat(MAX_MARKDOWN_CHARS + 1))).rejects.toThrow(
      MARKDOWN_TOO_LARGE_MESSAGE
    );
  });
});

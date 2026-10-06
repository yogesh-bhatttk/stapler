import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  type PDFObject
} from 'pdf-lib';

/**
 * Byte-level readers for exported PDFs, shared by the web-preview and the
 * packaged-extension specs.
 */

/**
 * Every string a document draws on page 0, including inside the form XObjects the
 * page invokes — which is where a flattened form field's value ends up.
 *
 * Show-text operands may be literal `(text)` or hex `<hex>`, and the hex code width
 * depends on the font, so all readings are concatenated and the caller asserts a
 * substring. The point is to check the value is *drawn*, not merely stored in /V.
 */
export async function drawnText(bytes: Uint8Array): Promise<string> {
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
    } catch (err) {
      const message = `Failed to decode a content stream while reading page text: ${
        err instanceof Error ? err.message : String(err)
      }`;
      throw new Error(message, { cause: err });
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

/** Byte offset of `<n> 0 obj` in the file (-1 if it is not a top-level object). */
function objOffset(bytes: Uint8Array, objectNumber: number): number {
  const text = Buffer.from(bytes).toString('latin1');
  return text.search(new RegExp(`(?:^|[\\r\\n])${objectNumber} 0 obj\\b`));
}

/** Every object number reachable from `root`, not following `/Parent`. */
function reachable(doc: PDFDocument, root: PDFRef): Set<number> {
  const found = new Set<number>();
  const walk = (value: PDFObject | undefined) => {
    if (value instanceof PDFRef) {
      if (found.has(value.objectNumber)) return;
      found.add(value.objectNumber);
      walk(doc.context.lookup(value));
    } else if (value instanceof PDFDict) {
      for (const [key, entry] of value.entries()) {
        if (key !== PDFName.of('Parent')) walk(entry);
      }
    } else if (value instanceof PDFArray) {
      value.asArray().forEach(walk);
    } else if (value instanceof PDFStream) {
      walk(value.dict);
    }
  };
  walk(root);
  return found;
}

/**
 * DOC-08's layout: byte offsets of page 1's objects, and of the objects only a
 * later page needs (mirrors `tests/unit/export-fast-web-view.test.ts`).
 */
export async function firstPageLayout(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPages();
  const first = reachable(doc, pages[0].ref);
  const later = new Set<number>();
  for (const page of pages.slice(1)) {
    for (const n of reachable(doc, page.ref)) if (!first.has(n)) later.add(n);
  }
  const offsets = (set: Set<number>) => [...set].map(n => objOffset(bytes, n));
  return { pageCount: pages.length, first: offsets(first), later: offsets(later) };
}

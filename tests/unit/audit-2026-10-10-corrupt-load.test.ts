/**
 * Audit 2026-10-10 F2 — a truncated PDF is refused, typed, by every
 * process-worker entry point that loads it.
 *
 * pdf-lib parses a file cut off before its trailer into a document whose
 * `catalog` is `undefined`; until the shared loader checked for that, the first
 * tool to touch the page tree (compress, grayscale, protect, metadata, …)
 * failed with a bare `TypeError: Cannot read properties of undefined (reading
 * 'Pages')`. Each entry point here runs against the real fixture bytes and must
 * reject with `CorruptDocument` and the copy that points at Repair.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { installCanvasShims } from './helpers/node-canvas-shims';

vi.setConfig({ testTimeout: 60_000 });

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value),
  releaseProxy: Symbol('releaseProxy')
}));
vi.mock('../../src/core/workers/pdfjs-setup', async () => {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return {
    pdfjsLib,
    openDocument: ({ data, password }: { data: Uint8Array; password?: string }) =>
      pdfjsLib.getDocument({ data, password, disableFontFace: true, verbosity: 0 })
  };
});

installCanvasShims();
const { processWorkerImpl: api } = await import('../../src/core/workers/process.worker');
const { BROKEN_PAGE_TREE_MESSAGE, assertReadablePageTree, loadPdfDocument } =
  await import('../../src/core/pdf/load');
const { fromUnknown } = await import('../../src/core/errors');

const TRUNCATED = ['truncated.pdf', 'truncated-header-only.pdf', 'truncated-mid-body.pdf'];
const read = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/${name}`));

/** Every entry point that opens one document's bytes with pdf-lib. */
const ENTRY_POINTS: [string, (bytes: Uint8Array) => Promise<unknown>][] = [
  ['inspect', b => api.inspect(b)],
  ['imageInventory', b => api.imageInventory(b)],
  ['rebuildCompressed (compress)', b => api.rebuildCompressed(b, [], [])],
  ['grayscalePlan', b => api.grayscalePlan(b, [0], 'gray')],
  ['grayscaleBegin', b => api.grayscaleBegin(b, { mode: 'gray', wholeDocument: true })],
  [
    'protectDocument',
    b =>
      api.protectDocument(b, {
        userPassword: 'open sesame',
        ownerPassword: '',
        allowPrinting: true,
        allowCopying: true,
        allowModifying: true
      })
  ],
  ['restrictDocument', b => api.restrictDocument(b, -4)],
  ['readMetadata', b => api.readMetadata(b)],
  ['scrubMetadata', b => api.scrubMetadata(b)],
  ['saveForFastWebView', b => api.saveForFastWebView(b)],
  ['getFormFields', b => api.getFormFields(b)],
  ['fillFormFields', b => api.fillFormFields(b, {}, false)],
  ['flattenDocument', b => api.flattenDocument(b)],
  ['checkSignatureIntegrity', b => api.checkSignatureIntegrity(b)],
  ['checkFontEmbedding', b => api.checkFontEmbedding(b)],
  ['readOutline', b => api.readOutline(b)],
  ['collectOffPageText', b => api.collectOffPageText(b)]
];

describe('F2 — truncated PDFs are refused with a typed, explained error', () => {
  it.each(TRUNCATED)('%s really does load into pdf-lib with no catalog', async name => {
    // The premise: pdf-lib does not reject these itself.
    const doc = await PDFDocument.load(read(name), { updateMetadata: false });
    expect((doc as { catalog?: unknown }).catalog).toBeUndefined();
    expect(() => assertReadablePageTree(doc)).toThrow(BROKEN_PAGE_TREE_MESSAGE);
  });

  it.each(TRUNCATED)('%s: the shared loader refuses it as CorruptDocument', async name => {
    const error = await loadPdfDocument(read(name)).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(TypeError);
    const typed = fromUnknown(error);
    expect(typed.kind).toBe('CorruptDocument');
    expect(typed.message).toBe(BROKEN_PAGE_TREE_MESSAGE);
    expect(typed.message).toMatch(/Repair/);
  });

  describe.each(TRUNCATED)('%s', name => {
    it.each(ENTRY_POINTS)('%s refuses it, typed', async (_label, call) => {
      const error = await call(read(name)).then(
        () => new Error('resolved instead of refusing'),
        (e: unknown) => e
      );
      expect(error, String(error)).not.toBeInstanceOf(TypeError);
      expect((error as { isStaplerError?: boolean }).isStaplerError, String(error)).toBe(true);
      expect(fromUnknown(error).kind).toBe('CorruptDocument');
    });
  });

  it('a well-formed document still loads', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const loaded = await loadPdfDocument(await doc.save());
    expect(loaded.getPageCount()).toBe(1);
  });
});

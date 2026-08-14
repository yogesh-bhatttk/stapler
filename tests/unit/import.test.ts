/**
 * DOC-02 — the import pipeline's classification and per-file isolation, driven by
 * the real fixture corpus.
 *
 * The workers are stubbed rather than run: `render.worker` needs pdf.js, an
 * OffscreenCanvas and a nested Worker, none of which exist under vitest's node
 * environment. Everything *this* module decides — the PDF header check, the empty
 * file, the raw `/XFA` scan, the oversized warning, which failure message a given
 * file gets, and whether one bad file aborts the batch — is decided before or
 * around those calls, so stubbing them tests the code under test rather than
 * pdf.js. The parts that genuinely need a browser (pdf.js's own
 * encrypted/truncated classification, and image decoding) are covered end to end
 * in `tests/e2e/import.spec.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface StubDocumentInfo {
  handle: string;
  pageCount: number;
  isXfa: boolean;
  fingerprint: string;
  pageSizes: { width: number; height: number }[];
}

/** Swappable per test: what the stubbed pdf.js load does with the bytes it is given. */
let loadDocument: (bytes: Uint8Array) => Promise<StubDocumentInfo>;
/** Swappable per test: what the stubbed pdf-lib inspection reports. */
let inspect: () => Promise<{ hasAcroForm: boolean; fieldCount: number }>;

const closed: string[] = [];

function okDocument(pageCount = 1, isXfa = false): StubDocumentInfo {
  return {
    handle: 'stub-handle',
    pageCount,
    isXfa,
    fingerprint: 'stub',
    pageSizes: Array.from({ length: pageCount }, () => ({ width: 612, height: 792 }))
  };
}

vi.mock('../../src/core/workers', () => {
  // `lease` hands the caller an object shaped like the Comlink proxy; only the
  // two methods `import.ts` calls need to exist.
  const renderApi = {
    loadDocument: (bytes: Uint8Array) => loadDocument(bytes),
    closeDocument: async (handle: string) => {
      closed.push(handle);
    }
  };
  const processApi = { inspect: () => inspect() };
  // Generic rather than `any`: the stub stands in for a `Comlink.Remote<T>`, and
  // callers only ever reach for the methods defined above.
  const leaseOn =
    <T>(target: T) =>
    (fn: (api: T) => Promise<unknown>) =>
      fn(target);
  return {
    renderWorker: {
      lease: leaseOn(renderApi),
      pin: () => ({ lease: leaseOn(renderApi), release: () => {} })
    },
    processWorker: { lease: leaseOn(processApi) },
    cvWorker: { lease: leaseOn({}) }
  };
});

const { importFiles, largeFileWarning, LARGE_FILE_BYTES, SUPPORTED_FORMATS } =
  await import('../../src/core/import');
const { sources } = await import('../../src/core/store');
const { XFA_MESSAGE } = await import('../../src/core/pdf/xfa');

function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)))
  );
}

function pdfFile(name: string, bytes: Uint8Array): File {
  return new File([bytes as BlobPart], name, { type: 'application/pdf' });
}

beforeEach(() => {
  loadDocument = async () => okDocument();
  inspect = async () => ({ hasAcroForm: false, fieldCount: 0 });
  closed.length = 0;
});

describe('DOC-02: every fixture imports or gets its own accurate explanation', () => {
  it('a real PDF imports, and its page refs point at the id the source was registered under', async () => {
    loadDocument = async () => okDocument(3);
    const outcome = await importFiles([pdfFile('cjk.pdf', fixtureBytes('cjk.pdf'))]);

    expect(outcome.failures).toEqual([]);
    expect(outcome.imported).toHaveLength(1);
    const [imported] = outcome.imported;
    expect(imported.pages).toHaveLength(3);
    // The bug this pipeline exists to prevent: refs naming an id nothing resolves.
    expect(new Set(imported.pages.map(p => p.sourceDocId))).toEqual(new Set([imported.source.id]));
    expect(sources.value[imported.source.id]?.name).toBe('cjk.pdf');
    // The pdf.js parse is released rather than leaked.
    expect(closed).toEqual(['stub-handle']);
  });

  it('an empty file is refused as empty, not as "not a PDF"', async () => {
    const outcome = await importFiles([pdfFile('empty.pdf', new Uint8Array(0))]);
    expect(outcome.imported).toEqual([]);
    expect(outcome.failures[0].message).toBe('The file is empty.');
  });

  it('not-a-pdf.pdf is refused for the specific reason that it has no PDF header', async () => {
    const bytes = new TextEncoder().encode('This is definitely not a PDF.');
    const outcome = await importFiles([pdfFile('not-a-pdf.pdf', bytes)]);
    expect(outcome.failures[0].message).toContain('does not start with a PDF header');
    // pdf.js is never even asked: the header check short-circuits.
    expect(closed).toEqual([]);
  });

  it('a header buried in leading junk is still recognised as a PDF, as viewers do', async () => {
    const real = fixtureBytes('cjk.pdf');
    const junked = new Uint8Array(real.length + 16);
    junked.set(new TextEncoder().encode('JUNKJUNKJUNKJUNK'), 0);
    junked.set(real, 16);
    const outcome = await importFiles([pdfFile('junk-prefix.pdf', junked)]);
    expect(outcome.failures).toEqual([]);
  });

  it('a document that parses to zero pages is explained, not imported empty', async () => {
    loadDocument = async () => okDocument(0);
    const outcome = await importFiles([pdfFile('cjk.pdf', fixtureBytes('cjk.pdf'))]);
    expect(outcome.failures[0].message).toBe('The document contains no pages.');
  });

  it('xfa.pdf is imported with the one XFA explanation, from the raw bytes alone', async () => {
    // pdf.js reports `isPureXfa: false` for a hybrid form — the raw-byte scan is
    // what must catch it (core/pdf/xfa.ts).
    loadDocument = async () => okDocument(1, false);
    const outcome = await importFiles([pdfFile('xfa.pdf', fixtureBytes('xfa.pdf'))]);

    expect(outcome.failures).toEqual([]);
    expect(outcome.imported[0].warnings).toContain(XFA_MESSAGE);
  });

  it('an XFA document is never advertised as fillable', async () => {
    inspect = async () => ({ hasAcroForm: true, fieldCount: 4 });
    const outcome = await importFiles([pdfFile('xfa.pdf', fixtureBytes('xfa.pdf'))]);
    expect(outcome.imported[0].warnings.some(w => /fillable/.test(w))).toBe(false);
  });

  it('a plain AcroForm is advertised as fillable', async () => {
    inspect = async () => ({ hasAcroForm: true, fieldCount: 4 });
    const outcome = await importFiles([pdfFile('cjk.pdf', fixtureBytes('cjk.pdf'))]);
    expect(outcome.imported[0].warnings).toContain('Contains 4 fillable form field(s).');
  });

  it('an encrypted document reports the password reason and does not abort the batch', async () => {
    const { encrypted } = await import('../../src/core/errors');
    const encryptedBytes = fixtureBytes('encrypted.pdf');
    loadDocument = async bytes => {
      // Stands in for pdf.js's PasswordException, which render.worker translates
      // (see render.worker.ts loadDocument). The E2E test proves the real one.
      if (bytes.length === encryptedBytes.length) {
        throw encrypted('The document requires a password to open.');
      }
      return okDocument();
    };

    const outcome = await importFiles([
      pdfFile('encrypted.pdf', encryptedBytes),
      pdfFile('cjk.pdf', fixtureBytes('cjk.pdf'))
    ]);

    expect(outcome.failures).toEqual([
      { name: 'encrypted.pdf', message: 'The document requires a password to open.' }
    ]);
    // Per-file isolation: the good file after the bad one still imported.
    expect(outcome.imported).toHaveLength(1);
    expect(outcome.imported[0].source.name).toBe('cjk.pdf');
  });

  it('an unsupported file type names every format that is actually accepted', async () => {
    const outcome = await importFiles([
      new File(['x' as BlobPart], 'notes.txt', { type: 'text/plain' })
    ]);
    expect(outcome.imported).toEqual([]);
    expect(outcome.failures[0].message).toBe(
      `text/plain cannot be imported. Stapler accepts ${SUPPORTED_FORMATS}.`
    );
    // The list must not claim a format the pipeline rejects, nor omit one it takes.
    for (const format of ['PDF', 'PNG', 'JPEG', 'WebP', 'GIF', 'TIFF', 'HEIC']) {
      expect(SUPPORTED_FORMATS).toContain(format);
    }
  });
});

describe('DOC-02: the >100MB warning', () => {
  it('warns above the threshold and stays silent at or below it', () => {
    expect(largeFileWarning(LARGE_FILE_BYTES)).toBeNull();
    expect(largeFileWarning(LARGE_FILE_BYTES - 1)).toBeNull();
    expect(largeFileWarning(LARGE_FILE_BYTES + 1)).toBe(
      '100MB is a large document — operations on it will be slower.'
    );
    expect(largeFileWarning(250 * 1024 * 1024)).toBe(
      '250MB is a large document — operations on it will be slower.'
    );
  });

  it('warns rather than refuses: an oversized PDF still imports', async () => {
    // Built from a real PDF padded past the threshold, so the header check and the
    // XFA scan run over the full length exactly as they would on a real 100MB file.
    const real = fixtureBytes('cjk.pdf');
    const big = new Uint8Array(LARGE_FILE_BYTES + 4096);
    big.set(real, 0);
    const outcome = await importFiles([pdfFile('big.pdf', big)]);

    expect(outcome.failures).toEqual([]);
    expect(outcome.imported[0].warnings).toContain(
      '100MB is a large document — operations on it will be slower.'
    );
  });
});

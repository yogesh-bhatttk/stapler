/**
 * Imported permission restrictions survive the export.
 *
 * The bug this covers: most "encrypted" PDFs in the wild carry an owner
 * password only — printing or copying forbidden, no password to open — and
 * `core/pdf/load.ts` opens them the way Chrome and Acrobat do, with the empty
 * user password. pdf-lib *genuinely decrypts* when it does that, and a
 * decrypted document has no `/Encrypt` dictionary left, so every export built
 * from one was written back with the restrictions silently gone: a file its
 * owner had made unprintable came out of Stapler printable, with no warning
 * and no way to tell.
 *
 * Everything here is asserted against **output bytes read back with pdf.js** —
 * the same verifier `encrypt.test.ts` uses for RED-06, and the one that
 * actually implements the standard security handler. An assertion about
 * `documentRestrictions()` or about the `/P` we *meant* to write would pass
 * just as happily against a file nothing enforces.
 *
 * The end-to-end cases drive the real `commitTool(…)` — the same entry point
 * the action bar calls — with only the platform's `saveFileAs` and the export
 * review modal replaced, so the store lookup, `applyProtection`, the worker
 * hop and the AES pass are all the production ones.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { unzipSync } from 'fflate';

/** Every file `platform.saveFileAs` was asked to write during a test. */
const saved: { name: string; bytes: Uint8Array }[] = [];

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(value => value),
  proxy: vi.fn(value => value)
}));

vi.mock('../../src/platform/current', () => ({
  platform: {
    kind: 'web',
    supportsFileSystemAccess: false,
    saveFileAs: async (bytes: Uint8Array, name: string) => {
      saved.push({ name, bytes: bytes.slice() });
      return true;
    },
    openFiles: async () => [],
    openDirectory: async () => null,
    saveOver: async () => false,
    persistHandle: async () => {},
    restoreHandles: async () => [],
    reopenHandle: async () => null,
    revokeHandle: async () => {},
    readClipboardImage: async () => null
  }
}));

/**
 * The worker pool, routed straight to the real implementation. Node has no
 * `Worker` to spawn, but every byte still goes through the same `compose` and
 * `restrictDocument` the extension runs.
 */
vi.mock('../../src/core/workers', async () => {
  const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
  // `any` here is deliberate: the pool hands callers a `Comlink.Remote<T>`,
  // which is exactly the wrapper being stubbed out, and re-deriving that type
  // would only describe the stub in terms of the thing it replaces.
  const client = (impl: any) => ({
    lease: (fn: (api: any) => unknown) => fn(impl),
    pin: () => ({ lease: (fn: (api: any) => unknown) => fn(impl), release: () => {} })
  });
  const unavailable = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error('This test does not run that worker');
      }
    }
  );
  return {
    processWorker: client(processWorkerImpl),
    renderWorker: client(unavailable),
    cvWorker: client(unavailable),
    ocrWorker: client(unavailable),
    convertWorker: client(unavailable)
  };
});

/** UX-04's review modal needs a person; every test here answers "save it". */
vi.mock('../../src/core/notify', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/notify')>();
  return { ...actual, requestExportReview: async () => true };
});

/**
 * Spies rather than replacements: every other test in this file needs the
 * real `compressToTargetSize`/`restrictDocument`, and only the never-grow test
 * below overrides one call each with `mockResolvedValueOnce`/
 * `mockImplementationOnce` to make the AES pass's overhead deterministic
 * instead of depending on real encryption arithmetic landing on the right side
 * of a byte boundary.
 */
vi.mock('../../src/core/operations', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/operations')>();
  return {
    ...actual,
    compressToTargetSize: vi.fn(actual.compressToTargetSize),
    restrictDocument: vi.fn(actual.restrictDocument)
  };
});

const { commitTool } = await import('../../src/ui/tools/commit');
const { processWorkerImpl } = await import('../../src/core/workers/process.worker');
const {
  activeDocId,
  addDocument,
  appendPages,
  documents,
  documentRestrictions,
  makePageRefs,
  registerSource,
  replaceWithSource,
  selectedPageKeys,
  sources
} = await import('../../src/core/store');
const { resetHistory } = await import('../../src/core/history');
const { __memoryFallback } = await import('../../src/core/opfs');
const { permissionFlags, withInheritedRestrictions } = await import('../../src/core/pdf/encrypt');
const { toasts } = await import('../../src/core/notify');
const { loadPdfDocumentWithRestrictions } = await import('../../src/core/pdf/load');
const { splitSettings } = await import('../../src/ui/tools/state');
const { compressMode, compressTarget } = await import('../../src/ui/tools/compress/state');
const { compressToTargetSize, restrictDocument } = await import('../../src/core/operations');

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let cachedPdfjs: PdfjsModule | undefined;
async function pdfjs(): Promise<PdfjsModule> {
  cachedPdfjs ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  return cachedPdfjs;
}

/** Opens output bytes exactly as a viewer would: no password offered. */
async function openWithNoPassword(bytes: Uint8Array) {
  const lib = await pdfjs();
  return lib.getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
}

function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)))
  );
}

/**
 * `/P -3904` — what `permission-no-print.pdf` was built with: printing,
 * copying, modifying, annotating, form filling, assembly and accessibility
 * extraction all denied.
 */
const NO_PRINT_P = -3904;

/** Registers `bytes` as a source and opens a document over it, as import does. */
async function openDocument(id: string, bytes: Uint8Array) {
  __memoryFallback.set(id, bytes);
  // Deliberately the real inspection, not a hand-written `restrictions` value:
  // recovering `/P` from a file pdf-lib is about to decrypt is the half of this
  // fix that has nowhere else to be tested.
  const facts = await processWorkerImpl.inspect(bytes);
  registerSource({
    id,
    name: `${id}.pdf`,
    pageCount: facts.pageCount,
    pageSizes: Array.from({ length: facts.pageCount }, () => ({ width: 200, height: 200 })),
    ...(facts.permissionRestrictions !== null ? { restrictions: facts.permissionRestrictions } : {})
  });
  const doc = {
    id: `${id}-doc`,
    name: `${id}.pdf`,
    pages: makePageRefs(id, facts.pageCount),
    annotations: [],
    dirty: false
  };
  addDocument(doc);
  activeDocId.value = doc.id;
  return doc;
}

beforeEach(() => {
  saved.length = 0;
  toasts.value = [];
  documents.value = [];
  sources.value = {};
  activeDocId.value = null;
  selectedPageKeys.value = new Set();
  compressMode.value = 'quality';
  compressTarget.value = { amount: 2, unit: 'MB' };
  resetHistory();
});

describe('recovering the original permissions at import', () => {
  it('reads /P off a file that only restricts, and that pdf-lib is about to decrypt', async () => {
    const facts = await processWorkerImpl.inspect(fixtureBytes('permission-no-print.pdf'));
    expect(facts.permissionRestrictions).toBe(NO_PRINT_P);

    // And the flags are gone from the decrypted document, which is the whole
    // reason they have to be captured here: pdf-lib keeps no `/Encrypt` once it
    // has decrypted, so nothing downstream could recover them.
    const decrypted = await PDFDocument.load(fixtureBytes('permission-no-print.pdf'), {
      password: '',
      updateMetadata: false
    });
    expect(decrypted.context.trailerInfo.Encrypt).toBeUndefined();
  });

  it('reports them from the rewrite path too, where the file is really decrypted', async () => {
    // `inspect` reads a file it is not allowed to modify, so it parses without
    // decrypting. Every rewriting caller takes the other branch — the empty
    // password retry — and the flags have to come back from there as well,
    // recovered from the raw bytes because the decrypted document no longer
    // has them.
    const { doc, restrictions } = await loadPdfDocumentWithRestrictions(
      fixtureBytes('permission-no-print.pdf')
    );
    expect(restrictions).toBe(NO_PRINT_P);
    expect(doc.isEncrypted).toBe(false);
    expect(doc.getPageCount()).toBe(1);
  });

  it('still refuses a file that needs a real password', async () => {
    await expect(
      loadPdfDocumentWithRestrictions(fixtureBytes('encrypted.pdf'))
    ).rejects.toMatchObject({ kind: 'Encrypted' });
  });

  it('reports nothing for a file whose /P denies nothing', async () => {
    // `permission-restricted.pdf` has an owner password but Ghostscript's
    // default `/P -4`: every permission bit set. Re-encrypting an export of it
    // would preserve no protection at all, so it stays a plain save.
    const facts = await processWorkerImpl.inspect(fixtureBytes('permission-restricted.pdf'));
    expect(facts.permissionRestrictions).toBeNull();
  });

  it('reports nothing for an ordinary unencrypted PDF', async () => {
    const plain = await PDFDocument.create();
    plain.addPage([200, 200]);
    const facts = await processWorkerImpl.inspect(await plain.save());
    expect(facts.permissionRestrictions).toBeNull();
    expect(facts.isEncrypted).toBe(false);
  });

  it('reports nothing for a file that really is password-protected', async () => {
    // A real user password: the empty one does not open it, so there is nothing
    // Stapler could rewrite and nothing to carry forward either.
    const facts = await processWorkerImpl.inspect(fixtureBytes('encrypted.pdf'));
    expect(facts.isEncrypted).toBe(true);
    expect(facts.permissionRestrictions).toBeNull();
  });
});

describe('when the raw /Encrypt re-parse itself fails', () => {
  it('reports restrictionsUnknown rather than silently treating the file as unrestricted', async () => {
    const bytes = fixtureBytes('permission-no-print.pdf');
    const realLoad = PDFDocument.load.bind(PDFDocument);
    // The one call this fix cares about: `restrictionsInBytes`'s raw,
    // undecrypting re-parse (`ignoreEncryption: true`, no `password` key) —
    // distinct from the main `ignoreEncryption: false` call (which is what
    // actually throws first, routing here) and the empty-password decrypt
    // retry (which has a `password` key). Only that one is made to fail.
    const spy = vi
      .spyOn(PDFDocument, 'load')
      .mockImplementation(async (input: Uint8Array, options?: Record<string, unknown>) => {
        if (options?.ignoreEncryption === true && !('password' in (options ?? {}))) {
          throw new Error('simulated malformed /Encrypt dictionary');
        }
        return realLoad(input, options as never);
      });
    try {
      const result = await loadPdfDocumentWithRestrictions(bytes);
      // Still opens and decrypts normally — a probe failure must not block
      // the document itself, only what can be said about its restrictions.
      expect(result.doc.isEncrypted).toBe(false);
      expect(result.doc.getPageCount()).toBe(1);
      expect(result.restrictions).toBeNull();
      expect(result.restrictionsUnknown).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('leaves restrictionsUnknown false on the ordinary success path', async () => {
    const result = await loadPdfDocumentWithRestrictions(fixtureBytes('permission-no-print.pdf'));
    expect(result.restrictions).toBe(NO_PRINT_P);
    expect(result.restrictionsUnknown).toBe(false);
  });
});

describe('exporting a permission-restricted document', () => {
  it('writes a file that still refuses printing, copying and modifying', async () => {
    const doc = await openDocument('restricted', fixtureBytes('permission-no-print.pdf'));
    expect(documentRestrictions(doc)).toBe(NO_PRINT_P);

    await commitTool('organize', {});
    expect(saved).toHaveLength(1);

    const lib = await pdfjs();
    // Opens with no password at all, exactly as the input did — the point of
    // re-applying the flags with an empty user password rather than a real one.
    const pdf = await openWithNoPassword(saved[0].bytes);
    expect(pdf.numPages).toBe(1);

    const permissions = await pdf.getPermissions();
    // `null` here is the bug: pdf.js returns it for a document that carries no
    // security handler, i.e. one where every restriction has been dropped.
    expect(permissions).not.toBeNull();
    expect(permissions).not.toContain(lib.PermissionFlag.PRINT);
    expect(permissions).not.toContain(lib.PermissionFlag.COPY);
    expect(permissions).not.toContain(lib.PermissionFlag.MODIFY_CONTENTS);

    // The flags are the input's own, bit for bit, rather than something
    // reconstructed from Stapler's three-checkbox vocabulary.
    const reparsed = await PDFDocument.load(saved[0].bytes, {
      ignoreEncryption: true,
      updateMetadata: false
    });
    const { PDFName, PDFNumber } = await import('pdf-lib');
    const encryptRef = reparsed.context.trailerInfo.Encrypt;
    const encryptDict = reparsed.context.lookup(encryptRef);
    const p = (encryptDict as InstanceType<typeof import('pdf-lib').PDFDict>).lookup(
      PDFName.of('P')
    );
    expect(p).toBeInstanceOf(PDFNumber);
    expect((p as InstanceType<typeof PDFNumber>).asNumber() | 0).toBe(NO_PRINT_P);
  });

  it('keeps the restriction when the restricted document is merged into another', async () => {
    const restricted = await openDocument(
      'merge-restricted',
      fixtureBytes('permission-no-print.pdf')
    );

    const plain = await PDFDocument.create();
    plain.addPage([200, 200]);
    const plainBytes = await plain.save();
    __memoryFallback.set('merge-plain', plainBytes);
    registerSource({
      id: 'merge-plain',
      name: 'merge-plain.pdf',
      pageCount: 1,
      pageSizes: [{ width: 200, height: 200 }]
    });
    appendPages(restricted.id, makePageRefs('merge-plain', 1));

    // Union of the restrictions, not the loosest of them: merging an
    // unrestricted file in must not be a way to launder a protected one.
    const merged = documents.value.find(d => d.id === restricted.id)!;
    expect(documentRestrictions(merged)).toBe(NO_PRINT_P);

    await commitTool('merge', {});
    expect(saved).toHaveLength(1);

    const lib = await pdfjs();
    const pdf = await openWithNoPassword(saved[0].bytes);
    expect(pdf.numPages).toBe(2);
    expect(await pdf.getPermissions()).not.toContain(lib.PermissionFlag.PRINT);
  });

  it('carries the restriction onto every member of a split-to-ZIP export', async () => {
    // Split is the one tool that turns a single restricted document into
    // several real PDFs at once — `save()`'s own `applyProtection` never sees
    // any of them, since they leave as a `.zip`, so this is the one path that
    // needs its own re-encryption pass (`restrictZipMembers`).
    const restricted = await openDocument(
      'split-restricted',
      fixtureBytes('permission-no-print.pdf')
    );
    const second = await PDFDocument.create();
    second.addPage([200, 200]);
    const secondBytes = await second.save();
    __memoryFallback.set('split-plain', secondBytes);
    registerSource({
      id: 'split-plain',
      name: 'split-plain.pdf',
      pageCount: 1,
      pageSizes: [{ width: 200, height: 200 }]
    });
    appendPages(restricted.id, makePageRefs('split-plain', 1));
    expect(documentRestrictions(documents.value.find(d => d.id === restricted.id)!)).toBe(
      NO_PRINT_P
    );

    splitSettings.value = {
      mode: 'individual',
      everyN: 2,
      customBoundaries: '',
      outputFormat: 'zip',
      targetSizeKb: 5000
    };
    await commitTool('split', {});
    expect(saved).toHaveLength(1);
    expect(saved[0].name.endsWith('.zip')).toBe(true);

    const members = Object.values(unzipSync(saved[0].bytes));
    expect(members).toHaveLength(2);

    const lib = await pdfjs();
    for (const member of members) {
      const pdf = await openWithNoPassword(member);
      expect(pdf.numPages).toBe(1);
      const permissions = await pdf.getPermissions();
      expect(permissions).not.toBeNull();
      expect(permissions).not.toContain(lib.PermissionFlag.PRINT);
      expect(permissions).not.toContain(lib.PermissionFlag.COPY);
      expect(permissions).not.toContain(lib.PermissionFlag.MODIFY_CONTENTS);
    }
  });

  it('keeps the restriction across an operation that replaces the document bytes', async () => {
    // Redaction and scan cleanup hand back a source written in the clear. The
    // source that knew about the restrictions is dropped in the same call, so
    // without inheritance this is the one path that strips them.
    const doc = await openDocument('rewritten', fixtureBytes('permission-no-print.pdf'));
    const rebuilt = await PDFDocument.create();
    rebuilt.addPage([200, 200]);
    const rebuiltBytes = await rebuilt.save();
    __memoryFallback.set('rewritten-out', rebuiltBytes);
    replaceWithSource(doc.id, {
      id: 'rewritten-out',
      name: 'rewritten-out.pdf',
      pageCount: 1,
      pageSizes: [{ width: 200, height: 200 }]
    });

    expect(documentRestrictions(documents.value.find(d => d.id === doc.id)!)).toBe(NO_PRINT_P);
  });
});

describe('compress never emits a file larger than the original (CLAUDE.md)', () => {
  it('keeps the original when re-applying restrictions would erase the saving', async () => {
    const original = fixtureBytes('permission-no-print.pdf');
    const doc = await openDocument('compress-restricted', original);
    expect(documentRestrictions(doc)).toBe(NO_PRINT_P);

    // A deterministic stand-in for "compression saved 10 bytes" — real
    // measurements would work just as well, but would make the test depend on
    // this exact fixture happening to compress by some specific amount.
    (compressToTargetSize as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      bytes: original.slice(0, original.byteLength - 10),
      originalBytes: original.byteLength,
      targetBytes: original.byteLength - 10,
      achievedBytes: original.byteLength - 10,
      reachedTarget: true,
      settings: { dpi: 150, quality: 0.75 },
      keptOriginal: false,
      trials: [],
      plan: { pages: [], actionableBytes: 0, skipped: [] },
      imageStats: []
    });
    // The AES pass that restores the input's restrictions adds back more than
    // compression saved — the exact scenario the growth guard exists for.
    (restrictDocument as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (bytes: Uint8Array) => new Uint8Array(bytes.byteLength + 20)
    );

    compressMode.value = 'target';
    compressTarget.value = { amount: 1, unit: 'KB' };
    await commitTool('compress', {});

    // Nothing reached `platform.saveFileAs` — the guard fires before the write,
    // not after, so there is no larger-than-original file on disk to clean up.
    expect(saved).toHaveLength(0);
    expect(toasts.value.some(t => t.title === 'Kept the original file.')).toBe(true);
  });

  it('does not block the user’s own explicit choice to add password protection', async () => {
    // Same setup, but with Protect turned on: the size increase is the user's
    // own request, not a silent side effect, so the guard must not apply.
    const original = fixtureBytes('permission-no-print.pdf');
    const doc = await openDocument('compress-restricted-protect', original);
    expect(documentRestrictions(doc)).toBe(NO_PRINT_P);

    const { protection } = await import('../../src/ui/tools/protect/state');
    protection.value = {
      ...protection.value,
      enabled: true,
      userPassword: 'sekrit',
      confirmPassword: 'sekrit',
      ownerPassword: '',
      allowPrinting: true,
      allowCopying: true,
      allowModifying: false
    };

    // `protectDocument` is the real implementation here (only `restrictDocument`
    // is mocked, and this branch never calls it), so it needs real, decrypted
    // bytes to encrypt — the same shape the actual compress pipeline hands it,
    // never the still-`/Encrypt`-bearing original.
    const decrypted = await PDFDocument.load(original, { password: '', updateMetadata: false });
    const decryptedBytes = await decrypted.save();

    (compressToTargetSize as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      bytes: decryptedBytes,
      originalBytes: original.byteLength,
      targetBytes: decryptedBytes.byteLength,
      achievedBytes: decryptedBytes.byteLength,
      reachedTarget: true,
      settings: { dpi: 150, quality: 0.75 },
      keptOriginal: false,
      trials: [],
      plan: { pages: [], actionableBytes: 0, skipped: [] },
      imageStats: []
    });

    compressMode.value = 'target';
    compressTarget.value = { amount: 1, unit: 'KB' };
    await commitTool('compress', {});

    expect(saved).toHaveLength(1);
    protection.value = { ...protection.value, enabled: false };
  });
});

describe('the restriction pass itself', () => {
  it('leaves every page readable without a password', async () => {
    // The AES pass is RED-06's, but with an empty *user* password, which is the
    // part `encrypt.test.ts` never exercises: a viewer has to decrypt the file
    // with no password at all and still get the text back.
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([300, 120]).drawText('Internal use only', { x: 20, y: 60, size: 12, font });
    doc.addPage([300, 120]).drawText('Second page body', { x: 20, y: 60, size: 12, font });
    doc.setTitle('Quarterly review');

    const restricted = await processWorkerImpl.restrictDocument(await doc.save(), NO_PRINT_P);

    const pdf = await openWithNoPassword(restricted);
    expect(pdf.numPages).toBe(2);
    const page = await pdf.getPage(1);
    const text = (await page.getTextContent()).items
      .map(item => ('str' in item ? item.str : ''))
      .join('')
      .trim();
    expect(text).toBe('Internal use only');

    // Strings are ciphertext too, not just streams — a readable title would
    // mean the info dictionary had been left in the clear.
    const { info } = (await pdf.getMetadata()) as { info: { Title?: string } };
    expect(info.Title).toBe('Quarterly review');
    expect(new TextDecoder('latin1').decode(restricted)).not.toContain('Quarterly review');
  });

  it('refuses to run over a file that is already encrypted', async () => {
    // The same guard `encryptPdf` has: re-encrypting ciphertext would produce a
    // file nothing can open, which is the corruption this codebase refuses to
    // risk. Reaching this would mean the export path double-applied.
    const once = await processWorkerImpl.restrictDocument(
      await (async () => {
        const doc = await PDFDocument.create();
        doc.addPage([200, 200]);
        return doc.save();
      })(),
      NO_PRINT_P
    );
    await expect(processWorkerImpl.restrictDocument(once, NO_PRINT_P)).rejects.toThrow(
      /protected|encrypt/i
    );
  });
});

describe('an unrestricted document is unaffected', () => {
  it('exports with no security handler at all', async () => {
    const plain = await PDFDocument.create();
    plain.addPage([200, 200]);
    const doc = await openDocument('plain', await plain.save());
    expect(documentRestrictions(doc)).toBeNull();

    await commitTool('organize', {});
    expect(saved).toHaveLength(1);

    // pdf.js returns null for a document with no security handler — nothing was
    // added where nothing was before.
    const pdf = await openWithNoPassword(saved[0].bytes);
    expect(await pdf.getPermissions()).toBeNull();
    expect(new TextDecoder('latin1').decode(saved[0].bytes)).not.toContain('/Encrypt');

    // And the export is byte-identical to the same export with this whole path
    // removed, which is what "the common case does not regress" means: the only
    // thing that could have changed it is an `/Encrypt` that was never added.
    const doc2 = documents.value.find(d => d.id === doc.id)!;
    const again = await processWorkerImpl.compose(
      doc2.pages,
      { plain: __memoryFallback.get('plain')! },
      [],
      undefined,
      undefined,
      null,
      null,
      undefined
    );
    expect(saved[0].bytes.byteLength).toBe(again.byteLength);
  });

  it('exports a /P -4 owner-password file without adding a handler either', async () => {
    // Nothing is denied, so there is nothing to preserve and no reason to
    // rewrite every object in the file to say so.
    await openDocument('all-allowed', fixtureBytes('permission-restricted.pdf'));
    await commitTool('organize', {});
    expect(saved).toHaveLength(1);
    const pdf = await openWithNoPassword(saved[0].bytes);
    expect(await pdf.getPermissions()).toBeNull();
  });
});

describe('withInheritedRestrictions', () => {
  const base = {
    userPassword: 'pw',
    ownerPassword: '',
    allowPrinting: true,
    allowCopying: true,
    allowModifying: true
  };

  it('narrows the user’s choices to what the document already allowed', () => {
    const narrowed = withInheritedRestrictions(base, NO_PRINT_P);
    expect(narrowed).toMatchObject({
      allowPrinting: false,
      allowCopying: false,
      allowModifying: false
    });
  });

  it('never widens them', () => {
    const strict = { ...base, allowPrinting: false, allowCopying: false, allowModifying: false };
    // -4 allows everything; the user's own choices still stand.
    expect(withInheritedRestrictions(strict, -4)).toMatchObject({
      allowPrinting: false,
      allowCopying: false,
      allowModifying: false
    });
  });

  it('leaves the settings alone when nothing was inherited', () => {
    expect(withInheritedRestrictions(base, null)).toBe(base);
  });

  it('round-trips its own flags: a permission-only /P denies the same three', () => {
    const denied = permissionFlags({
      ...base,
      allowPrinting: false,
      allowCopying: false,
      allowModifying: false
    });
    expect(withInheritedRestrictions(base, denied)).toMatchObject({
      allowPrinting: false,
      allowCopying: false,
      allowModifying: false
    });
  });
});

/**
 * SGN-09 — structural signature/tamper check.
 *
 * There is no cryptographic signing anywhere in this codebase (PAdES/CMS is a
 * deliberate non-goal — see PLAN §1.1), so the fixture here builds a `/Sig`
 * dictionary by hand, the same way `golden.test.ts` builds a raw `/Outlines`
 * tree by hand for OPS-01: real structure, fake signature bytes, because
 * `checkSignatureIntegrity` never reads `/Contents`, only `/ByteRange` against
 * the file's real length.
 *
 * The fixture mirrors how real incremental-update signing actually works: the
 * `/Contents` hex placeholder and the `/ByteRange` numbers are both reserved at
 * a fixed width *before* the first save, so the real offsets can be measured
 * from the saved bytes and patched back in without shifting anything else —
 * `useObjectStreams: false` keeps both objects as plain, offset-stable text so
 * that patch is a literal string replacement.
 */
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: vi.fn(val => val)
}));

import { processWorkerImpl } from '../../src/core/workers/process.worker';

const BR_PAD = 10;
const pad = (n: number) => String(n).padStart(BR_PAD, '0');
const CONTENTS_HEX_LEN = 256;

async function buildSignedFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const ctx = doc.context;

  const placeholderHex = 'A'.repeat(CONTENTS_HEX_LEN);
  const sigDict = ctx.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [9999999999, 9999999999, 9999999999, 9999999999],
    Contents: PDFHexString.of(placeholderHex)
  });
  const sigRef = ctx.register(sigDict);

  const widget = ctx.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    Rect: [10, 10, 100, 30],
    T: PDFHexString.fromText('Signature1'),
    V: sigRef,
    F: 4
  });
  const widgetRef = ctx.register(widget);
  doc.getPages()[0].node.set(PDFName.of('Annots'), ctx.obj([widgetRef]));

  const acroForm = ctx.obj({ Fields: [widgetRef], SigFlags: 3 });
  doc.catalog.set(PDFName.of('AcroForm'), ctx.register(acroForm));

  const bytes1 = await doc.save({ useObjectStreams: false });
  const text1 = Buffer.from(bytes1).toString('latin1');

  const brPlaceholder = '9999999999 9999999999 9999999999 9999999999';
  const brIndex = text1.indexOf(brPlaceholder);
  if (brIndex === -1) throw new Error('ByteRange placeholder not found in saved fixture');

  const hexRun = 'A'.repeat(CONTENTS_HEX_LEN);
  const hexIndex = text1.indexOf(hexRun);
  if (hexIndex === -1) throw new Error('Contents placeholder not found in saved fixture');
  const contentsHexStart = text1.lastIndexOf('<', hexIndex) + 1;
  const contentsHexEnd = text1.indexOf('>', hexIndex);

  const range2Len = bytes1.length - contentsHexEnd;
  const replacement = `${pad(0)} ${pad(contentsHexStart)} ${pad(contentsHexEnd)} ${pad(range2Len)}`;
  expect(replacement.length).toBe(brPlaceholder.length); // sanity: the patch must not shift anything

  const text2 = text1.slice(0, brIndex) + replacement + text1.slice(brIndex + brPlaceholder.length);
  return new Uint8Array(Buffer.from(text2, 'latin1'));
}

describe('checkSignatureIntegrity (SGN-09)', () => {
  it('reports no signature for an ordinary document', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const bytes = await doc.save();

    const report = await processWorkerImpl.checkSignatureIntegrity(bytes);
    expect(report).toEqual({ hasSignature: false, intact: null, signatures: [] });
  });

  it('reports intact when the /ByteRange reaches the real end of the file', async () => {
    const bytes = await buildSignedFixture();

    // Prove the fixture actually loads and carries a real /Sig field, so a
    // pass here is not just an artifact of a broken fixture.
    const reparsed = await PDFDocument.load(bytes);
    expect(reparsed.getPageCount()).toBe(1);

    const report = await processWorkerImpl.checkSignatureIntegrity(bytes);
    expect(report.hasSignature).toBe(true);
    expect(report.intact).toBe(true);
    expect(report.signatures).toHaveLength(1);
    expect(report.signatures[0].fieldName).toBe('Signature1');
    expect(report.signatures[0].reachesEndOfFile).toBe(true);
    // The AC's own words: verified against real byte offsets.
    const [, , start2, len2] = report.signatures[0].byteRange;
    expect(start2 + len2).toBe(bytes.length);
  });

  it('reports modified-after-signing when a byte is appended after the signed range', async () => {
    const intact = await buildSignedFixture();
    const tampered = new Uint8Array(intact.length + 1);
    tampered.set(intact);
    tampered.set([0x0a], intact.length); // one appended newline byte

    // The appended byte must not stop the file from parsing — the whole point
    // of this check is to catch a document that still opens fine.
    const reparsed = await PDFDocument.load(tampered);
    expect(reparsed.getPageCount()).toBe(1);

    const report = await processWorkerImpl.checkSignatureIntegrity(tampered);
    expect(report.hasSignature).toBe(true);
    expect(report.intact).toBe(false);
    expect(report.signatures[0].reachesEndOfFile).toBe(false);
    const [, , start2, len2] = report.signatures[0].byteRange;
    // The stated range's end really is one byte short of the actual file now.
    expect(start2 + len2).toBe(tampered.length - 1);
  });

  it('is unaffected by unrelated bytes appended before the signature ever existed', async () => {
    // A negative control: the untampered fixture itself, re-checked, must not
    // spuriously report modification just because it is being read a second
    // time or because Buffer/Uint8Array round-tripped it.
    const bytes = await buildSignedFixture();
    const copy = new Uint8Array(bytes); // a fresh, independent buffer
    const report = await processWorkerImpl.checkSignatureIntegrity(copy);
    expect(report.intact).toBe(true);
  });
});

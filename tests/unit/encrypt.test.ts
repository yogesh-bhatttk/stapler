import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { encryptPdf, permissionFlags, type ProtectionSettings } from '../../src/core/pdf/encrypt';

// The worker module calls `Comlink.expose` at import time, which needs a real
// message port. Same stub `process.test.ts` uses to import the implementation.
vi.mock('comlink', () => ({ expose: vi.fn(), transfer: vi.fn(value => value) }));
import { processWorkerImpl } from '../../src/core/workers/process.worker';

/**
 * RED-06's acceptance criterion, proved against real bytes.
 *
 * pdf.js is the verifier because it implements the standard security handler in
 * full — it is the same decoder Chrome's viewer descends from, and unlike pdf-lib
 * it can actually be handed a password. "The header says /Encrypt" would prove
 * nothing; every assertion below turns on whether the content decrypts.
 */
type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let cached: PdfjsModule | undefined;
async function pdfjs(): Promise<PdfjsModule> {
  cached ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  return cached;
}

const PAGE_ONE = 'Confidential quarterly figures';
const PAGE_TWO = 'Second page body text';

async function samplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const first = doc.addPage([400, 200]);
  first.drawText(PAGE_ONE, { x: 20, y: 150, size: 12, font });
  const second = doc.addPage([400, 200]);
  second.drawText(PAGE_TWO, { x: 20, y: 150, size: 12, font });
  doc.setTitle('Board pack');
  return doc.save();
}

const SETTINGS: ProtectionSettings = {
  userPassword: 'open-sesame',
  ownerPassword: 'owner-key',
  allowPrinting: false,
  allowCopying: false,
  allowModifying: false
};

async function open(bytes: Uint8Array, password?: string) {
  const lib = await pdfjs();
  // getDocument transfers the buffer, so each attempt gets its own copy.
  return lib.getDocument({ data: bytes.slice(), password, useSystemFonts: false }).promise;
}

async function pageText(
  pdf: Awaited<ReturnType<typeof open>>,
  pageNumber: number
): Promise<string> {
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  return content.items
    .map(item => ('str' in item ? item.str : ''))
    .join('')
    .trim();
}

describe('encryptPdf', () => {
  it('produces a file that cannot be opened without the password', async () => {
    const encrypted = await encryptPdf(await samplePdf(), SETTINGS);

    await expect(open(encrypted)).rejects.toMatchObject({ name: 'PasswordException' });
    await expect(open(encrypted, 'not-the-password')).rejects.toMatchObject({
      name: 'PasswordException'
    });
  });

  it('opens with the user password and every page decrypts intact', async () => {
    const encrypted = await encryptPdf(await samplePdf(), SETTINGS);

    const pdf = await open(encrypted, SETTINGS.userPassword);
    expect(pdf.numPages).toBe(2);
    expect(await pageText(pdf, 1)).toBe(PAGE_ONE);
    expect(await pageText(pdf, 2)).toBe(PAGE_TWO);

    // Strings are encrypted too, not just streams: a readable title in the
    // output would mean the info dictionary had been left in the clear.
    const { info } = (await pdf.getMetadata()) as { info: { Title?: string } };
    expect(info.Title).toBe('Board pack');
    expect(new TextDecoder('latin1').decode(encrypted)).not.toContain('Board pack');
  });

  it('opens with the owner password as well', async () => {
    const encrypted = await encryptPdf(await samplePdf(), SETTINGS);
    const pdf = await open(encrypted, SETTINGS.ownerPassword);
    expect(pdf.numPages).toBe(2);
    expect(await pageText(pdf, 1)).toBe(PAGE_ONE);
  });

  it('carries the permission set the caller asked for', async () => {
    const lib = await pdfjs();
    const encrypted = await encryptPdf(await samplePdf(), {
      ...SETTINGS,
      allowPrinting: true,
      allowCopying: false,
      allowModifying: false
    });

    const pdf = await open(encrypted, SETTINGS.userPassword);
    const permissions = (await pdf.getPermissions()) ?? [];
    expect(permissions).toContain(lib.PermissionFlag.PRINT);
    expect(permissions).not.toContain(lib.PermissionFlag.COPY);
    expect(permissions).not.toContain(lib.PermissionFlag.MODIFY_CONTENTS);
  });

  it('leaves the source bytes untouched', async () => {
    const plain = await samplePdf();
    const before = plain.slice();
    await encryptPdf(plain, SETTINGS);
    expect(plain).toEqual(before);

    // And the unprotected original still opens with no password at all.
    const pdf = await open(before);
    expect(await pageText(pdf, 1)).toBe(PAGE_ONE);
  });

  it('refuses to encrypt without a password, and refuses an already-encrypted file', async () => {
    const plain = await samplePdf();
    await expect(encryptPdf(plain, { ...SETTINGS, userPassword: '' })).rejects.toThrow(/password/i);

    const once = await encryptPdf(plain, SETTINGS);
    await expect(encryptPdf(once, SETTINGS)).rejects.toThrow(/protected|encrypt/i);
  });

  it('is reachable through the process worker, which is how export calls it', async () => {
    const encrypted = await processWorkerImpl.protectDocument(await samplePdf(), SETTINGS);
    await expect(open(encrypted)).rejects.toMatchObject({ name: 'PasswordException' });
    const pdf = await open(encrypted, SETTINGS.userPassword);
    expect(await pageText(pdf, 1)).toBe(PAGE_ONE);
  });

  it('sets the reserved permission bits the spec requires', () => {
    const all = permissionFlags({
      ...SETTINGS,
      allowPrinting: true,
      allowCopying: true,
      allowModifying: true
    });
    expect(all & 0b11).toBe(0); // bits 1-2 reserved, must be clear
    expect(all & (1 << 6)).not.toBe(0); // bits 7-8 reserved, must be set
    expect(all & (1 << 9)).not.toBe(0); // bit 10 must stay set
    expect(permissionFlags({ ...SETTINGS, allowPrinting: false }) & (1 << 2)).toBe(0);
  });
});

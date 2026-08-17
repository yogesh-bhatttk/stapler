import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFileSync } from 'node:fs';
import {
  ENCRYPT_CHECKPOINT_OBJECTS,
  encryptPdf,
  permissionFlags,
  type ProtectionSettings
} from '../../src/core/pdf/encrypt';
import type { JobPort } from '../../src/core/workers/protocol';

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

  /**
   * The AES pass used to be one uninterruptible loop over every indirect object:
   * `protectDocument` could only be cancelled before it started or after it
   * finished, so "Cancel" on a large document ran the whole encryption anyway.
   *
   * These assertions are about *where the loop got to*, not about wall-clock
   * time, which is too noisy to assert on in CI. The loop names the object it is
   * about to encrypt in its progress label, so the last label observed is a
   * direct, deterministic measurement of how far it ran.
   */
  describe('cancellation inside the object loop', () => {
    const LARGE = 'tests/fixtures/text-300.pdf';

    function tracker(cancelAfterChecks: number) {
      const labels: string[] = [];
      const fractions: (number | null)[] = [];
      let checks = 0;
      const port: JobPort = {
        progress(fraction, label) {
          fractions.push(fraction);
          labels.push(label);
        },
        cancelled() {
          checks += 1;
          return checks > cancelAfterChecks;
        }
      };
      const reached = () => {
        const last = labels[labels.length - 1];
        const match = last?.match(/^Encrypting object (\d+) of (\d+)$/);
        return match ? { at: Number(match[1]), total: Number(match[2]) } : null;
      };
      return { port, labels, fractions, reached, checkCount: () => checks };
    }

    it('checks for cancellation repeatedly during the loop, not once at each end', async () => {
      const bytes = new Uint8Array(readFileSync(LARGE));
      const doc = await PDFDocument.load(bytes, {
        ignoreEncryption: false,
        updateMetadata: false
      });
      const total = doc.context.enumerateIndirectObjects().length;
      // The fixture has to be big enough for the object gate to trip at all,
      // otherwise this test would pass against the old single-shot loop.
      expect(total).toBeGreaterThan(ENCRYPT_CHECKPOINT_OBJECTS * 4);

      const t = tracker(Number.POSITIVE_INFINITY);
      await encryptPdf(bytes, SETTINGS, t.port);

      // One check per gate trip: at minimum the object-count floor.
      expect(t.checkCount()).toBeGreaterThanOrEqual(Math.floor(total / ENCRYPT_CHECKPOINT_OBJECTS));
      // Progress is monotonic and stays inside its own 0..1 span.
      const numeric = t.fractions.filter((f): f is number => f !== null);
      expect(numeric.every(f => f >= 0 && f <= 1)).toBe(true);
      expect([...numeric].sort((a, b) => a - b)).toEqual(numeric);
    });

    it('stops well before completion when the caller aborts partway', async () => {
      const bytes = new Uint8Array(readFileSync(LARGE));
      const before = bytes.slice();

      // Abort at the second cancellation check, i.e. after roughly two gates.
      const t = tracker(1);
      await expect(encryptPdf(bytes, SETTINGS, t.port)).rejects.toMatchObject({
        kind: 'UserCancelled'
      });

      const reached = t.reached();
      expect(reached).not.toBeNull();
      // The whole point: it stopped near the start, not at the end.
      expect(reached!.at).toBeLessThan(reached!.total / 4);
      expect(reached!.at).toBeLessThanOrEqual(ENCRYPT_CHECKPOINT_OBJECTS * 3);

      // And an abort mid-encryption leaves the caller's input byte-identical —
      // no half-encrypted document is ever handed back or written over the
      // original.
      expect(bytes).toEqual(before);
    });

    it('honours a signal that is already aborted before the first object', async () => {
      const bytes = new Uint8Array(readFileSync(LARGE));
      const t = tracker(0);
      await expect(encryptPdf(bytes, SETTINGS, t.port)).rejects.toMatchObject({
        kind: 'UserCancelled'
      });
      const reached = t.reached();
      // Nothing was reported at all, or only the very first gate.
      expect(reached === null || reached.at <= ENCRYPT_CHECKPOINT_OBJECTS).toBe(true);
    });

    it('maps the encryption span into the caller-visible 0.1–0.95 band', async () => {
      const { processWorkerImpl: impl } = await import('../../src/core/workers/process.worker');
      const fractions: (number | null)[] = [];
      const port: JobPort = {
        progress(fraction) {
          fractions.push(fraction);
        },
        cancelled: () => false
      };
      await impl.protectDocument(new Uint8Array(readFileSync(LARGE)), SETTINGS, port);

      const inner = fractions.filter((f): f is number => f !== null && f > 0.1 && f < 1);
      expect(inner.length).toBeGreaterThan(0);
      expect(Math.min(...inner)).toBeGreaterThanOrEqual(0.1);
      expect(Math.max(...inner)).toBeLessThanOrEqual(0.95);
      // The bar still ends at 1, so the UI does not stall at 95%.
      expect(fractions[fractions.length - 1]).toBe(1);
    });

    it('cancelling through the worker entry point leaves the input untouched', async () => {
      const { processWorkerImpl: impl } = await import('../../src/core/workers/process.worker');
      const bytes = new Uint8Array(readFileSync(LARGE));
      const before = bytes.slice();
      let checks = 0;
      const port: JobPort = {
        progress() {},
        cancelled: () => ++checks > 3
      };
      await expect(impl.protectDocument(bytes, SETTINGS, port)).rejects.toMatchObject({
        kind: 'UserCancelled'
      });
      expect(bytes).toEqual(before);
    });
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

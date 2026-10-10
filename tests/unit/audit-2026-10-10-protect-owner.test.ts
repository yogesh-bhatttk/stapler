/**
 * AUDIT-2026-10-10 S1/P7 — an empty owner password must not make the open
 * password the owner password while permissions are withheld.
 *
 * Revision 6 checks the owner password first (Algorithm 2.A): a password that
 * validates against `/O` gets full rights whatever `/P` says. So the test is
 * Algorithm 2.B itself, run here independently of `encrypt.ts` with Node's own
 * crypto, against the `/O` and `/U` entries actually written to the file.
 */
import { describe, expect, it } from 'vitest';
import { createCipheriv, createHash } from 'node:crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { encryptPdf, type ProtectionSettings } from '../../src/core/pdf/encrypt';

async function plainPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 200]).drawText('Owner password check', { x: 20, y: 150, size: 12, font });
  return doc.save({ useObjectStreams: false });
}

/** `/O` and `/U` from the trailer's `/Encrypt` dictionary, as written. */
function encryptEntries(bytes: Uint8Array): { o: Buffer; u: Buffer } {
  const text = Buffer.from(bytes).toString('latin1');
  const get = (key: string) => {
    const match = new RegExp(`/${key}\\s*<([0-9A-Fa-f]+)>`).exec(text);
    if (!match) throw new Error(`no /${key} hex string in the output`);
    return Buffer.from(match[1], 'hex');
  };
  return { o: get('O'), u: get('U') };
}

/** ISO 32000-2 Algorithm 2.B, written from the spec rather than from encrypt.ts. */
function hash2B(password: Buffer, salt: Buffer, extra: Buffer): Buffer {
  let k = createHash('sha256')
    .update(Buffer.concat([password, salt, extra]))
    .digest();
  for (let round = 0; ; round++) {
    const k1 = Buffer.concat(Array(64).fill(Buffer.concat([password, k, extra])));
    const cipher = createCipheriv('aes-128-cbc', k.subarray(0, 16), k.subarray(16, 32));
    cipher.setAutoPadding(false);
    const e = Buffer.concat([cipher.update(k1), cipher.final()]);
    let sum = 0;
    for (let i = 0; i < 16; i++) sum += e[i];
    k = createHash(['sha256', 'sha384', 'sha512'][sum % 3])
      .update(e)
      .digest();
    if (round >= 63 && e[e.length - 1] <= round - 31) break;
  }
  return k.subarray(0, 32);
}

function validates(bytes: Uint8Array, password: string) {
  const { o, u } = encryptEntries(bytes);
  const pw = Buffer.from(password, 'utf8');
  return {
    owner: hash2B(pw, o.subarray(32, 40), u.subarray(0, 48)).equals(o.subarray(0, 32)),
    user: hash2B(pw, u.subarray(32, 40), Buffer.alloc(0)).equals(u.subarray(0, 32))
  };
}

const BASE: ProtectionSettings = {
  userPassword: 'open-sesame',
  ownerPassword: '',
  allowPrinting: true,
  allowCopying: true,
  allowModifying: true
};

describe('Protect with an empty owner password (S1/P7)', () => {
  it('the hash check above is sound: an explicit owner password validates as owner', async () => {
    const out = await encryptPdf(await plainPdf(), {
      ...BASE,
      ownerPassword: 'owner-key',
      allowPrinting: false
    });
    expect(validates(out, 'owner-key')).toEqual({ owner: true, user: false });
    expect(validates(out, 'open-sesame')).toEqual({ owner: false, user: true });
  }, 30_000);

  for (const [label, patch] of [
    ['printing', { allowPrinting: false }],
    ['copying', { allowCopying: false }],
    ['editing', { allowModifying: false }]
  ] as const) {
    it(`with ${label} withheld, the open password is not the owner password`, async () => {
      const out = await encryptPdf(await plainPdf(), { ...BASE, ...patch });
      // Before the fix this was { owner: true, user: true }: whoever could open
      // the file was its owner, and the unticked box restricted nobody.
      expect(validates(out, 'open-sesame')).toEqual({ owner: false, user: true });
      // Nor does an empty owner password unlock it.
      expect(validates(out, '').owner).toBe(false);
    }, 30_000);
  }

  it('two exports draw different random owner passwords', async () => {
    const plain = await plainPdf();
    const a = encryptEntries(await encryptPdf(plain, { ...BASE, allowPrinting: false }));
    const b = encryptEntries(await encryptPdf(plain, { ...BASE, allowPrinting: false }));
    expect(a.o.equals(b.o)).toBe(false);
  }, 30_000);

  it('with every permission allowed, the open password is still reused as owner', async () => {
    const out = await encryptPdf(await plainPdf(), BASE);
    expect(validates(out, 'open-sesame')).toEqual({ owner: true, user: true });
  }, 30_000);

  it('still opens with the open password in pdf.js and reports the restriction', async () => {
    const out = await encryptPdf(await plainPdf(), { ...BASE, allowPrinting: false });
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await pdfjs.getDocument({ data: out.slice(), password: 'open-sesame' }).promise;
    const page = await pdf.getPage(1);
    const text = (await page.getTextContent()).items.map(i => ('str' in i ? i.str : '')).join('');
    expect(text).toContain('Owner password check');
    const permissions = await pdf.getPermissions();
    expect(permissions).not.toBeNull();
    expect(permissions).not.toContain(pdfjs.PermissionFlag.PRINT);
    await pdf.cleanup();
  }, 30_000);
});

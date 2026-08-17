/**
 * RED-06 — the PDF standard security handler, applied at export.
 *
 * This *adds* encryption to a document Stapler already holds in the clear. It is
 * not the password-removal non-goal in PLAN §1.1 turned around: nothing here can
 * open, decrypt, or weaken a protected file, and `encryptPdf` refuses outright if
 * the bytes it is handed are already encrypted.
 *
 * pdf-lib cannot write encrypted documents, so the handler is implemented here
 * against its low-level object model: load the finished bytes, walk every
 * indirect object, replace each string and stream with its ciphertext, register
 * an /Encrypt dictionary, and let pdf-lib serialise the result.
 *
 * Revision 6 / AES-256 (ISO 32000-2, 7.6.4.3) is the algorithm, for two reasons.
 * It needs only primitives WebCrypto actually offers — SHA-2 and AES-CBC — where
 * the older revisions need MD5 and RC4, neither of which WebCrypto provides and
 * both of which would have to be hand-rolled. And it derives one file key used
 * for every object, so there is no per-object key derivation to get subtly wrong.
 *
 * Two WebCrypto shapes have to be worked around, both noted at their call sites:
 * AES-CBC always applies PKCS#7 padding, and there is no ECB mode.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFStream,
  PDFString
} from 'pdf-lib';
import { encrypted, internal } from '../errors';
import { checkpoint, type JobHandle } from '../workers/protocol';

export interface ProtectionSettings {
  /** Required to open the file. Empty means "no open password", which we refuse. */
  userPassword: string;
  /** Grants full rights. Empty means "same as the user password". */
  ownerPassword: string;
  allowPrinting: boolean;
  allowCopying: boolean;
  allowModifying: boolean;
}

export const DEFAULT_PROTECTION: ProtectionSettings = {
  userPassword: '',
  ownerPassword: '',
  allowPrinting: true,
  allowCopying: true,
  allowModifying: false
};

/**
 * The /P permission flags (Table 22). Bit 1 is the low bit of the integer.
 *
 * Bits 1–2 are reserved and must be 0; bits 7–8 and 13–32 are reserved and must
 * be 1, which is why the base is -4 rather than 0. Bit 10 (extraction for
 * accessibility) is deprecated in PDF 2.0 and must stay set.
 */
export function permissionFlags(settings: ProtectionSettings): number {
  let p = -4;
  if (!settings.allowPrinting) p &= ~(1 << 2) & ~(1 << 11); // print, high-quality print
  if (!settings.allowCopying) p &= ~(1 << 4); // copy / extract
  if (!settings.allowModifying) {
    p &= ~(1 << 3); // modify contents
    p &= ~(1 << 5); // add or modify annotations
    p &= ~(1 << 8); // fill in form fields
    p &= ~(1 << 10); // assemble document
  }
  return p | 0;
}

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

function subtle(): SubtleCrypto {
  const api = globalThis.crypto?.subtle;
  if (!api) throw internal('WebCrypto is unavailable, so this document cannot be encrypted.');
  return api;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

async function digest(algorithm: 'SHA-256' | 'SHA-384' | 'SHA-512', data: Uint8Array) {
  return new Uint8Array(await subtle().digest(algorithm, data));
}

async function aesKey(key: Uint8Array, usage: 'encrypt') {
  return subtle().importKey('raw', key, 'AES-CBC', false, [usage]);
}

/**
 * AES-CBC with no padding, which the spec's algorithms 2.A, 2.B, 8 and 9 are all
 * defined in terms of.
 *
 * WebCrypto has no no-padding mode: it always appends one PKCS#7 block. Since
 * every input here is already a multiple of the block size, that extra block is
 * pure padding and dropping it leaves exactly the unpadded ciphertext.
 */
async function aesNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (data.length % 16 !== 0) throw internal('AES no-padding input must be a multiple of 16');
  const out = new Uint8Array(
    await subtle().encrypt({ name: 'AES-CBC', iv }, await aesKey(key, 'encrypt'), data)
  );
  return out.subarray(0, out.length - 16);
}

/** AES-256-CBC with a random IV prepended, which is the /AESV3 stream format. */
async function aesEncrypt(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(16);
  const body = new Uint8Array(
    await subtle().encrypt({ name: 'AES-CBC', iv }, await aesKey(key, 'encrypt'), data)
  );
  return concat(iv, body);
}

/** Passwords are UTF-8 and truncated to 127 bytes (7.6.4.3.3). */
function passwordBytes(password: string): Uint8Array {
  return new TextEncoder().encode(password).subarray(0, 127);
}

/**
 * Algorithm 2.B — the revision-6 password hash.
 *
 * The loop runs at least 64 times and then until the last byte of the round's
 * ciphertext is small enough, which is what makes the hash deliberately slow.
 */
async function hash2B(
  password: Uint8Array,
  salt: Uint8Array,
  extra: Uint8Array
): Promise<Uint8Array> {
  let k = await digest('SHA-256', concat(password, salt, extra));
  let e = new Uint8Array([0]);

  for (let round = 0; round < 64 || e[e.length - 1] > round - 32; round++) {
    const block = concat(password, k, extra);
    const k1 = new Uint8Array(block.length * 64);
    for (let i = 0; i < 64; i++) k1.set(block, i * block.length);

    e = await aesNoPad(k.subarray(0, 16), k.subarray(16, 32), k1);

    let sum = 0;
    for (let i = 0; i < 16; i++) sum += e[i];
    const remainder = sum % 3;
    k = await digest(remainder === 0 ? 'SHA-256' : remainder === 1 ? 'SHA-384' : 'SHA-512', e);
  }

  return k.subarray(0, 32);
}

/* ------------------------------------------------------------------ *
 * The /Encrypt dictionary
 * ------------------------------------------------------------------ */

interface EncryptionKeys {
  fileKey: Uint8Array;
  o: Uint8Array;
  u: Uint8Array;
  oe: Uint8Array;
  ue: Uint8Array;
  perms: Uint8Array;
  p: number;
}

async function deriveKeys(settings: ProtectionSettings): Promise<EncryptionKeys> {
  const fileKey = randomBytes(32);
  const user = passwordBytes(settings.userPassword);
  const owner = passwordBytes(settings.ownerPassword || settings.userPassword);
  const empty = new Uint8Array(0);
  const zeroIv = new Uint8Array(16);

  const uValidation = randomBytes(8);
  const uKeySalt = randomBytes(8);
  const u = concat(await hash2B(user, uValidation, empty), uValidation, uKeySalt);
  const ue = await aesNoPad(await hash2B(user, uKeySalt, empty), zeroIv, fileKey);

  const oValidation = randomBytes(8);
  const oKeySalt = randomBytes(8);
  const o = concat(await hash2B(owner, oValidation, u), oValidation, oKeySalt);
  const oe = await aesNoPad(await hash2B(owner, oKeySalt, u), zeroIv, fileKey);

  // Algorithm 10: the permissions, repeated inside the encrypted payload so a
  // viewer can tell that /P was not tampered with in transit.
  const p = permissionFlags(settings);
  const permsBlock = new Uint8Array(16);
  new DataView(permsBlock.buffer).setInt32(0, p, true);
  permsBlock.set([0xff, 0xff, 0xff, 0xff], 4);
  permsBlock[8] = 0x54; // 'T' — /EncryptMetadata is true
  permsBlock.set([0x61, 0x64, 0x62], 9); // 'adb'
  permsBlock.set(randomBytes(4), 12);
  // Algorithm 10 specifies AES-256 in ECB with no padding, which WebCrypto does
  // not offer. For a single block, CBC with a zero IV is the same transform.
  const perms = await aesNoPad(fileKey, new Uint8Array(16), permsBlock);

  return { fileKey, o, u, oe, ue, perms, p };
}

function hexOf(bytes: Uint8Array): PDFHexString {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return PDFHexString.of(hex);
}

/* ------------------------------------------------------------------ *
 * Rewriting the document
 * ------------------------------------------------------------------ */

/**
 * Encrypts every string in a direct object, in place.
 *
 * References are not followed: each indirect object is visited once by the
 * caller, so following them would encrypt shared objects twice.
 */
async function encryptStrings(
  object: PDFObject,
  fileKey: Uint8Array,
  seen: Set<PDFObject>
): Promise<void> {
  if (seen.has(object)) return;
  seen.add(object);

  if (object instanceof PDFDict) {
    for (const [key, value] of object.entries()) {
      if (value instanceof PDFString || value instanceof PDFHexString) {
        object.set(key, hexOf(await aesEncrypt(fileKey, value.asBytes())));
      } else {
        await encryptStrings(value, fileKey, seen);
      }
    }
    return;
  }

  if (object instanceof PDFArray) {
    const items = object.asArray();
    for (let i = 0; i < items.length; i++) {
      const value = items[i];
      if (value instanceof PDFString || value instanceof PDFHexString) {
        object.set(i, hexOf(await aesEncrypt(fileKey, value.asBytes())));
      } else {
        await encryptStrings(value, fileKey, seen);
      }
    }
  }
}

/**
 * How often the object loop stops to report progress and test for cancellation.
 *
 * Two gates, whichever comes first, because neither alone is safe:
 *
 *  • **Time** is the one that actually bounds cancellation latency, since object
 *    cost varies by three orders of magnitude (a 12-byte name versus a 5MB image
 *    stream). 50ms matches the main-thread budget in CLAUDE.md and keeps the
 *    check itself — a Comlink round-trip to the main thread — under ~2% overhead.
 *  • **Object count** is the floor, for the case the time gate never trips.
 *    Measured on `tests/fixtures/text-300.pdf` (604 indirect objects, ~116ms to
 *    encrypt end to end) an object averages ~0.2ms, so 64 objects is ~13ms of
 *    work — well inside budget, and it guarantees a check even on a document
 *    small and fast enough that 50ms never elapses.
 */
export const ENCRYPT_CHECKPOINT_MS = 50;
export const ENCRYPT_CHECKPOINT_OBJECTS = 64;

/**
 * Returns `bytes` encrypted with a standard security handler.
 *
 * Throws rather than returning half-encrypted output: the caller keeps the
 * original bytes and reports the reason, per the never-corrupt rule. That is
 * also what makes mid-loop cancellation safe — the partially-encrypted
 * `PDFDocument` is local to this call and is discarded with the stack, and
 * `bytes` itself is only ever read, never written, so an abort leaves the
 * caller's input exactly as it was.
 *
 * `job` is optional so the pure-function tests can call this without a worker.
 * Progress is reported over its own 0..1 span; see `subJob` for placing that
 * span inside a caller's wider bar.
 */
export async function encryptPdf(
  bytes: Uint8Array,
  settings: ProtectionSettings,
  job?: JobHandle
): Promise<Uint8Array> {
  if (!settings.userPassword) {
    throw internal('A password is required before a document can be protected.');
  }

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/encrypt/i.test(message)) {
      throw encrypted(
        'This document is already password-protected, so Stapler will not re-encrypt it.'
      );
    }
    throw err;
  }

  const keys = await deriveKeys(settings);
  const context = doc.context;
  const seen = new Set<PDFObject>();

  // A snapshot array, not a live view: `context.assign` below replaces entries
  // while this loop runs, and pdf-lib's `enumerateIndirectObjects` already
  // returns a materialised array, so indexing it is exactly what the previous
  // `for…of` iterated over.
  const objects = context.enumerateIndirectObjects();
  let lastCheck = performance.now();

  for (let i = 0; i < objects.length; i++) {
    const [ref, object] = objects[i];

    // The cancellation point this loop used to lack entirely: `protectDocument`
    // could only be stopped before the first object or after the last one, so a
    // cancelled encryption of a large document ran to completion anyway.
    if (
      i > 0 &&
      (i % ENCRYPT_CHECKPOINT_OBJECTS === 0 ||
        performance.now() - lastCheck >= ENCRYPT_CHECKPOINT_MS)
    ) {
      await checkpoint(job, i / objects.length, `Encrypting object ${i} of ${objects.length}`);
      lastCheck = performance.now();
    }

    if (object instanceof PDFStream) {
      if (!(object instanceof PDFRawStream)) {
        // Every stream in freshly-serialised bytes parses back as a raw stream.
        // Anything else would need its own encoding path, and guessing is how a
        // document gets silently corrupted.
        throw internal('Unexpected stream type while encrypting; nothing was written.');
      }
      await encryptStrings(object.dict, keys.fileKey, seen);
      const contents = await aesEncrypt(keys.fileKey, object.getContents());
      object.dict.set(PDFName.of('Length'), PDFNumber.of(contents.length));
      context.assign(ref, PDFRawStream.of(object.dict, contents));
      continue;
    }
    await encryptStrings(object, keys.fileKey, seen);
  }

  // Registered last, so the walk above never sees it: the /Encrypt dictionary's
  // own strings are the one thing in the file that must stay in the clear.
  const encryptDict = context.obj({
    Filter: 'Standard',
    V: 5,
    R: 6,
    Length: 256,
    CF: context.obj({
      StdCF: context.obj({ CFM: 'AESV3', AuthEvent: 'DocOpen', Length: 32 })
    }),
    StmF: 'StdCF',
    StrF: 'StdCF',
    P: keys.p,
    EncryptMetadata: true
  }) as PDFDict;
  encryptDict.set(PDFName.of('O'), hexOf(keys.o));
  encryptDict.set(PDFName.of('U'), hexOf(keys.u));
  encryptDict.set(PDFName.of('OE'), hexOf(keys.oe));
  encryptDict.set(PDFName.of('UE'), hexOf(keys.ue));
  encryptDict.set(PDFName.of('Perms'), hexOf(keys.perms));
  context.trailerInfo.Encrypt = context.register(encryptDict);

  // The trailer /ID is never encrypted, and viewers expect one on an encrypted
  // file even though revision 6 does not mix it into the key.
  const id = hexOf(randomBytes(16));
  context.trailerInfo.ID = context.obj([id, id]);

  // AES-256 is a PDF 2.0 feature; the extension declaration is how a 1.7 header
  // announces it to readers that check (ISO 32000-2 Annex E).
  doc.catalog.set(
    PDFName.of('Extensions'),
    context.obj({ ADBE: context.obj({ BaseVersion: '1.7', ExtensionLevel: 3 }) })
  );

  // Object streams would have to be encrypted as whole streams and the xref
  // stream left in the clear; a plain xref table sidesteps the distinction.
  // Field appearances must not be regenerated after the strings are ciphertext.
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

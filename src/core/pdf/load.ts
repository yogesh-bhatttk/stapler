/**
 * The one shared "hand these bytes to pdf-lib" entry point.
 *
 * Refuses an encrypted document with a clear, classified error (PLAN §5.2) —
 * but only after trying the empty password first. Most "encrypted" PDFs found
 * in the wild only restrict printing/copying and were never locked from
 * *opening*: their real user password is the empty string, which is exactly
 * what Chrome's own viewer, Acrobat and Preview all try silently before
 * showing any content. pdf-lib genuinely decrypts when handed the correct
 * password — verified directly: loading with `password: ''` against such a
 * file succeeds, reports `isEncrypted: false`, and round-trips through
 * `.save()` intact. This is a real decrypt, not the old `ignoreEncryption`
 * shortcut that left ciphertext in place and got read as if it were plain.
 *
 * Every place that loads a PDF for reading or rewriting must go through this
 * — a second, ad-hoc `PDFDocument.load(bytes)` elsewhere has no retry and
 * refuses a permission-only-encrypted PDF outright, even when a sibling call
 * on the exact same bytes (routed through here) would have succeeded.
 *
 * Decrypting is only half of it. A document opened this way has no `/Encrypt`
 * dictionary left — pdf-lib drops it on a successful decrypt (`trailerInfo`
 * keeps `Root` alone, `context.isDecrypted` becomes true) — so every export
 * built from it used to be written back with the *permissions dropped*: a file
 * whose owner had forbidden printing came out of Stapler printable, silently
 * and irreversibly. Recovering those flags is what
 * {@link loadPdfDocumentWithRestrictions} is for; re-applying them on save is
 * `encrypt.ts`'s `permissionOnlyPlan`.
 */
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef } from 'pdf-lib';
import { corrupt, encrypted } from '../errors';

/**
 * The `/P` bits (Table 22) that actually deny a user something, as a mask.
 *
 * Bits 3–6 (print, modify, copy, annotate), 9 (fill form fields), 10 (extract
 * for accessibility), 11 (assemble) and 12 (high-quality print). Everything
 * else in `/P` is reserved and carries no permission. A `/P` with all of these
 * set restricts nothing at all, which is what a file gets from
 * `gs -sOwnerPassword=…` with no permission flags — very common, and not worth
 * re-encrypting an export to preserve.
 */
const MEANINGFUL_PERMISSION_BITS =
  (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 8) | (1 << 9) | (1 << 10) | (1 << 11);

export interface LoadedDocument {
  doc: PDFDocument;
  /**
   * The original `/P` flags, when this document was permission-restricted and
   * opened with the empty user password — the value an export has to carry
   * back so a compliant reader still refuses what the input refused.
   *
   * `null` when there is nothing to preserve: no `/Encrypt` at all, a `/P` that
   * denies nothing, a non-standard security handler, or a file that only opened
   * because the caller passed `allowEncrypted` (its real user password is
   * unknown, so its content cannot be rewritten anyway).
   */
  restrictions: number | null;
}

/** Reads `/Encrypt`'s `/P` from a document parsed *without* decrypting it. */
function permissionsOf(doc: PDFDocument): number | null {
  const entry = doc.context.trailerInfo.Encrypt;
  const dict =
    entry instanceof PDFRef
      ? doc.context.lookupMaybe(entry, PDFDict)
      : entry instanceof PDFDict
        ? entry
        : undefined;
  if (!dict) return null;
  // Only the standard security handler has a `/P` this codebase can re-create.
  // A custom handler's permissions live in its own private encoding, and
  // guessing at one is how a document comes out of here more permissive than
  // it went in without anyone noticing.
  if (dict.lookup(PDFName.of('Filter')) !== PDFName.of('Standard')) return null;
  const p = dict.lookup(PDFName.of('P'));
  if (!(p instanceof PDFNumber)) return null;
  // `/P` is a signed 32-bit integer; some producers write it unsigned.
  const flags = p.asNumber() | 0;
  return (flags & MEANINGFUL_PERMISSION_BITS) === MEANINGFUL_PERMISSION_BITS ? null : flags;
}

/**
 * Parses `bytes` without decrypting them, purely to read the `/Encrypt`
 * dictionary the decrypting parse throws away.
 *
 * Deliberately its own parse rather than something carried out of the load
 * above: pdf-lib exposes no hook between "decrypt succeeded" and "forget the
 * encryption dictionary", and reconstructing `/P` from the decrypted document
 * is impossible because the value is simply no longer there.
 */
async function restrictionsInBytes(bytes: Uint8Array): Promise<number | null> {
  try {
    const raw = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return permissionsOf(raw);
  } catch {
    // Unreadable encryption dictionary. The document itself already loaded, so
    // the export goes ahead; it simply carries no restrictions, exactly as it
    // did before any of this existed.
    return null;
  }
}

/** Whether the empty user password opens this file, i.e. it only restricts. */
async function opensWithEmptyPassword(bytes: Uint8Array): Promise<boolean> {
  try {
    await PDFDocument.load(bytes, { password: '', updateMetadata: false });
    return true;
  } catch {
    return false;
  }
}

async function loadInternal(
  bytes: Uint8Array,
  allowEncrypted: boolean,
  wantRestrictions: boolean
): Promise<LoadedDocument> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, {
      ignoreEncryption: allowEncrypted,
      updateMetadata: false
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/encrypt/i.test(message)) {
      try {
        const decrypted = await PDFDocument.load(bytes, { password: '', updateMetadata: false });
        // The empty password opened it, so this is a permission-only file and
        // its `/P` is exactly what an export of it must carry back.
        return {
          doc: decrypted,
          restrictions: wantRestrictions ? await restrictionsInBytes(bytes) : null
        };
      } catch {
        // The empty password didn't open it either — a real password is required.
        throw encrypted('The document is encrypted, so its contents cannot be rewritten.');
      }
    }
    throw corrupt(`The PDF could not be parsed: ${message}`);
  }
  if (doc.isEncrypted && !allowEncrypted) {
    throw encrypted('The document is encrypted, so its contents cannot be rewritten.');
  }
  if (!wantRestrictions || !doc.isEncrypted) return { doc, restrictions: null };
  // `allowEncrypted` read this file without decrypting it, so its strings and
  // streams are still ciphertext and its `/Encrypt` dictionary is still here to
  // read. Its permissions are only worth reporting if the file opens with no
  // password at all — otherwise nothing downstream can rewrite it regardless.
  return {
    doc,
    restrictions: (await opensWithEmptyPassword(bytes)) ? permissionsOf(doc) : null
  };
}

export async function loadPdfDocument(
  bytes: Uint8Array,
  allowEncrypted = false
): Promise<PDFDocument> {
  return (await loadInternal(bytes, allowEncrypted, false)).doc;
}

/**
 * The same load, plus the original permission flags when there are any.
 *
 * Separate from {@link loadPdfDocument} because recovering `/P` costs a second
 * parse of the whole file, and only the import-time inspection needs the
 * answer — every other load is on the hot path (compose parses one document per
 * source, per export) and must not pay for it.
 */
export async function loadPdfDocumentWithRestrictions(
  bytes: Uint8Array,
  allowEncrypted = false
): Promise<LoadedDocument> {
  return loadInternal(bytes, allowEncrypted, true);
}

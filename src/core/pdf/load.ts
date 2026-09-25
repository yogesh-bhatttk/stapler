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
import { translate } from '../i18n';

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
   * unknown, so its content cannot be rewritten anyway). Also `null` when
   * {@link restrictionsUnknown} is true — the two are indistinguishable from
   * this field alone, which is exactly why that one exists.
   */
  restrictions: number | null;
  /**
   * True when this document's `/Encrypt` dictionary could not be parsed at
   * all, so whether it actually restricts anything is genuinely unknown —
   * `restrictions` above is `null`, the same as "nothing to preserve", but
   * that would be papering over a real gap: this file may well have arrived
   * with real restrictions this codebase simply failed to read, and an export
   * of it will not carry them forward. A caller that surfaces import-time
   * facts to the user (`core/import.ts`) should warn on this specifically,
   * rather than let it look identical to the ordinary, unrestricted case.
   */
  restrictionsUnknown: boolean;
}

interface RestrictionsProbe {
  flags: number | null;
  unknown: boolean;
}

/** Reads `/Encrypt`'s `/P` from a document parsed *without* decrypting it. */
function permissionsOf(doc: PDFDocument): RestrictionsProbe {
  try {
    const entry = doc.context.trailerInfo.Encrypt;
    const dict =
      entry instanceof PDFRef
        ? doc.context.lookupMaybe(entry, PDFDict)
        : entry instanceof PDFDict
          ? entry
          : undefined;
    if (!dict) return { flags: null, unknown: false };
    // Only the standard security handler has a `/P` this codebase can
    // re-create. A custom handler's permissions live in its own private
    // encoding, and guessing at one is how a document comes out of here more
    // permissive than it went in without anyone noticing — a deliberate
    // "nothing to preserve" answer, not the unreadable case below.
    if (dict.lookup(PDFName.of('Filter')) !== PDFName.of('Standard')) {
      return { flags: null, unknown: false };
    }
    const p = dict.lookup(PDFName.of('P'));
    if (!(p instanceof PDFNumber)) return { flags: null, unknown: false };
    // `/P` is a signed 32-bit integer; some producers write it unsigned.
    const flags = p.asNumber() | 0;
    return {
      flags: (flags & MEANINGFUL_PERMISSION_BITS) === MEANINGFUL_PERMISSION_BITS ? null : flags,
      unknown: false
    };
  } catch (err) {
    // A malformed `/Encrypt` dict that a lookup chokes on — genuinely rare,
    // since this is called only on a document pdf-lib already parsed
    // successfully. Not the deliberate "nothing to preserve" answer above:
    // this file may carry real restrictions this codebase failed to read.
    console.warn(
      "Stapler: this document's /Encrypt dictionary could not be read; its permission " +
        'restrictions, if any, will not be reapplied on export.',
      err
    );
    return { flags: null, unknown: true };
  }
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
async function restrictionsInBytes(bytes: Uint8Array): Promise<RestrictionsProbe> {
  try {
    const raw = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return permissionsOf(raw);
  } catch (err) {
    // The whole re-parse failed, not just one dictionary lookup within it —
    // genuinely rare, since the decrypting parse in `loadInternal` already
    // succeeded on these same bytes. The document itself still loads, so the
    // export goes ahead rather than being refused over a restriction this
    // codebase cannot even name; it simply cannot re-apply a `/P` it was
    // unable to read.
    console.warn(
      "Stapler: this document's original permission restrictions could not be read " +
        '(the /Encrypt dictionary failed to re-parse) and will not be reapplied on export.',
      err
    );
    return { flags: null, unknown: true };
  }
}

/** Whether the empty user password opens this file, i.e. it only restricts. */
async function opensWithEmptyPassword(bytes: Uint8Array): Promise<boolean> {
  try {
    await PDFDocument.load(bytes, { password: '', ...LOAD_OPTIONS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Why every load here asks for `preserveXFA`.
 *
 * pdf-lib deletes `/AcroForm /XFA` as a *side effect of `getForm()`* unless this
 * is set — it warns to the console and calls `deleteXFA()`. So without it every
 * `form.hasXFA()` in this codebase answers `false` on its first and only call,
 * for every document that has one: the check runs after the thing it is looking
 * for has already been destroyed. That is what left `inspect`, `getFormFields`,
 * `fillFormFields` and `flattenDocument` relying entirely on `hasXfaMarker`'s
 * raw byte scan, which cannot see an `/XFA` key stored inside a compressed
 * object stream (the ordinary shape of a real LiveCycle form).
 *
 * Preserving it is also the right answer on its own terms: silently dropping an
 * XML payload out of a document Stapler is only rewriting the metadata of is
 * exactly the kind of quiet destruction this codebase refuses elsewhere.
 */
const LOAD_OPTIONS = { updateMetadata: false, preserveXFA: true } as const;

async function loadInternal(
  bytes: Uint8Array,
  allowEncrypted: boolean,
  wantRestrictions: boolean
): Promise<LoadedDocument> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, {
      ignoreEncryption: allowEncrypted,
      ...LOAD_OPTIONS
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/encrypt/i.test(message)) {
      try {
        const decrypted = await PDFDocument.load(bytes, { password: '', ...LOAD_OPTIONS });
        // The empty password opened it, so this is a permission-only file and
        // its `/P` is exactly what an export of it must carry back.
        const probe = wantRestrictions
          ? await restrictionsInBytes(bytes)
          : { flags: null, unknown: false };
        return { doc: decrypted, restrictions: probe.flags, restrictionsUnknown: probe.unknown };
      } catch {
        // The empty password didn't open it either — a real password is required.
        throw encrypted(
          translate('The document is encrypted, so its contents cannot be rewritten.')
        );
      }
    }
    throw corrupt(translate('The PDF could not be parsed: {message}', { message }));
  }
  if (doc.isEncrypted && !allowEncrypted) {
    throw encrypted(translate('The document is encrypted, so its contents cannot be rewritten.'));
  }
  if (!wantRestrictions || !doc.isEncrypted) {
    return { doc, restrictions: null, restrictionsUnknown: false };
  }
  // `allowEncrypted` read this file without decrypting it, so its strings and
  // streams are still ciphertext and its `/Encrypt` dictionary is still here to
  // read. Its permissions are only worth reporting if the file opens with no
  // password at all — otherwise nothing downstream can rewrite it regardless.
  if (!(await opensWithEmptyPassword(bytes))) {
    return { doc, restrictions: null, restrictionsUnknown: false };
  }
  const probe = permissionsOf(doc);
  return { doc, restrictions: probe.flags, restrictionsUnknown: probe.unknown };
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

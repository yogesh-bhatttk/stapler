/**
 * SGN-03 — XFA detection that does not depend on a parser.
 *
 * The old detection asked pdf.js (`isPureXfa`) and pdf-lib (`getForm().hasXFA()`)
 * whether a document was XFA. Both answers arrive *after* a full parse, and both
 * are narrower than the question:
 *
 *  • `isPureXfa` is only true for a *pure* XFA form — one with no AcroForm
 *    fallback. Every hybrid XFA form (the common case: `/XFA` next to `/Fields`)
 *    reports false, so it was treated as an ordinary AcroForm and half-filled:
 *    pdf-lib writes `/V` into the AcroForm shadow fields while the XML payload
 *    that the viewer actually renders keeps the old values.
 *  • `hasXFA()` needs the `/AcroForm` dict to have survived the load. If a
 *    document is repaired on parse, or the catalog is only reachable through a
 *    broken xref, the key is gone and the check silently says "not XFA".
 *
 * So the authoritative check runs on the raw bytes, before any parse. A false
 * positive costs the user an explanatory message on a document they can still
 * stamp; a false negative costs them a form that reports success and drops their
 * typing. This module deliberately errs toward the first.
 */

/** The `/XFA` key as bytes; comparing bytes avoids any text-decoding decisions. */
const XFA_KEY = [0x2f, 0x58, 0x46, 0x41]; // "/XFA"

/**
 * Delimiters that may legally follow a PDF name. `/XFA` must be followed by one
 * of these to be a key rather than the prefix of a longer name like `/XFAFoo`.
 */
function isNameTerminator(byte: number | undefined): boolean {
  if (byte === undefined) return true; // end of file terminates the name
  return (
    byte === 0x20 || // space
    byte === 0x0a ||
    byte === 0x0d ||
    byte === 0x09 ||
    byte === 0x0c ||
    byte === 0x00 ||
    byte === 0x5b || // [
    byte === 0x3c || // <
    byte === 0x28 || // (
    byte === 0x2f || // /
    byte === 0x5d || // ]
    byte === 0x3e // >
  );
}

/**
 * True when the raw file contains an `/XFA` name. Cheap linear scan over bytes,
 * no allocation, safe on a 300MB file.
 *
 * Note the deliberate limitation: a `/XFA` key inside a compressed object stream
 * is not visible here. That is why callers combine this with the parsed checks
 * ({@link isXfaDocument}) rather than replacing them — the raw scan catches what
 * the parser drops, and the parser catches what compression hides.
 */
export function hasXfaMarker(bytes: Uint8Array): boolean {
  const limit = bytes.length - XFA_KEY.length;
  for (let i = 0; i <= limit; i++) {
    if (bytes[i] !== XFA_KEY[0]) continue;
    if (
      bytes[i + 1] === XFA_KEY[1] &&
      bytes[i + 2] === XFA_KEY[2] &&
      bytes[i + 3] === XFA_KEY[3] &&
      isNameTerminator(bytes[i + 4])
    ) {
      return true;
    }
  }
  return false;
}

/** The one message the whole product uses for an XFA form, so it never drifts. */
export const XFA_MESSAGE =
  'This is an XFA form. Its fields live in an XML payload that Stapler cannot fill, ' +
  'and writing to the AcroForm shadow fields would leave the document inconsistent. ' +
  'Use the stamp tools to place text and signatures on top instead.';

/**
 * Combines the raw-byte evidence with whatever a parser reported. Either being
 * true means the document is XFA and the interactive-fill path must refuse.
 */
export function isXfaDocument(bytes: Uint8Array, parserSaysXfa: boolean): boolean {
  return parserSaysXfa || hasXfaMarker(bytes);
}

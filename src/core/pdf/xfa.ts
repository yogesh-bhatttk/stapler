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

/**
 * CNV-08's refusal, for a conversion *out* of PDF.
 *
 * Distinct from the compose refusal below because the failure is the other way
 * round: nothing is being written back into the PDF, so there is no form to
 * break — the problem is that the text a converter can see is not the text the
 * user sees. A pure XFA form's page objects usually hold nothing but a "your
 * viewer cannot show this" placeholder, and a `.docx` containing only that,
 * handed over as a converted form, is silent corruption of the user's
 * expectations if not of their bytes.
 *
 * Parameterised by the target format because all three conversions out of PDF
 * (CNV-08 Word, CNV-10 Excel, CNV-12 PowerPoint) refuse for the same reason, and
 * a shared constant naming one of them told an Excel user their *Word document*
 * would be wrong — a refusal that describes an output they never asked for reads
 * as a bug in the tool rather than a fact about their file.
 */
export type XfaConvertTarget = 'Word document' | 'Excel workbook' | 'PowerPoint presentation';

export function xfaConvertMessage(target: XfaConvertTarget): string {
  return (
    'This is an XFA form. What it shows on screen is generated from an XML payload, not ' +
    `from the page content Stapler can read, so a converted ${target} would contain ` +
    'the dead AcroForm shadow layer — usually a "open this in Adobe Reader" placeholder — ' +
    'rather than the form. Nothing was converted. Print or export the form to a flat PDF ' +
    'from a viewer that renders XFA, then convert that.'
  );
}

/**
 * The refusal for operations that rebuild a document page by page — merge,
 * split, organise, watermark, n-up, normalise.
 *
 * None of them can carry an XFA form across: the fields live in an XML payload
 * hanging off `/AcroForm`, and a `copyPages` rebuild takes the pages and leaves
 * the payload behind. The output opens, looks right, and has a dead form — the
 * exact shape of silent corruption this product refuses to ship.
 */
export const XFA_COMPOSE_MESSAGE =
  'This is an XFA form. Its fields live in an XML payload that cannot survive being ' +
  'rebuilt page by page, so merging, splitting, organising or watermarking it would ' +
  'produce a document whose form no longer works. Nothing was changed. Sign and Annotate ' +
  'can still stamp text and signatures on top, which flattens the form deliberately.';

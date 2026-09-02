/**
 * CNV-09 — a `.docx` → the structured HTML `mammoth` produces.
 *
 * The mirror of `docx-writer.ts`, and lazily loaded for the same reason: nothing
 * in `mammoth`'s dependency tree (jszip, @xmldom/xmldom, bluebird, underscore,
 * lop) is parsed or evaluated until someone actually converts a document, so it
 * stays out of the 900KB initial bundle `scripts/check-bundle-size.js` measures.
 * It is a real bundled dependency — pure JS, no WASM, no network — so this is a
 * lazy *chunk*, not a remote fetch (PLAN §5.4).
 *
 * **Refusing bad input properly is most of this file.** `mammoth` reports a
 * corrupt package by rejecting with a bare `Error` out of jszip's internals
 * ("Can't find end of central directory : is this a zip file ?"), which is not
 * something to put in front of a user, and an unhandled rejection here would
 * surface as a generic failure with no idea what went wrong. Every known failure
 * shape is therefore translated below into a `StaplerError` that says what the
 * file is and what to do about it — and the two shapes that can be told apart
 * from the first eight bytes are caught *before* `mammoth` is even loaded.
 */

import { corrupt, fromUnknown, unsupported } from '../errors';
import { checkpoint, type JobHandle } from '../workers/protocol';

/** `PK\x03\x04` — the local file header every ZIP, and so every `.docx`, opens with. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/**
 * The OLE2 compound-file signature. Two very different files start with it and
 * both are common mistakes here: a legacy binary `.doc`, and a password-protected
 * `.docx` (OOXML encryption wraps the real ZIP inside an OLE container).
 */
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export const DOCX_LEGACY_MESSAGE =
  'This is a legacy Word .doc file, or a password-protected .docx. Neither can be read here — ' +
  'open it in Word or LibreOffice and save it as an unprotected .docx first.';

export const DOCX_NOT_A_ZIP_MESSAGE =
  'This file is not a readable .docx: its ZIP container could not be opened. The original file ' +
  'is untouched — nothing was converted.';

export const DOCX_NO_DOCUMENT_MESSAGE =
  'This .docx is missing its main document part (word/document.xml), so there is nothing to ' +
  'convert. The original file is untouched.';

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((byte, index) => bytes[index] === byte);
}

export interface DocxHtmlResult {
  html: string;
  /** `mammoth`'s own warnings, verbatim — surfaced, never swallowed. */
  messages: string[];
}

/**
 * Reads the `.docx` and returns `mammoth`'s HTML.
 *
 * Throws rather than returning a partial result: a half-read document converted
 * into a PDF that looks complete is the silent-corruption outcome PLAN §5.2
 * forbids outright.
 */
export async function readDocxAsHtml(bytes: Uint8Array, job?: JobHandle): Promise<DocxHtmlResult> {
  await checkpoint(job, 0, 'Reading the Word document');

  if (bytes.length === 0) {
    throw corrupt('This file is empty, so there is nothing to convert.');
  }
  if (startsWith(bytes, OLE2_MAGIC)) throw unsupported(DOCX_LEGACY_MESSAGE);
  if (!startsWith(bytes, ZIP_MAGIC)) throw corrupt(DOCX_NOT_A_ZIP_MESSAGE);

  const mammoth = await import('mammoth');
  await checkpoint(job, 0.2, 'Reading the Word document');

  // `.slice()` so the `ArrayBuffer` handed to jszip is exactly this document and
  // nothing else: a `Uint8Array` can be a *view* onto a larger buffer, and
  // `copy.buffer` would then be that whole buffer rather than the file.
  //
  // `arrayBuffer` *and* `buffer` because `mammoth`'s package `browser` field
  // swaps `lib/unzip.js` for `browser/unzip.js`, and the two read **different**
  // option keys — the browser one looks only at `arrayBuffer`, the Node one only
  // at `path`/`buffer`. Vite picks the browser build for the shipped worker and
  // Vitest picks the Node one, so passing both is what makes the worker and the
  // unit test execute the identical call instead of the test grading a path the
  // browser never takes. The browser build ignores `buffer` entirely.
  const copy = bytes.slice();
  const arrayBuffer = copy.buffer as ArrayBuffer;

  let result;
  try {
    result = await mammoth.convertToHtml({ arrayBuffer, buffer: copy } as {
      arrayBuffer: ArrayBuffer;
    });
  } catch (err) {
    throw translateMammothError(err);
  }

  return {
    html: result.value ?? '',
    messages: (result.messages ?? []).map(message => message.message)
  };
}

/**
 * Turns whatever `mammoth`/jszip threw into a message a user can act on.
 *
 * The three matched shapes are the ones reproduced against `mammoth` 1.12.2 in
 * `tests/unit/word-to-pdf.test.ts`; anything unmatched is still wrapped as a
 * refusal with the underlying text attached, rather than being allowed through
 * as an unhandled rejection.
 */
export function translateMammothError(err: unknown): Error {
  const message = fromUnknown(err).message;

  if (
    /end of central directory|End of data reached|Corrupted zip|is this a zip file/i.test(message)
  ) {
    return corrupt(DOCX_NOT_A_ZIP_MESSAGE);
  }
  if (/main document part/i.test(message)) {
    return corrupt(DOCX_NO_DOCUMENT_MESSAGE);
  }
  if (/encrypted|password/i.test(message)) {
    return unsupported(DOCX_LEGACY_MESSAGE);
  }
  return corrupt(`This .docx could not be read, so nothing was converted (${message}).`);
}

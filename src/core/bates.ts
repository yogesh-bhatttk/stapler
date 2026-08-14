/**
 * OPS-11 — Bates numbering, the pure part.
 *
 * A Bates number is a legal-discovery page identifier: a fixed prefix followed by a
 * zero-padded sequence number that must be strictly sequential across the production
 * set. The label maths lives here rather than in the worker so it can be unit-tested
 * without a PDF, and so the panel can show the exact string that will be stamped.
 *
 * Deliberately independent of the `{n}` page-number substitution in the watermark and
 * header/footer stamps: a document can legitimately carry both a printed page number
 * and a Bates number, and they need not agree.
 */

export interface BatesConfig {
  /** Printed verbatim before the number, e.g. `ACME-`. May be empty. */
  prefix: string;
  /** Zero-padding width, 1..12. `6` gives `000001`. */
  digits: number;
  /** Number given to the first stamped page. */
  start: number;
}

/** The widest padding worth allowing: beyond this the stamp is nonsense, not data. */
export const MAX_BATES_DIGITS = 12;

/**
 * The label for the page `offset` positions after the first one.
 *
 * A number wider than `digits` is never truncated — losing the high digits would
 * make two different pages share an identifier, which is precisely the failure a
 * Bates stamp exists to prevent — so the field grows instead.
 */
export function batesLabel(config: BatesConfig, offset: number): string {
  const digits = Math.min(MAX_BATES_DIGITS, Math.max(1, Math.floor(config.digits) || 1));
  const start = Math.max(0, Math.floor(config.start) || 0);
  const value = start + Math.max(0, Math.floor(offset));
  return `${config.prefix}${String(value).padStart(digits, '0')}`;
}

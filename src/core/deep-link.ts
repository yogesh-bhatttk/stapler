/**
 * GAP-4 / GAP-5 — tool parameters carried in a link.
 *
 * The landing pages for "compress PDF to 100 KB" and friends, and any link a
 * person shares, pre-fill a tool through the query part of the hash route:
 * `#/tool/compress?target=100KB`, `#/tool/image-to-size?target=20KB&max=600`.
 * The hash, not the page's real query string, because the extension editor is
 * one static page whose only router is the hash — the same link then works in
 * `editor.html` and on the website twin. A real query string
 * (`compress-pdf-to-size.html?target=300KB`) is accepted as a fallback for
 * hand-written links.
 *
 * Everything here is pure: parse, clamp, and reject garbage. The UI applies
 * what survives (`ui/deepLink.ts`) and then strips the query so a reload or a
 * later visit to the same tool does not re-apply it over the user's own edit.
 */

export type SizeUnit = 'KB' | 'MB';

export interface SizeParam {
  amount: number;
  unit: SizeUnit;
}

export interface SizeBounds {
  /** Smallest target accepted, in decimal bytes. Anything smaller is raised to it. */
  minBytes: number;
  /** Largest target accepted, in decimal bytes. Anything larger is lowered to it. */
  maxBytes: number;
}

/**
 * A PDF under 10 KB is a page of plain text at best, and nothing Stapler
 * compresses gets there; 2 GB is past anything a browser tab can hold.
 */
export const PDF_TARGET_BOUNDS: SizeBounds = { minBytes: 10_000, maxBytes: 2_000_000_000 };

/**
 * Portal limits go as low as 10 KB for a signature scan; 5 KB leaves a little
 * room below that. 50 MB is well past any upload form's limit.
 */
export const IMAGE_TARGET_BOUNDS: SizeBounds = { minBytes: 5_000, maxBytes: 50_000_000 };

/** Longest-side limits for the `max` parameter, in pixels. */
export const MAX_DIMENSION_BOUNDS = { min: 16, max: 16_384 } as const;

const UNIT_SCALE: Record<SizeUnit, number> = { KB: 1_000, MB: 1_000_000 };

/** Decimal, matching `targetSizeBytes` in the compress tool. */
export function sizeParamBytes(size: SizeParam): number {
  return Math.round(size.amount * UNIT_SCALE[size.unit]);
}

const SIZE_PATTERN = /^(\d{1,10}(?:[.,]\d{1,4})?|[.,]\d{1,4})(k|kb|kib|m|mb|mib)?$/;

/**
 * Parses `100KB`, `100 kb`, `1.5MB`, `1,5 MB`, `250` (KB when no unit is
 * given — the unit these limits are almost always quoted in), `500KiB` and
 * `1MiB` (binary, scaled by 1024 — see below) and clamps the
 * result into `bounds`. Returns null for anything else: an empty value,
 * negative or zero sizes, other units, stray characters, `Infinity`, `NaN`.
 *
 * The unit is kept where the value stays in bounds, so `1MB` pre-fills as
 * "1 MB" rather than "1000 KB". A clamped value is expressed in whichever unit
 * reads naturally for the bound it hit.
 */
export function parseSizeParam(
  raw: string | null | undefined,
  bounds: SizeBounds = PDF_TARGET_BOUNDS
): SizeParam | null {
  if (typeof raw !== 'string') return null;
  const compact = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (compact.length === 0 || compact.length > 24) return null;
  const match = SIZE_PATTERN.exec(compact);
  if (!match) return null;
  const amount = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit: SizeUnit = match[2]?.startsWith('m') ? 'MB' : 'KB';
  // IMG-11: KiB and MiB are binary units. A portal that says "500 KiB" means
  // 512,000 bytes, so it is scaled by 1024 and expressed in (decimal) KB,
  // rounded *down* — a limit must never be pre-filled above what it allows.
  const binary = match[2]?.endsWith('ib') ?? false;
  if (binary) {
    const bytes = amount * (unit === 'MB' ? 1024 * 1024 : 1024);
    if (bytes < bounds.minBytes) return fromBytes(bounds.minBytes);
    if (bytes > bounds.maxBytes) return fromBytes(bounds.maxBytes);
    return { amount: Math.floor((bytes / UNIT_SCALE.KB) * 100) / 100, unit: 'KB' };
  }
  const bytes = amount * UNIT_SCALE[unit];
  if (bytes < bounds.minBytes) return fromBytes(bounds.minBytes);
  if (bytes > bounds.maxBytes) return fromBytes(bounds.maxBytes);
  return { amount: roundAmount(amount), unit };
}

/**
 * The same size in another unit (IMG-2): switching "0.5 MB" to KB reads
 * "500 KB", not "0.5 KB". Rounded to two decimals, like every amount here.
 */
export function convertSizeUnit(size: SizeParam, unit: SizeUnit): SizeParam {
  if (size.unit === unit) return size;
  if (!Number.isFinite(size.amount)) return { amount: size.amount, unit };
  return { amount: roundAmount((size.amount * UNIT_SCALE[size.unit]) / UNIT_SCALE[unit]), unit };
}

export type SizeValidation =
  | { ok: true; bytes: number }
  | { ok: false; reason: 'invalid' | 'too-small' | 'too-large'; min: SizeParam; max: SizeParam };

/**
 * Whether a typed target is usable as it stands (IMG-2, IMG-12). An input
 * shows exactly what will run, so an out-of-range value is not silently
 * replaced by the last good one: it is reported, with the range, and the run
 * refuses it until it is fixed.
 */
export function validateSizeParam(size: SizeParam, bounds: SizeBounds): SizeValidation {
  const min = fromBytes(bounds.minBytes);
  const max = fromBytes(bounds.maxBytes);
  if (!Number.isFinite(size.amount) || size.amount <= 0) {
    return { ok: false, reason: 'invalid', min, max };
  }
  const bytes = sizeParamBytes(size);
  if (bytes < bounds.minBytes) return { ok: false, reason: 'too-small', min, max };
  if (bytes > bounds.maxBytes) return { ok: false, reason: 'too-large', min, max };
  return { ok: true, bytes };
}

/** The whole-unit form of a byte count: MB when it divides evenly, else KB. */
function fromBytes(bytes: number): SizeParam {
  if (bytes >= UNIT_SCALE.MB && bytes % 10_000 === 0) {
    return { amount: roundAmount(bytes / UNIT_SCALE.MB), unit: 'MB' };
  }
  return { amount: roundAmount(bytes / UNIT_SCALE.KB), unit: 'KB' };
}

function roundAmount(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/**
 * Parses a longest-side pixel limit (`max=600`, `max=600px`). Clamped into
 * {@link MAX_DIMENSION_BOUNDS}; null for anything that is not a plain
 * positive number.
 */
export function parseMaxDimensionParam(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const match = /^(\d{1,6})(?:px)?$/.exec(raw.trim().toLowerCase());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(MAX_DIMENSION_BOUNDS.max, Math.max(MAX_DIMENSION_BOUNDS.min, value));
}

export interface ToolLinkParams {
  /** The tool id the route names, or null when the route is not a tool route. */
  toolId: string | null;
  /** The route without its query, e.g. `/tool/compress`. */
  path: string;
  /** The query parameters, merged: the hash's own win over the page's. */
  params: URLSearchParams;
  /** True when the hash itself carried a query that should be stripped. */
  hashHadQuery: boolean;
}

const TOOL_PATH = /^\/tool\/([^/?#]+)/;

/**
 * Splits a hash-router location (`/tool/compress?target=100KB`, as wouter's
 * hash hook reports it) plus the page's real `location.search` into the route
 * and its parameters.
 */
export function readToolLink(hashLocation: string, pageSearch = ''): ToolLinkParams {
  const question = hashLocation.indexOf('?');
  const path = question === -1 ? hashLocation : hashLocation.slice(0, question);
  const hashQuery = question === -1 ? '' : hashLocation.slice(question + 1);
  const params = new URLSearchParams(pageSearch.startsWith('?') ? pageSearch.slice(1) : pageSearch);
  for (const [key, value] of new URLSearchParams(hashQuery)) params.set(key, value);
  return {
    toolId: TOOL_PATH.exec(path)?.[1] ?? null,
    path,
    params,
    hashHadQuery: question !== -1
  };
}

/**
 * The query string that pre-fills a target, e.g. `target=100KB`, for building
 * links (the landing pages use it).
 */
export function targetQuery(size: SizeParam): string {
  return `target=${size.amount}${size.unit}`;
}

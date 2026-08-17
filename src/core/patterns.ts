/**
 * RED-05 — pattern detection over extracted page text.
 *
 * Pure string work, deliberately separated from the render worker that supplies
 * the text and turns hits back into rectangles: everything interesting here is a
 * false-positive question, and false positives are only testable if the matcher
 * can be called with a plain string.
 *
 * Nothing in this file redacts anything. It proposes; `RedactPanel` requires a
 * click before a proposal becomes a mark, and marks are only removed from the
 * document by the existing RED-02 commit path.
 */

export type PatternCategory = 'email' | 'phone' | 'ssn' | 'credit-card' | 'ip';

export interface PatternHit {
  category: PatternCategory;
  /** Half-open character range into the string passed to `detectPatterns`. */
  start: number;
  end: number;
  text: string;
}

export const PATTERN_LABELS: Record<PatternCategory, string> = {
  email: 'Email address',
  phone: 'Phone number',
  ssn: 'US Social Security number',
  'credit-card': 'Credit card number',
  ip: 'IP address'
};

/**
 * Ordering is significant: the first category to claim a span wins, and later
 * overlapping hits are dropped. Structured identifiers come before the looser
 * phone pattern so `123-45-6789` is reported once, as an SSN.
 */
const MATCHERS: { category: PatternCategory; re: RegExp; accept?: (text: string) => boolean }[] = [
  {
    category: 'email',
    // Deliberately not RFC 5322: quoted local parts and bare-IP domains cost far
    // more false positives on prose than they buy in recall.
    re: /[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/g
  },
  {
    category: 'ssn',
    // The excluded area/group/serial values are never issued, so rejecting them
    // keeps ordinary hyphenated numbering (placeholder rows, part numbers ending
    // in -0000) out of the suggestions.
    re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g
  },
  {
    category: 'credit-card',
    // 13-19 digits, optionally grouped by single spaces or hyphens. The regex is
    // the cheap filter; Luhn is what actually decides.
    re: /\b\d(?:[ -]?\d){12,18}\b/g,
    accept: text => luhn(text.replace(/[ -]/g, ''))
  },
  {
    category: 'ip',
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g
  },
  {
    category: 'ip',
    // IPv6, including the `::` compressed forms. Written out rather than
    // assembled so it stays greppable against RFC 4291.
    re: /(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,7}:(?![0-9A-Fa-f:])|(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}|(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}|(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}|(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}|[0-9A-Fa-f]{1,4}:(?::[0-9A-Fa-f]{1,4}){1,6}|::(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4}/g,
    // A `12:00:00` clock time satisfies one of the branches above; a real address
    // has at least two colons and is not an all-decimal reading of a time.
    accept: text => (text.match(/:/g)?.length ?? 0) >= 2 && !/^\d{1,2}(?::\d{2}){1,2}$/.test(text)
  },
  {
    category: 'phone',
    // A separator between every group is required. Ten bare digits are far more
    // often an account or order number, and requiring the separator is what keeps
    // credit-card digit runs from being re-reported as phone numbers.
    re: /(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}\b/g
  }
];

/** Luhn check digit. Rejects the all-zero string, which passes arithmetically. */
export function luhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  if (/^0+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Every match in `text`, in document order, with overlaps resolved by the
 * `MATCHERS` precedence above.
 */
export function detectPatterns(text: string): PatternHit[] {
  const hits: PatternHit[] = [];
  const claimed: [number, number][] = [];

  for (const { category, re, accept } of MATCHERS) {
    re.lastIndex = 0;
    for (;;) {
      const match = re.exec(text);
      if (!match) break;
      const start = match.index;
      const end = start + match[0].length;
      if (end === start) {
        re.lastIndex++;
        continue;
      }
      if (accept && !accept(match[0])) continue;
      if (claimed.some(([s, e]) => start < e && s < end)) continue;
      claimed.push([start, end]);
      hits.push({ category, start, end, text: match[0] });
    }
  }

  return hits.sort((a, b) => a.start - b.start);
}

/* ------------------------------------------------------------------ *
 * Locating hits on the page
 * ------------------------------------------------------------------ */

/** The subset of pdf.js's text item this module needs. Mirrors `TextRun`. */
export interface PatternRun {
  str: string;
  /** [scaleX, skewY, skewX, scaleY, tx, ty] — tx/ty are the baseline origin. */
  transform: number[];
  width: number;
  height: number;
  /** True when pdf.js ended a line after this run. */
  hasEOL?: boolean;
}

/** A rectangle normalised to the page box, origin top-left, as the DOM wants it. */
export interface PatternBox {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The slice of the match this rectangle covers. */
  text: string;
}

/** Minimal view of a pdf.js viewport, so rotated pages can be mapped correctly. */
export interface PatternViewport {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): number[];
}

export interface LocatedPattern {
  category: PatternCategory;
  /** The whole matched string, even when it is split across several runs. */
  text: string;
  boxes: PatternBox[];
}

/**
 * Runs a page's text through `detectPatterns` and maps each hit back to one
 * rectangle per text run it covers.
 *
 * Runs are concatenated in the order pdf.js emits them, with a newline after a
 * run that ends a line. Concatenating rather than scanning run by run is what
 * lets a hit be found when the typesetter split `jane.doe@` and `example.com`
 * into separate runs; the newline stops a pattern being invented across a line
 * break, since none of the patterns may contain one.
 *
 * The per-character width is the same monospace approximation `findText` uses
 * (pdf.js exposes no per-glyph advances), so a suggested rectangle is as
 * conservative — very slightly over-inclusive — as a searched one, and the RED-03
 * geometric verifier judges both with the same arithmetic.
 */
function boxFromRun(
  run: PatternRun,
  viewport: PatternViewport,
  from: number,
  to: number
): PatternBox {
  const perChar = run.width / Math.max(1, run.str.length);
  const height = run.height || run.transform[3] || 12;
  const x0 = run.transform[4] + from * perChar;
  const x1 = run.transform[4] + to * perChar;
  const y0 = run.transform[5];
  const y1 = run.transform[5] + height;
  const corners = [
    viewport.convertToViewportPoint(x0, y0),
    viewport.convertToViewportPoint(x1, y0),
    viewport.convertToViewportPoint(x1, y1),
    viewport.convertToViewportPoint(x0, y1)
  ];
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const left = Math.min(...xs) / viewport.width;
  const top = Math.min(...ys) / viewport.height;
  const right = Math.max(...xs) / viewport.width;
  const bottom = Math.max(...ys) / viewport.height;
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
    text: run.str.slice(from, to)
  };
}

export function locatePatterns(
  runs: PatternRun[],
  viewportOrWidth: PatternViewport | number,
  pageHeight?: number
): LocatedPattern[] {
  const viewport: PatternViewport =
    typeof viewportOrWidth === 'number'
      ? {
          width: viewportOrWidth,
          height: pageHeight ?? viewportOrWidth,
          convertToViewportPoint: (x, y) => [x, (pageHeight ?? viewportOrWidth) - y]
        }
      : viewportOrWidth;
  const spans: { run: PatternRun; start: number }[] = [];
  let text = '';
  for (const run of runs) {
    if (run.str.length > 0) spans.push({ run, start: text.length });
    text += run.str;
    if (run.hasEOL) text += '\n';
  }
  if (!text) return [];

  const located: LocatedPattern[] = [];
  for (const hit of detectPatterns(text)) {
    const boxes: PatternBox[] = [];
    for (const { run, start } of spans) {
      const end = start + run.str.length;
      if (hit.end <= start || hit.start >= end) continue;
      const from = Math.max(0, hit.start - start);
      const to = Math.min(run.str.length, hit.end - start);
      if (to <= from) continue;
      boxes.push(boxFromRun(run, viewport, from, to));
    }
    if (boxes.length > 0) located.push({ category: hit.category, text: hit.text, boxes });
  }
  return located;
}

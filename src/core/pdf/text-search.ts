/**
 * Matching search text across pdf.js text runs (AUDIT-FINDINGS §1).
 *
 * pdf.js splits a page's text into runs at every change of font, size, colour
 * or kerning cluster. "Account number" is routinely three runs, and a name is
 * routinely split mid-word by a single kern pair. Searching each run in
 * isolation — which is what find-and-mark used to do — therefore *misses*
 * occurrences, and a redaction feature that silently fails to find the thing
 * the user searched for is the worst kind of miss: the UI reports "0 matches"
 * and the secret stays in the file.
 *
 * So the page is matched as one string, with a map back to the run and offset
 * every character came from, and a match is returned as one slice per run it
 * touches. The caller draws a box per slice, which is correct even when a match
 * straddles a font change and the two halves sit at different sizes.
 *
 * Two deliberate biases, both towards over-matching, because for redaction an
 * extra mark costs the user a redraw and a missed one costs them the document:
 *
 *  - Runs are joined with no separator, so a producer that splits "Hello World"
 *    into "Hello" and "World" without emitting the space still matches the
 *    query "HelloWorld". It cannot match "Hello World"; nothing here invents
 *    whitespace that is not in the text layer.
 *  - A run pdf.js marks as ending a line (`hasEOL`) is followed by a newline in
 *    the haystack, so a match cannot silently span two lines of unrelated text.
 */
import type { TextRun } from '../text-layout';

/** The part of one run a match covers, as a `[start, end)` character range. */
export interface RunSlice {
  runIndex: number;
  start: number;
  end: number;
}

export interface CrossRunMatch {
  /** In run order. Length > 1 only when the match straddles a run boundary. */
  slices: RunSlice[];
  /** The matched text as it appears in the concatenated page text. */
  text: string;
}

interface CharSource {
  runIndex: number;
  offset: number;
}

/**
 * Every occurrence of `needle` in the concatenated text of `runs`.
 *
 * Occurrences do not overlap: the scan resumes after each match, which is what
 * makes marking "aa" in "aaa" produce one mark, not two overlapping ones.
 */
export function findAcrossRuns(
  runs: TextRun[],
  needle: string,
  matchCase: boolean
): CrossRunMatch[] {
  if (!needle) return [];

  let haystack = '';
  const sources: CharSource[] = [];
  for (let runIndex = 0; runIndex < runs.length; runIndex++) {
    const run = runs[runIndex];
    for (let offset = 0; offset < run.str.length; offset++) {
      sources.push({ runIndex, offset });
    }
    haystack += run.str;
    if (run.hasEOL) {
      // A separator with no source: a match may not span it, and `sliceFor`
      // never sees these indices because a match containing one is impossible
      // (the needle would have to contain the newline, and then the lookup
      // below simply finds no source and the match is skipped).
      haystack += '\n';
      sources.push({ runIndex: -1, offset: -1 });
    }
  }

  const hay = matchCase ? haystack : haystack.toLowerCase();
  const query = matchCase ? needle : needle.toLowerCase();

  const matches: CrossRunMatch[] = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(query, from);
    if (at === -1) break;
    from = at + query.length;

    const slices = slicesFor(sources, at, at + query.length);
    // A match that crosses an injected line break has no run to sit in; the
    // text layer says those characters are on different lines, so it is not a
    // match on the page even though it is one in the joined string.
    if (slices.length > 0) {
      matches.push({ slices, text: haystack.slice(at, at + query.length) });
    }
  }
  return matches;
}

/** Groups `[start, end)` of the concatenated text into per-run ranges. */
function slicesFor(sources: CharSource[], start: number, end: number): RunSlice[] {
  const slices: RunSlice[] = [];
  for (let i = start; i < end; i++) {
    const source = sources[i];
    if (!source || source.runIndex < 0) return [];
    const last = slices[slices.length - 1];
    if (last && last.runIndex === source.runIndex && last.end === source.offset) {
      last.end = source.offset + 1;
    } else {
      slices.push({ runIndex: source.runIndex, start: source.offset, end: source.offset + 1 });
    }
  }
  return slices;
}

/**
 * CNV-12 — the slide plan, written out as a `.pptx`.
 *
 * `pptxgenjs` is loaded through a **dynamic `import()`** and nothing else in this
 * file touches it, so it lands in its own lazy chunk and costs nothing until a
 * conversion runs. That is the same discipline `docx` (CNV-08), `mammoth`
 * (CNV-09) and `xlsx` (CNV-11) follow, and the reason all four live behind
 * `convert.worker.ts` rather than in four workers of their own.
 *
 * ## Why every picture is handed over as `data`, never as `path`
 *
 * `pptxgenjs` can fetch an image for you. `encodeSlideMediaRels` in its bundle
 * builds a list of the media relationships it still has to resolve and, in a
 * browser, resolves each with `new XMLHttpRequest()`. That code path is a network
 * request, which invariant 1 forbids outright — so this writer sets `data` on
 * **every** `addImage` call and never sets `path`.
 *
 * The argument that this is unreachable rests on three facts about the library
 * and this file, not on a test:
 *
 *  1. `addImage` is called from **one place in the whole application** — the loop
 *     at the bottom of this file.
 *  2. That call sets `data` **unconditionally**. There is no branch on which it
 *     is absent; a placement whose bytes are missing is skipped before the call.
 *  3. The library selects the relationships to resolve with one filter,
 *     `rel.type !== 'online' && !rel.data && …`, and **that same filter gates
 *     every branch** — the browser's `XMLHttpRequest`, and the `node:fs` and
 *     `node:https` branches it takes instead under Node. A relationship carrying
 *     its own bytes is excluded before any of them is chosen.
 *
 * Because the candidate list is shared, a conversion that completes at all — in
 * any environment — is evidence that it held nothing: had this file produced an
 * XHR-eligible relationship, Node's own branch would have tried to read it off a
 * filesystem and failed. `pdf-to-ppt.test.ts` converts a document *that embeds
 * real images* and asserts two of them arrived in the package, so that evidence
 * is exercised on every run.
 *
 * That test also installs a throwing `XMLHttpRequest`, `fetch` and `WebSocket`,
 * and it is worth being exact about what that does and does not show. It runs
 * under Vitest's Node environment, where `pptxgenjs` checks `process.versions
 * ?.node` and takes its Node branch — so the browser `XMLHttpRequest` call is
 * never a candidate there and the stub going unfired proves nothing about it.
 * The stubs are kept as a regression tripwire rather than as proof: a future
 * `addImage` that passed a `path` would break fact 2, and the run would fail
 * loudly instead of the product quietly acquiring a fetch. The proof is facts
 * 1–3 above, and `verify-offline`'s bundle scan is where the library's own
 * occurrence is accounted for (see `RELEASE_CHECKLIST.md`).
 *
 * ## Geometry
 *
 * None. `slides.ts` has already resolved the page box's origin, the y flip, page
 * and text rotation and the fit-to-slide scale into points from the slide's
 * top-left, so this file divides by 72 and writes inches. Keeping the arithmetic
 * out of here is what lets it be unit-tested without the library.
 */

import { unsupported } from '../errors';
import { checkpoint, type JobHandle } from '../workers/protocol';
import type { PlannedSlide, SlidePlan } from './slides';
// Type-only, and therefore erased: this file's single *runtime* reference to
// `pptxgenjs` is the `await import(...)` below, which is what keeps the library
// in its own lazy chunk. `tests/unit/pdf-to-ppt.test.ts` asserts the source tree
// holds no static import of it.
import type PptxGenJS from 'pptxgenjs';

/** Points per inch. PowerPoint measures in inches (and stores EMU). */
const POINTS_PER_INCH = 72;

/**
 * The smallest box PowerPoint will keep. A zero-width shape is dropped by some
 * viewers and shows as an unselectable sliver in others, so a measured extent
 * below this is widened to it rather than written as-is.
 */
const MIN_EXTENT_INCHES = 0.02;

/** Why a deck with no slides is refused rather than written. */
export const NO_SLIDES_MESSAGE =
  'There are no pages to convert, so there would be no slides. Nothing was written.';

function inches(points: number): number {
  // Six decimals is ~0.9 EMU, well below PowerPoint's own resolution, and keeps
  // the numbers out of exponential notation.
  return Math.round((points / POINTS_PER_INCH) * 1e6) / 1e6;
}

function extent(points: number): number {
  return Math.max(MIN_EXTENT_INCHES, inches(points));
}

/**
 * Bytes → base64, in chunks.
 *
 * `btoa(String.fromCharCode(...bytes))` is the one-liner and it throws
 * `RangeError: Maximum call stack size exceeded` on a few hundred kilobytes,
 * which is an ordinary size for a photograph in a PDF. The chunk size is well
 * under any engine's argument limit.
 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** What the caller has to supply beyond the plan itself. */
export interface PptxBuildOptions {
  /** Written into the deck's core properties as its title. */
  title: string;
  /** CNV-06's archive, already unzipped: ZIP entry name → bytes. */
  images: Readonly<Record<string, Uint8Array>>;
}

/**
 * Writes the plan as a `.pptx`.
 *
 * One slide per page, in page order, with each page's pictures added before its
 * text boxes so the text is on top — which is the z-order the page itself has
 * (a PDF's text is drawn over its background image) and the only order that
 * leaves an OCR'd scan's text layer legible rather than hidden.
 */
export async function buildPptx(
  plan: SlidePlan,
  options: PptxBuildOptions,
  job?: JobHandle
): Promise<Uint8Array> {
  if (plan.slides.length === 0) throw unsupported(NO_SLIDES_MESSAGE);

  await checkpoint(job, 0, 'Loading the PowerPoint writer');
  // The only reference to `pptxgenjs` in the whole source tree, and it is
  // dynamic — see the module comment.
  const { default: PptxGenJS } = await import('pptxgenjs');

  const deck = new PptxGenJS();
  deck.title = options.title;
  // One custom layout at the source page's own size, rather than one of
  // PowerPoint's 4:3 / 16:9 presets: a letter-sized page force-fitted to 16:9
  // would letterbox every slide in the deck, which is the opposite of "a
  // same-size slide".
  deck.defineLayout({
    name: 'PDF_PAGE',
    width: inches(plan.slideWidth),
    height: inches(plan.slideHeight)
  });
  deck.layout = 'PDF_PAGE';

  /**
   * ZIP entry name → the data URI already built for it, so shared art is
   * base64-encoded once however many slides use it.
   *
   * This also bounds the memory: a JS string is immutable, so handing the same
   * string to forty `addImage` calls costs one copy of it, not forty. What it
   * does *not* fix is the forty media *parts* the library then writes — that is
   * `dedupeMediaParts`' job, below.
   */
  const encoded = new Map<string, string>();

  for (let i = 0; i < plan.slides.length; i++) {
    const planned = plan.slides[i];
    await checkpoint(
      job,
      i / plan.slides.length,
      `Writing slide ${i + 1} of ${plan.slides.length}`
    );
    addSlide(deck, planned, options.images, encoded);
  }

  await checkpoint(job, 0.85, 'Packaging the presentation');
  // `uint8array` rather than `arraybuffer`: JSZip supports both, and this is the
  // shape the Comlink transfer and `platform.saveFileAs` both want.
  //
  // `compression: true` even though `dedupeMediaParts` may re-zip below. The
  // alternative — write uncompressed and let the dedup pass do the only
  // compression — is faster on a deck with duplicated art and *wrong* on one
  // without, because the dedup pass returns the original bytes untouched when
  // there is nothing to collapse, and those bytes would then be an
  // uncompressed `.pptx`. The common case is the one that must be right; the
  // duplicated-art case pays for one extra deflate and saves far more than that
  // in file size.
  const written = await deck.write({ outputType: 'uint8array', compression: true });
  if (!(written instanceof Uint8Array)) {
    // Defensive: a library change that started returning a Blob here would
    // otherwise reach `saveFileAs` as an unwritable value.
    throw unsupported(
      'The PowerPoint writer returned an unexpected result, so nothing was written. Your PDF is ' +
        'untouched.'
    );
  }

  await checkpoint(job, 0.95, 'Removing duplicated images');
  const deduped = await dedupeMediaParts(written);
  await checkpoint(job, 1, 'Packaging the presentation');
  return deduped;
}

/**
 * Collapses byte-identical `ppt/media/` parts to one copy, repointing the
 * relationships that named the copies.
 *
 * **Why this exists.** `pptxgenjs` does not deduplicate media at all for the way
 * this writer calls it. Its only collapsing rule compares the `path` a caller
 * passed, and this writer never passes one — so a picture handed over as `data`
 * always becomes a new media part, even twice on the same slide, and every part
 * is named `image-<slideNum>-<n>`. That is measured, not read off the source:
 * `pdf-to-ppt.test.ts`'s first dedup test asserts the library's own behaviour
 * (three slides drawing one image → three parts) *before* asserting this pass
 * collapses them, so the test cannot silently stop being about anything. A logo
 * drawn on 300 pages is therefore 300 identical parts in the package, which is
 * not a cosmetic problem: a 400 KB letterhead on a 300-page document is a 120 MB
 * deck, and this codebase's rule for a shared image (CNV-06, CMP-03) is *encode
 * once, not once per page*. `pptx-writer.ts` already base64-encodes each distinct
 * image once; this makes the same true of the file.
 *
 * **Why it is safe.** A media part is referenced only from a `_rels` part's
 * `Target`, and `[Content_Types].xml` types these by *extension*
 * (`<Default Extension="png" …/>`), not per part — so removing a part and
 * repointing its relationship leaves nothing dangling. `Target`s are rewritten by
 * exact-string replacement of the whole attribute value, so a part name that is a
 * prefix of another cannot be partially rewritten.
 *
 * **Why identity is compared byte-for-byte** rather than by a hash: a hash
 * collision here would silently swap one image for another, which is precisely
 * the class of failure this codebase refuses. Parts are grouped by length first,
 * so the comparison is cheap.
 *
 * When nothing is duplicated the original bytes are returned **untouched** — the
 * package is not unzipped and re-zipped for nothing.
 */
export async function dedupeMediaParts(bytes: Uint8Array): Promise<Uint8Array> {
  const { unzipSync, zipSync, strFromU8, strToU8 } = await import('fflate');
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    // We just wrote this package, so this is unreachable in practice. Returning
    // the bytes we have is the only correct answer if it ever is reached: a deck
    // with duplicated images is a large file, and no deck at all is a lost one.
    return bytes;
  }

  const media = Object.keys(files)
    .filter(name => name.startsWith('ppt/media/') && !name.endsWith('/'))
    .sort();
  if (media.length < 2) return bytes;

  /** Duplicate part name → the canonical part it is identical to. */
  const replacement = new Map<string, string>();
  /** Length → the canonical parts seen at that length. */
  const canonical = new Map<number, string[]>();

  for (const name of media) {
    const bucket = canonical.get(files[name].length);
    if (!bucket) {
      canonical.set(files[name].length, [name]);
      continue;
    }
    const match = bucket.find(other => sameBytes(files[other], files[name]));
    if (match) replacement.set(name, match);
    else bucket.push(name);
  }

  if (replacement.size === 0) return bytes;

  const rewritten: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    if (replacement.has(name)) continue;
    if (!name.endsWith('.rels')) {
      rewritten[name] = content;
      continue;
    }
    let xml = strFromU8(content);
    for (const [duplicate, keep] of replacement) {
      // Both are `ppt/media/...`; a slide's rels name them relative to
      // `ppt/slides/`, and the presentation's would name them relative to `ppt/`.
      // Rewriting the whole quoted attribute value avoids touching a part whose
      // name is a prefix of another's.
      for (const prefix of ['../media/', '/ppt/media/', 'media/']) {
        const from = `Target="${prefix}${duplicate.slice('ppt/media/'.length)}"`;
        const to = `Target="${prefix}${keep.slice('ppt/media/'.length)}"`;
        xml = xml.split(from).join(to);
      }
    }
    rewritten[name] = strToU8(xml);
  }

  return zipSync(rewritten, { level: 6 });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function addSlide(
  deck: PptxGenJS,
  planned: PlannedSlide,
  images: Readonly<Record<string, Uint8Array>>,
  encoded: Map<string, string>
): void {
  const slide = deck.addSlide();

  for (const image of planned.images) {
    let data = encoded.get(image.fileName);
    if (data === undefined) {
      const bytes = images[image.fileName];
      // `planSlides` already refused a placement whose file is missing from the
      // archive, so this is unreachable in the product; skipping rather than
      // throwing keeps one bad image from costing the whole deck if it is ever
      // reached.
      if (!bytes || bytes.length === 0) continue;
      // Encoded once per distinct image, not once per placement: a logo drawn on
      // 40 slides is one base64 string, and a JS string is immutable, so 40
      // `addImage` calls share it rather than holding 40 copies. It is *not* one
      // media part — the library writes a fresh part per call however identical
      // the `data` is, which is `dedupeMediaParts`' whole reason for existing.
      data = `image/${image.format === 'jpg' ? 'jpeg' : 'png'};base64,${toBase64(bytes)}`;
      encoded.set(image.fileName, data);
    }
    slide.addImage({
      // `data`, never `path`. See the module comment: `path` is what makes the
      // library reach for XMLHttpRequest.
      data,
      x: inches(image.x),
      y: inches(image.y),
      w: extent(image.width),
      h: extent(image.height),
      ...(image.rotate ? { rotate: image.rotate } : {}),
      altText: image.altText
    });
  }

  for (const box of planned.boxes) {
    slide.addText(
      box.runs.map(run => ({
        text: run.text,
        options: { bold: run.bold, italic: run.italic }
      })),
      {
        x: inches(box.x),
        y: inches(box.y),
        w: extent(box.width),
        h: extent(box.height),
        fontSize: Math.max(1, Math.round(box.fontSize * 10) / 10),
        // Zero inset and top anchoring are what make the box's top-left edge the
        // place the first glyph is drawn from, which is the whole basis of the
        // positioning in `slides.ts`. PowerPoint's default 0.05"/0.1" margins
        // would shift every line on every slide.
        margin: 0,
        valign: 'top',
        align: 'left',
        // One PDF line is one visual line. Wrapping would push the second half
        // of a line down onto the next line's box, so the box is allowed to
        // overrun instead — the text stays where the page put it, which is what
        // this tool promises, and the overrun is disclosed in the panel.
        wrap: false,
        fit: 'none',
        isTextBox: true,
        // Degrees clockwise about the box's centre, already folded into
        // `[0, 360)` by `slides.ts` — which matters, because the library's
        // `convertRotationDegrees` only subtracts 360 from a value *above* 360
        // and passes anything negative straight through. Omitted when zero so an
        // unrotated deck carries no `rot` attribute at all.
        ...(box.rotate ? { rotate: box.rotate } : {})
      }
    );
  }
}

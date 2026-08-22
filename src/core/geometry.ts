/**
 * Polygon geometry, for redaction marks that are a drawn shape rather than a
 * rectangle (RED-07).
 *
 * Kept as pure functions in `core/` with no PDF types of its own, because every
 * layer of the redaction pipeline has to agree on the answer to the same
 * question — "is this run/pixel/annotation inside the mark?" — and they ask it in
 * four different coordinate spaces: content space (the operator filter), the
 * page's normalised display frame (the verifier's text half), region-local pixels
 * (the verifier's pixel half), and an image's own unit square (the image pixel
 * blackout). A disagreement between any two of them is a leak: content removed
 * that the mark never covered, or worse, content left under an opaque shape that
 * the verifier then declares clean.
 *
 * The **nonzero winding rule** is used throughout, because that is what
 * `pdf-lib`'s `drawSvgPath` fill emits (`f`, not `f*`) for the visible mark. Had
 * this used the even-odd rule while the mark filled nonzero, a self-crossing
 * freehand shape would paint opaque black over an area these predicates call
 * "outside" — text that is never removed, never verified, and hidden under a
 * black shape. That is precisely the overlay-only failure RED-02 exists to
 * prevent, so the two rules are deliberately the same one.
 */

export interface Point {
  x: number;
  y: number;
}

/** Structurally identical to `interpreter.ts`'s `Rect`; kept local so this module imports nothing. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The axis-aligned bounding box of a polygon. Empty input gives an empty box. */
export function polygonBounds(points: readonly Point[]): Box {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Twice the signed area of the triangle `a`, `b`, `p` — the "which side" test. */
function side(a: Point, b: Point, x: number, y: number): number {
  return (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y);
}

/**
 * Point-in-polygon by winding number (the nonzero rule) — see the module note on
 * why this rule and not even-odd.
 *
 * Works in either y direction: a reflection negates every winding number, and the
 * predicate only asks whether it is zero. Fewer than three points enclose nothing.
 */
export function pointInPolygon(points: readonly Point[], x: number, y: number): boolean {
  const n = points.length;
  if (n < 3) return false;
  let winding = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    if (a.y <= y) {
      if (b.y > y && side(a, b, x, y) > 0) winding++;
    } else if (b.y <= y && side(a, b, x, y) < 0) winding--;
  }
  return winding !== 0;
}

/**
 * Liang–Barsky: does the segment `a`→`b` meet the closed box at all?
 *
 * True for a segment that lies entirely inside the box, and for one that only
 * touches its boundary. A zero-length segment reduces to a point-in-box test.
 */
function segmentMeetsBox(a: Point, b: Point, box: Box): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return (
    clip(-dx, a.x - box.x) &&
    clip(dx, box.x + box.width - a.x) &&
    clip(-dy, a.y - box.y) &&
    clip(dy, box.y + box.height - a.y)
  );
}

/**
 * Does the polygon overlap the box at all?
 *
 * This is the granularity RED-02 already applies to rectangle marks: a text run
 * is removed when its box *intersects* the mark, not when it is contained by it
 * (`filterContentStream`'s `intersects` call). Polygon marks match that rule
 * rather than inventing a stricter one, so switching a mark from rectangle to
 * shape never leaves behind a run the rectangle would have taken.
 */
export function polygonOverlapsBox(points: readonly Point[], box: Box): boolean {
  if (points.length < 3) return false;
  const bounds = polygonBounds(points);
  // Cheap reject first: most runs on a page are nowhere near the mark.
  if (
    bounds.x > box.x + box.width ||
    bounds.x + bounds.width < box.x ||
    bounds.y > box.y + box.height ||
    bounds.y + bounds.height < box.y
  ) {
    return false;
  }
  // A box corner inside the polygon covers the box-inside-polygon case, which no
  // edge crossing would reveal.
  const corners: Point[] = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height }
  ];
  for (const c of corners) {
    if (pointInPolygon(points, c.x, c.y)) return true;
  }
  // Any edge meeting the box covers both a crossing and a polygon drawn entirely
  // inside the box.
  for (let i = 0; i < points.length; i++) {
    if (segmentMeetsBox(points[i], points[(i + 1) % points.length], box)) return true;
  }
  return false;
}

/**
 * Is every part of the box inside the polygon?
 *
 * Used where a whole object can only be dropped when the mark covers all of it —
 * an image XObject's `Do`, which is either removed outright or has its pixels
 * blacked out. Deliberately conservative: an edge that merely grazes the box
 * boundary answers "no", which routes the image to the pixel path and blacks out
 * more of it than strictly necessary. Over-removal is the only safe direction to
 * be wrong in.
 */
export function polygonContainsBox(points: readonly Point[], box: Box): boolean {
  if (points.length < 3) return false;
  const corners: Point[] = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height }
  ];
  for (const c of corners) {
    if (!pointInPolygon(points, c.x, c.y)) return false;
  }
  for (let i = 0; i < points.length; i++) {
    if (segmentMeetsBox(points[i], points[(i + 1) % points.length], box)) return false;
  }
  return true;
}

/**
 * Rasterises a polygon into a `width`×`height` mask of 0/1 bytes, row-major.
 *
 * `points` are in the mask's own grid units (x = column, y = row); the caller
 * does whatever scaling and y-flipping its space needs, so this stays a single
 * implementation shared by the pixel verifier and the image blackout. A pixel is
 * in when its *centre* is in, by scanline crossings under the nonzero rule —
 * `growMask` is how a caller biases that towards over-coverage.
 */
export function fillPolygonMask(
  points: readonly Point[],
  width: number,
  height: number
): Uint8Array {
  const mask = new Uint8Array(Math.max(0, width) * Math.max(0, height));
  const n = points.length;
  if (n < 3 || width <= 0 || height <= 0) return mask;

  const crossings: { x: number; dir: number }[] = [];
  for (let row = 0; row < height; row++) {
    const y = row + 0.5;
    crossings.length = 0;
    for (let i = 0; i < n; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      if (a.y === b.y) continue;
      const lo = Math.min(a.y, b.y);
      const hi = Math.max(a.y, b.y);
      // Half-open in y, so a vertex shared by two edges is counted once.
      if (y < lo || y >= hi) continue;
      const t = (y - a.y) / (b.y - a.y);
      crossings.push({ x: a.x + t * (b.x - a.x), dir: b.y > a.y ? 1 : -1 });
    }
    if (crossings.length < 2) continue;
    crossings.sort((p, q) => p.x - q.x);
    let winding = 0;
    for (let i = 0; i < crossings.length - 1; i++) {
      winding += crossings[i].dir;
      if (winding === 0) continue;
      // Pixel centre at col+0.5 lies in [x_i, x_i+1).
      const from = Math.max(0, Math.ceil(crossings[i].x - 0.5));
      const to = Math.min(width, Math.ceil(crossings[i + 1].x - 0.5));
      const base = row * width;
      for (let col = from; col < to; col++) mask[base + col] = 1;
    }
  }
  return mask;
}

/**
 * Separable square min/max filter over a 0/1 mask. Out-of-bounds counts as 0, so
 * eroding also trims `radius` pixels off the mask's own border — which is what
 * makes a full mask erode to exactly the inset rectangle the pixel verifier used
 * before shapes existed.
 */
function filterMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
  rule: 'erode' | 'dilate'
): Uint8Array {
  if (radius <= 0 || width <= 0 || height <= 0) return mask;
  const span = radius * 2 + 1;
  const prefix = new Int32Array(Math.max(width, height) + 1);
  const pass = (src: Uint8Array, major: number, minor: number, rowMajor: boolean): Uint8Array => {
    const out = new Uint8Array(src.length);
    for (let a = 0; a < major; a++) {
      for (let b = 0; b < minor; b++) {
        prefix[b + 1] = prefix[b] + src[rowMajor ? a * minor + b : b * major + a];
      }
      for (let b = 0; b < minor; b++) {
        const lo = b - radius;
        const hi = b + radius;
        const at = rowMajor ? a * minor + b : b * major + a;
        if (rule === 'erode') {
          if (lo < 0 || hi >= minor) continue;
          out[at] = prefix[hi + 1] - prefix[lo] === span ? 1 : 0;
        } else {
          const sum = prefix[Math.min(minor, hi + 1)] - prefix[Math.max(0, lo)];
          out[at] = sum > 0 ? 1 : 0;
        }
      }
    }
    return out;
  };
  return pass(pass(mask, height, width, true), width, height, false);
}

/** Drops every pixel within `radius` of a zero or of the mask's edge. */
export function shrinkMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number
): Uint8Array {
  return filterMask(mask, width, height, radius, 'erode');
}

/** Adds every pixel within `radius` of a one — the over-coverage bias. */
export function growMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number
): Uint8Array {
  return filterMask(mask, width, height, radius, 'dilate');
}

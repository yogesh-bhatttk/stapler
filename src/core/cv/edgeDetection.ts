import { Point, Quad, quadArea } from './imageUtils';

function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function extractDocumentQuad(imageData: ImageData): {
  quad: Quad | null;
  confident: boolean;
} {
  const { width, height, data } = imageData;

  // 1. Grayscale
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    gray[i] = luma(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  }

  // 2. Gaussian Blur (5x5)
  const blurred = new Float32Array(width * height);
  const kernel = [2, 4, 5, 4, 2, 4, 9, 12, 9, 4, 5, 12, 15, 12, 5, 4, 9, 12, 9, 4, 2, 4, 5, 4, 2];
  const weight = 159;
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      let sum = 0;
      let k = 0;
      for (let ky = -2; ky <= 2; ky++) {
        const rowOffset = (y + ky) * width;
        for (let kx = -2; kx <= 2; kx++) {
          sum += gray[rowOffset + (x + kx)] * kernel[k++];
        }
      }
      blurred[y * width + x] = sum / weight;
    }
  }

  // 3. Sobel Edge Detection + NMS
  //
  // Bounded to [3, height-4] / [3, width-4], one pixel further in than the blur
  // pass's own [2, height-3] / [2, width-3]: the 3x3 Sobel kernel reads
  // `blurred` at y±1/x±1, so starting at the blur's own boundary read one row
  // into the region `blurred` never wrote (it defaults to 0, not "the same
  // brightness as its neighbour"). That fake 0-vs-real-luma seam produced a
  // spurious high-magnitude edge ring around the whole frame, strong enough
  // that a photo with no real edges anywhere still confidently reported a quad.
  const mag = new Float32Array(width * height);
  const dir = new Int8Array(width * height);
  let maxMag = 0;

  for (let y = 3; y < height - 3; y++) {
    for (let x = 3; x < width - 3; x++) {
      const p11 = blurred[(y - 1) * width + (x - 1)];
      const p12 = blurred[(y - 1) * width + x];
      const p13 = blurred[(y - 1) * width + (x + 1)];
      const p21 = blurred[y * width + (x - 1)];
      const p23 = blurred[y * width + (x + 1)];
      const p31 = blurred[(y + 1) * width + (x - 1)];
      const p32 = blurred[(y + 1) * width + x];
      const p33 = blurred[(y + 1) * width + (x + 1)];

      const gx = -p11 + p13 - 2 * p21 + 2 * p23 - p31 + p33;
      const gy = -p11 - 2 * p12 - p13 + p31 + 2 * p32 + p33;

      const m = Math.sqrt(gx * gx + gy * gy);
      mag[y * width + x] = m;
      if (m > maxMag) maxMag = m;

      let a = Math.atan2(gy, gx) * (180 / Math.PI);
      if (a < 0) a += 180;
      if ((a >= 0 && a < 22.5) || (a >= 157.5 && a <= 180)) dir[y * width + x] = 0;
      else if (a >= 22.5 && a < 67.5) dir[y * width + x] = 1;
      else if (a >= 67.5 && a < 112.5) dir[y * width + x] = 2;
      else dir[y * width + x] = 3;
    }
  }

  // Same reasoning as the Sobel bound above: `mag` is only valid inside
  // [3, height-4] / [3, width-4], so reading its ±1 neighbours needs one more
  // pixel of margin.
  const nms = new Float32Array(width * height);
  for (let y = 4; y < height - 4; y++) {
    for (let x = 4; x < width - 4; x++) {
      const m = mag[y * width + x];
      const d = dir[y * width + x];
      let p1 = 0,
        p2 = 0;
      if (d === 0) {
        p1 = mag[y * width + (x - 1)];
        p2 = mag[y * width + (x + 1)];
      } else if (d === 1) {
        p1 = mag[(y - 1) * width + (x + 1)];
        p2 = mag[(y + 1) * width + (x - 1)];
      } else if (d === 2) {
        p1 = mag[(y - 1) * width + x];
        p2 = mag[(y + 1) * width + x];
      } else if (d === 3) {
        p1 = mag[(y - 1) * width + (x - 1)];
        p2 = mag[(y + 1) * width + (x + 1)];
      }

      if (m >= p1 && m >= p2) nms[y * width + x] = m;
    }
  }

  // A blank or near-blank frame has no gradient anywhere, so `maxMag` is 0 (or
  // rounds to it) and both thresholds below would also be 0 — at which point
  // `nms[i] >= high` is true for every pixel, including the ones that are not an
  // edge at all, and the whole frame gets traced as "edges". Bailing out here
  // is what makes a textureless photo report no confident quad instead of one.
  if (maxMag < 1e-6) return { quad: null, confident: false };

  // 4. Hysteresis Thresholding
  const high = maxMag * 0.15;
  const low = maxMag * 0.05;
  const edges = new Uint8Array(width * height);
  const stack: number[] = [];

  for (let i = 0; i < nms.length; i++) {
    if (nms[i] >= high) {
      edges[i] = 255;
      stack.push(i);
    } else if (nms[i] >= low) {
      edges[i] = 128;
    }
  }

  const dx8 = [-1, 0, 1, -1, 1, -1, 0, 1];
  const dy8 = [-1, -1, -1, 0, 0, 1, 1, 1];

  while (stack.length > 0) {
    const i = stack.pop()!;
    const y = Math.floor(i / width);
    const x = i % width;
    for (let k = 0; k < 8; k++) {
      const nx = x + dx8[k];
      const ny = y + dy8[k];
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        const ni = ny * width + nx;
        if (edges[ni] === 128) {
          edges[ni] = 255;
          stack.push(ni);
        }
      }
    }
  }
  for (let i = 0; i < edges.length; i++) {
    if (edges[i] !== 255) edges[i] = 0;
  }

  // A page's physical corner is exactly where the gradient direction changes
  // fastest, and hysteresis thresholding routinely drops a pixel or two right
  // there — a well-documented Canny weakness, not specific to this
  // implementation. That turns one closed loop around the page into four
  // disconnected straight edges, each of which trivially simplifies to a
  // 2-point line and so never matches the "exactly 4 points" quad filter below.
  // One dilation pass bridges a 1-pixel gap without measurably fattening the
  // page's actual corners at any resolution this runs at.
  const dilated = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (edges[i] === 255) {
        dilated[i] = 255;
        continue;
      }
      for (let dy = -1; dy <= 1 && dilated[i] === 0; dy++) {
        for (let dx = -1; dx <= 1 && dilated[i] === 0; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (edges[ny * width + nx] === 255) dilated[i] = 255;
        }
      }
    }
  }

  // 5. Contour Tracing (Moore-Neighbor)
  const contours = mooreNeighbor(dilated, width, height);

  // 6. Find Largest Quadrilateral
  let bestQuad: Quad | null = null;
  let maxArea = 0;

  for (const contour of contours) {
    // Approximate polygon
    const perimeter = contourPerimeter(contour);
    const approx = approxPoly(contour, 0.02 * perimeter);

    // We want exactly 4 points, but approximation might give more or less.
    // Let's filter for 4 points.
    if (approx.length === 4 && isConvex(approx)) {
      const q = makeQuad(approx);
      const area = quadArea(q);
      if (area > maxArea) {
        maxArea = area;
        bestQuad = q;
      }
    }
  }

  const frameArea = width * height;
  if (bestQuad && maxArea > frameArea * 0.15 && maxArea < frameArea * 0.995) {
    return { quad: bestQuad, confident: true };
  }

  return { quad: null, confident: false };
}

function mooreNeighbor(edges: Uint8Array, width: number, height: number): Point[][] {
  const visited = new Uint8Array(width * height);
  const contours: Point[][] = [];
  const dx = [1, 1, 0, -1, -1, -1, 0, 1];
  const dy = [0, -1, -1, -1, 0, 1, 1, 1];

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (edges[i] === 255 && !visited[i]) {
        let startDir = -1;
        for (let k = 0; k < 8; k++) {
          if (edges[(y + dy[k]) * width + (x + dx[k])] === 255) {
            startDir = k;
            break;
          }
        }
        if (startDir === -1) {
          visited[i] = 1;
          continue;
        }

        const contour: Point[] = [];
        let currX = x;
        let currY = y;
        let backtrackDir = (startDir + 4) % 8;
        const firstX = x;
        const firstY = y;

        while (true) {
          contour.push({ x: currX, y: currY });
          visited[currY * width + currX] = 1;

          let foundDir = -1;
          for (let k = 1; k < 8; k++) {
            const dir = (backtrackDir + k) % 8;
            const nx = currX + dx[dir];
            const ny = currY + dy[dir];
            if (nx >= 0 && nx < width && ny >= 0 && ny < height && edges[ny * width + nx] === 255) {
              foundDir = dir;
              break;
            }
          }

          if (foundDir === -1) break;

          currX += dx[foundDir];
          currY += dy[foundDir];
          backtrackDir = (foundDir + 4) % 8;

          if (currX === firstX && currY === firstY) break;
          if (contour.length > (width + height) * 4) break;
        }

        if (contour.length > Math.min(width, height) * 0.1) contours.push(contour);
      }
    }
  }
  return contours;
}

function contourPerimeter(points: Point[]): number {
  let p = 0;
  for (let i = 0; i < points.length; i++) {
    const next = points[(i + 1) % points.length];
    p += Math.sqrt((next.x - points[i].x) ** 2 + (next.y - points[i].y) ** 2);
  }
  return p;
}

function pointLineDistance(p: Point, a: Point, b: Point) {
  const num = Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y));
  const den = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
  return den === 0 ? 0 : num / den;
}

function douglasPeucker(points: Point[], epsilon: number): Point[] {
  let maxDist = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const dist = pointLineDistance(points[i], points[0], points[points.length - 1]);
    if (dist > maxDist) {
      maxDist = dist;
      index = i;
    }
  }
  if (maxDist > epsilon) {
    const res1 = douglasPeucker(points.slice(0, index + 1), epsilon);
    const res2 = douglasPeucker(points.slice(index), epsilon);
    return res1.slice(0, res1.length - 1).concat(res2);
  } else {
    return [points[0], points[points.length - 1]];
  }
}

function approxPoly(points: Point[], epsilon: number): Point[] {
  let maxD = 0;
  let idx = 0;
  const p0 = points[0];
  for (let i = 1; i < points.length; i++) {
    const d = (points[i].x - p0.x) ** 2 + (points[i].y - p0.y) ** 2;
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  const part1 = douglasPeucker(points.slice(0, idx + 1), epsilon);
  const part2 = douglasPeucker(points.slice(idx).concat([points[0]]), epsilon);
  return part1.slice(0, -1).concat(part2.slice(0, -1));
}

function isConvex(pts: Point[]): boolean {
  if (pts.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i];
    const p1 = pts[(i + 1) % pts.length];
    const p2 = pts[(i + 2) % pts.length];
    const cross = (p1.x - p0.x) * (p2.y - p1.y) - (p1.y - p0.y) * (p2.x - p1.x);
    if (cross !== 0) {
      if (sign === 0) sign = Math.sign(cross);
      else if (Math.sign(cross) !== sign) return false;
    }
  }
  return true;
}

function makeQuad(pts: Point[]): Quad {
  // Sort into tl, tr, br, bl
  const sortedBySum = [...pts].sort((a, b) => a.x + a.y - (b.x + b.y));
  const tl = sortedBySum[0];
  const br = sortedBySum[3];
  const remaining = [sortedBySum[1], sortedBySum[2]];
  const sortedByDiff = remaining.sort((a, b) => a.x - a.y - (b.x - b.y));
  const bl = sortedByDiff[0];
  const tr = sortedByDiff[1];
  return { tl, tr, br, bl };
}

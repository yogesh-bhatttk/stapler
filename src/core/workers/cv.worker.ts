/**
 * Scan-cleanup pixel work (SCN-01, SCN-02).
 *
 * Off the main thread because a 12MP phone photo is ~48MB of RGBA and the
 * threshold pass touches every pixel twice — far past the 50ms main-thread budget.
 */
import * as Comlink from 'comlink';
import {
  detectCorners,
  warpPerspective,
  warpTargetSize,
  type CornerDetection,
  type Quad
} from '../cv/imageUtils';
import {
  applyAdaptiveThreshold,
  applyContrastBrightness,
  applyDespeckle,
  deskew,
  type Preset
} from '../cv/enhance';
import { checkpoint, type JobHandle } from './protocol';

export interface ScanSettings {
  preset: Preset;
  contrast: number;
  brightness: number;
  /** Null skips de-warping, e.g. for a page that is already flat. */
  corners: Quad | null;
  /** Off by default for the Photo preset, where rotation would crop the subject. */
  deskew: boolean;
  /** Fast noise removal for binary (thresholded) images. */
  despeckle: boolean;
}

export interface CVJob {
  detectCorners(imageData: ImageData): CornerDetection;
  processScan(imageData: ImageData, settings: ScanSettings, job?: JobHandle): Promise<ImageData>;
  trimBox(imageData: ImageData): { x: number; y: number; width: number; height: number } | null;
}

const api: CVJob = {
  detectCorners(imageData) {
    return detectCorners(imageData);
  },

  trimBox(imageData) {
    const data = imageData.data;
    const width = imageData.width;
    const height = imageData.height;

    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const a = data[idx + 3];

        // Treat transparent or near-white as background
        if (a > 10 && (r < 250 || g < 250 || b < 250)) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX >= minX && maxY >= minY) {
      // Add 1% padding so we don't clip exact edges tightly.
      //
      // maxX/maxY are *inclusive* pixel indices, so the right and bottom edges of
      // the content are at (maxX + 1) / width — using maxX / width cropped the
      // last column and row of ink away, one pixel short on every scan.
      const padding = 0.01;
      const normMinX = Math.max(0, minX / width - padding);
      const normMinY = Math.max(0, minY / height - padding);
      const normMaxX = Math.min(1, (maxX + 1) / width + padding);
      const normMaxY = Math.min(1, (maxY + 1) / height + padding);

      return {
        x: normMinX,
        y: normMinY,
        width: normMaxX - normMinX,
        height: normMaxY - normMinY
      };
    }
    return null;
  },

  async processScan(imageData, settings, job) {
    let current = imageData;

    if (settings.corners) {
      await checkpoint(job, 0.1, 'Correcting perspective');
      const { width, height } = warpTargetSize(settings.corners);
      current = warpPerspective(current, settings.corners, width, height);
    }

    if (settings.deskew) {
      await checkpoint(job, 0.4, 'Measuring skew');
      const straightened = deskew(current);
      if (straightened.angle !== 0) {
        await checkpoint(job, 0.5, `Straightening ${straightened.angle.toFixed(1)}°`);
      }
      current = straightened.image;
    }

    await checkpoint(job, 0.7, 'Enhancing');
    switch (settings.preset) {
      case 'bw':
        // Aggressive window and margin: pure white paper, solid black text.
        current = applyAdaptiveThreshold(current, 15, 15);
        if (settings.despeckle) current = applyDespeckle(current);
        break;
      case 'auto':
        // Wider window, gentler margin — keeps grey scans legible without
        // dropping faint strokes.
        current = applyAdaptiveThreshold(current, 25, 10);
        if (settings.despeckle) current = applyDespeckle(current);
        break;
      case 'photo':
      case 'original':
        // Thresholding a colour photograph destroys it (SCN-02 acceptance
        // criterion), so these presets only ever adjust tone.
        current = applyContrastBrightness(current, settings.contrast, settings.brightness);
        break;
    }

    await checkpoint(job, 1, 'Done');
    return Comlink.transfer(current, [current.data.buffer]);
  }
};

Comlink.expose(api);

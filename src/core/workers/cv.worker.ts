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
}

const api: CVJob = {
  detectCorners(imageData) {
    return detectCorners(imageData);
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

import { signal } from '@preact/signals';
import type { Preset } from '../../../core/cv/enhance';
import type { Quad } from '../../../core/cv/imageUtils';
import { DOC_PAGE_WHITE } from '../../../core/doc-colors';

export interface CleanupSettings {
  preset: Preset;
  contrast: number;
  brightness: number;
  deskew: boolean;
  despeckle: boolean;
  flattenBackground: boolean;
  flattenTint: string;
}

export const cleanupSettings = signal<CleanupSettings>({
  preset: 'auto',
  contrast: 0,
  brightness: 0,
  deskew: true,
  despeckle: true,
  flattenBackground: false,
  flattenTint: DOC_PAGE_WHITE
});

/**
 * Corner overrides per page key. SCN-01 requires manual handles as the
 * always-available fallback, so a user correction must survive a re-detect.
 */
export const cornerOverrides = signal<Record<string, Quad>>({});

/** True while detection is running, so the panel can say so. */
export const isDetectingCorners = signal(false);

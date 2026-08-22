import { effect, signal } from '@preact/signals';
import { activeDocId } from '../../../core/store';
import type { BlurStrength } from '../../../core/faceblur/blur';
import type { FaceBlurReport } from '../../../core/faceblur/runFaceBlur';

export interface FaceBlurSettings {
  /** Off leaves a logo-only run, which needs no model and asks for nothing. */
  detectFaces: boolean;
  /**
   * Use the first redaction mark as a logo template and blur every place that
   * graphic repeats. Deliberately reuses RED-01's marks rather than adding a
   * second way to draw a rectangle on a page.
   */
  useMarkedLogo: boolean;
  strength: BlurStrength;
}

export const faceBlurSettings = signal<FaceBlurSettings>({
  detectFaces: true,
  useMarkedLogo: false,
  strength: 'medium'
});

/** Last run's outcome, so the panel can say what happened after the toast has gone. */
export const faceBlurReport = signal<FaceBlurReport | null>(null);

/**
 * True once the user has said no to the detector download.
 *
 * RED-08's acceptance criterion is that declining leaves the tool *disabled
 * with a clear message*, not silently doing nothing. This signal is what makes
 * that visible: it disables the face half of the panel, puts an explanation
 * next to it, and makes the export path say out loud that faces were not
 * blurred. It survives until the user either allows the download or turns face
 * blur off deliberately, so the state cannot be forgotten between two clicks.
 */
export const faceBlurModelDeclined = signal(false);

// Page indices and a marked logo mean nothing against a different document, and
// a report about the previous one is worse than no report.
effect(() => {
  void activeDocId.value;
  faceBlurReport.value = null;
});

import { effect, signal } from '@preact/signals';
import { activeDocId } from '../../../core/store';
import type { BlurStrength } from '../../../core/faceblur/blur';
import type { FaceBlurReport } from '../../../core/faceblur/runFaceBlur';

export interface FaceBlurSettings {
  /** Off leaves a logo-only run, which never loads the detector. */
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

// Page indices and a marked logo mean nothing against a different document, and
// a report about the previous one is worse than no report.
effect(() => {
  void activeDocId.value;
  faceBlurReport.value = null;
});

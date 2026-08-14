import { signal } from '@preact/signals';
import { DEFAULT_OCR_LANGUAGE } from '../../../core/ocr/model';

export interface OcrSettings {
  /** tesseract language code. Only `eng` ships in OCR-01. */
  lang: string;
  /**
   * When true, OCR runs on the pages ticked in the grid rather than the whole
   * document. Recognition is the slowest thing in the app, so the default is the
   * cheap one.
   */
  selectedPagesOnly: boolean;
}

export const ocrSettings = signal<OcrSettings>({
  lang: DEFAULT_OCR_LANGUAGE,
  selectedPagesOnly: false
});

/**
 * Last run's outcome, so the panel can say what happened after the toast has
 * gone. Null before the first run.
 */
export const ocrReport = signal<{ wordsAdded: number; wordsSkipped: number; pages: number } | null>(
  null
);

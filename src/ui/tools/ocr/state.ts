import { signal } from '@preact/signals';
import { DEFAULT_OCR_LANGUAGE } from '../../../core/ocr/model';

export interface OcrSettings {
  /** tesseract language code — see `OCR_LANGUAGES` for what's available. */
  lang: string;
  /**
   * When true, OCR runs on the pages ticked in the grid rather than the whole
   * document. Recognition is the slowest thing in the app, so the default is the
   * cheap one.
   */
  selectedPagesOnly: boolean;
  /**
   * CV9 — also OCR pages that already draw real text. Off by default: their
   * text would be added a second time, and search and copy would return it twice.
   */
  includePagesWithText: boolean;
}

export const ocrSettings = signal<OcrSettings>({
  lang: DEFAULT_OCR_LANGUAGE,
  selectedPagesOnly: false,
  includePagesWithText: false
});

/**
 * Last run's outcome, so the panel can say what happened after the toast has
 * gone. Null before the first run.
 */
export const ocrReport = signal<{
  wordsAdded: number;
  wordsSkipped: number;
  pages: number;
  pagesReplaced: number;
  /** §2.3 — pages recognition could not run on at all (see `runOcr`'s per-page try/catch). */
  pagesSkipped: number;
  /** CV9 — pages left out because they already had real text. */
  pagesWithText: number;
} | null>(null);

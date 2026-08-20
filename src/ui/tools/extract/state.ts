import { signal } from '@preact/signals';
import { DEFAULT_OCR_LANGUAGE } from '../../../core/ocr/model';

export interface ExtractSettings {
  mode: 'text' | 'markdown';
  /**
   * Language OCR falls back to when a page has no usable text layer — see
   * `OcrPanel`'s language setting for the same catalogue. Only consulted if
   * extraction actually needs to fall back; a document with a real text
   * layer never touches this.
   */
  lang: string;
}

export const extractSettings = signal<ExtractSettings>({
  mode: 'text',
  lang: DEFAULT_OCR_LANGUAGE
});
export const extractedText = signal<string>('');

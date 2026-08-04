import { signal } from '@preact/signals';

export interface ExtractSettings {
  mode: 'text' | 'markdown';
}

export const extractSettings = signal<ExtractSettings>({ mode: 'text' });
export const extractedText = signal<string>('');

import { signal } from '@preact/signals';
import type { ToolId } from '../../../core/tools';
import type { CompressSettings } from '../compress/state';
import type { WatermarkSettings, HeaderFooterSettings } from '../watermark/state';
import type { NUpSettings } from '../nup/state';
import type { NormalizeSettings } from '../normalize/state';

export interface Recipe {
  id: string;
  name: string;
  tools: ToolId[];
  settings: {
    compress?: CompressSettings;
    watermark?: WatermarkSettings;
    headerFooter?: HeaderFooterSettings;
    nup?: NUpSettings;
    normalize?: NormalizeSettings;
  };
}

export const savedRecipes = signal<Recipe[]>(
  JSON.parse(localStorage.getItem('stapler:recipes') || '[]')
);

savedRecipes.subscribe(recipes => {
  localStorage.setItem('stapler:recipes', JSON.stringify(recipes));
});

export const activeRecipeId = signal<string | null>(null);

import type { FsaDirectoryHandle } from '../../../platform/fsa';

export const inputDirHandle = signal<FsaDirectoryHandle | FileSystemDirectoryHandle | null>(null);
export const outputDirHandle = signal<FsaDirectoryHandle | FileSystemDirectoryHandle | null>(null);

/**
 * One thing that happened to one file that the run summary has to mention.
 *
 * `kept-original` is the compress fallback (CMP-04): the compressed result came
 * out no smaller than the input, so the original was written through unchanged.
 * That is the correct outcome, but silently emitting a byte-identical copy left
 * the user believing a folder of files had been compressed when it had not.
 */
export interface BatchNote {
  file: string;
  kind: 'kept-original';
  detail: string;
}

export interface BatchProgress {
  total: number;
  completed: number;
  failed: number;
  currentFile: string;
  isProcessing: boolean;
  /** Per-file outcomes worth telling the user about, in the order they happened. */
  notes: BatchNote[];
}

export const batchProgress = signal<BatchProgress>({
  total: 0,
  completed: 0,
  failed: 0,
  currentFile: '',
  isProcessing: false,
  notes: []
});

/**
 * BAT-03 — output filename pattern. Tokens: {basename}, {index}, {date}.
 * Defaults to '{basename}' which preserves the pre-BAT-03 behaviour exactly.
 */
export const outputPattern = signal<string>(
  localStorage.getItem('stapler:batch:outputPattern') ?? '{basename}'
);

outputPattern.subscribe(p => {
  localStorage.setItem('stapler:batch:outputPattern', p);
});
